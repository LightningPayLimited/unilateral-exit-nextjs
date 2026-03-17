'use client';

import { StepStatus, BroadcastPhase } from '@/lib/types';

interface StatusBadgeProps {
  status: StepStatus | BroadcastPhase;
  small?: boolean;
}

const LABELS: Record<string, string> = {
  [StepStatus.PENDING]: 'Pending',
  [StepStatus.BROADCASTING]: 'Broadcasting...',
  [StepStatus.BROADCAST]: 'In Mempool',
  [StepStatus.CONFIRMED]: 'Confirmed',
  [StepStatus.WAITING_CSV]: 'Waiting CSV',
  [StepStatus.FAILED]: 'Failed',
  [BroadcastPhase.INTERMEDIATES]: 'Intermediates',
  [BroadcastPhase.WAITING_LEAF_CSV]: 'Waiting CSV',
  [BroadcastPhase.LEAF_NODE]: 'Leaf Tx',
  [BroadcastPhase.WAITING_REFUND_CSV]: 'Waiting CSV',
  [BroadcastPhase.LEAF_REFUND]: 'Refund Tx',
  [BroadcastPhase.COMPLETE]: 'Complete',
  [BroadcastPhase.ALREADY_EXITED]: 'Already Exited',
};

function getColorClasses(status: string): string {
  switch (status) {
    case StepStatus.CONFIRMED:
    case BroadcastPhase.COMPLETE:
    case BroadcastPhase.ALREADY_EXITED:
      return 'bg-green-500/15 border-green-500 text-green-500';
    case StepStatus.BROADCASTING:
    case StepStatus.BROADCAST:
    case BroadcastPhase.INTERMEDIATES:
    case BroadcastPhase.LEAF_NODE:
    case BroadcastPhase.LEAF_REFUND:
      return 'bg-amber-500/15 border-amber-500 text-amber-500';
    case StepStatus.WAITING_CSV:
    case BroadcastPhase.WAITING_LEAF_CSV:
    case BroadcastPhase.WAITING_REFUND_CSV:
      return 'bg-blue-500/15 border-blue-500 text-blue-500';
    case StepStatus.FAILED:
      return 'bg-red-500/15 border-red-500 text-red-500';
    default:
      return 'bg-zinc-500/15 border-zinc-500 text-zinc-500';
  }
}

export function StatusBadge({ status, small }: StatusBadgeProps) {
  const colorClasses = getColorClasses(status);
  return (
    <span
      className={`inline-block border rounded font-semibold ${colorClasses} ${
        small ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-xs'
      }`}
    >
      {LABELS[status] ?? status}
    </span>
  );
}
