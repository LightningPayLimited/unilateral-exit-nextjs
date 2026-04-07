'use client';

import { useEffect, useState } from 'react';
import type { BroadcastTree } from '@/lib/types';
import { BroadcastPhase } from '@/lib/types';
import { useExit } from '@/context/ExitContext';
import { loadWallet, buildCpfpTx, findAnchorVout, getTxVsize, fetchUtxos, getAddress } from '@/lib/wallet';
import { parseTx } from '@/lib/tx-parser';
import { submitPackage, getFeeRate } from '@/lib/broadcaster';

const MEMPOOL_EXPLORER = process.env.NEXT_PUBLIC_MEMPOOL_EXPLORER ?? 'https://mempool.space';
const PUBLIC_MEMPOOL_API = 'https://mempool.space/api';

// Look up UTXOs for an address. Tries public mempool.space first (which has
// the full address index), then falls back to the local proxied mempool for
// users running their own indexer. Public-first ordering keeps the dev console
// quiet for users whose local mempool doesn't have an address index.
async function fetchAddressUtxos(addr: string): Promise<
  | { ok: true; utxos: Array<{ txid: string; vout: number; value: number }>; source: string }
  | { ok: false; status: number; source: string }
> {
  const sources: Array<{ url: string; label: string }> = [
    { url: `${PUBLIC_MEMPOOL_API}/address/${addr}/utxo`, label: 'mempool.space' },
    { url: `/mempool/api/address/${addr}/utxo`, label: 'local mempool' },
  ];
  let lastStatus = 0;
  for (const { url, label } of sources) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const utxos = await res.json();
        if (Array.isArray(utxos)) return { ok: true, utxos, source: label };
      }
      lastStatus = res.status;
    } catch {
      // network error, try next source
    }
  }
  return { ok: false, status: lastStatus, source: 'all sources' };
}

interface TxInfo {
  txid: string;
  vout: Array<{ value: number; scriptpubkey_address?: string; scriptpubkey_type?: string }>;
  status?: { confirmed?: boolean; block_height?: number };
}

// Fetch a tx by id from local mempool first, then public mempool.space.
// Local mempool is typically much faster and doesn't require network egress,
// and as the broadcast destination it always has the tx if it was successful.
async function fetchTxInfo(txid: string): Promise<TxInfo | null> {
  const sources = [
    `/mempool/api/tx/${txid}`,
    `${PUBLIC_MEMPOOL_API}/tx/${txid}`,
  ];
  for (const url of sources) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        return await res.json();
      }
    } catch {
      // try next
    }
  }
  return null;
}

// Returns true if outpoint is spent, false if unspent, null if unknown.
async function fetchOutspend(txid: string, vout: number): Promise<boolean | null> {
  const sources = [
    `/mempool/api/tx/${txid}/outspend/${vout}`,
    `${PUBLIC_MEMPOOL_API}/tx/${txid}/outspend/${vout}`,
  ];
  for (const url of sources) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        return !!data.spent;
      }
    } catch {
      // try next
    }
  }
  return null;
}

// Like fetchOutspend but also returns the spending txid if spent.
async function fetchOutspendDetailed(txid: string, vout: number): Promise<{ spent: boolean; txid?: string; vin?: number; status?: { confirmed?: boolean; block_height?: number } } | null> {
  const sources = [
    `/mempool/api/tx/${txid}/outspend/${vout}`,
    `${PUBLIC_MEMPOOL_API}/tx/${txid}/outspend/${vout}`,
  ];
  for (const url of sources) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        return await res.json();
      }
    } catch {
      // try next
    }
  }
  return null;
}

interface SweepPanelProps {
  tree: BroadcastTree;
}

interface SweepResult {
  leafId: string;
  leafPath: string;
  utxoValue: number;
  fee: number;
  sendAmount: number;
  txid: string;
  hashVariant?: string;
  address?: string;
  error?: string;
}

interface DiagnoseClassifiedOutput {
  vout: number;
  value: number;
  scriptHex: string;
  scriptType: string;
  taprootOutputKey?: string;
  address?: string;
}

interface DiagnoseCandidate {
  variant: string;
  derivationPath: string;
  derivedAddress?: string;
  derivedTweakedOutputKey: string;
  ownerSigningPubKeyMatchesProto: boolean;
  matchesRefundOutput0: boolean;
}

interface DiagnoseResult {
  leafId: string;
  analysis: string;
  refundTx: { outputs: DiagnoseClassifiedOutput[] };
  candidates: DiagnoseCandidate[];
}

interface SpendingTxOutput {
  address?: string;
  scriptType?: string;
  value: number;
  vout: number;
}

export function SweepPanel({ tree }: SweepPanelProps) {
  const { state, findCoopExit } = useExit();
  const [mnemonic, setMnemonic] = useState('');
  const [mnemonicLoadedFromWallet, setMnemonicLoadedFromWallet] = useState(false);
  const [account, setAccount] = useState(1);
  const [destination, setDestination] = useState('');
  const [feeRate, setFeeRate] = useState(3);
  const [loading, setLoading] = useState(false);
  const [verifyResult, setVerifyResult] = useState<string | null>(null);
  const [verifyDetails, setVerifyDetails] = useState<{ path: string; outputKey: string; hashVariant: string } | null>(null);
  const [sweepResults, setSweepResults] = useState<SweepResult[]>([]);
  const [step, setStep] = useState<'input' | 'verified' | 'done'>('input');
  const [coopExitOutputs, setCoopExitOutputs] = useState<SpendingTxOutput[] | null>(null);
  const [coopExitOutputsError, setCoopExitOutputsError] = useState<string | null>(null);
  const [diagnoseResults, setDiagnoseResults] = useState<DiagnoseResult[]>([]);
  const [diagnoseLoading, setDiagnoseLoading] = useState(false);
  const [reverseAddress, setReverseAddress] = useState('');
  const [reverseLoading, setReverseLoading] = useState(false);
  const [refundBroadcastResults, setRefundBroadcastResults] = useState<Array<{ leafId: string; field: string; txid: string; status: string }>>([]);
  const [refundBroadcastLoading, setRefundBroadcastLoading] = useState(false);
  const [reverseResult, setReverseResult] = useState<{
    matches: Array<{
      leafId: string;
      account: number;
      hashVariant: string;
      derivationPath: string;
      derivedAddress?: string;
      refundTxid: string;
      refundOutputValue: number;
      ownerSigningPubKeyMatchesProto: boolean;
    }>;
    leavesScanned: number;
    accountsScanned: number[];
    targetOutputKey: string;
    error?: string;
  } | null>(null);

  const leafIds = tree.leaves.map(l => l.leafId);
  const phase = state.treePhases[tree.treeId];
  const coopExit = state.coopExitInfo[tree.treeId];

  // For trees marked ALREADY_EXITED before coopExitInfo was being recorded,
  // backfill the spending tx so the user can see where their funds went.
  useEffect(() => {
    if (phase === BroadcastPhase.ALREADY_EXITED && !coopExit) {
      findCoopExit(tree.treeId);
    }
  }, [phase, coopExit, tree.treeId, findCoopExit]);

  // Auto-load the mnemonic from the CPFP wallet section. The user already
  // imported their Spark seed there, so we don't need to ask them to type it
  // again every time the sweep panel renders.
  useEffect(() => {
    let cancelled = false;
    loadWallet().then(w => {
      if (cancelled || !w?.mnemonic) return;
      setMnemonic(w.mnemonic);
      setMnemonicLoadedFromWallet(true);
    }).catch(() => {
      // ignore — fall back to manual entry
    });
    return () => { cancelled = true; };
  }, []);

  // Once we know the coop-exit spending txid, fetch its outputs from
  // mempool.space so we can show the user exactly which addresses received
  // funds — without needing them to leave the app.
  useEffect(() => {
    if (!coopExit?.spendingTxid) return;
    let cancelled = false;
    setCoopExitOutputsError(null);
    const sources = [
      `${PUBLIC_MEMPOOL_API}/tx/${coopExit.spendingTxid}`,
      `/mempool/api/tx/${coopExit.spendingTxid}`,
    ];
    (async () => {
      for (const url of sources) {
        try {
          const res = await fetch(url);
          if (!res.ok) continue;
          const data = await res.json();
          if (cancelled) return;
          const outputs: SpendingTxOutput[] = (data.vout ?? []).map(
            (o: { scriptpubkey_address?: string; scriptpubkey_type?: string; value: number }, i: number) => ({
              address: o.scriptpubkey_address,
              scriptType: o.scriptpubkey_type,
              value: o.value,
              vout: i,
            }),
          );
          setCoopExitOutputs(outputs);
          return;
        } catch {
          // try next source
        }
      }
      if (!cancelled) setCoopExitOutputsError('Could not fetch spending tx');
    })();
    return () => {
      cancelled = true;
    };
  }, [coopExit?.spendingTxid]);

  const verify = async () => {
    if (!mnemonic.trim()) return;
    setLoading(true);
    setVerifyResult(null);
    setVerifyDetails(null);
    try {
      const savedState = JSON.parse(localStorage.getItem('unilateral-exit-state') ?? '{}');
      const importedData = savedState.importedData ?? {};
      const res = await fetch('/verify-mnemonic', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mnemonic: mnemonic.trim(),
          identityPublicKey: importedData.identityPublicKey ?? '',
          serializedNodes: importedData.serializedNodes ?? {},
        }),
      });
      const data = await res.json();
      if (data.identityMatch && data.signingKeyMatch) {
        setAccount(data.matchedAccount);
        setVerifyResult(`Verified! Account ${data.matchedAccount}, hash variant: ${data.matchedHashVariant}`);
        if (data.leafDerivation) {
          setVerifyDetails({
            path: data.leafDerivation.path,
            outputKey: data.leafDerivation.taprootOutputKey,
            hashVariant: data.leafDerivation.hashVariant,
          });
        }
        setStep('verified');
      } else if (data.identityMatch) {
        setAccount(data.matchedAccount);
        setVerifyResult(`Identity matches (account ${data.matchedAccount}) but no leaf signing key matched. You can still try to sweep.`);
        setStep('verified');
      } else {
        setVerifyResult('Mnemonic does not match this tree. Check your seed phrase.');
      }
    } catch (e) {
      setVerifyResult(`Error: ${e instanceof Error ? e.message : e}`);
    }
    setLoading(false);
  };

  const sweep = async () => {
    if (!destination.trim()) {
      setVerifyResult('Enter a destination address');
      return;
    }
    setLoading(true);
    const results: SweepResult[] = [];

    // Pull serializedNodes once so we can compute refund txids server-side.
    const savedState = JSON.parse(localStorage.getItem('unilateral-exit-state') ?? '{}');
    const serializedNodes = savedState.importedData?.serializedNodes ?? {};

    // Per-leaf cooperative-spend detection. We probe ALL leaf-node tx variants
    // (CPFP / direct) and ALL refund variants from the protobuf to figure out:
    //   1. Which leaf-node variant we actually broadcast
    //   2. Which refund variant is the correct one for that broadcast variant
    //   3. Whether the leaf-node output is unspent (= we can still broadcast
    //      the matching refund tx) or spent (= cooperative close happened)
    interface CoopSpendInfo {
      found: boolean;
      spendingTxid?: string;
      sourceTxid?: string;
      sourceVout?: number;
      outputs?: Array<{ vout: number; value: number; address?: string; scriptpubkey_type?: string }>;
      // The refund variant whose input matches a tx we have on-chain
      matchingRefundField?: string;
      matchingRefundTxid?: string;
      matchingRefundParentTxid?: string;
      matchingRefundParentVout?: number;
      debug: string[];
    }
    const coopSpendByLeaf = new Map<string, CoopSpendInfo>();
    {
      for (const leafId of leafIds) {
        const debug: string[] = [];
        let found: CoopSpendInfo | null = null;
        try {
          // Step 1: get all variants from the protobuf
          let variants: Array<{ field: string; txid: string; inputs: Array<{ prevTxid: string; prevVout: number }> }> = [];
          try {
            const probeRes = await fetch('/leaf-coop-spend', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ leafId, serializedNodes }),
            });
            const probeData = await probeRes.json();
            if (probeRes.ok && Array.isArray(probeData.variants)) {
              variants = probeData.variants;
              debug.push(`variants=${variants.map(v => `${v.field}=${v.txid.slice(0, 12)}`).join(',')}`);
            }
          } catch {
            debug.push('variant-fetch-failed');
          }

          // Step 2: pick candidate "leaf-node" txids — both from broadcast
          // state and from non-refund variants in the protobuf
          const leafNodeTxids = new Set<string>();
          const leafStepId = `${leafId}-leaf-node`;
          if (state.stepTxids[leafStepId]) {
            leafNodeTxids.add(state.stepTxids[leafStepId]);
            debug.push(`broadcast-state-leaf-node=${state.stepTxids[leafStepId].slice(0, 12)}`);
          }
          for (const v of variants) {
            if (v.field === 'nodeTx' || v.field === 'directTx') {
              leafNodeTxids.add(v.txid);
            }
          }

          // Step 3: figure out which leaf-node tx is actually on-chain, and
          // for each on-chain candidate, find the matching refund variant
          // (refund whose input prevout points to that candidate)
          let onChainLeafNodeTxid: string | null = null;
          for (const candidateTxid of leafNodeTxids) {
            const txInfo = await fetchTxInfo(candidateTxid);
            if (!txInfo?.vout) {
              debug.push(`${candidateTxid.slice(0, 12)}=tx-not-onchain`);
              continue;
            }
            debug.push(`${candidateTxid.slice(0, 12)}=has-${txInfo.vout.length}-outputs`);
            onChainLeafNodeTxid = candidateTxid;

            // Find a refund variant whose input matches this on-chain tx
            const matchingRefund = variants.find(v =>
              (v.field === 'refundTx' || v.field === 'directRefundTx' || v.field === 'directFromCpfpRefundTx') &&
              v.inputs[0]?.prevTxid === candidateTxid,
            );
            if (matchingRefund) {
              debug.push(`matching-refund=${matchingRefund.field}(${matchingRefund.txid.slice(0, 12)})`);
            }

            // Probe each output of this leaf-node tx for spends
            for (let vIdx = 0; vIdx < txInfo.vout.length; vIdx++) {
              const outspendInfo = await fetchOutspendDetailed(candidateTxid, vIdx);
              if (!outspendInfo?.spent || !outspendInfo.txid) {
                debug.push(`${candidateTxid.slice(0, 12)}:${vIdx}-unspent`);
                continue;
              }
              debug.push(`${candidateTxid.slice(0, 12)}:${vIdx}-spent-by-${outspendInfo.txid.slice(0, 12)}`);
              const spendingTx = await fetchTxInfo(outspendInfo.txid);
              if (!spendingTx?.vout) continue;
              found = {
                found: true,
                spendingTxid: outspendInfo.txid,
                sourceTxid: candidateTxid,
                sourceVout: vIdx,
                outputs: spendingTx.vout.map((o, i) => ({
                  vout: i,
                  value: o.value,
                  address: o.scriptpubkey_address,
                  scriptpubkey_type: o.scriptpubkey_type,
                })),
                matchingRefundField: matchingRefund?.field,
                matchingRefundTxid: matchingRefund?.txid,
                matchingRefundParentTxid: matchingRefund?.inputs[0]?.prevTxid,
                matchingRefundParentVout: matchingRefund?.inputs[0]?.prevVout,
                debug,
              };
              break;
            }
            if (found) break;

            // No spend found yet — record the matching refund info anyway
            // so the user can see which refund variant they should broadcast
            if (matchingRefund && !found) {
              found = {
                found: false,
                sourceTxid: candidateTxid,
                matchingRefundField: matchingRefund.field,
                matchingRefundTxid: matchingRefund.txid,
                matchingRefundParentTxid: matchingRefund.inputs[0]?.prevTxid,
                matchingRefundParentVout: matchingRefund.inputs[0]?.prevVout,
                debug,
              };
            }
          }
        } catch (e) {
          debug.push(`probe-error: ${e instanceof Error ? e.message : 'unknown'}`);
        }
        coopSpendByLeaf.set(leafId, found ?? { found: false, debug });
      }
    }

    for (const leafId of leafIds) {
      try {
        // Derive candidate addresses + compute the refund txid from the protobuf.
        const addrRes = await fetch('/leaf-address', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mnemonic: mnemonic.trim(), leafId, account, serializedNodes }),
        });
        const addrData = await addrRes.json();
        if (!addrRes.ok || !Array.isArray(addrData.candidates)) {
          results.push({ leafId, leafPath: '', utxoValue: 0, fee: 0, sendAmount: 0, txid: '', error: addrData.error || 'Could not derive leaf address' });
          continue;
        }
        type Candidate = { variant: string; address?: string; derivationPath?: string; tweakedOutputKey?: string; error?: string };
        const candidates = addrData.candidates as Candidate[];
        const computedRefundTxid: string | undefined = addrData.refundTxid;
        const computedRefundValue: number | undefined = addrData.refundOutputValue;

        let matched: { candidate: Candidate; utxos: Array<{ txid: string; vout: number; value: number }>; source: string } | null = null;
        const triedSummaries: string[] = [];

        // Helper that probes a known refund txid: looks up the tx, validates its
        // vout 0 matches one of our derived candidates, and confirms the output
        // is still unspent.
        const tryRefundTxid = async (txid: string, sourceLabel: string) => {
          const txInfo = await fetchTxInfo(txid);
          if (!txInfo) {
            triedSummaries.push(`${sourceLabel}=tx-not-found(${txid.slice(0, 12)}...)`);
            return null;
          }
          const vout0 = txInfo.vout?.[0];
          if (!vout0?.scriptpubkey_address) {
            triedSummaries.push(`${sourceLabel}=vout0-no-address`);
            return null;
          }
          const matchedCandidate = candidates.find(c => c.address === vout0.scriptpubkey_address);
          if (!matchedCandidate) {
            triedSummaries.push(`${sourceLabel}=vout0-mismatch(${vout0.scriptpubkey_address})`);
            return null;
          }
          const isUnspent = await fetchOutspend(txid, 0);
          if (isUnspent === null) {
            triedSummaries.push(`${sourceLabel}=outspend-unknown`);
            return null;
          }
          if (isUnspent === true) {
            triedSummaries.push(`${sourceLabel}=already-spent(${txid.slice(0, 12)}...)`);
            return null;
          }
          return {
            candidate: matchedCandidate,
            utxos: [{ txid, vout: 0, value: vout0.value }],
            source: sourceLabel,
          };
        };

        // Strategy 0: per-leaf cooperative-spend output.
        const coopInfo = coopSpendByLeaf.get(leafId);
        if (coopInfo?.found && coopInfo.outputs && coopInfo.spendingTxid) {
          const candidateAddrSet = new Set(candidates.map(c => c.address).filter(Boolean));
          let coopMatched = false;
          for (const o of coopInfo.outputs) {
            if (!o.address || !candidateAddrSet.has(o.address)) continue;
            const spent = await fetchOutspend(coopInfo.spendingTxid, o.vout);
            if (spent === true) {
              triedSummaries.push(`coop-spend=already-spent(vout${o.vout})`);
              continue;
            }
            const matchedCandidate = candidates.find(c => c.address === o.address)!;
            matched = {
              candidate: matchedCandidate,
              utxos: [{ txid: coopInfo.spendingTxid, vout: o.vout, value: o.value }],
              source: 'coop-spend',
            };
            coopMatched = true;
            break;
          }
          if (!coopMatched && !matched) {
            const outDescriptions = coopInfo.outputs
              .map(o => o.address ? `vout${o.vout}=${o.value}sats→${o.address}` : `vout${o.vout}=${o.value}sats(${o.scriptpubkey_type ?? 'unknown'})`)
              .join(', ');
            triedSummaries.push(
              `coop-spend=no-match(source=${coopInfo.sourceTxid?.slice(0, 12)}:${coopInfo.sourceVout} → spent-by ${coopInfo.spendingTxid.slice(0, 12)}; outputs=[${outDescriptions}])`,
            );
          }
        } else {
          // Surface the full debug trace AND the matching refund info if any
          const dbg = (coopInfo?.debug ?? ['no-debug']).join(' | ');
          const refundInfo = coopInfo?.matchingRefundField
            ? ` | ACTION: broadcast ${coopInfo.matchingRefundField}=${coopInfo.matchingRefundTxid?.slice(0, 12)}... to claim funds at ${coopInfo.sourceTxid?.slice(0, 12)}`
            : '';
          triedSummaries.push(`coop-spend=no-spend-found[${dbg}${refundInfo}]`);
        }

        // Strategy 1: txid from the broadcast state (if we broadcast it ourselves)
        if (!matched) {
          const refundStepId = `${leafId}-leaf-refund`;
          const knownRefundTxid = state.stepTxids[refundStepId];
          if (knownRefundTxid) {
            matched = await tryRefundTxid(knownRefundTxid, 'broadcast-state');
          } else {
            triedSummaries.push('broadcast-state=no-txid');
          }
        }
        const refundStepId = `${leafId}-leaf-refund`;
        const knownRefundTxid = state.stepTxids[refundStepId];

        // Strategy 2: txid computed from the pre-signed refund hex in serializedNodes
        if (!matched && computedRefundTxid && computedRefundTxid !== knownRefundTxid) {
          matched = await tryRefundTxid(computedRefundTxid, 'computed-from-protobuf');
        }

        // Strategy 3: fall back to address index lookup
        if (!matched) {
          for (const c of candidates) {
            if (!c.address) continue;
            const lookup = await fetchAddressUtxos(c.address);
            if (!lookup.ok) {
              triedSummaries.push(`${c.variant}=lookup-failed(${lookup.status})`);
              continue;
            }
            if (lookup.utxos.length > 0) {
              matched = { candidate: c, utxos: lookup.utxos, source: lookup.source };
              break;
            }
            triedSummaries.push(`${c.variant}=empty(${c.address})`);
          }
        }

        if (!matched) {
          // Include the computed refund txid in the error so the user can look it up manually.
          const refundHint = computedRefundTxid
            ? ` Expected refund txid: ${computedRefundTxid} (value: ${computedRefundValue ?? '?'} sats)`
            : '';
          results.push({ leafId, leafPath: '', utxoValue: 0, fee: 0, sendAmount: 0, txid: '', error: `No UTXOs found — tried: ${triedSummaries.join(', ')}.${refundHint}` });
          continue;
        }

        const leafPath = matched.candidate.derivationPath ?? '';
        const hashVariant = matched.candidate.variant;

        // Sweep each UTXO at the matched leaf address
        for (const utxo of matched.utxos) {
          const sweepRes = await fetch('/sweep', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              mnemonic: mnemonic.trim(),
              leafId,
              account,
              hashVariant,
              destinationAddress: destination.trim(),
              utxoTxid: utxo.txid,
              utxoVout: utxo.vout,
              utxoValue: utxo.value,
              feeRate,
              dryRun: false,
            }),
          });
          const sweepData = await sweepRes.json();

          if (sweepData.error) {
            results.push({ leafId, leafPath: sweepData.leafPath || leafPath, utxoValue: utxo.value, fee: 0, sendAmount: 0, txid: '', error: sweepData.error });
            continue;
          }

          // Broadcast
          const broadcastRes = await fetch('/mempool/api/tx', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: sweepData.txHex,
          });
          const broadcastText = await broadcastRes.text();

          if (broadcastRes.ok) {
            results.push({
              leafId,
              leafPath: sweepData.leafPath,
              utxoValue: sweepData.utxoValue,
              fee: sweepData.fee,
              sendAmount: sweepData.sendAmount,
              hashVariant: sweepData.hashVariant,
              address: matched.candidate.address,
              txid: broadcastText.trim(),
            });
          } else if (broadcastText.includes('-27')) {
            results.push({ leafId, leafPath: sweepData.leafPath, utxoValue: sweepData.utxoValue, fee: sweepData.fee, sendAmount: sweepData.sendAmount, hashVariant: sweepData.hashVariant, address: matched.candidate.address, txid: sweepData.txid, error: 'Already broadcast' });
          } else {
            results.push({ leafId, leafPath: sweepData.leafPath, utxoValue: utxo.value, fee: 0, sendAmount: 0, hashVariant: sweepData.hashVariant, address: matched.candidate.address, txid: '', error: broadcastText });
          }
        }
      } catch (e) {
        results.push({ leafId, leafPath: '', utxoValue: 0, fee: 0, sendAmount: 0, txid: '', error: e instanceof Error ? e.message : 'Unknown error' });
      }
    }

    setSweepResults(results);
    setStep('done');
    setLoading(false);
  };

  // Find and broadcast the matching refund tx variant for each leaf. Used
  // when we discover the leaf-node tx is on-chain but unspent — this kicks
  // off the actual refund broadcast (will fail with non-bip68-final if CSV
  // hasn't elapsed yet, which is fine — the user knows to wait).
  const broadcastMatchingRefunds = async () => {
    setRefundBroadcastLoading(true);
    const results: Array<{ leafId: string; field: string; txid: string; status: string }> = [];
    const savedState = JSON.parse(localStorage.getItem('unilateral-exit-state') ?? '{}');
    const serializedNodes = savedState.importedData?.serializedNodes ?? {};

    for (const leafId of leafIds) {
      try {
        const probeRes = await fetch('/leaf-coop-spend', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ leafId, serializedNodes }),
        });
        const probeData = await probeRes.json();
        if (!probeRes.ok || !Array.isArray(probeData.variants)) {
          results.push({ leafId, field: '', txid: '', status: `probe failed: ${probeData.error || 'unknown'}` });
          continue;
        }

        type ProbeVariant = {
          field: string;
          txid: string;
          txHex: string;
          version: number;
          inputs: Array<{ prevTxid: string; prevVout: number; nSequence: number }>;
          outputs: Array<{ value: number; scriptHex: string; scriptType: string }>;
        };

        // Try each leaf-node variant: find the one that's on-chain
        const candidateLeafTxids: Array<{ field: string; txid: string }> = probeData.variants
          .filter((v: ProbeVariant) => v.field === 'nodeTx' || v.field === 'directTx')
          .map((v: ProbeVariant) => ({ field: v.field, txid: v.txid }));

        let matchingRefund: ProbeVariant | null = null;
        for (const cand of candidateLeafTxids) {
          const txInfo = await fetchTxInfo(cand.txid);
          if (!txInfo?.vout) continue;
          const m = probeData.variants.find((v: ProbeVariant) =>
            (v.field === 'refundTx' || v.field === 'directRefundTx' || v.field === 'directFromCpfpRefundTx') &&
            v.inputs[0]?.prevTxid === cand.txid,
          );
          if (m) {
            matchingRefund = m as ProbeVariant;
            break;
          }
        }

        if (!matchingRefund) {
          results.push({ leafId, field: '', txid: '', status: 'no matching refund variant for any on-chain leaf-node tx' });
          continue;
        }

        // Try direct broadcast first
        const directRes = await fetch('/mempool/api/tx', {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: matchingRefund.txHex,
        });
        const directText = await directRes.text();

        if (directRes.ok) {
          results.push({ leafId, field: matchingRefund.field, txid: directText.trim(), status: 'broadcast OK' });
          continue;
        }
        if (directText.includes('non-bip68-final')) {
          results.push({ leafId, field: matchingRefund.field, txid: matchingRefund.txid, status: 'CSV not elapsed yet — wait and retry' });
          continue;
        }
        if (directText.includes('-27') || directText.includes('already')) {
          results.push({ leafId, field: matchingRefund.field, txid: matchingRefund.txid, status: 'already broadcast / in chain' });
          continue;
        }

        // Direct broadcast failed. Decide CPFP vs CSV-wait based on the tx
        // structure: TRUC v3 transactions have a 0-sat anchor output and need
        // CPFP; v2 transactions have built-in fees and just need CSV/policy.
        const hasAnchor = matchingRefund.outputs.some(o =>
          o.value === 0 && (o.scriptType === 'p2a-anchor' || o.scriptType === 'op_true' || o.scriptType === 'push_op_true'),
        );
        const isV3Truc = matchingRefund.version === 3;
        const inputSeq = matchingRefund.inputs[0]?.nSequence;
        // Detect CSV: nSequence with bit 31 unset and lower 16 bits = block count
        const csvBlocks = (inputSeq !== undefined && (inputSeq & 0x80000000) === 0) ? (inputSeq & 0xffff) : 0;
        const outputSummary = matchingRefund.outputs.map(o => `${o.value}sats(${o.scriptType})`).join(',');

        if (!hasAnchor && !isV3Truc) {
          // v2 standalone tx with built-in fees. Direct broadcast failed —
          // most likely CSV not elapsed (mempool stripped the message).
          results.push({
            leafId,
            field: matchingRefund.field,
            txid: matchingRefund.txid,
            status: `v${matchingRefund.version} standalone tx (CSV=${csvBlocks} blocks, outputs=[${outputSummary}]) — likely "CSV not elapsed". Wait for ${csvBlocks} blocks since the parent confirmed, then retry. Raw error: ${directText.slice(0, 100)}`,
          });
          continue;
        }

        // Has an anchor — try CPFP via submitpackage
        if (directText.includes('-26') || directText.includes('insufficient fee')) {
          const wallet = await loadWallet();
          if (!wallet) {
            results.push({ leafId, field: matchingRefund.field, txid: matchingRefund.txid, status: `needs CPFP but no wallet loaded (set one up in Wallet tab)` });
            continue;
          }
          // Use cached UTXOs (skip slow scantxoutset refresh)
          const utxos = wallet.utxos;
          if (!utxos || utxos.length === 0) {
            results.push({ leafId, field: matchingRefund.field, txid: matchingRefund.txid, status: 'needs CPFP but wallet has no cached UTXOs — click Refresh Balance on the Wallet tab first' });
            continue;
          }
          try {
            const anchorVout = findAnchorVout(matchingRefund.txHex);
            if (anchorVout === null) {
              results.push({ leafId, field: matchingRefund.field, txid: matchingRefund.txid, status: `outputs=[${outputSummary}] — has-anchor heuristic matched but findAnchorVout disagrees (script pattern mismatch)` });
              continue;
            }
            const parentVsize = getTxVsize(matchingRefund.txHex);
            const recommendedRate = await getFeeRate('/mempool');
            const feeRate = Math.max(recommendedRate, 1);
            const cpfpHex = buildCpfpTx({
              mnemonic: wallet.mnemonic,
              addressIndex: wallet.addressIndex,
              parentTxHex: matchingRefund.txHex,
              anchorVout,
              fundingUtxos: utxos,
              feeRate,
              parentVsize,
            });
            const pkgResult = await submitPackage(
              [matchingRefund.txHex, cpfpHex],
              '/rpc',
              process.env.NEXT_PUBLIC_RPC_USER ?? '',
              process.env.NEXT_PUBLIC_RPC_PASSWORD ?? '',
            );
            if (pkgResult.txids && pkgResult.txids.length > 0) {
              results.push({ leafId, field: matchingRefund.field, txid: pkgResult.txids[0], status: `broadcast via CPFP package OK${pkgResult.error ? ` (child note: ${pkgResult.error})` : ''}` });
            } else if (pkgResult.error?.includes('non-bip68-final')) {
              results.push({ leafId, field: matchingRefund.field, txid: matchingRefund.txid, status: `CSV not elapsed yet (${csvBlocks} blocks required) — wait and retry` });
            } else {
              results.push({ leafId, field: matchingRefund.field, txid: matchingRefund.txid, status: `submitpackage failed: ${pkgResult.error ?? 'unknown'}` });
            }
          } catch (e) {
            results.push({ leafId, field: matchingRefund.field, txid: matchingRefund.txid, status: `CPFP build failed: ${e instanceof Error ? e.message : 'unknown'}` });
          }
          continue;
        }

        results.push({ leafId, field: matchingRefund.field, txid: matchingRefund.txid, status: `failed (v${matchingRefund.version}, outputs=[${outputSummary}], CSV=${csvBlocks}): ${directText.slice(0, 200)}` });
      } catch (e) {
        results.push({ leafId, field: '', txid: '', status: `error: ${e instanceof Error ? e.message : 'unknown'}` });
      }
    }
    setRefundBroadcastResults(results);
    setRefundBroadcastLoading(false);
  };

  const reverseLookup = async () => {
    if (!mnemonic.trim() || !reverseAddress.trim()) return;
    setReverseLoading(true);
    setReverseResult(null);
    try {
      const savedState = JSON.parse(localStorage.getItem('unilateral-exit-state') ?? '{}');
      const importedData = savedState.importedData ?? {};
      const res = await fetch('/find-leaf-by-address', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mnemonic: mnemonic.trim(),
          targetAddress: reverseAddress.trim(),
          serializedNodes: importedData.serializedNodes ?? {},
          accounts: [0, 1, 2, 3],
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setReverseResult({ matches: [], leavesScanned: 0, accountsScanned: [], targetOutputKey: '', error: data.error || `HTTP ${res.status}` });
      } else {
        setReverseResult(data);
      }
    } catch (e) {
      setReverseResult({ matches: [], leavesScanned: 0, accountsScanned: [], targetOutputKey: '', error: e instanceof Error ? e.message : 'Unknown' });
    }
    setReverseLoading(false);
  };

  const diagnose = async () => {
    if (!mnemonic.trim()) return;
    setDiagnoseLoading(true);
    setDiagnoseResults([]);
    try {
      const savedState = JSON.parse(localStorage.getItem('unilateral-exit-state') ?? '{}');
      const importedData = savedState.importedData ?? {};
      const results: DiagnoseResult[] = [];
      for (const leafId of leafIds) {
        const res = await fetch('/diagnose-leaf', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mnemonic: mnemonic.trim(),
            leafId,
            account,
            serializedNodes: importedData.serializedNodes ?? {},
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          results.push({ leafId, analysis: `Error: ${data.error || res.status}`, refundTx: { outputs: [] }, candidates: [] });
        } else {
          results.push(data as DiagnoseResult);
        }
      }
      setDiagnoseResults(results);
    } catch (e) {
      alert(`Diagnose failed: ${e instanceof Error ? e.message : e}`);
    }
    setDiagnoseLoading(false);
  };

  return (
    <div className="mt-3 p-3 rounded-lg border border-amber-700/50 bg-amber-950/20">
      <h3 className="text-sm font-semibold text-amber-400 mb-2">Sweep Funds</h3>

      {phase === BroadcastPhase.ALREADY_EXITED && (
        <div className="mb-3 p-2 rounded border border-blue-700/50 bg-blue-950/30">
          <p className="text-[11px] text-blue-300 font-semibold mb-1">
            Tree was cooperatively closed
          </p>
          <p className="text-[10px] text-zinc-400 mb-1.5">
            Your refund tx was never broadcast — Spark spent the tree input directly
            to the same leaf p2tr address that the unilateral refund would have paid
            to (derivation <span className="font-mono">m/8797555&apos;/{`{account}`}&apos;/1&apos;/{`{leaf_child}`}&apos;</span>).
            Verify your mnemonic and click <strong>Sweep</strong> below — the panel
            will derive each leaf address and look up UTXOs there directly.
          </p>
          {coopExit && (
            <div className="text-[10px]">
              <p className="text-zinc-500">
                Spent input: <span className="font-mono">{coopExit.prevTxid.slice(0, 16)}...:{coopExit.prevVout}</span>
              </p>
              <p className="text-zinc-500 mt-0.5">
                Spending tx{coopExit.spendingBlockHeight ? ` (block ${coopExit.spendingBlockHeight})` : ''}:
              </p>
              <a
                href={`${MEMPOOL_EXPLORER}/tx/${coopExit.spendingTxid}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-blue-400 underline hover:text-blue-300 break-all"
              >
                {coopExit.spendingTxid}
              </a>

              {coopExitOutputs && coopExitOutputs.length > 0 && (
                <div className="mt-2 pt-2 border-t border-blue-900/50">
                  <p className="text-zinc-400 mb-1">Outputs of that tx:</p>
                  {coopExitOutputs.map(o => (
                    <div key={o.vout} className="mb-1">
                      <p className="text-zinc-500">
                        vout {o.vout} — <span className="text-amber-400">{o.value.toLocaleString()} sats</span>
                        {o.scriptType ? ` (${o.scriptType})` : ''}
                      </p>
                      {o.address ? (
                        <a
                          href={`${MEMPOOL_EXPLORER}/address/${o.address}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono text-blue-400 underline hover:text-blue-300 break-all"
                        >
                          {o.address}
                        </a>
                      ) : (
                        <p className="font-mono text-zinc-600 italic">no address (non-standard script)</p>
                      )}
                    </div>
                  ))}
                  <p className="text-[9px] text-zinc-500 mt-2 italic">
                    If any of these addresses is one you control, the funds are
                    already in that wallet. Import the same mnemonic into a
                    standard wallet (Sparrow / Electrum / BlueWallet, BIP84/BIP86)
                    if you don&apos;t recognize the address — it may be one of your
                    own L1 receive addresses derived from the same seed.
                  </p>
                </div>
              )}
              {coopExitOutputsError && (
                <p className="text-red-400 mt-1">{coopExitOutputsError}</p>
              )}
            </div>
          )}
        </div>
      )}

      {step === 'input' && (
        <>
          {mnemonicLoadedFromWallet ? (
            <div className="mb-2 p-2 rounded border border-zinc-700 bg-zinc-900/50 text-[11px] text-zinc-400">
              Using mnemonic from wallet section ({mnemonic.split(/\s+/).length} words).{' '}
              <button
                onClick={() => { setMnemonic(''); setMnemonicLoadedFromWallet(false); }}
                className="text-blue-400 hover:text-blue-300 underline"
              >
                use a different one
              </button>
            </div>
          ) : (
            <input
              type="password"
              placeholder="Spark wallet mnemonic"
              value={mnemonic}
              onChange={e => setMnemonic(e.target.value)}
              className="w-full p-2 rounded bg-zinc-800 border border-zinc-600 text-zinc-200 text-xs mb-2"
            />
          )}
          <button
            onClick={verify}
            disabled={loading || !mnemonic.trim()}
            className="w-full py-2 rounded bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold disabled:opacity-50"
          >
            {loading ? 'Verifying...' : 'Verify Mnemonic'}
          </button>
        </>
      )}

      {step === 'verified' && (
        <>
          {verifyDetails && (
            <div className="mb-2 p-2 rounded border border-green-700/50 bg-green-950/20 text-[10px] text-zinc-300">
              <p className="text-green-400 font-semibold mb-0.5">Derivation verified</p>
              <p className="font-mono break-all">Path: {verifyDetails.path}</p>
              <p className="font-mono break-all">Hash variant: {verifyDetails.hashVariant}</p>
              <p className="font-mono break-all text-zinc-500">Output key: {verifyDetails.outputKey}</p>
            </div>
          )}

          {/* Reverse-lookup tool: given a known leaf p2tr address, find which leafId derives to it */}
          <div className="mb-2 p-2 rounded border border-zinc-700 bg-zinc-900/40">
            <p className="text-[10px] text-zinc-400 mb-1">
              Reverse-lookup: paste a known leaf address you&apos;ve already swept to verify our derivation matches.
            </p>
            <input
              type="text"
              placeholder="bc1p..."
              value={reverseAddress}
              onChange={e => setReverseAddress(e.target.value)}
              className="w-full p-2 rounded bg-zinc-800 border border-zinc-600 text-zinc-200 text-[11px] mb-1 font-mono"
            />
            <button
              onClick={reverseLookup}
              disabled={reverseLoading || !reverseAddress.trim()}
              className="w-full py-1 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-200 text-[11px] font-semibold disabled:opacity-50"
            >
              {reverseLoading ? 'Scanning...' : 'Find matching leaf'}
            </button>
            {reverseResult && (
              <div className="mt-1.5 text-[10px]">
                {reverseResult.error && (
                  <p className="text-red-400">{reverseResult.error}</p>
                )}
                {!reverseResult.error && reverseResult.matches.length === 0 && (
                  <p className="text-amber-400">
                    No match found. Scanned {reverseResult.leavesScanned} leaves across accounts {reverseResult.accountsScanned.join(',')}.
                    Target output key: <span className="font-mono break-all">{reverseResult.targetOutputKey}</span>
                  </p>
                )}
                {reverseResult.matches.map((m, i) => (
                  <div key={`m-${i}`} className="mt-1 p-1.5 rounded bg-green-950/30 border border-green-700/50">
                    <p className="text-green-400 font-semibold">MATCH</p>
                    <p className="text-zinc-300 font-mono break-all">leaf: {m.leafId}</p>
                    <p className="text-zinc-300 font-mono break-all">{m.derivationPath}</p>
                    <p className="text-zinc-400">
                      account={m.account} variant={m.hashVariant} value={m.refundOutputValue.toLocaleString()} sats
                    </p>
                    <p className="text-zinc-500">
                      ownerSigningPubKey matches proto: {m.ownerSigningPubKeyMatchesProto ? 'yes' : 'no'}
                    </p>
                    <p className="text-zinc-500 font-mono break-all">refund txid: {m.refundTxid}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <input
            type="text"
            placeholder="Destination BTC address"
            value={destination}
            onChange={e => setDestination(e.target.value)}
            className="w-full p-2 rounded bg-zinc-800 border border-zinc-600 text-zinc-200 text-xs mb-2"
          />
          <div className="flex gap-2 mb-2">
            <div className="flex-1">
              <label className="text-[10px] text-zinc-500">Fee rate (sat/vB)</label>
              <input
                type="number"
                value={feeRate}
                onChange={e => setFeeRate(Number(e.target.value))}
                className="w-full p-2 rounded bg-zinc-800 border border-zinc-600 text-zinc-200 text-xs"
              />
            </div>
            <div className="flex-1">
              <label className="text-[10px] text-zinc-500">Account</label>
              <input
                type="number"
                value={account}
                onChange={e => setAccount(Number(e.target.value))}
                className="w-full p-2 rounded bg-zinc-800 border border-zinc-600 text-zinc-200 text-xs"
              />
            </div>
            <div className="flex-1">
              <label className="text-[10px] text-zinc-500">Leaves</label>
              <p className="p-2 text-xs text-zinc-300">{leafIds.length} leaf(s)</p>
            </div>
          </div>
          <button
            onClick={sweep}
            disabled={loading || !destination.trim()}
            className="w-full py-2 rounded bg-green-600 hover:bg-green-500 text-white text-xs font-semibold disabled:opacity-50"
          >
            {loading ? 'Sweeping...' : `Sweep ${leafIds.length} leaf(s) to destination`}
          </button>
          <button
            onClick={() => setStep('input')}
            className="w-full py-1 mt-1 text-[10px] text-zinc-500 hover:text-zinc-300"
          >
            Back
          </button>
        </>
      )}

      {step === 'done' && (
        <div>
          {sweepResults.map((r, i) => (
            <div key={`${r.leafId}-${i}`} className="py-1.5 border-b border-zinc-800">
              <p className="text-[11px] text-zinc-400 font-mono break-all">Leaf {r.leafId}</p>
              {r.leafPath && (
                <p className="text-[10px] text-zinc-600 font-mono break-all">{r.leafPath}{r.hashVariant ? ` (${r.hashVariant})` : ''}</p>
              )}
              {r.address && (
                <a
                  href={`${MEMPOOL_EXPLORER}/address/${r.address}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] font-mono text-zinc-500 hover:text-zinc-300 break-all block"
                >
                  src: {r.address}
                </a>
              )}
              {r.error ? (
                <p className="text-[11px] text-red-400 break-all">{r.error}</p>
              ) : (
                <>
                  <p className="text-[11px] text-green-400">
                    Sent {r.sendAmount.toLocaleString()} sats (fee: {r.fee})
                  </p>
                  <a
                    href={`${MEMPOOL_EXPLORER}/tx/${r.txid}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] font-mono text-blue-500 underline hover:text-blue-400"
                  >
                    {r.txid.slice(0, 20)}...
                  </a>
                </>
              )}
            </div>
          ))}
          {sweepResults.length === 0 && (
            <p className="text-[11px] text-zinc-500 italic">No UTXOs found at any candidate leaf address.</p>
          )}

          {sweepResults.some(r => r.error?.startsWith('No UTXOs')) || sweepResults.length === 0 ? (
            <div className="mt-3 pt-2 border-t border-zinc-800">
              <p className="text-[10px] text-zinc-500 mb-1.5">
                If no UTXOs were found, the leaf-node tx may be on-chain but its
                refund tx hasn&apos;t been broadcast yet. Click below to find the
                matching refund tx variant from the protobuf and broadcast it.
                (Will fail with &quot;CSV not elapsed&quot; if you need to wait longer.)
              </p>
              <button
                onClick={broadcastMatchingRefunds}
                disabled={refundBroadcastLoading}
                className="w-full py-1.5 rounded bg-amber-700 hover:bg-amber-600 text-zinc-100 text-[11px] font-semibold disabled:opacity-50 mb-2"
              >
                {refundBroadcastLoading ? 'Broadcasting refunds...' : 'Broadcast matching refund tx for each leaf'}
              </button>
              {refundBroadcastResults.length > 0 && (
                <div className="mb-2">
                  {refundBroadcastResults.map((r, i) => (
                    <div key={`rbr-${i}`} className="text-[10px] text-zinc-300 py-1 border-b border-zinc-800">
                      <p className="font-mono break-all">leaf {r.leafId.slice(0, 16)}...</p>
                      {r.field && <p className="text-zinc-500">variant: {r.field}</p>}
                      {r.txid && (
                        <a
                          href={`${MEMPOOL_EXPLORER}/tx/${r.txid}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono text-blue-400 underline hover:text-blue-300 break-all"
                        >
                          {r.txid}
                        </a>
                      )}
                      <p className={r.status.includes('OK') || r.status.includes('already') ? 'text-green-400' : r.status.includes('CSV') ? 'text-amber-400' : 'text-red-400'}>
                        {r.status}
                      </p>
                    </div>
                  ))}
                </div>
              )}
              <button
                onClick={diagnose}
                disabled={diagnoseLoading}
                className="w-full py-1.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-200 text-[11px] font-semibold disabled:opacity-50"
              >
                {diagnoseLoading ? 'Diagnosing...' : 'Diagnose addresses vs refund tx outputs'}
              </button>
            </div>
          ) : null}

          {diagnoseResults.map((d, i) => (
            <div key={`diag-${i}`} className="mt-2 p-2 rounded border border-zinc-700 bg-zinc-900/40">
              <p className="text-[11px] font-mono text-zinc-400 break-all">Leaf {d.leafId}</p>
              <p className="text-[11px] text-amber-400 mt-1">{d.analysis}</p>
              {d.refundTx.outputs.length > 0 && (
                <div className="mt-1.5">
                  <p className="text-[10px] text-zinc-500 mb-0.5">Refund tx outputs:</p>
                  {d.refundTx.outputs.map(o => (
                    <div key={o.vout} className="text-[10px] text-zinc-400 ml-1">
                      vout {o.vout} - {o.value.toLocaleString()} sats - {o.scriptType}
                      {o.address && (
                        <a
                          href={`${MEMPOOL_EXPLORER}/address/${o.address}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block font-mono text-blue-400 underline hover:text-blue-300 break-all"
                        >
                          {o.address}
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {d.candidates.length > 0 && (
                <div className="mt-1.5">
                  <p className="text-[10px] text-zinc-500 mb-0.5">Derived candidates:</p>
                  {d.candidates.map((c, j) => (
                    <div key={`c-${j}`} className="text-[10px] text-zinc-400 ml-1">
                      <span className={c.matchesRefundOutput0 ? 'text-green-400' : ''}>
                        {c.variant} {c.matchesRefundOutput0 ? '✓ MATCH' : ''}
                      </span>
                      {c.derivedAddress && (
                        <span className="block font-mono text-zinc-600 break-all">{c.derivedAddress}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}

          <button
            onClick={() => { setStep('input'); setSweepResults([]); setDiagnoseResults([]); }}
            className="w-full py-1 mt-2 text-[10px] text-zinc-500 hover:text-zinc-300"
          >
            Done
          </button>
        </div>
      )}

      {verifyResult && step !== 'done' && (
        <p className={`text-[11px] mt-2 ${verifyResult.startsWith('Verified') ? 'text-green-400' : 'text-red-400'}`}>
          {verifyResult}
        </p>
      )}
    </div>
  );
}
