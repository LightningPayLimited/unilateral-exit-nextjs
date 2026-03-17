'use client';

import { StatusBadge } from '@/components/status-badge';
import type { BroadcastStep } from '@/lib/types';
import { StepStatus } from '@/lib/types';

const MEMPOOL_URL = process.env.NEXT_PUBLIC_MEMPOOL_HOST ?? 'http://127.0.0.1:3006';

interface LeafRowProps {
  step: BroadcastStep;
  status: StepStatus;
  txid?: string;
  error?: string;
  csvTarget?: number;
  currentHeight?: number;
}

export function LeafRow({ step, status, txid, error, csvTarget, currentHeight }: LeafRowProps) {
  const typeLabel = step.type === 'intermediate'
    ? `Node ${step.depth}`
    : step.type === 'leaf-node'
    ? 'Leaf Tx'
    : 'Refund Tx';

  const blocksRemaining = csvTarget && currentHeight ? Math.max(0, csvTarget - currentHeight) : null;
  const canOpenTx = txid && (status === StepStatus.BROADCAST || status === StepStatus.CONFIRMED);

  return (
    <div className="flex justify-between items-center py-1.5 px-1 border-b border-zinc-800">
      <div className="flex-1 mr-2">
        <span className="text-[13px] font-semibold text-zinc-200">{typeLabel}</span>
        {step.csvBlocks > 0 && (
          <p className="text-[11px] text-zinc-500">CSV: {step.csvBlocks} blocks</p>
        )}
        {txid && (
          canOpenTx ? (
            <a
              href={`${MEMPOOL_URL}/tx/${txid}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] font-mono text-blue-500 underline hover:text-blue-400 block"
            >
              {txid.slice(0, 16)}...
            </a>
          ) : (
            <p className="text-[10px] font-mono text-zinc-600">{txid.slice(0, 16)}...</p>
          )
        )}
        {error && <p className="text-[11px] text-red-500">{error}</p>}
        {blocksRemaining !== null && blocksRemaining > 0 && (
          <p className="text-[11px] text-zinc-500">
            {blocksRemaining} blocks remaining (~{(blocksRemaining * 10 / 60 / 24).toFixed(1)} days)
          </p>
        )}
      </div>
      {canOpenTx ? (
        <a href={`${MEMPOOL_URL}/tx/${txid}`} target="_blank" rel="noopener noreferrer">
          <StatusBadge status={status} small />
        </a>
      ) : (
        <StatusBadge status={status} small />
      )}
    </div>
  );
}
