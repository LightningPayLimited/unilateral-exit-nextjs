import { NextRequest, NextResponse } from 'next/server';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { createHash } from 'crypto';
import * as btc from '@scure/btc-signer';
import { TreeNodeCodec } from '@/lib/proto/tree-node';
import { hexToBytes, bytesToHex } from '@/lib/hex-utils';
import { computeTxid } from '@/lib/tx-parser';

const HARDENED = 0x80000000;

function hashInputVariants(leafId: string): { label: string; bytes: Buffer }[] {
  const variants: { label: string; bytes: Buffer }[] = [
    { label: 'utf8', bytes: Buffer.from(leafId, 'utf8') },
    { label: 'utf8-nodashes', bytes: Buffer.from(leafId.replace(/-/g, ''), 'utf8') },
  ];
  const stripped = leafId.replace(/-/g, '');
  if (/^[0-9a-fA-F]{32}$/.test(stripped)) {
    variants.push({ label: 'uuid-bytes', bytes: Buffer.from(stripped, 'hex') });
  }
  return variants;
}

// Reverse-lookup: given a known p2tr leaf address (or just the tweaked output
// key hex), scan every node in serializedNodes and try every (account,
// hash-variant) combination to find which leaf derives to it.
//
// This is the verification tool — if our derivation logic is correct, any leaf
// the user has previously swept should show up here when scanned with their
// mnemonic.
export async function POST(req: NextRequest) {
  try {
    const {
      mnemonic,
      targetAddress,
      targetOutputKey,
      serializedNodes,
      accounts: accountsArg,
    } = await req.json();

    if (!mnemonic || !validateMnemonic(mnemonic, wordlist)) {
      return NextResponse.json({ error: 'valid mnemonic required' }, { status: 400 });
    }
    if (!serializedNodes || typeof serializedNodes !== 'object') {
      return NextResponse.json({ error: 'serializedNodes required' }, { status: 400 });
    }
    if (!targetAddress && !targetOutputKey) {
      return NextResponse.json({ error: 'targetAddress or targetOutputKey required' }, { status: 400 });
    }

    // Resolve the target into a normalized 32-byte taproot output key (lowercase hex)
    let targetKeyHex: string;
    if (targetOutputKey) {
      targetKeyHex = String(targetOutputKey).toLowerCase().replace(/^0x/, '');
    } else {
      try {
        const decoded = btc.Address().decode(String(targetAddress));
        if (decoded.type !== 'tr') {
          return NextResponse.json({ error: `target address is not p2tr (${decoded.type})` }, { status: 400 });
        }
        targetKeyHex = bytesToHex(decoded.pubkey);
      } catch (e) {
        return NextResponse.json({ error: `failed to decode targetAddress: ${e instanceof Error ? e.message : e}` }, { status: 400 });
      }
    }

    const accounts: number[] = Array.isArray(accountsArg) && accountsArg.length > 0
      ? accountsArg.map(Number)
      : [0, 1, 2, 3];

    const seed = mnemonicToSeedSync(mnemonic);
    const root = HDKey.fromMasterSeed(seed);

    interface Match {
      leafId: string;
      account: number;
      hashVariant: string;
      derivationPath: string;
      derivedAddress: string | undefined;
      derivedTweakedOutputKey: string;
      refundTxid: string;
      refundOutputValue: number;
      ownerSigningPubKeyMatchesProto: boolean;
    }

    const matches: Match[] = [];
    const scanned: { leafId: string; account: number; variant: string; derivedKey: string }[] = [];

    for (const [, hex] of Object.entries(serializedNodes)) {
      let node;
      try {
        node = TreeNodeCodec.decode(hexToBytes(hex as string));
      } catch {
        continue;
      }
      const leafId = node.id;
      if (!leafId) continue;

      const protoSigning = bytesToHex(node.ownerSigningPublicKey);
      const refundHex = bytesToHex(node.refundTx);
      let refundTxid = '';
      try {
        refundTxid = await computeTxid(refundHex);
      } catch {
        // ignore
      }

      for (const account of accounts) {
        const signingKey = root.derive(`m/8797555'/${account}'/1'`);

        for (const { label, bytes } of hashInputVariants(leafId)) {
          const hash = createHash('sha256').update(bytes).digest();
          const leafChild = hash.readUInt32BE(0) % HARDENED;
          const childKey = signingKey.deriveChild(leafChild + HARDENED);
          if (!childKey.publicKey) continue;
          const xOnly = childKey.publicKey.slice(1);
          const p2tr = btc.p2tr(xOnly);
          const derivedKey = bytesToHex(p2tr.script.slice(2));
          scanned.push({ leafId, account, variant: label, derivedKey });

          if (derivedKey === targetKeyHex) {
            const fullPub = bytesToHex(childKey.publicKey);
            matches.push({
              leafId,
              account,
              hashVariant: label,
              derivationPath: `m/8797555'/${account}'/1'/${leafChild}'`,
              derivedAddress: p2tr.address,
              derivedTweakedOutputKey: derivedKey,
              refundTxid,
              refundOutputValue: node.value,
              ownerSigningPubKeyMatchesProto: fullPub === protoSigning,
            });
          }
        }
      }
    }

    return NextResponse.json({
      targetOutputKey: targetKeyHex,
      accountsScanned: accounts,
      leavesScanned: Object.keys(serializedNodes).length,
      matches,
      // First 20 scanned entries for debugging when no match found
      sample: matches.length === 0 ? scanned.slice(0, 20) : undefined,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'find-leaf-by-address error' }, { status: 500 });
  }
}
