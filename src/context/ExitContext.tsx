'use client';

import React, { createContext, useContext, useReducer, useEffect, useCallback, useRef } from 'react';
import type { UniexitData, BroadcastTree, ExitState } from '@/lib/types';
import { BroadcastPhase, StepStatus } from '@/lib/types';
import { parseTreeState } from '@/lib/tree-parser';
import { broadcastTx, submitPackage, getTxStatus, getCurrentBlockHeight, getFeeRate, determinePhase, getNextStep, checkOutspend } from '@/lib/broadcaster';
import { saveState, loadState } from '@/lib/storage';
import { buildCpfpTx, buildAllCpfpPackages, findAnchorVout, getTxVsize, fetchUtxos, getAddress, computeTxidFromHex } from '@/lib/wallet';
import { parseTx } from '@/lib/tx-parser';
import type { WalletState, CpfpPackage } from '@/lib/wallet';

const DEFAULT_MEMPOOL_URL = '/mempool';
const DEFAULT_RPC_URL = '/rpc';
const DEFAULT_RPC_USER = process.env.NEXT_PUBLIC_RPC_USER ?? '';
const DEFAULT_RPC_PASSWORD = process.env.NEXT_PUBLIC_RPC_PASSWORD ?? '';

const initialState: ExitState = {
  importedData: null,
  trees: [],
  treePhases: {},
  stepStatuses: {},
  stepTxids: {},
  stepErrors: {},
  csvTargetHeights: {},
  currentBlockHeight: 0,
  isRunning: false,
  mempoolBaseUrl: DEFAULT_MEMPOOL_URL,
  rpcUrl: DEFAULT_RPC_URL,
  rpcUser: DEFAULT_RPC_USER,
  rpcPassword: DEFAULT_RPC_PASSWORD,
};

type Action =
  | { type: 'LOAD_STATE'; state: ExitState }
  | { type: 'IMPORT_DATA'; data: UniexitData; trees: BroadcastTree[] }
  | { type: 'START_BROADCAST' }
  | { type: 'PAUSE' }
  | { type: 'STEP_BROADCASTING'; stepId: string }
  | { type: 'STEP_BROADCAST'; stepId: string; txid: string }
  | { type: 'STEP_CONFIRMED'; stepId: string; blockHeight: number }
  | { type: 'STEP_FAILED'; stepId: string; error: string }
  | { type: 'STEP_WAITING_CSV'; stepId: string; targetHeight: number }
  | { type: 'UPDATE_BLOCK_HEIGHT'; height: number }
  | { type: 'TREE_PHASE_UPDATE'; treeId: string; phase: BroadcastPhase }
  | { type: 'TREE_COMPLETE'; treeId: string }
  | { type: 'TREE_ALREADY_EXITED'; treeId: string; txids?: Record<string, string> }
  | { type: 'CLEAR' };

function reducer(state: ExitState, action: Action): ExitState {
  switch (action.type) {
    case 'LOAD_STATE':
      return action.state;

    case 'IMPORT_DATA': {
      const treePhases: Record<string, BroadcastPhase> = {};
      const stepStatuses: Record<string, StepStatus> = {};
      for (const tree of action.trees) {
        treePhases[tree.treeId] = BroadcastPhase.INTERMEDIATES;
        for (const step of tree.steps) {
          stepStatuses[step.id] = StepStatus.PENDING;
        }
      }
      return {
        ...state,
        importedData: action.data,
        trees: action.trees,
        treePhases,
        stepStatuses,
        stepTxids: {},
        stepErrors: {},
        csvTargetHeights: {},
      };
    }

    case 'START_BROADCAST':
      return { ...state, isRunning: true };

    case 'PAUSE':
      return { ...state, isRunning: false };

    case 'STEP_BROADCASTING':
      return {
        ...state,
        stepStatuses: { ...state.stepStatuses, [action.stepId]: StepStatus.BROADCASTING },
        stepErrors: { ...state.stepErrors, [action.stepId]: '' },
      };

    case 'STEP_BROADCAST':
      return {
        ...state,
        stepStatuses: { ...state.stepStatuses, [action.stepId]: StepStatus.BROADCAST },
        stepTxids: { ...state.stepTxids, [action.stepId]: action.txid },
      };

    case 'STEP_CONFIRMED':
      return {
        ...state,
        stepStatuses: { ...state.stepStatuses, [action.stepId]: StepStatus.CONFIRMED },
      };

    case 'STEP_FAILED':
      return {
        ...state,
        stepStatuses: { ...state.stepStatuses, [action.stepId]: StepStatus.FAILED },
        stepErrors: { ...state.stepErrors, [action.stepId]: action.error },
      };

    case 'STEP_WAITING_CSV':
      return {
        ...state,
        stepStatuses: { ...state.stepStatuses, [action.stepId]: StepStatus.WAITING_CSV },
        csvTargetHeights: { ...state.csvTargetHeights, [action.stepId]: action.targetHeight },
      };

    case 'UPDATE_BLOCK_HEIGHT':
      return { ...state, currentBlockHeight: action.height };

    case 'TREE_PHASE_UPDATE':
      return {
        ...state,
        treePhases: { ...state.treePhases, [action.treeId]: action.phase },
      };

    case 'TREE_COMPLETE': {
      return {
        ...state,
        treePhases: { ...state.treePhases, [action.treeId]: BroadcastPhase.COMPLETE },
      };
    }

    case 'TREE_ALREADY_EXITED': {
      const newStatuses = { ...state.stepStatuses };
      const newTxids = { ...state.stepTxids };
      const tree = state.trees.find(t => t.treeId === action.treeId);
      if (tree) {
        for (const step of tree.steps) {
          newStatuses[step.id] = StepStatus.CONFIRMED;
          if (action.txids && action.txids[step.id]) {
            newTxids[step.id] = action.txids[step.id];
          }
        }
      }
      return {
        ...state,
        treePhases: { ...state.treePhases, [action.treeId]: BroadcastPhase.ALREADY_EXITED },
        stepStatuses: newStatuses,
        stepTxids: newTxids,
      };
    }

    case 'CLEAR':
      return initialState;

    default:
      return state;
  }
}

interface ExitContextValue {
  state: ExitState;
  importData: (data: UniexitData) => void;
  startBroadcast: (wallet: WalletState) => void;
  pause: () => void;
  retryStep: (stepId: string) => void;
  bumpFee: (stepId: string) => void;
  clear: () => void;
}

const ExitContext = createContext<ExitContextValue | null>(null);

export function ExitProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const runningRef = useRef(false);
  const walletRef = useRef<WalletState | null>(null);
  const cpfpPackagesRef = useRef<Map<string, CpfpPackage>>(new Map());

  // Load persisted state on mount
  useEffect(() => {
    loadState().then(saved => {
      if (saved) {
        dispatch({ type: 'LOAD_STATE', state: {
          ...saved,
          isRunning: false,
          mempoolBaseUrl: DEFAULT_MEMPOOL_URL,
          rpcUrl: DEFAULT_RPC_URL,
          rpcUser: DEFAULT_RPC_USER,
          rpcPassword: DEFAULT_RPC_PASSWORD,
        } });
      }
    });
  }, []);

  // Persist state on every change
  useEffect(() => {
    if (state.importedData) {
      saveState(state);
    }
  }, [state]);

  // Update tree phases whenever step statuses change
  useEffect(() => {
    for (const tree of state.trees) {
      if (state.treePhases[tree.treeId] === BroadcastPhase.ALREADY_EXITED) continue;
      const newPhase = determinePhase(tree, state.stepStatuses);
      if (state.treePhases[tree.treeId] !== newPhase) {
        dispatch({ type: 'TREE_PHASE_UPDATE', treeId: tree.treeId, phase: newPhase });
      }
    }
  }, [state.stepStatuses, state.trees, state.treePhases]);

  // Look up on-chain txids for already-exited trees that are missing txids
  useEffect(() => {
    for (const tree of state.trees) {
      if (state.treePhases[tree.treeId] !== BroadcastPhase.ALREADY_EXITED) continue;
      const leafStep = tree.steps.find(st => st.type === 'leaf-node');
      const refundStep = tree.steps.find(st => st.type === 'leaf-refund');
      if (leafStep && state.stepTxids[leafStep.id] && refundStep && state.stepTxids[refundStep.id]) continue;
      // Missing txids — look them up
      (async () => {
        try {
          const parsed = parseTx(leafStep!.txHex);
          const inp = parsed.inputs[0];
          const leafOutspend = await checkOutspend(inp.prevTxid, inp.prevVout, state.mempoolBaseUrl);
          const txids: Record<string, string> = {};
          if (leafOutspend.spent && leafOutspend.spendingTxid) {
            if (leafStep) txids[leafStep.id] = leafOutspend.spendingTxid;
            const refundOutspend = await checkOutspend(leafOutspend.spendingTxid, 0, state.mempoolBaseUrl);
            if (refundOutspend.spent && refundOutspend.spendingTxid && refundStep) {
              txids[refundStep.id] = refundOutspend.spendingTxid;
            }
          }
          // Store intermediate txids we already have
          for (const st of tree.steps) {
            if (st.type === 'intermediate' && state.stepTxids[st.id]) {
              txids[st.id] = state.stepTxids[st.id];
            }
          }
          if (Object.keys(txids).length > 0) {
            dispatch({ type: 'TREE_ALREADY_EXITED', treeId: tree.treeId, txids });
          }
        } catch (e) {
          console.log(`[exit] could not look up exit txids for ${tree.treeId.slice(0,8)}: ${e instanceof Error ? e.message : e}`);
        }
      })();
    }
  }, [state.trees, state.treePhases]); // eslint-disable-line react-hooks/exhaustive-deps

  const importData = useCallback((data: UniexitData) => {
    const trees = parseTreeState(data);
    dispatch({ type: 'IMPORT_DATA', data, trees });
  }, []);

  const clear = useCallback(() => {
    runningRef.current = false;
    dispatch({ type: 'CLEAR' });
  }, []);

  // Broadcast loop
  const runBroadcastLoop = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;

    while (runningRef.current) {
      const s = stateRef.current;
      if (!s.isRunning) {
        runningRef.current = false;
        break;
      }

      // Update block height
      try {
        const height = await getCurrentBlockHeight(s.mempoolBaseUrl);
        dispatch({ type: 'UPDATE_BLOCK_HEIGHT', height });
      } catch {
        // Will retry next iteration
      }

      let didWork = false;

      for (const tree of s.trees) {
        const phase = s.treePhases[tree.treeId];
        if (phase === BroadcastPhase.COMPLETE || phase === BroadcastPhase.ALREADY_EXITED) {
          continue;
        }

        // Check confirmations for broadcast steps
        for (const step of tree.steps) {
          const status = s.stepStatuses[step.id];
          if (status === StepStatus.BROADCAST) {
            const txid = s.stepTxids[step.id];
            if (txid) {
              const txStatus = await getTxStatus(txid, s.mempoolBaseUrl);
              if (txStatus.confirmed && txStatus.blockHeight) {
                dispatch({ type: 'STEP_CONFIRMED', stepId: step.id, blockHeight: txStatus.blockHeight });
                didWork = true;

                if (step.type === 'intermediate') {
                  const leafNodeSteps = tree.steps.filter(st => st.type === 'leaf-node');
                  const allIntermediates = tree.steps.filter(st => st.type === 'intermediate');
                  const allIntConfirmed = allIntermediates.every(
                    st => st.id === step.id || stateRef.current.stepStatuses[st.id] === StepStatus.CONFIRMED,
                  );
                  if (allIntConfirmed) {
                    for (const leafStep of leafNodeSteps) {
                      if (leafStep.csvBlocks > 0) {
                        dispatch({
                          type: 'STEP_WAITING_CSV',
                          stepId: leafStep.id,
                          targetHeight: txStatus.blockHeight + leafStep.csvBlocks,
                        });
                      }
                    }
                  }
                } else if (step.type === 'leaf-node') {
                  const refundStep = tree.steps.find(
                    st => st.type === 'leaf-refund' && st.nodeId === step.nodeId,
                  );
                  if (refundStep && refundStep.csvBlocks > 0) {
                    dispatch({
                      type: 'STEP_WAITING_CSV',
                      stepId: refundStep.id,
                      targetHeight: txStatus.blockHeight + refundStep.csvBlocks,
                    });
                  }
                }
              }
            }
          }
        }

        // Try to broadcast next step
        const currentState = stateRef.current;
        const nextStep = getNextStep(
          tree,
          currentState.stepStatuses,
          currentState.csvTargetHeights,
          currentState.currentBlockHeight,
        );

        // TRUC limit: don't broadcast if any step in this tree is still unconfirmed in mempool
        const hasUnconfirmedInMempool = tree.steps.some(
          st => currentState.stepStatuses[st.id] === StepStatus.BROADCAST,
        );
        if (hasUnconfirmedInMempool) {
          const pendingSteps = tree.steps.filter(st => currentState.stepStatuses[st.id] === StepStatus.BROADCAST);
          const pendingTxids = pendingSteps.map(st => currentState.stepTxids[st.id] || 'unknown').join(', ');
          console.log(`[exit] tree ${tree.treeId.slice(0,8)} waiting for pending tx to confirm (TRUC limit) txids: ${pendingTxids}`);
          continue;
        }

        if (nextStep) {
          // Only refresh wallet UTXOs if we have none cached
          if (walletRef.current && walletRef.current.utxos.length === 0) {
            try {
              const addr = getAddress(walletRef.current.mnemonic, walletRef.current.addressIndex);
              const freshUtxos = await fetchUtxos(addr, s.mempoolBaseUrl, s.rpcUrl, s.rpcUser, s.rpcPassword);
              walletRef.current = { ...walletRef.current, utxos: freshUtxos };
              // Rebuild all CPFP packages with fresh UTXOs
              cpfpPackagesRef.current = new Map();
            } catch {
              // Use cached UTXOs
            }
          }

          // Pre-build CPFP packages for all pending steps if not already built
          if (cpfpPackagesRef.current.size === 0 && walletRef.current && walletRef.current.utxos.length > 0) {
            const currentState = stateRef.current;
            const pendingSteps: { id: string; txHex: string }[] = [];
            for (const t of s.trees) {
              const tPhase = currentState.treePhases[t.treeId];
              if (tPhase === BroadcastPhase.COMPLETE || tPhase === BroadcastPhase.ALREADY_EXITED) continue;
              for (const st of t.steps) {
                const stStatus = currentState.stepStatuses[st.id];
                if (!stStatus || stStatus === StepStatus.PENDING || stStatus === StepStatus.FAILED || stStatus === StepStatus.WAITING_CSV) {
                  pendingSteps.push({ id: st.id, txHex: st.txHex });
                }
              }
            }
            if (pendingSteps.length > 0) {
              try {
                const recommendedRate = await getFeeRate(s.mempoolBaseUrl);
                const feeRate = Math.max(recommendedRate, 1);
                const packages = buildAllCpfpPackages({
                  mnemonic: walletRef.current.mnemonic,
                  addressIndex: walletRef.current.addressIndex,
                  steps: pendingSteps,
                  fundingUtxos: walletRef.current.utxos,
                  feeRate,
                });
                console.log(`[exit] pre-built ${packages.length} CPFP packages for ${pendingSteps.length} pending steps`);
                for (const pkg of packages) {
                  cpfpPackagesRef.current.set(pkg.stepId, pkg);
                }
              } catch (e) {
                console.log(`[exit] failed to pre-build CPFP packages: ${e instanceof Error ? e.message : e}`);
              }
            }
          }

          console.log(`[exit] tree ${tree.treeId.slice(0,8)} broadcasting step ${nextStep.id} (${nextStep.type}, depth=${nextStep.depth})`);
          dispatch({ type: 'STEP_BROADCASTING', stepId: nextStep.id });

          // Try direct broadcast first to detect already-confirmed/in-mempool txs
          let result = await broadcastTx(nextStep.txHex, s.mempoolBaseUrl);

          // If needs CPFP (zero-fee rejection or ambiguous -25), use pre-built package or build on-the-fly.
          // The mempool API returns bare {"code":-25} without the message, so 'missing-inputs'
          // may actually be 'non-BIP68-final' or a fee rejection. submitpackage gives proper errors.
          if (result.error === 'needs-cpfp' || result.error === 'missing-inputs') {
            const prebuilt = cpfpPackagesRef.current.get(nextStep.id);
            if (prebuilt) {
              console.log(`[exit] step ${nextStep.id} using pre-built CPFP package`);
              const pkgResult = await submitPackage(
                [prebuilt.parentTxHex, prebuilt.cpfpChildHex],
                s.rpcUrl,
                s.rpcUser,
                s.rpcPassword,
              );
              cpfpPackagesRef.current.delete(nextStep.id);

              // Handle partial success: parent accepted even if child failed
              if (pkgResult.txids && pkgResult.txids.length > 0) {
                result = { txid: pkgResult.txids[0] };
                if (pkgResult.error) {
                  console.log(`[exit] parent accepted, child issue: ${pkgResult.error}`);
                }
              } else if (pkgResult.error) {
                // Determine if it's the parent tx or just the CPFP child that failed
                const parentTxFailed = pkgResult.error.includes(prebuilt.parentTxHex.slice(0, 12)) ||
                  pkgResult.error.split(';').length > 1; // both txs failed = parent inputs missing
                if (pkgResult.error.includes('missingorspent') && !parentTxFailed) {
                  console.log('[exit] CPFP child inputs not yet available (waiting for previous CPFP to confirm)');
                  result = { error: 'Waiting for previous CPFP to confirm' };
                } else if (pkgResult.error.includes('missingorspent') && parentTxFailed) {
                  console.log(`[exit] parent tx inputs missing on-chain — intermediate output may have been spent`);
                  result = { error: 'missing-inputs' };
                } else {
                  result = { error: pkgResult.error };
                }
              }
            } else {
              // No pre-built package available, fall back to on-the-fly build
              const wallet = walletRef.current;
              if (!wallet || wallet.utxos.length === 0) {
                console.log(`[exit] step ${nextStep.id} needs CPFP but no wallet UTXOs`);
                result = { error: 'Needs CPFP: fund the wallet or wait for previous CPFP to confirm' };
              } else {
                try {
                  const anchorVout = findAnchorVout(nextStep.txHex);
                  if (anchorVout === null) {
                    result = { error: 'No anchor output found in tx' };
                  } else {
                    const parentVsize = getTxVsize(nextStep.txHex);
                    const recommendedRate = await getFeeRate(s.mempoolBaseUrl);
                    const feeRate = Math.max(recommendedRate, 1);

                    const cpfpHex = buildCpfpTx({
                      mnemonic: wallet.mnemonic,
                      addressIndex: wallet.addressIndex,
                      parentTxHex: nextStep.txHex,
                      anchorVout,
                      fundingUtxos: wallet.utxos,
                      feeRate,
                      parentVsize,
                    });

                    const pkgResult = await submitPackage(
                      [nextStep.txHex, cpfpHex],
                      s.rpcUrl,
                      s.rpcUser,
                      s.rpcPassword,
                    );

                    if (pkgResult.txids && pkgResult.txids.length > 0) {
                      result = { txid: pkgResult.txids[0] };
                      if (pkgResult.error) {
                        console.log(`[exit] parent accepted, child issue: ${pkgResult.error}`);
                      }
                    } else if (pkgResult.error) {
                      if (pkgResult.error.includes('missingorspent')) {
                        if (walletRef.current) {
                          walletRef.current = { ...walletRef.current, utxos: [] };
                        }
                      }
                      result = { error: pkgResult.error };
                    }
                  }
                } catch (e) {
                  const msg = e instanceof Error ? e.message : 'CPFP build failed';
                  console.log(`[exit] CPFP error: ${msg}`);
                  result = { error: msg };
                }
              }
            }
          }

          // Handle result
          if (result.error === 'already-confirmed') {
            try {
              const confirmedTxid = computeTxidFromHex(nextStep.txHex);
              console.log(`[exit] step ${nextStep.id} already confirmed on-chain txid=${confirmedTxid}`);
              dispatch({ type: 'STEP_BROADCAST', stepId: nextStep.id, txid: confirmedTxid });
            } catch {
              console.log(`[exit] step ${nextStep.id} already confirmed on-chain (could not compute txid)`);
            }
            dispatch({ type: 'STEP_CONFIRMED', stepId: nextStep.id, blockHeight: currentState.currentBlockHeight });
            didWork = true;
          } else if (result.error === 'missing-inputs') {
            // Check if the inputs were already spent (cooperative close)
            let alreadyExited = false;
            try {
              const parsed = parseTx(nextStep.txHex);
              for (const inp of parsed.inputs) {
                console.log(`[exit] step ${nextStep.id} spends ${inp.prevTxid}:${inp.prevVout}`);
                const outspend = await checkOutspend(inp.prevTxid, inp.prevVout, s.mempoolBaseUrl);
                if (outspend.spent) {
                  console.log(`[exit] input ${inp.prevTxid}:${inp.prevVout} already spent by ${outspend.spendingTxid} at block ${outspend.spendingBlockHeight} — tree already exited`);
                  alreadyExited = true;
                } else {
                  console.log(`[exit] input ${inp.prevTxid}:${inp.prevVout} is NOT spent — UTXO may not exist`);
                }
              }
            } catch (e) {
              console.log(`[exit] could not check outspends: ${e instanceof Error ? e.message : e}`);
            }
            if (alreadyExited) {
              console.log(`[exit] tree ${tree.treeId.slice(0,8)} already exited (inputs spent by another tx)`);
              // Look up the full chain of on-chain txids for display
              const exitTxids: Record<string, string> = {};
              try {
                const parsed = parseTx(nextStep.txHex);
                const inp = parsed.inputs[0];
                // The spending tx of the intermediate output is the leaf-node tx
                const leafOutspend = await checkOutspend(inp.prevTxid, inp.prevVout, s.mempoolBaseUrl);
                if (leafOutspend.spent && leafOutspend.spendingTxid) {
                  const leafTxid = leafOutspend.spendingTxid;
                  // Find leaf-node step and store its txid
                  const leafStep = tree.steps.find(st => st.type === 'leaf-node');
                  if (leafStep) exitTxids[leafStep.id] = leafTxid;
                  // Check if the leaf output was spent (refund tx)
                  const refundOutspend = await checkOutspend(leafTxid, 0, s.mempoolBaseUrl);
                  if (refundOutspend.spent && refundOutspend.spendingTxid) {
                    const refundStep = tree.steps.find(st => st.type === 'leaf-refund');
                    if (refundStep) exitTxids[refundStep.id] = refundOutspend.spendingTxid;
                  }
                }
                // Also store intermediate txids from what we already have
                for (const st of tree.steps) {
                  if (st.type === 'intermediate' && currentState.stepTxids[st.id]) {
                    exitTxids[st.id] = currentState.stepTxids[st.id];
                  }
                }
              } catch (e) {
                console.log(`[exit] could not look up exit txids: ${e instanceof Error ? e.message : e}`);
              }
              dispatch({ type: 'TREE_ALREADY_EXITED', treeId: tree.treeId, txids: exitTxids });
              didWork = true;
            } else {
              dispatch({ type: 'STEP_FAILED', stepId: nextStep.id, error: 'Inputs not found on-chain' });
            }
          } else if (result.error === 'csv-not-elapsed') {
            console.log(`[exit] step ${nextStep.id} CSV not elapsed`);
            dispatch({
              type: 'STEP_WAITING_CSV',
              stepId: nextStep.id,
              targetHeight: currentState.currentBlockHeight + nextStep.csvBlocks,
            });
          } else if (result.error === 'wait-for-parent') {
            console.log(`[exit] step ${nextStep.id} waiting for parent to confirm`);
            dispatch({ type: 'STEP_FAILED', stepId: nextStep.id, error: 'Waiting for parent tx to confirm' });
          } else if (result.error) {
            console.log(`[exit] step ${nextStep.id} failed: ${result.error}`);
            dispatch({ type: 'STEP_FAILED', stepId: nextStep.id, error: result.error });
          } else if (result.txid) {
            console.log(`[exit] step ${nextStep.id} broadcast OK txid=${result.txid}`);
            dispatch({ type: 'STEP_BROADCAST', stepId: nextStep.id, txid: result.txid });
            didWork = true;
            // After a successful CPFP submit, stop processing more trees this iteration.
            // Chained packages depend on this CPFP confirming first.
            break;
          }
        }
      }

      // Wait before next iteration
      const delay = didWork ? 2000 : 15000;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }, []);

  const startBroadcast = useCallback((wallet: WalletState) => {
    walletRef.current = wallet;
    cpfpPackagesRef.current = new Map(); // Force rebuild with fresh wallet UTXOs
    dispatch({ type: 'START_BROADCAST' });
    setTimeout(() => runBroadcastLoop(), 0);
  }, [runBroadcastLoop]);

  const pause = useCallback(() => {
    dispatch({ type: 'PAUSE' });
    runningRef.current = false;
  }, []);

  const retryStep = useCallback((stepId: string) => {
    // Reset the step to PENDING so the broadcast loop picks it up
    // with full CPFP and error handling logic
    const step = state.trees.flatMap(t => t.steps).find(s => s.id === stepId);
    if (step) {
      dispatch({ type: 'STEP_FAILED', stepId, error: '' });
      if (step.csvBlocks > 0 && state.currentBlockHeight > 0) {
        // Re-enter WAITING_CSV — the loop will check if CSV elapsed and broadcast
        dispatch({
          type: 'STEP_WAITING_CSV',
          stepId,
          targetHeight: state.csvTargetHeights[stepId] ?? state.currentBlockHeight,
        });
      }
    }
  }, [state.trees, state.mempoolBaseUrl]);

  const bumpFee = useCallback(async (stepId: string) => {
    const step = state.trees.flatMap(t => t.steps).find(s => s.id === stepId);
    if (!step) return;

    const wallet = walletRef.current;
    if (!wallet || wallet.utxos.length === 0) {
      // Try loading wallet from storage
      const loaded = await import('@/lib/wallet').then(m => m.loadWallet());
      if (!loaded || loaded.utxos.length === 0) {
        alert('No funded wallet available. Fund the wallet first, then refresh balance.');
        return;
      }
      walletRef.current = loaded;
    }

    const w = walletRef.current!;
    try {
      const anchorVout = findAnchorVout(step.txHex);
      if (anchorVout === null) {
        alert('No anchor output found in this transaction.');
        return;
      }

      const parentVsize = getTxVsize(step.txHex);
      const recommendedRate = await getFeeRate(state.mempoolBaseUrl);
      const feeRate = Math.max(recommendedRate, 1);

      const cpfpHex = buildCpfpTx({
        mnemonic: w.mnemonic,
        addressIndex: w.addressIndex,
        parentTxHex: step.txHex,
        anchorVout,
        fundingUtxos: w.utxos,
        feeRate,
        parentVsize,
      });

      console.log(`[bump] broadcasting CPFP child for step ${stepId}, feeRate=${feeRate}`);

      // Parent is already in mempool, just broadcast the child directly
      const result = await broadcastTx(cpfpHex, state.mempoolBaseUrl);
      if (result.error) {
        // If direct broadcast fails (e.g. needs package), try submitpackage
        console.log(`[bump] direct child broadcast failed: ${result.error}, trying submitpackage`);
        const pkgResult = await submitPackage(
          [step.txHex, cpfpHex],
          state.rpcUrl,
          state.rpcUser,
          state.rpcPassword,
        );
        // Handle partial success: parent accepted even if child failed
        if (pkgResult.txids && pkgResult.txids.length > 0) {
          const parentTxid = pkgResult.txids[0];
          console.log(`[bump] parent tx accepted: ${parentTxid}${pkgResult.error ? ` (child issue: ${pkgResult.error})` : ''}`);
          dispatch({ type: 'STEP_BROADCAST', stepId, txid: parentTxid });
          const usedTxids = new Set(w.utxos.map(u => `${u.txid}:${u.vout}`));
          walletRef.current = {
            ...w,
            utxos: w.utxos.filter(u => !usedTxids.has(`${u.txid}:${u.vout}`)),
          };
        } else if (pkgResult.error) {
          alert(`Bump failed: ${pkgResult.error}`);
        }
      } else {
        console.log(`[bump] CPFP child broadcast OK: ${result.txid}`);
        const usedTxids = new Set(w.utxos.map(u => `${u.txid}:${u.vout}`));
        walletRef.current = {
          ...w,
          utxos: w.utxos.filter(u => !usedTxids.has(`${u.txid}:${u.vout}`)),
        };
        if (result.txid) {
          dispatch({ type: 'STEP_BROADCAST', stepId, txid: result.txid });
        }
      }
    } catch (e) {
      alert(`Bump failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
    }
  }, [state.trees, state.mempoolBaseUrl, state.rpcUrl, state.rpcUser, state.rpcPassword]);

  return (
    <ExitContext.Provider value={{ state, importData, startBroadcast, pause, retryStep, bumpFee, clear }}>
      {children}
    </ExitContext.Provider>
  );
}

export function useExit(): ExitContextValue {
  const ctx = useContext(ExitContext);
  if (!ctx) throw new Error('useExit must be used within ExitProvider');
  return ctx;
}
