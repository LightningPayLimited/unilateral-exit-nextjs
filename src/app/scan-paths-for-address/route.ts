import { NextRequest, NextResponse } from 'next/server';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { createHash } from 'crypto';
import * as btc from '@scure/btc-signer';
import { bytesToHex } from '@/lib/hex-utils';

const HARDENED = 0x80000000;

// Try a wide variety of derivation paths and address schemes for a target
// p2tr address. This is the "I have an address with funds, find the key for
// it" scanner — used when the standard leaf p2tr derivation doesn't match.
export async function POST(req: NextRequest) {
  try {
    const { mnemonic, targetAddress, leafIds: leafIdsArg } = await req.json();
    if (!mnemonic || !validateMnemonic(mnemonic, wordlist)) {
      return NextResponse.json({ error: 'valid mnemonic required' }, { status: 400 });
    }
    if (!targetAddress) {
      return NextResponse.json({ error: 'targetAddress required' }, { status: 400 });
    }

    // Decode target → 32-byte taproot output key
    let targetKeyHex: string;
    try {
      const decoded = btc.Address().decode(String(targetAddress));
      if (decoded.type !== 'tr') {
        return NextResponse.json({ error: `target is not p2tr (${decoded.type})` }, { status: 400 });
      }
      targetKeyHex = bytesToHex(decoded.pubkey);
    } catch (e) {
      return NextResponse.json({ error: `invalid address: ${e instanceof Error ? e.message : e}` }, { status: 400 });
    }

    const seed = mnemonicToSeedSync(mnemonic);
    const root = HDKey.fromMasterSeed(seed);

    interface Match {
      scheme: string;
      path: string;
      derivedKey: string;
      derivedAddress?: string;
    }
    const matches: Match[] = [];
    let scannedCount = 0;

    // Helper to try a key path and check if its p2tr matches
    const tryPath = (scheme: string, path: string, key: HDKey | null) => {
      if (!key?.publicKey) return;
      scannedCount++;
      try {
        const xOnly = key.publicKey.slice(1);
        const p2tr = btc.p2tr(xOnly);
        const derivedKey = bytesToHex(p2tr.script.slice(2));
        if (derivedKey === targetKeyHex) {
          matches.push({ scheme, path, derivedKey, derivedAddress: p2tr.address });
        }
      } catch {
        // ignore
      }
    };

    // ─── Scheme A: BIP86 standard taproot (m/86'/0'/account'/change/index) ────
    for (let account = 0; account < 5; account++) {
      for (const change of [0, 1]) {
        const acctKey = root.derive(`m/86'/0'/${account}'`);
        for (let i = 0; i < 100; i++) {
          tryPath('BIP86', `m/86'/0'/${account}'/${change}/${i}`, acctKey.derive(`${change}/${i}`));
        }
      }
    }

    // ─── Scheme B: Spark identity key directly (m/8797555'/account'/0') ────
    for (let account = 0; account < 5; account++) {
      tryPath('spark-identity', `m/8797555'/${account}'/0'`, root.derive(`m/8797555'/${account}'/0'`));
      // And as receive chain
      const idAcct = root.derive(`m/8797555'/${account}'/0'`);
      for (let i = 0; i < 50; i++) {
        tryPath('spark-identity-chain', `m/8797555'/${account}'/0'/0/${i}`, idAcct.derive(`0/${i}`));
        tryPath('spark-identity-chain', `m/8797555'/${account}'/0'/${i}'`, idAcct.deriveChild(i + HARDENED));
      }
    }

    // ─── Scheme C: Spark signing chain with linear index (no hash) ────
    for (let account = 0; account < 5; account++) {
      const signingKey = root.derive(`m/8797555'/${account}'/1'`);
      for (let i = 0; i < 200; i++) {
        tryPath('spark-signing-linear', `m/8797555'/${account}'/1'/${i}'`, signingKey.deriveChild(i + HARDENED));
        tryPath('spark-signing-linear', `m/8797555'/${account}'/1'/${i}`, signingKey.derive(`${i}`));
      }
    }

    // ─── Scheme D: Spark refund chain (m/8797555'/account'/2') ────
    for (let account = 0; account < 5; account++) {
      const refundKey = root.derive(`m/8797555'/${account}'/2'`);
      tryPath('spark-refund-base', `m/8797555'/${account}'/2'`, refundKey);
      for (let i = 0; i < 100; i++) {
        tryPath('spark-refund-linear', `m/8797555'/${account}'/2'/${i}'`, refundKey.deriveChild(i + HARDENED));
      }
    }

    // ─── Scheme E: Hashed leafId at OTHER chain depths ────
    if (Array.isArray(leafIdsArg)) {
      for (const leafId of leafIdsArg as string[]) {
        const sha = createHash('sha256').update(leafId).digest();
        const leafChild = sha.readUInt32BE(0) % HARDENED;
        for (let account = 0; account < 5; account++) {
          for (const chain of [0, 2, 3]) {
            const k = root.derive(`m/8797555'/${account}'/${chain}'`);
            tryPath('hashed-leaf-other-chain', `m/8797555'/${account}'/${chain}'/${leafChild}'`, k.deriveChild(leafChild + HARDENED));
          }
        }
      }
    }

    // ─── Scheme F: BIP84 P2WPKH at index → re-encoded as P2TR (long shot) ────
    for (let account = 0; account < 3; account++) {
      const acctKey = root.derive(`m/84'/0'/${account}'`);
      for (let i = 0; i < 50; i++) {
        tryPath('BIP84-as-tr', `m/84'/0'/${account}'/0/${i}`, acctKey.derive(`0/${i}`));
        tryPath('BIP84-as-tr', `m/84'/0'/${account}'/1/${i}`, acctKey.derive(`1/${i}`));
      }
    }

    return NextResponse.json({
      targetOutputKey: targetKeyHex,
      scannedCount,
      matches,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'scan-paths-for-address error' }, { status: 500 });
  }
}
