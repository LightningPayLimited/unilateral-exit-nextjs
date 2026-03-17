'use client';

import { useState } from 'react';
import { StatusBadge } from '@/components/status-badge';
import { LeafRow } from '@/components/leaf-row';
import { determinePhase } from '@/lib/broadcaster';
import type { BroadcastTree } from '@/lib/types';
import { StepStatus, BroadcastPhase } from '@/lib/types';
import { useExit } from '@/context/ExitContext';

interface BroadcastProgressProps {
  tree: BroadcastTree;
  index: number;
}

export function BroadcastProgress({ tree, index }: BroadcastProgressProps) {
  const { state, retryStep } = useExit();
  const [expanded, setExpanded] = useState(false);

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

      {expanded && (
        <div className="mt-2 border-t border-zinc-700 pt-1">
          {tree.steps.map(step => (
            <button
              key={step.id}
              className="w-full text-left"
              onClick={() => {
                if (state.stepStatuses[step.id] === StepStatus.FAILED) {
                  retryStep(step.id);
                }
              }}
            >
              <LeafRow
                step={step}
                status={state.stepStatuses[step.id] ?? StepStatus.PENDING}
                txid={state.stepTxids[step.id]}
                error={state.stepErrors[step.id]}
                csvTarget={state.csvTargetHeights[step.id]}
                currentHeight={state.currentBlockHeight}
              />
            </button>
          ))}
        </div>
      )}

      {failedSteps.length > 0 && !expanded && (
        <p className="text-[11px] text-red-500 mt-1.5">
          {failedSteps.length} failed step{failedSteps.length > 1 ? 's' : ''} - click to expand
        </p>
      )}
    </div>
  );
}
