'use client';

import { useState } from 'react';
import type { BroadcastTree } from '@/lib/types';

const MEMPOOL_EXPLORER = process.env.NEXT_PUBLIC_MEMPOOL_EXPLORER ?? 'https://mempool.space';

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

export function SweepPanel({ tree }: SweepPanelProps) {
  const [mnemonic, setMnemonic] = useState('');
  const [account, setAccount] = useState(1);
  const [destination, setDestination] = useState('');
  const [feeRate, setFeeRate] = useState(3);
  const [loading, setLoading] = useState(false);
  const [verifyResult, setVerifyResult] = useState<string | null>(null);
  const [sweepResults, setSweepResults] = useState<SweepResult[]>([]);
  const [step, setStep] = useState<'input' | 'verified' | 'done'>('input');

  const leafIds = tree.leaves.map(l => l.leafId);

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
        // Look up the UTXO for this leaf's refund output
        const decodeRes = await fetch('/decode-node', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            nodeHex: JSON.parse(
              localStorage.getItem('unilateral-exit-state') ?? '{}'
            ).importedData?.serializedNodes?.[leafId] ?? '',
          }),
        });
        const node = await decodeRes.json();

        // Determine which refund tx was used (direct or cpfp)
        // Try directRefundTx first, then refundTx
        const refundHexes = [
          node.directRefundTxHex,
          node.directFromCpfpRefundTxHex,
          node.refundTxHex,
        ].filter((h: string) => h && h.length > 10);

        let swept = false;
        for (const refundHex of refundHexes) {
          // Parse refund tx to find its txid and output value
          const parseRes = await fetch('/decode-refund-tx', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ txHex: refundHex }),
          });

          if (!parseRes.ok) continue;
          const parsed = await parseRes.json();

          // Check if this refund tx is on-chain
          const checkRes = await fetch(`/mempool/api/tx/${parsed.txid}`);
          if (!checkRes.ok) continue;
          const txData = await checkRes.json();
          if (!txData.status?.confirmed) continue;

          // Check if the output is still unspent
          const outspendRes = await fetch(`/mempool/api/tx/${parsed.txid}/outspends`);
          if (!outspendRes.ok) continue;
          const outspends = await outspendRes.json();
          if (outspends[0]?.spent) {
            results.push({ leafId, leafPath: '', utxoValue: 0, fee: 0, sendAmount: 0, txid: '', error: 'Already swept' });
            swept = true;
            break;
          }

          // Sweep it
          const sweepRes = await fetch('/sweep', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              mnemonic: mnemonic.trim(),
              leafId,
              account,
              destinationAddress: destination.trim(),
              utxoTxid: parsed.txid,
              utxoVout: 0,
              utxoValue: parsed.outputValue,
              feeRate,
              dryRun: false,
            }),
          });
          const sweepData = await sweepRes.json();

          if (sweepData.error) {
            results.push({ leafId, leafPath: sweepData.leafPath || '', utxoValue: parsed.outputValue, fee: 0, sendAmount: 0, txid: '', error: sweepData.error });
            swept = true;
            break;
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
          } else {
            // Check if already confirmed (-27)
            if (broadcastText.includes('-27')) {
              results.push({ leafId, leafPath: sweepData.leafPath, utxoValue: sweepData.utxoValue, fee: sweepData.fee, sendAmount: sweepData.sendAmount, txid: sweepData.txid, error: 'Already broadcast' });
            } else {
              results.push({ leafId, leafPath: sweepData.leafPath, utxoValue: sweepData.utxoValue, fee: 0, sendAmount: 0, txid: '', error: broadcastText });
            }
          }
          swept = true;
          break;
        }

        if (!swept) {
          results.push({ leafId, leafPath: '', utxoValue: 0, fee: 0, sendAmount: 0, txid: '', error: 'Refund tx not found on-chain yet' });
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
