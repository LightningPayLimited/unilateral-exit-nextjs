import { NextRequest, NextResponse } from 'next/server';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { createHash } from 'crypto';
import * as btc from '@scure/btc-signer';
import { TreeNodeCodec } from '@/lib/proto/tree-node';
import { hexToBytes, bytesToHex } from '@/lib/hex-utils';

const HARDENED_OFFSET = 0x80000000;

function toXOnly(pubkey: Uint8Array): Uint8Array {
  return pubkey.length === 33 ? pubkey.slice(1) : pubkey;
}

export async function POST(req: NextRequest) {
  try {
    const { mnemonic, passphrase, serializedNodes } = await req.json();
    const seed = mnemonicToSeedSync(mnemonic, passphrase || '');
    const root = HDKey.fromMasterSeed(seed);

    // Extract target keys and node IDs from serializedNodes
    let targetSigningPub = '';
    let targetIdentityPub = '';
    const nodeIds: string[] = [];

    if (serializedNodes) {
      for (const [, hex] of Object.entries(serializedNodes)) {
        try {
          const node = TreeNodeCodec.decode(hexToBytes(hex as string));
          if (!targetSigningPub && node.ownerSigningPublicKey.length > 0) {
            targetSigningPub = bytesToHex(node.ownerSigningPublicKey);
          }
          if (!targetIdentityPub && node.ownerIdentityPublicKey.length > 0) {
            targetIdentityPub = bytesToHex(node.ownerIdentityPublicKey);
          }
          if (node.id) nodeIds.push(node.id);
        } catch { /* skip */ }
      }
    }

    // Try different base paths and hash inputs
    const hashInputVariants = (nodeId: string): { label: string; input: Buffer }[] => [
      { label: 'utf8 string', input: Buffer.from(nodeId, 'utf8') },
      { label: 'utf8 no dashes', input: Buffer.from(nodeId.replace(/-/g, ''), 'utf8') },
      { label: 'hex bytes (uuid)', input: Buffer.from(nodeId.replace(/-/g, ''), 'hex') },
    ];

    const basePaths = [
      "m/8797555'/0'/1'",
      "m/8797555'/1'/1'",
      "m/8797555'/0'/0'",
      "m/8797555'/1'/0'",
    ];

    const results: Record<string, unknown>[] = [];

    for (const basePath of basePaths) {
      const baseKey = root.derive(basePath);
      const basePub = Buffer.from(baseKey.publicKey!).toString('hex');

      for (const nodeId of nodeIds) {
        for (const { label, input } of hashInputVariants(nodeId)) {
          const hash = createHash('sha256').update(input).digest();
          const rawIdx = new DataView(hash.buffer, hash.byteOffset, hash.byteLength).getUint32(0, false);
          const childIdx = (rawIdx % HARDENED_OFFSET) + HARDENED_OFFSET;

          const childKey = baseKey.deriveChild(childIdx);
          const childPub = Buffer.from(childKey.publicKey!).toString('hex');

          let tweakedOutputKey = '';
          try {
            const p2tr = btc.p2tr(toXOnly(childKey.publicKey!));
            if (p2tr.script.length === 34) tweakedOutputKey = Buffer.from(p2tr.script.slice(2)).toString('hex');
          } catch { /* skip */ }

          const matchesSigning = targetSigningPub ? childPub === targetSigningPub : false;

          if (matchesSigning || label === 'utf8 string') {
            results.push({
              basePath,
              basePub,
              nodeId: nodeId.slice(0, 12) + '...',
              hashInput: label,
              childIndex: childIdx,
              childPub,
              tweakedOutputKey,
              matchesSigningPub: matchesSigning,
            });
          }
        }
      }
    }

    // Identity check
    const identityCheck: Record<string, unknown> = { targetIdentityPub };
    for (let account = 0; account < 5; account++) {
      const k = root.derive(`m/8797555'/${account}'/0'`);
      const pub = Buffer.from(k.publicKey!).toString('hex');
      identityCheck[`m/8797555'/${account}'/0'`] = pub;
      if (pub === targetIdentityPub) identityCheck['matchedAccount'] = account;
    }

    return NextResponse.json({ results, identityCheck });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'error' }, { status: 500 });
  }
}
