/**
 * Simple HD wallet for CPFP fee bumping.
 * Generates P2WPKH addresses, tracks UTXOs, and signs CPFP child transactions.
 */

import { HDKey } from '@scure/bip32';
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';

const WALLET_STORAGE_KEY = 'cpfp-wallet';
const DERIVATION_BASE = "m/84'/0'/0'";

export interface WalletUtxo {
  txid: string;
  vout: number;
  value: number;
}

export interface WalletState {
  mnemonic: string;
  addressIndex: number;
  utxos: WalletUtxo[];
}

function deriveKey(mnemonic: string, index: number): HDKey {
  const seed = mnemonicToSeedSync(mnemonic);
  const root = HDKey.fromMasterSeed(seed);
  return root.derive(`${DERIVATION_BASE}/0/${index}`);
}

export function getAddress(mnemonic: string, index: number): string {
  const key = deriveKey(mnemonic, index);
  const p2wpkh = btc.p2wpkh(key.publicKey!);
  return p2wpkh.address!;
}

export function getP2wpkh(mnemonic: string, index: number) {
  const key = deriveKey(mnemonic, index);
  return btc.p2wpkh(key.publicKey!);
}

export function createNewWallet(): WalletState {
  return {
    mnemonic: generateMnemonic(wordlist, 128),
    addressIndex: 0,
    utxos: [],
  };
}

export function importWallet(mnemonic: string): WalletState | null {
  if (!validateMnemonic(mnemonic, wordlist)) return null;
  return { mnemonic, addressIndex: 0, utxos: [] };
}

export async function saveWallet(state: WalletState): Promise<void> {
  localStorage.setItem(WALLET_STORAGE_KEY, JSON.stringify(state));
}

export async function loadWallet(): Promise<WalletState | null> {
  const json = localStorage.getItem(WALLET_STORAGE_KEY);
  if (!json) return null;
  return JSON.parse(json);
}

export async function clearWallet(): Promise<void> {
  localStorage.removeItem(WALLET_STORAGE_KEY);
}

export async function fetchUtxos(
  address: string,
  baseUrl: string,
  rpcUrl?: string,
  rpcUser?: string,
  rpcPassword?: string,
): Promise<WalletUtxo[]> {
  // Try mempool.space UTXO endpoint first
  try {
    const response = await fetch(`${baseUrl}/api/address/${address}/utxo`);
    if (response.ok) {
      const data = await response.json();
      return data.map((u: any) => ({
        txid: u.txid,
        vout: u.vout,
        value: u.value,
      }));
    }
  } catch {
    // Fall through to RPC method
  }

  // Fallback: use bitcoind scantxoutset RPC
  if (rpcUrl && rpcUser) {
    console.log('[wallet] UTXO endpoint unavailable, using scantxoutset RPC');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': 'Basic ' + btoa(`${rpcUser}:${rpcPassword}`),
    };
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'scantxoutset',
        params: ['start', [`addr(${address})`]],
      }),
    });
    const data = await response.json();
    if (data.result?.unspents) {
      return data.result.unspents.map((u: any) => ({
        txid: u.txid,
        vout: u.vout,
        value: Math.round(u.amount * 1e8),
      }));
    }
  }

  throw new Error('Failed to fetch UTXOs: no working endpoint');
}

/**
 * Get the wallet's total balance from UTXOs.
 */
export async function getBalance(
  mnemonic: string,
  addressIndex: number,
  baseUrl: string,
): Promise<{ balance: number; utxos: WalletUtxo[] }> {
  const address = getAddress(mnemonic, addressIndex);
  const utxos = await fetchUtxos(address, baseUrl);
  const balance = utxos.reduce((s, u) => s + u.value, 0);
  return { balance, utxos };
}

/**
 * Detect ephemeral anchor output (matches all patterns from Spark SDK).
 */
function isEphemeralAnchorOutput(script: Uint8Array | undefined, amount: bigint | undefined): boolean {
  if (amount !== 0n || !script) return false;
  // Pattern 1: Bare OP_TRUE (0x51)
  if (script.length === 1 && script[0] === 0x51) return true;
  // Pattern 2: Push OP_TRUE (0x01 0x51)
  if (script.length === 2 && script[0] === 0x01 && script[1] === 0x51) return true;
  // Pattern 3: Bitcoin v29 ephemeral anchor (015152014e0173)
  if (script.length === 7 &&
    script[0] === 0x01 && script[1] === 0x51 && script[2] === 0x52 &&
    script[3] === 0x01 && script[4] === 0x4e && script[5] === 0x01 && script[6] === 0x73) return true;
  // Pattern 4: OP_1 + push 2 bytes (51024e73)
  if (script.length === 4 &&
    script[0] === 0x51 && script[1] === 0x02 && script[2] === 0x4e && script[3] === 0x73) return true;
  return false;
}

/**
 * Find the ephemeral anchor output vout in a transaction hex.
 */
export function findAnchorVout(txHex: string): number | null {
  const raw = hex.decode(txHex);
  const tx = btc.Transaction.fromRaw(raw, {
    allowUnknownOutputs: true,
    allowUnknownInputs: true,
    allowLegacyWitnessUtxo: true,
  });
  for (let i = 0; i < tx.outputsLength; i++) {
    const out = tx.getOutput(i);
    if (isEphemeralAnchorOutput(out.script, out.amount)) {
      return i;
    }
  }
  return null;
}

/**
 * Compute the txid from a raw transaction hex.
 */
export function computeTxidFromHex(txHex: string): string {
  const raw = hex.decode(txHex);
  const tx = btc.Transaction.fromRaw(raw, {
    allowUnknownOutputs: true,
    allowUnknownInputs: true,
    allowLegacyWitnessUtxo: true,
  });
  return tx.id;
}

/**
 * Get the vsize of a transaction from its hex.
 */
export function getTxVsize(txHex: string): number {
  const raw = hex.decode(txHex);
  const tx = btc.Transaction.fromRaw(raw, {
    allowUnknownOutputs: true,
    allowUnknownInputs: true,
    allowLegacyWitnessUtxo: true,
  });
  return tx.vsize;
}

/**
 * Build and sign a CPFP child transaction.
 */
export function buildCpfpTx(params: {
  mnemonic: string;
  addressIndex: number;
  parentTxHex: string;
  anchorVout: number;
  fundingUtxos: WalletUtxo[];
  feeRate: number;
  parentVsize: number;
}): string {
  const { mnemonic, addressIndex, parentTxHex, anchorVout, fundingUtxos, feeRate, parentVsize } = params;

  const key = deriveKey(mnemonic, addressIndex);
  const p2wpkh = btc.p2wpkh(key.publicKey!);

  const parentRaw = hex.decode(parentTxHex);
  const parentTx = btc.Transaction.fromRaw(parentRaw, {
    allowUnknownOutputs: true,
    allowUnknownInputs: true,
    allowLegacyWitnessUtxo: true,
  });
  const parentTxid = parentTx.id;

  const childVsize = Math.ceil(10.5 + fundingUtxos.length * 68 + 41 + 31);
  const totalFee = Math.ceil((parentVsize + childVsize) * feeRate);
  const totalFunding = fundingUtxos.reduce((s, u) => s + u.value, 0);
  const changeValue = totalFunding - totalFee;

  if (changeValue <= 0) {
    throw new Error(`Insufficient funds: need ${totalFee} sats for fee, have ${totalFunding} sats`);
  }

  console.log(`[cpfp] parent vsize=${parentVsize} child vsize=${childVsize} total=${parentVsize + childVsize}`);
  console.log(`[cpfp] feeRate=${feeRate} totalFee=${totalFee} funding=${totalFunding} change=${changeValue}`);

  const tx = new btc.Transaction({
    version: 3,
    allowUnknown: true,
    allowLegacyWitnessUtxo: true,
  });

  for (const utxo of fundingUtxos) {
    tx.addInput({
      txid: utxo.txid,
      index: utxo.vout,
      sequence: 0xffffffff,
      witnessUtxo: {
        script: p2wpkh.script,
        amount: BigInt(utxo.value),
      },
    });
  }

  const anchorOutput = parentTx.getOutput(anchorVout);
  tx.addInput({
    txid: parentTxid,
    index: anchorVout,
    sequence: 0xffffffff,
    witnessUtxo: {
      script: anchorOutput.script!,
      amount: 0n,
    },
  });

  if (changeValue >= 546) {
    tx.addOutputAddress(p2wpkh.address!, BigInt(changeValue));
  }

  for (let i = 0; i < fundingUtxos.length; i++) {
    tx.updateInput(i, { witnessScript: p2wpkh.script });
    tx.signIdx(key.privateKey!, i);
    tx.finalizeIdx(i);
  }

  return hex.encode(tx.toBytes(true, true));
}

export interface CpfpPackage {
  stepId: string;
  parentTxHex: string;
  cpfpChildHex: string;
}

/**
 * Pre-build CPFP packages for all pending steps, chaining change UTXOs.
 * Mirrors the Spark SDK's constructUnilateralExitFeeBumpPackages approach:
 * after each CPFP child is built, its change output becomes a virtual UTXO
 * for the next package, so only one initial wallet UTXO is needed.
 */
export function buildAllCpfpPackages(params: {
  mnemonic: string;
  addressIndex: number;
  steps: { id: string; txHex: string }[];
  fundingUtxos: WalletUtxo[];
  feeRate: number;
}): CpfpPackage[] {
  const { mnemonic, addressIndex, steps, feeRate } = params;

  const key = deriveKey(mnemonic, addressIndex);
  const p2wpkh = btc.p2wpkh(key.publicKey!);

  // Mutable copy of UTXOs - we chain change outputs through
  const availableUtxos: WalletUtxo[] = [...params.fundingUtxos];
  const packages: CpfpPackage[] = [];
  const seenTxids = new Set<string>();

  for (const step of steps) {
    // Parse parent to get txid and check for duplicates
    const parentRaw = hex.decode(step.txHex);
    const parentTx = btc.Transaction.fromRaw(parentRaw, {
      allowUnknownOutputs: true,
      allowUnknownInputs: true,
      allowLegacyWitnessUtxo: true,
    });
    const parentTxid = parentTx.id;

    // Skip already-packaged transactions (shared intermediates across leaves)
    if (seenTxids.has(parentTxid)) continue;
    seenTxids.add(parentTxid);

    const anchorVout = findAnchorVout(step.txHex);
    if (anchorVout === null) continue;
    if (availableUtxos.length === 0) {
      console.log(`[cpfp-prebuild] no UTXOs left for step ${step.id}`);
      break;
    }

    const parentVsize = parentTx.vsize;
    const childVsize = Math.ceil(10.5 + availableUtxos.length * 68 + 41 + 31);

    // Select minimum UTXOs needed (like SDK's selectUtxosForFee)
    const totalVbytes = parentVsize + Math.ceil(10.5 + 1 * 68 + 41 + 31);
    const minFee = Math.ceil(totalVbytes * feeRate);
    let selectedUtxos: WalletUtxo[] = [];
    let totalFunding = 0;
    for (const utxo of availableUtxos) {
      selectedUtxos.push(utxo);
      totalFunding += utxo.value;
      const actualChildVsize = Math.ceil(10.5 + selectedUtxos.length * 68 + 41 + 31);
      const actualFee = Math.ceil((parentVsize + actualChildVsize) * feeRate);
      if (totalFunding >= actualFee + 546) break;
    }

    const actualChildVsize = Math.ceil(10.5 + selectedUtxos.length * 68 + 41 + 31);
    const totalFee = Math.ceil((parentVsize + actualChildVsize) * feeRate);
    const changeValue = totalFunding - totalFee;

    if (changeValue <= 0) {
      console.log(`[cpfp-prebuild] insufficient funds for step ${step.id}`);
      break;
    }

    // Build the CPFP child
    const tx = new btc.Transaction({
      version: 3,
      allowUnknown: true,
      allowLegacyWitnessUtxo: true,
    });

    for (const utxo of selectedUtxos) {
      tx.addInput({
        txid: utxo.txid,
        index: utxo.vout,
        sequence: 0xffffffff,
        witnessUtxo: {
          script: p2wpkh.script,
          amount: BigInt(utxo.value),
        },
      });
    }

    tx.addInput({
      txid: parentTxid,
      index: anchorVout,
      sequence: 0xffffffff,
      witnessUtxo: {
        script: parentTx.getOutput(anchorVout).script!,
        amount: 0n,
      },
    });

    if (changeValue >= 546) {
      tx.addOutputAddress(p2wpkh.address!, BigInt(changeValue));
    }

    for (let i = 0; i < selectedUtxos.length; i++) {
      tx.updateInput(i, { witnessScript: p2wpkh.script });
      tx.signIdx(key.privateKey!, i);
      tx.finalizeIdx(i);
    }

    const cpfpChildHex = hex.encode(tx.toBytes(true, true));
    packages.push({ stepId: step.id, parentTxHex: step.txHex, cpfpChildHex });

    // Remove used UTXOs from available list
    const usedSet = new Set(selectedUtxos.map(u => `${u.txid}:${u.vout}`));
    for (let i = availableUtxos.length - 1; i >= 0; i--) {
      if (usedSet.has(`${availableUtxos[i].txid}:${availableUtxos[i].vout}`)) {
        availableUtxos.splice(i, 1);
      }
    }

    // Add change as a virtual UTXO at the END of the list.
    // This way the next package will prefer confirmed UTXOs (at the front)
    // and only fall back to chained unconfirmed change if no others are available.
    if (changeValue >= 546) {
      const childTx = btc.Transaction.fromRaw(hex.decode(cpfpChildHex), {
        allowUnknownOutputs: true,
        allowUnknownInputs: true,
        allowLegacyWitnessUtxo: true,
      });
      availableUtxos.push({
        txid: childTx.id,
        vout: 0,
        value: changeValue,
      });
    }

    console.log(`[cpfp-prebuild] step ${step.id}: fee=${totalFee} change=${changeValue} utxos_remaining=${availableUtxos.length}`);
  }

  return packages;
}
