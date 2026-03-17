'use client';

import type { BroadcastTree } from '@/lib/types';

interface TreeCardProps {
  tree: BroadcastTree;
  index: number;
}

export function TreeCard({ tree, index }: TreeCardProps) {
  const intermediateCount = tree.steps.filter(s => s.type === 'intermediate').length;
  const leafCount = tree.leaves.length;

  return (
    <div className="p-3 rounded-lg border border-zinc-700 mb-2">
      <div className="flex justify-between items-center">
        <span className="font-semibold text-zinc-200">Tree {index + 1}</span>
        <span className="text-base font-bold text-orange-500">
          {tree.totalValue.toLocaleString()} sats
        </span>
      </div>
      <p className="text-xs text-zinc-400 mt-1">
        {leafCount} {leafCount === 1 ? 'leaf' : 'leaves'} &middot; {intermediateCount} intermediates &middot; {tree.steps.length} steps
      </p>
      <p className="text-[10px] text-zinc-600 mt-1 font-mono break-all">
        {tree.treeId}
      </p>
    </div>
  );
}
