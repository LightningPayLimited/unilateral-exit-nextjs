'use client';

import { useState, useEffect, useCallback } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  createNewWallet,
  importWallet,
  saveWallet,
  loadWallet,
  clearWallet,
  getAddress,
  fetchUtxos,
  type WalletState,
  type WalletUtxo,
} from '@/lib/wallet';

const MEMPOOL_URL = '/mempool';
const RPC_URL = '/rpc';
const RPC_USER = process.env.NEXT_PUBLIC_RPC_USER ?? '';
const RPC_PASSWORD = process.env.NEXT_PUBLIC_RPC_PASSWORD ?? '';

export default function WalletScreen() {
  const [wallet, setWallet] = useState<WalletState | null>(null);
  const [address, setAddress] = useState('');
  const [balance, setBalance] = useState(0);
  const [utxos, setUtxos] = useState<WalletUtxo[]>([]);
  const [loading, setLoading] = useState(false);
  const [importMnemonic, setImportMnemonic] = useState('');
  const [showMnemonic, setShowMnemonic] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    loadWallet().then(w => {
      if (w) {
        setWallet(w);
        setAddress(getAddress(w.mnemonic, w.addressIndex));
      }
    });
  }, []);

  const refreshBalance = useCallback(async (w: WalletState) => {
    setLoading(true);
    try {
      const addr = getAddress(w.mnemonic, w.addressIndex);
      const fetchedUtxos = await fetchUtxos(addr, MEMPOOL_URL, RPC_URL, RPC_USER, RPC_PASSWORD);
      const bal = fetchedUtxos.reduce((s, u) => s + u.value, 0);
      setUtxos(fetchedUtxos);
      setBalance(bal);
      const updated = { ...w, utxos: fetchedUtxos };
      setWallet(updated);
      await saveWallet(updated);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to fetch balance');
    }
    setLoading(false);
  }, []);

  const handleCreate = useCallback(async () => {
    const w = createNewWallet();
    setWallet(w);
    setAddress(getAddress(w.mnemonic, w.addressIndex));
    await saveWallet(w);
    alert('Wallet created! Back up your seed phrase in the wallet tab.');
  }, []);

  const handleImport = useCallback(async () => {
    const trimmed = importMnemonic.trim().toLowerCase();
    const w = importWallet(trimmed);
    if (!w) {
      alert('Please enter a valid BIP39 mnemonic phrase.');
      return;
    }
    setWallet(w);
    setAddress(getAddress(w.mnemonic, w.addressIndex));
    setImportMnemonic('');
    await saveWallet(w);
    refreshBalance(w);
  }, [importMnemonic, refreshBalance]);

  const handleClear = useCallback(async () => {
    if (!confirm('This will delete the wallet. Make sure you have the seed phrase backed up.')) return;
    await clearWallet();
    setWallet(null);
    setAddress('');
    setBalance(0);
    setUtxos([]);
  }, []);

  if (!mounted) return null;

  if (!wallet) {
    return (
      <div className="p-5 pt-14 pb-10">
        <div className="mb-5">
          <h1 className="text-2xl font-bold text-zinc-100">CPFP Wallet</h1>
          <p className="text-sm text-zinc-500 mt-1">Fund this wallet to pay mining fees for CPFP</p>
        </div>

        <button
          className="w-full bg-orange-500 hover:bg-orange-600 text-white font-bold py-3.5 rounded-lg transition-colors"
          onClick={handleCreate}
        >
          Create New Wallet
        </button>

        <p className="text-center text-zinc-500 mt-5 mb-2 text-sm">or import existing</p>

        <textarea
          className="w-full border border-zinc-700 bg-transparent rounded-lg p-3 text-sm text-zinc-200 min-h-[80px] placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
          placeholder="Enter 12-word mnemonic..."
          value={importMnemonic}
          onChange={e => setImportMnemonic(e.target.value)}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />

        <button
          className="w-full bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white font-bold py-3.5 rounded-lg mt-3 transition-colors"
          onClick={handleImport}
          disabled={!importMnemonic.trim()}
        >
          Import Wallet
        </button>
      </div>
    );
  }

  return (
    <div className="p-5 pt-14 pb-10">
      <h1 className="text-2xl font-bold text-zinc-100 mb-5">CPFP Wallet</h1>

      <div className="p-5 rounded-lg border border-zinc-700 text-center mb-4">
        <p className="text-xs text-zinc-500">Balance</p>
        <p className="text-3xl font-bold text-orange-500 mt-1">{balance.toLocaleString()} sats</p>
        <p className="text-[13px] text-zinc-500 mt-0.5">{(balance / 1e8).toFixed(8)} BTC</p>
      </div>

      <div className="p-4 rounded-lg border border-zinc-700 mb-4">
        <p className="text-xs text-zinc-500 mb-3">Deposit Address</p>
        <div className="flex justify-center mb-3">
          <div className="bg-white p-4 rounded-xl">
            <QRCodeSVG value={`bitcoin:${address}`} size={200} />
          </div>
        </div>
        <p className="text-[13px] font-mono text-center break-all leading-5 select-all text-zinc-300">
          {address}
        </p>
        <p className="text-[11px] text-zinc-600 mt-2 text-center">
          Send Bitcoin here to fund CPFP fee bumping
        </p>
      </div>

      <button
        className="w-full bg-blue-500 hover:bg-blue-600 disabled:opacity-50 text-white font-bold py-3.5 rounded-lg transition-colors"
        onClick={() => refreshBalance(wallet)}
        disabled={loading}
      >
        {loading ? 'Checking...' : 'Refresh Balance'}
      </button>

      {utxos.length > 0 && (
        <div className="mt-4">
          <h3 className="font-semibold text-zinc-200">UTXOs ({utxos.length})</h3>
          {utxos.map(u => (
            <div key={`${u.txid}:${u.vout}`} className="flex justify-between items-center py-1.5 border-b border-zinc-800">
              <span className="text-[13px] font-semibold text-zinc-300">{u.value.toLocaleString()} sats</span>
              <span className="text-[10px] text-zinc-600 font-mono">{u.txid.slice(0, 20)}...:{u.vout}</span>
            </div>
          ))}
        </div>
      )}

      <button
        className="w-full mt-6 text-blue-500 hover:text-blue-400 text-sm transition-colors"
        onClick={() => setShowMnemonic(!showMnemonic)}
      >
        {showMnemonic ? 'Hide' : 'Show'} Seed Phrase
      </button>

      {showMnemonic && (
        <div className="p-4 rounded-lg border border-red-500 mt-2">
          <p className="text-[11px] text-red-500 mb-2">
            Keep this safe! Anyone with these words can spend your funds.
          </p>
          <p className="text-sm leading-6 select-all text-zinc-200">{wallet.mnemonic}</p>
        </div>
      )}

      <button
        className="w-full mt-6 py-3 rounded-lg border border-red-500 text-red-500 hover:bg-red-500/10 font-semibold transition-colors"
        onClick={handleClear}
      >
        Delete Wallet
      </button>
    </div>
  );
}
