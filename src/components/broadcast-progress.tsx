'use client';

import { useState, useEffect } from 'react';
import { StatusBadge } from '@/components/status-badge';
import { LeafRow } from '@/components/leaf-row';
import { SweepPanel } from '@/components/sweep-panel';
import { determinePhase } from '@/lib/broadcaster';
import type { BroadcastTree } from '@/lib/types';
import { StepStatus, BroadcastPhase } from '@/lib/types';
import { useExit } from '@/context/ExitContext';
import { TreeNodeCodec } from '@/lib/proto/tree-node';
import { hexToBytes, bytesToHex } from '@/lib/hex-utils';
import { computeTxid } from '@/lib/tx-parser';

const PUBLIC_MEMPOOL_API = 'https://mempool.space/api';

async function fetchTxInfoSafe(txid: string): Promise<{
  vout: Array<{ value: number; scriptpubkey_address?: string; scriptpubkey_type?: string }>;
  vin?: Array<{ txid: string; vout: number; prevout?: { value: number; scriptpubkey_address?: string } }>;
  status?: { confirmed?: boolean; block_height?: number };
} | null> {
  for (const url of [`/mempool/api/tx/${txid}`, `${PUBLIC_MEMPOOL_API}/tx/${txid}`]) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch { /* try next */ }
  }
  return null;
}

async function fetchOutspendSafe(txid: string, vout: number): Promise<{ spent: boolean; txid?: string } | null> {
  for (const url of [`/mempool/api/tx/${txid}/outspend/${vout}`, `${PUBLIC_MEMPOOL_API}/tx/${txid}/outspend/${vout}`]) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch { /* try next */ }
  }
  return null;
}

type LeafActualStatus =
  | { kind: 'loading' }
  | { kind: 'leaf-not-onchain'; leafNodeTxid: string }
  | { kind: 'leaf-pending-csv'; leafNodeTxid: string; csvBlocks: number }
  | { kind: 'unilateral-refund-unspent'; refundField: string; refundTxid: string; address?: string; value: number }
  | { kind: 'unilateral-refund-swept'; refundField: string; refundTxid: string; sweptByTxid: string }
  | { kind: 'coop-closed'; spendingTxid: string; outputs: Array<{ vout: number; value: number; address?: string }>; inputs: Array<{ txid: string; vout: number }>; blockHeight?: number }
  | { kind: 'error'; reason: string };

interface BroadcastProgressProps {
  tree: BroadcastTree;
  index: number;
}

export function BroadcastProgress({ tree, index }: BroadcastProgressProps) {
  const { state, retryStep, bumpFee } = useExit();
  const [expanded, setExpanded] = useState(false);
  // For each leaf, compute the txids of all 3 refund variants from the
  // protobuf so the user can see and click each one (only one of them is
  // actually on-chain, depending on which leaf-node variant was broadcast).
  const [refundVariantsByLeaf, setRefundVariantsByLeaf] = useState<Record<string, Array<{ field: string; txid: string }>>>({});
  const [actualStatusByLeaf, setActualStatusByLeaf] = useState<Record<string, LeafActualStatus>>({});

  useEffect(() => {
    if (!expanded) return;
    const serializedNodes = state.importedData?.serializedNodes;
    if (!serializedNodes) return;
    let cancelled = false;
    (async () => {
      const variantsMap: Record<string, Array<{ field: string; txid: string }>> = {};
      const statusMap: Record<string, LeafActualStatus> = {};
      for (const leaf of tree.leaves) {
        statusMap[leaf.leafId] = { kind: 'loading' };
      }
      if (!cancelled) setActualStatusByLeaf({ ...statusMap });

      for (const leaf of tree.leaves) {
        const hex = serializedNodes[leaf.leafId];
        if (!hex) {
          statusMap[leaf.leafId] = { kind: 'error', reason: 'no protobuf data' };
          continue;
        }
        try {
          const node = TreeNodeCodec.decode(hexToBytes(hex));

          // Compute txids for all relevant variants
          const allVariants: Array<{ field: string; txHex: string; txid: string }> = [];
          for (const f of [
            { field: 'nodeTx', bytes: node.nodeTx },
            { field: 'refundTx', bytes: node.refundTx },
            { field: 'directTx', bytes: node.directTx },
            { field: 'directRefundTx', bytes: node.directRefundTx },
            { field: 'directFromCpfpRefundTx', bytes: node.directFromCpfpRefundTx },
          ]) {
            if (!f.bytes || f.bytes.length === 0) continue;
            try {
              const txHex = bytesToHex(f.bytes);
              const txid = await computeTxid(txHex);
              allVariants.push({ field: f.field, txHex, txid });
            } catch { /* skip */ }
          }

          // Display variants for the refund row
          variantsMap[leaf.leafId] = allVariants
            .filter(v => v.field === 'refundTx' || v.field === 'directRefundTx' || v.field === 'directFromCpfpRefundTx')
            .map(v => ({ field: v.field, txid: v.txid }));

          // Probe: which leaf-node variant is actually on-chain?
          const leafNodeCandidates = allVariants.filter(v => v.field === 'nodeTx' || v.field === 'directTx');
          // Also include broadcast state's leaf-node txid
          const broadcastLeafTxid = state.stepTxids[`${leaf.leafId}-leaf-node`];
          const candidateTxids = new Set<string>(leafNodeCandidates.map(v => v.txid));
          if (broadcastLeafTxid) candidateTxids.add(broadcastLeafTxid);

          let onChainLeafTxid: string | null = null;
          for (const cand of candidateTxids) {
            const info = await fetchTxInfoSafe(cand);
            if (info?.vout) { onChainLeafTxid = cand; break; }
          }
          if (!onChainLeafTxid) {
            statusMap[leaf.leafId] = { kind: 'leaf-not-onchain', leafNodeTxid: [...candidateTxids][0] ?? '?' };
            if (!cancelled) setActualStatusByLeaf({ ...statusMap });
            continue;
          }

          // Check if leaf-node:0 is spent
          const outspend = await fetchOutspendSafe(onChainLeafTxid, 0);
          if (!outspend?.spent || !outspend.txid) {
            // Still locked. Estimate CSV from the matching refund's nSequence
            const refundStep = tree.steps.find(s => s.type === 'leaf-refund' && s.nodeId === leaf.leafId);
            const csv = refundStep?.csvBlocks ?? 0;
            statusMap[leaf.leafId] = { kind: 'leaf-pending-csv', leafNodeTxid: onChainLeafTxid, csvBlocks: csv };
            if (!cancelled) setActualStatusByLeaf({ ...statusMap });
            continue;
          }

          // Something spent it. Match against our refund variants
          const spendingTxid = outspend.txid;
          const matchingRefundVariant = allVariants.find(v =>
            (v.field === 'refundTx' || v.field === 'directRefundTx' || v.field === 'directFromCpfpRefundTx') &&
            v.txid === spendingTxid,
          );

          const spendingTx = await fetchTxInfoSafe(spendingTxid);
          const outputs = spendingTx?.vout?.map((o, i) => ({
            vout: i,
            value: o.value,
            address: o.scriptpubkey_address,
          })) ?? [];

          if (matchingRefundVariant) {
            // Unilateral exit completed. Check if vout 0 is still unspent
            const refundOut0Spend = await fetchOutspendSafe(spendingTxid, 0);
            if (refundOut0Spend?.spent && refundOut0Spend.txid) {
              statusMap[leaf.leafId] = {
                kind: 'unilateral-refund-swept',
                refundField: matchingRefundVariant.field,
                refundTxid: spendingTxid,
                sweptByTxid: refundOut0Spend.txid,
              };
            } else {
              statusMap[leaf.leafId] = {
                kind: 'unilateral-refund-unspent',
                refundField: matchingRefundVariant.field,
                refundTxid: spendingTxid,
                address: outputs[0]?.address,
                value: outputs[0]?.value ?? 0,
              };
            }
          } else {
            // Spent by something not in our variants
            statusMap[leaf.leafId] = {
              kind: 'coop-closed',
              spendingTxid,
              outputs,
              inputs: spendingTx?.vin?.map(i => ({ txid: i.txid, vout: i.vout })) ?? [],
              blockHeight: spendingTx?.status?.block_height,
            };
          }
          if (!cancelled) setActualStatusByLeaf({ ...statusMap });
        } catch (e) {
          statusMap[leaf.leafId] = { kind: 'error', reason: e instanceof Error ? e.message : 'unknown' };
        }
      }
      if (!cancelled) {
        setRefundVariantsByLeaf(variantsMap);
        setActualStatusByLeaf({ ...statusMap });
      }
    })();
    return () => { cancelled = true; };
  }, [expanded, tree.leaves, tree.steps, state.importedData?.serializedNodes, state.stepTxids]);

  const phase = state.treePhases[tree.treeId] === BroadcastPhase.ALREADY_EXITED
    ? BroadcastPhase.ALREADY_EXITED
    : determinePhase(tree, state.stepStatuses);

  const confirmedSteps = tree.steps.filter(
    s => state.stepStatuses[s.id] === StepStatus.CONFIRMED,
  ).length;

  const failedSteps = tree.steps.filter(
    s => state.stepStatuses[s.id] === StepStatus.FAILED,
  );

  let statusMessage = '';
  switch (phase) {
    case BroadcastPhase.INTERMEDIATES: {
      const intermediates = tree.steps.filter(s => s.type === 'intermediate');
      const broadcastCount = intermediates.filter(
        s => state.stepStatuses[s.id] === StepStatus.CONFIRMED || state.stepStatuses[s.id] === StepStatus.BROADCAST,
      ).length;
      statusMessage = `Broadcasting ${broadcastCount}/${intermediates.length} intermediate nodes`;
      break;
    }
    case BroadcastPhase.WAITING_LEAF_CSV: {
      const leafNodes = tree.steps.filter(s => s.type === 'leaf-node');
      const targets = leafNodes.map(s => state.csvTargetHeights[s.id]).filter(Boolean);
      const maxTarget = Math.max(...targets, 0);
      const remaining = Math.max(0, maxTarget - state.currentBlockHeight);
      statusMessage = `Waiting for block ${maxTarget.toLocaleString()} (${remaining.toLocaleString()} blocks, ~${(remaining * 10 / 60 / 24).toFixed(1)} days)`;
      break;
    }
    case BroadcastPhase.LEAF_NODE:
      statusMessage = 'Broadcasting leaf transaction';
      break;
    case BroadcastPhase.WAITING_REFUND_CSV: {
      const refunds = tree.steps.filter(s => s.type === 'leaf-refund');
      const targets = refunds.map(s => state.csvTargetHeights[s.id]).filter(Boolean);
      const maxTarget = Math.max(...targets, 0);
      const remaining = Math.max(0, maxTarget - state.currentBlockHeight);
      statusMessage = `Waiting for block ${maxTarget.toLocaleString()} (${remaining.toLocaleString()} blocks, ~${(remaining * 10 / 60 / 24).toFixed(1)} days)`;
      break;
    }
    case BroadcastPhase.LEAF_REFUND:
      statusMessage = 'Broadcasting refund transaction';
      break;
    case BroadcastPhase.COMPLETE:
      statusMessage = 'Funds recovered!';
      break;
    case BroadcastPhase.ALREADY_EXITED:
      statusMessage = 'Tree already exited (cooperative)';
      break;
  }

  return (
    <div className="p-3 rounded-lg border border-zinc-700 mb-2.5">
      <button className="w-full text-left" onClick={() => setExpanded(!expanded)}>
        <div className="flex justify-between items-center">
          <div>
            <span className="font-semibold text-zinc-200">Tree {index + 1}</span>
            <p className="text-sm font-bold text-orange-500">{tree.totalValue.toLocaleString()} sats</p>
          </div>
          <StatusBadge status={phase} />
        </div>

        <div className="h-1 bg-zinc-700 rounded mt-2 overflow-hidden">
          <div
            className="h-full bg-green-500 rounded transition-all"
            style={{ width: `${(confirmedSteps / tree.steps.length) * 100}%` }}
          />
        </div>

        <p className="text-xs text-zinc-400 mt-1.5">{statusMessage}</p>
        <p className="text-[11px] text-zinc-600 mt-0.5">
          {confirmedSteps}/{tree.steps.length} steps confirmed
        </p>
      </button>

      {expanded && Object.keys(actualStatusByLeaf).length > 0 && (
        <div className="mt-2 p-2 rounded border border-zinc-700 bg-zinc-900/40">
          <p className="text-[10px] text-zinc-500 font-semibold mb-1">ACTUAL ON-CHAIN STATUS</p>
          {tree.leaves.map(leaf => {
            const st = actualStatusByLeaf[leaf.leafId];
            if (!st) return null;
            return (
              <div key={`status-${leaf.leafId}`} className="text-[10px] mb-1">
                <p className="font-mono text-zinc-500 break-all">leaf {leaf.leafId.slice(0, 16)}... ({leaf.value.toLocaleString()} sats)</p>
                {st.kind === 'loading' && <p className="text-zinc-400">probing chain...</p>}
                {st.kind === 'leaf-not-onchain' && (
                  <p className="text-amber-400">⚠ Leaf-node tx not on-chain ({st.leafNodeTxid.slice(0, 12)}...)</p>
                )}
                {st.kind === 'leaf-pending-csv' && (
                  <p className="text-blue-400">
                    ⏳ Unilateral exit in progress. Leaf-node {st.leafNodeTxid.slice(0, 12)}... is on-chain. Refund tx is locked behind {st.csvBlocks}-block CSV — broadcast it after the timer elapses.
                  </p>
                )}
                {st.kind === 'unilateral-refund-unspent' && (
                  <p className="text-green-400">
                    ✓ Unilateral exit complete via {st.refundField} ({st.refundTxid.slice(0, 12)}...).
                    {' '}Funds ready to sweep: {st.value.toLocaleString()} sats at{' '}
                    <span className="font-mono text-zinc-300 break-all">{st.address}</span>
                  </p>
                )}
                {st.kind === 'unilateral-refund-swept' && (
                  <p className="text-green-400">
                    ✓ Already swept. Refund {st.refundField} ({st.refundTxid.slice(0, 12)}...) was spent by {st.sweptByTxid.slice(0, 12)}...
                  </p>
                )}
                {st.kind === 'coop-closed' && (
                  <div className="text-orange-400">
                    <p>
                      ⚠ Spent by an unknown tx (not any of our protobuf variants):{' '}
                      <a
                        href={`https://mempool.space/tx/${st.spendingTxid}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-blue-400 underline hover:text-blue-300"
                      >
                        {st.spendingTxid}
                      </a>
                      {st.blockHeight && <span className="text-zinc-500"> (block {st.blockHeight})</span>}
                    </p>
                    <p className="text-zinc-500 mt-1">Inputs:</p>
                    {st.inputs.map((inp, i) => (
                      <p key={`i-${i}`} className="font-mono text-zinc-400 break-all ml-2">
                        in{i}: {inp.txid.slice(0, 24)}...:{inp.vout}
                      </p>
                    ))}
                    <p className="text-zinc-500 mt-1">Outputs:</p>
                    {st.outputs.map(o => (
                      <p key={`o-${o.vout}`} className="font-mono text-zinc-400 break-all ml-2">
                        vout{o.vout}={o.value.toLocaleString()}sats {o.address ? `→ ${o.address}` : '(non-standard)'}
                      </p>
                    ))}
                    <p className="text-zinc-500 mt-1 text-[9px] italic">
                      If you didn&apos;t do anything cooperative with Spark, this tx may have been broadcast
                      by an earlier session of this app or a console action. Click the txid to see full
                      details on the explorer.
                    </p>
                  </div>
                )}
                {st.kind === 'error' && (
                  <p className="text-red-400">error: {st.reason}</p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {expanded && (
        <div className="mt-2 border-t border-zinc-700 pt-1">
          {tree.steps.map(step => {
            const stepStatus = state.stepStatuses[step.id] ?? StepStatus.PENDING;
            const isRefund = step.type === 'leaf-refund';
            const refundVariants = isRefund ? refundVariantsByLeaf[step.nodeId] : undefined;
            return (
              <div key={step.id}>
                <button
                  className="w-full text-left"
                  onClick={() => {
                    if (stepStatus === StepStatus.FAILED) {
                      retryStep(step.id);
                    }
                  }}
                >
                  <LeafRow
                    step={step}
                    status={stepStatus}
                    txid={state.stepTxids[step.id]}
                    error={state.stepErrors[step.id]}
                    csvTarget={state.csvTargetHeights[step.id]}
                    currentHeight={state.currentBlockHeight}
                    refundVariants={refundVariants}
                  />
                </button>
                {stepStatus === StepStatus.BROADCAST && (
                  <button
                    className="text-[11px] text-amber-500 hover:text-amber-400 ml-1 mb-1"
                    onClick={() => bumpFee(step.id)}
                  >
                    Bump Fee (CPFP)
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {failedSteps.length > 0 && !expanded && (
        <p className="text-[11px] text-red-500 mt-1.5">
          {failedSteps.length} failed step{failedSteps.length > 1 ? 's' : ''} - click to expand
        </p>
      )}

      {(phase === BroadcastPhase.COMPLETE || phase === BroadcastPhase.ALREADY_EXITED) && (
        <SweepPanel tree={tree} />
      )}
    </div>
  );
}
