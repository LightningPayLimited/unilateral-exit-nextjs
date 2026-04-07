'use client';

import { useEffect, useState } from 'react';
import { StatusBadge } from '@/components/status-badge';
import type { BroadcastStep } from '@/lib/types';
import { StepStatus } from '@/lib/types';
import { computeTxidFromHex } from '@/lib/wallet';

const MEMPOOL_URL = process.env.NEXT_PUBLIC_MEMPOOL_EXPLORER ?? 'https://mempool.space';

interface LeafRowProps {
  step: BroadcastStep;
  status: StepStatus;
  txid?: string;
  error?: string;
  csvTarget?: number;
  currentHeight?: number;
  refundVariants?: Array<{ field: string; txid: string }>;
}

export function LeafRow({ step, status, txid, error, csvTarget, currentHeight, refundVariants }: LeafRowProps) {
  const typeLabel = step.type === 'intermediate'
    ? `Node ${step.depth}`
    : step.type === 'leaf-node'
    ? 'Leaf Tx'
    : 'Refund Tx';

  // If broadcast state has no txid, compute it offline from the pre-signed
  // tx hex so we can still link to the tx on the explorer.
  const [computedTxid, setComputedTxid] = useState<string | null>(null);
  useEffect(() => {
    if (txid || !step.txHex) {
      setComputedTxid(null);
      return;
    }
    try {
      setComputedTxid(computeTxidFromHex(step.txHex));
    } catch {
      setComputedTxid(null);
    }
  }, [txid, step.txHex]);

  const displayTxid = txid ?? computedTxid ?? undefined;
  const fromBroadcast = !!txid;
  const blocksRemaining = csvTarget && currentHeight ? Math.max(0, csvTarget - currentHeight) : null;
  const canOpenTx = !!displayTxid && (status === StepStatus.BROADCAST || status === StepStatus.CONFIRMED);

  return (
    <div className="flex justify-between items-center py-1.5 px-1 border-b border-zinc-800">
      <div className="flex-1 mr-2">
        <span className="text-[13px] font-semibold text-zinc-200">{typeLabel}</span>
        {step.csvBlocks > 0 && (
          <p className="text-[11px] text-zinc-500">CSV: {step.csvBlocks} blocks</p>
        )}
        {displayTxid && (
          canOpenTx ? (
            <a
              href={`${MEMPOOL_URL}/tx/${displayTxid}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] font-mono text-blue-500 underline hover:text-blue-400 block"
              title={fromBroadcast ? 'broadcast txid' : 'computed from pre-signed hex (may not be on-chain)'}
            >
              {displayTxid.slice(0, 16)}...{!fromBroadcast && ' (computed)'}
            </a>
          ) : (
            <p className="text-[10px] font-mono text-zinc-600">{displayTxid.slice(0, 16)}...{!fromBroadcast && ' (computed)'}</p>
          )
        )}
        {error && <p className="text-[11px] text-red-500">{error}</p>}
        {blocksRemaining !== null && blocksRemaining > 0 && (
          <p className="text-[11px] text-zinc-500">
            {blocksRemaining} blocks remaining (~{(blocksRemaining * 10 / 60 / 24).toFixed(1)} days)
          </p>
        )}
        {/* For refund steps, show all 3 protobuf variants - only one will be on-chain */}
        {step.type === 'leaf-refund' && refundVariants && refundVariants.length > 0 && (
          <div className="mt-1">
            <p className="text-[10px] text-zinc-500">Refund variants from protobuf:</p>
            {refundVariants.map(v => (
              <a
                key={v.field}
                href={`${MEMPOOL_URL}/tx/${v.txid}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] font-mono text-blue-500 underline hover:text-blue-400 block break-all"
                title={`computed from protobuf field ${v.field}`}
              >
                {v.field}: {v.txid.slice(0, 16)}...
              </a>
            ))}
          </div>
        )}
      </div>
      {canOpenTx ? (
        <a href={`${MEMPOOL_URL}/tx/${displayTxid}`} target="_blank" rel="noopener noreferrer">
          <StatusBadge status={status} small />
        </a>
      ) : (
        <StatusBadge status={status} small />
      )}
    </div>
  );
}
