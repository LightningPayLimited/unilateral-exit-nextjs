import { NextRequest, NextResponse } from 'next/server';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import * as btc from '@scure/btc-signer';
import { TreeNodeCodec } from '@/lib/proto/tree-node';
import { hexToBytes, bytesToHex } from '@/lib/hex-utils';

const HARDENED_OFFSET = 0x80000000;

function toXOnly(pubkey: Uint8Array): Uint8Array {
  return pubkey.length === 33 ? pubkey.slice(1) : pubkey;
}

function getOutputKeyHex(p2tr: { script: Uint8Array }): string {
  const script = p2tr.script;
  if (script.length === 34 && script[0] === 0x51 && script[1] === 0x20) {
    return Buffer.from(script.slice(2)).toString('hex');
  }
  return '';
}

function checkKey(pubkey: Uint8Array, target: string, label: string, results: string[]) {
  const xOnly = toXOnly(pubkey);
  const xOnlyHex = Buffer.from(xOnly).toString('hex');
  if (xOnlyHex === target) results.push(`FOUND (untweaked x-only)! ${label}`);
  try {
    const p2tr = btc.p2tr(xOnly);
    const outputKey = getOutputKeyHex(p2tr);
    if (outputKey === target) results.push(`FOUND (tweaked p2tr)! ${label}`);
  } catch { /* skip */ }
}

export async function POST(req: NextRequest) {
  try {
    const { mnemonic, targetOutputKey, serializedNodes } = await req.json();
    if (!mnemonic || !targetOutputKey) {
      return NextResponse.json({ error: 'mnemonic and targetOutputKey required' }, { status: 400 });
    }
    if (!validateMnemonic(mnemonic, wordlist)) {
      return NextResponse.json({ error: 'invalid mnemonic' }, { status: 400 });
    }

    const seed = mnemonicToSeedSync(mnemonic);
    const root = HDKey.fromMasterSeed(seed);
    const target = targetOutputKey.toLowerCase();
    const results: string[] = [];

    // Extract proto keys from serializedNodes if provided
    let ownerSigningPub = '';
    let ownerIdentityPub = '';
    let verifyingPub = '';
    const nodeIds: string[] = [];

    if (serializedNodes) {
      for (const [, hex] of Object.entries(serializedNodes)) {
        try {
          const node = TreeNodeCodec.decode(hexToBytes(hex as string));
          if (!ownerSigningPub) ownerSigningPub = bytesToHex(node.ownerSigningPublicKey);
          if (!ownerIdentityPub) ownerIdentityPub = bytesToHex(node.ownerIdentityPublicKey);
          if (!verifyingPub) verifyingPub = bytesToHex(node.verifyingPublicKey);
          if (node.id) nodeIds.push(node.id);
        } catch { /* skip */ }
      }
    }

    // Strategy 1: Standard BIP86
    for (let i = 0; i < 200; i++) {
      for (const change of [0, 1]) {
        const key = root.derive(`m/86'/0'/0'/${change}/${i}`);
        checkKey(key.publicKey!, target, `BIP86: m/86'/0'/0'/${change}/${i}`, results);
      }
    }

    // Strategy 2: Spark base keys + children
    for (let account = 0; account < 10; account++) {
      for (let keyIdx = 0; keyIdx < 5; keyIdx++) {
        const path = `m/8797555'/${account}'/${keyIdx}'`;
        const key = root.derive(path);
        checkKey(key.publicKey!, target, `Spark base: ${path}`, results);
        for (let child = 0; child < 500; child++) {
          const hChild = key.deriveChild(child + HARDENED_OFFSET);
          checkKey(hChild.publicKey!, target, `Spark ${path}/${child}' (hardened)`, results);
          try {
            const nhChild = key.deriveChild(child);
            checkKey(nhChild.publicKey!, target, `Spark ${path}/${child} (non-hardened)`, results);
          } catch { /* skip */ }
        }
      }
    }

    // Strategy 3: Spark sha256(nodeId) leaf derivation
    if (nodeIds.length > 0) {
      const { createHash } = await import('crypto');
      for (let account = 0; account < 5; account++) {
        for (let keyIdx = 0; keyIdx < 5; keyIdx++) {
          const baseKey = root.derive(`m/8797555'/${account}'/${keyIdx}'`);
          for (const nodeId of nodeIds) {
            const hash = createHash('sha256').update(nodeId).digest();
            const view = new DataView(hash.buffer, hash.byteOffset, hash.byteLength);
            const childIdx = (view.getUint32(0, false) % HARDENED_OFFSET) + HARDENED_OFFSET;
            const childKey = baseKey.deriveChild(childIdx);
            checkKey(childKey.publicKey!, target, `Spark sha256("${nodeId.slice(0, 8)}...") from m/8797555'/${account}'/${keyIdx}'`, results);
          }
        }
      }
    }

    // Strategy 4: Other common paths
    for (const basePath of ["m/44'/0'/0'", "m/49'/0'/0'", "m/84'/0'/0'", "m/86'/1'/0'", "m/86'/0'/1'", "m/1852'/0'/0'"]) {
      for (let i = 0; i < 50; i++) {
        for (const change of [0, 1]) {
          try {
            const key = root.derive(`${basePath}/${change}/${i}`);
            checkKey(key.publicKey!, target, `${basePath}/${change}/${i}`, results);
          } catch { /* skip */ }
        }
      }
    }

    // Strategy 5: Check proto keys directly
    const protoKeyResults: Record<string, { xOnly: string; tweakedOutputKey: string; matchesTarget: boolean }> = {};
    const protoKeys = [
      ...(ownerIdentityPub ? [{ name: 'ownerIdentityPub', hex: ownerIdentityPub }] : []),
      ...(ownerSigningPub ? [{ name: 'ownerSigningPub', hex: ownerSigningPub }] : []),
      ...(verifyingPub ? [{ name: 'verifyingPub (FROST)', hex: verifyingPub }] : []),
    ];
    for (const pk of protoKeys) {
      const raw = Buffer.from(pk.hex, 'hex');
      const xOnly = toXOnly(raw);
      const xOnlyHex = Buffer.from(xOnly).toString('hex');
      let tweakedHex = '';
      let matches = false;
      try {
        const p2tr = btc.p2tr(xOnly);
        tweakedHex = getOutputKeyHex(p2tr);
        matches = tweakedHex === target;
        if (matches) results.push(`FOUND! Target is p2tr(${pk.name})`);
      } catch { tweakedHex = 'error'; }
      if (xOnlyHex === target) {
        results.push(`FOUND! Target is untweaked x-only of ${pk.name}`);
        matches = true;
      }
      protoKeyResults[pk.name] = { xOnly: xOnlyHex, tweakedOutputKey: tweakedHex, matchesTarget: matches };
    }

    // Find matching paths for proto keys
    let matchedSigningPath = 'none';
    let matchedIdentityPath = 'none';
    if (ownerSigningPub || ownerIdentityPub) {
      for (let account = 0; account < 10; account++) {
        for (let keyIdx = 0; keyIdx < 5; keyIdx++) {
          const k = root.derive(`m/8797555'/${account}'/${keyIdx}'`);
          const pub = Buffer.from(k.publicKey!).toString('hex');
          if (ownerSigningPub && pub === ownerSigningPub) matchedSigningPath = `m/8797555'/${account}'/${keyIdx}'`;
          if (ownerIdentityPub && pub === ownerIdentityPub) matchedIdentityPath = `m/8797555'/${account}'/${keyIdx}'`;
        }
      }
    }

    return NextResponse.json({
      results: results.length > 0 ? results : ['No match found in scanned paths'],
      debug: {
        targetOutputKey: target,
        protoKeyAnalysis: Object.keys(protoKeyResults).length > 0 ? protoKeyResults : undefined,
        ownerSigningPubFromProto: ownerSigningPub || undefined,
        ownerIdentityPubFromProto: ownerIdentityPub || undefined,
        matchedSigningPath,
        matchedIdentityPath,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'scan error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
