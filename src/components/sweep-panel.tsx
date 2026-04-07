'use client';

import { useEffect, useState } from 'react';
import type { BroadcastTree } from '@/lib/types';
import { BroadcastPhase } from '@/lib/types';
import { useExit } from '@/context/ExitContext';

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
  error?: string;
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
  const [account, setAccount] = useState(1);
  const [destination, setDestination] = useState('');
  const [feeRate, setFeeRate] = useState(3);
  const [loading, setLoading] = useState(false);
  const [verifyResult, setVerifyResult] = useState<string | null>(null);
  const [sweepResults, setSweepResults] = useState<SweepResult[]>([]);
  const [step, setStep] = useState<'input' | 'verified' | 'done'>('input');
  const [coopExitOutputs, setCoopExitOutputs] = useState<SpendingTxOutput[] | null>(null);
  const [coopExitOutputsError, setCoopExitOutputsError] = useState<string | null>(null);

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
        setVerifyResult(`Verified! Account ${data.matchedAccount}, signing key matches.`);
        setStep('verified');
      } else if (data.identityMatch) {
        setAccount(data.matchedAccount);
        setVerifyResult(`Identity matches (account ${data.matchedAccount}) but signing key mismatch.`);
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

    for (const leafId of leafIds) {
      try {
        // Address-based discovery: derive the leaf p2tr address (the same one
        // both the unilateral refund tx AND a Spark cooperative close pay to)
        // and look up its UTXOs directly. The Spark SDK may hash the leaf id
        // as utf8/utf8-no-dashes/uuid-bytes — /leaf-address returns one
        // candidate per variant; we try each until we find UTXOs.
        const addrRes = await fetch('/leaf-address', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mnemonic: mnemonic.trim(), leafId, account }),
        });
        const addrData = await addrRes.json();
        if (!addrRes.ok || !Array.isArray(addrData.candidates)) {
          results.push({ leafId, leafPath: '', utxoValue: 0, fee: 0, sendAmount: 0, txid: '', error: addrData.error || 'Could not derive leaf address' });
          continue;
        }
        type Candidate = { variant: string; address?: string; derivationPath?: string; error?: string };
        const candidates = addrData.candidates as Candidate[];

        // Look up UTXOs at each candidate; pick the first one that has any.
        let matched: { candidate: Candidate; utxos: Array<{ txid: string; vout: number; value: number }>; source: string } | null = null;
        const triedSummaries: string[] = [];
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
          triedSummaries.push(`${c.variant}=empty(${c.address.slice(0, 14)}...)`);
        }

        if (!matched) {
          results.push({ leafId, leafPath: '', utxoValue: 0, fee: 0, sendAmount: 0, txid: '', error: `No UTXOs at any candidate address — tried: ${triedSummaries.join(', ')}` });
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
              txid: broadcastText.trim(),
            });
          } else if (broadcastText.includes('-27')) {
            results.push({ leafId, leafPath: sweepData.leafPath, utxoValue: sweepData.utxoValue, fee: sweepData.fee, sendAmount: sweepData.sendAmount, txid: sweepData.txid, error: 'Already broadcast' });
          } else {
            results.push({ leafId, leafPath: sweepData.leafPath, utxoValue: utxo.value, fee: 0, sendAmount: 0, txid: '', error: broadcastText });
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
          <input
            type="password"
            placeholder="Spark wallet mnemonic"
            value={mnemonic}
            onChange={e => setMnemonic(e.target.value)}
            className="w-full p-2 rounded bg-zinc-800 border border-zinc-600 text-zinc-200 text-xs mb-2"
          />
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
          {sweepResults.map(r => (
            <div key={r.leafId} className="py-1.5 border-b border-zinc-800">
              <p className="text-[11px] text-zinc-400">Leaf {r.leafId.slice(0, 8)}...</p>
              {r.error ? (
                <p className="text-[11px] text-red-400">{r.error}</p>
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
          <button
            onClick={() => { setStep('input'); setSweepResults([]); }}
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
