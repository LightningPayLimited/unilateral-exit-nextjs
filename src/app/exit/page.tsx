'use client';

import { useEffect, useRef, useState } from 'react';
import { BroadcastProgress } from '@/components/broadcast-progress';
import { useExit } from '@/context/ExitContext';
import { BroadcastPhase, StepStatus } from '@/lib/types';
import { getCurrentBlockHeight } from '@/lib/broadcaster';
import { loadWallet } from '@/lib/wallet';

export default function ExitScreen() {
  const { state, startBroadcast, pause } = useExit();
  const heightInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const [walletLoaded, setWalletLoaded] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    loadWallet().then(w => setWalletLoaded(!!w));
  }, []);

  useEffect(() => {
    const fetchHeight = async () => {
      try {
        await getCurrentBlockHeight(state.mempoolBaseUrl);
      } catch {
        // ignore
      }
    };
    fetchHeight();
    heightInterval.current = setInterval(fetchHeight, 30000);
    return () => {
      if (heightInterval.current) clearInterval(heightInterval.current);
    };
  }, [state.mempoolBaseUrl]);

  if (!mounted) return null;

  const hasData = state.trees.length > 0;

  const completeTrees = state.trees.filter(
    t =>
      state.treePhases[t.treeId] === BroadcastPhase.COMPLETE ||
      state.treePhases[t.treeId] === BroadcastPhase.ALREADY_EXITED,
  ).length;

  const totalValue = state.trees.reduce((sum, t) => sum + t.totalValue, 0);
  const recoveredValue = state.trees
    .filter(
      t =>
        state.treePhases[t.treeId] === BroadcastPhase.COMPLETE ||
        state.treePhases[t.treeId] === BroadcastPhase.ALREADY_EXITED,
    )
    .reduce((sum, t) => sum + t.totalValue, 0);

  const totalSteps = state.trees.reduce((sum, t) => sum + t.steps.length, 0);
  const confirmedSteps = state.trees.reduce(
    (sum, t) =>
      sum + t.steps.filter(s => state.stepStatuses[s.id] === StepStatus.CONFIRMED).length,
    0,
  );

  if (!hasData) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <p className="text-sm text-zinc-500 text-center">
          Import exit data from the Import tab first
        </p>
      </div>
    );
  }

  return (
    <div className="p-5 pt-14 pb-10">
      <div className="flex justify-between items-baseline mb-4">
        <h1 className="text-2xl font-bold text-zinc-100">Exit Progress</h1>
        {state.currentBlockHeight > 0 && (
          <span className="text-xs text-zinc-500 font-mono">
            Block {state.currentBlockHeight.toLocaleString()}
          </span>
        )}
      </div>

      <div className="p-4 rounded-lg border border-zinc-700 mb-4">
        <div className="flex justify-around mb-3">
          <div className="text-center flex-1">
            <p className="text-xl font-bold text-zinc-100">{completeTrees}/{state.trees.length}</p>
            <p className="text-[10px] text-zinc-500">Trees Complete</p>
          </div>
          <div className="text-center flex-1">
            <p className="text-xl font-bold text-zinc-100">{confirmedSteps}/{totalSteps}</p>
            <p className="text-[10px] text-zinc-500">Steps Confirmed</p>
          </div>
        </div>
        <div className="flex justify-around mb-3">
          <div className="text-center flex-1">
            <p className="text-xl font-bold text-orange-500">{recoveredValue.toLocaleString()}</p>
            <p className="text-[10px] text-zinc-500">Sats Recovered</p>
          </div>
          <div className="text-center flex-1">
            <p className="text-xl font-bold text-orange-500">{totalValue.toLocaleString()}</p>
            <p className="text-[10px] text-zinc-500">Total Sats</p>
          </div>
        </div>

        <div className="h-1.5 bg-zinc-700 rounded overflow-hidden">
          <div
            className="h-full bg-green-500 rounded transition-all"
            style={{ width: `${totalSteps > 0 ? (confirmedSteps / totalSteps) * 100 : 0}%` }}
          />
        </div>
      </div>

      <button
        className={`w-full py-3.5 rounded-lg font-bold text-white transition-colors mb-5 ${
          state.isRunning
            ? 'bg-red-500 hover:bg-red-600'
            : 'bg-green-500 hover:bg-green-600'
        }`}
        onClick={async () => {
          if (state.isRunning) {
            pause();
          } else {
            const wallet = await loadWallet();
            if (!wallet) {
              alert('Create or import a wallet in the Wallet tab first to pay CPFP fees.');
              return;
            }
            startBroadcast(wallet);
          }
        }}
      >
        {state.isRunning ? 'Pause' : 'Start Broadcasting'}
      </button>

      {!walletLoaded && (
        <p className="text-xs text-amber-500 text-center mb-4 -mt-3">
          Set up a funded wallet in the Wallet tab to pay CPFP mining fees
        </p>
      )}

      <h2 className="text-lg font-semibold text-zinc-200 mb-2.5">Trees</h2>
      {state.trees.map((tree, i) => (
        <BroadcastProgress key={tree.treeId} tree={tree} index={i} />
      ))}
    </div>
  );
}
