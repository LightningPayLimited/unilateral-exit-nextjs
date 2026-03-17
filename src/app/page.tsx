'use client';

import { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { TreeCard } from '@/components/tree-card';
import { useExit } from '@/context/ExitContext';
import type { UniexitData } from '@/lib/types';

export default function ImportScreen() {
  const { state, importData, clear } = useExit();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleLoadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      setLoading(true);
      const content = await file.text();
      const data: UniexitData = JSON.parse(content);

      if (!data.leaves || !data.serializedNodes) {
        alert('This file does not contain valid unilateral exit data.');
        setLoading(false);
        return;
      }

      importData(data);
      setLoading(false);
    } catch (err) {
      setLoading(false);
      alert(err instanceof Error ? err.message : 'Failed to load file');
    }
    // Reset file input so the same file can be re-selected
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const hasData = state.trees.length > 0;
  const totalValue = state.trees.reduce((sum, t) => sum + t.totalValue, 0);
  const totalSteps = state.trees.reduce((sum, t) => sum + t.steps.length, 0);
  const totalLeaves = state.trees.reduce((sum, t) => sum + t.leaves.length, 0);

  return (
    <div className="p-5 pt-14 pb-10">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-100">Unilateral Exit</h1>
        <p className="text-sm text-zinc-500 mt-1">Recover your Spark wallet funds on-chain</p>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        onChange={handleLoadFile}
        className="hidden"
      />

      {!hasData ? (
        <div className="flex flex-col items-center mt-10">
          <button
            className="bg-orange-500 hover:bg-orange-600 disabled:opacity-60 text-white font-bold px-6 py-3.5 rounded-lg w-full transition-colors"
            onClick={() => fileInputRef.current?.click()}
            disabled={loading}
          >
            {loading ? 'Loading...' : 'Load Exit Data'}
          </button>
          <p className="text-xs text-zinc-500 mt-3 text-center">
            Select the JSON file exported from Lightning Pay settings
          </p>
        </div>
      ) : (
        <>
          <div className="p-4 rounded-lg border border-zinc-700 mb-5">
            <span className="inline-block text-[11px] font-bold text-blue-500 bg-blue-500/10 border border-blue-500 px-2.5 py-0.5 rounded mb-3">
              {state.importedData?.network?.toUpperCase() ?? 'UNKNOWN'}
            </span>

            <div className="flex justify-around mb-4">
              <div className="text-center">
                <p className="text-2xl font-bold text-zinc-100">{state.trees.length}</p>
                <p className="text-[11px] text-zinc-500">Trees</p>
              </div>
              <div className="text-center">
                <p className="text-2xl font-bold text-zinc-100">{totalLeaves}</p>
                <p className="text-[11px] text-zinc-500">Leaves</p>
              </div>
              <div className="text-center">
                <p className="text-2xl font-bold text-zinc-100">{totalSteps}</p>
                <p className="text-[11px] text-zinc-500">Steps</p>
              </div>
            </div>

            <div className="flex justify-between items-center py-2 border-t border-zinc-800">
              <span className="text-sm text-zinc-400">Total Value</span>
              <div className="text-right">
                <p className="text-base font-bold text-orange-500">{totalValue.toLocaleString()} sats</p>
                <p className="text-[11px] text-zinc-500">{(totalValue / 1e8).toFixed(8)} BTC</p>
              </div>
            </div>

            <div className="flex justify-between items-center py-2 border-t border-zinc-800">
              <span className="text-sm text-zinc-400">Nodes Decoded</span>
              <span className="text-base font-bold text-orange-500">
                {Object.keys(state.importedData?.serializedNodes ?? {}).length}
              </span>
            </div>
          </div>

          <h2 className="text-lg font-semibold text-zinc-200 mb-2.5">Trees</h2>
          {state.trees.map((tree, i) => (
            <TreeCard key={tree.treeId} tree={tree} index={i} />
          ))}

          <div className="flex gap-2.5 mt-4">
            <button
              className="flex-1 bg-orange-500 hover:bg-orange-600 text-white font-bold py-3.5 rounded-lg transition-colors"
              onClick={() => router.push('/exit')}
            >
              Begin Exit
            </button>
            <button
              className="border border-red-500 text-red-500 hover:bg-red-500/10 font-bold px-5 py-3.5 rounded-lg transition-colors"
              onClick={() => {
                if (confirm('Remove imported data and broadcast state?')) {
                  clear();
                }
              }}
            >
              Clear
            </button>
          </div>

          <button
            className="w-full bg-orange-500 hover:bg-orange-600 disabled:opacity-60 text-white font-bold py-3.5 rounded-lg mt-2 transition-colors"
            onClick={() => fileInputRef.current?.click()}
            disabled={loading}
          >
            {loading ? 'Loading...' : 'Load Different File'}
          </button>
        </>
      )}
    </div>
  );
}
