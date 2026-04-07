import { NextRequest, NextResponse } from 'next/server';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { TreeNodeCodec } from '@/lib/proto/tree-node';
import { hexToBytes, bytesToHex } from '@/lib/hex-utils';
import * as btc from '@scure/btc-signer';
import { createHash } from 'crypto';

function toXOnly(pub: Uint8Array): Uint8Array {
  return pub.length === 33 ? pub.slice(1) : pub;
}

export async function POST(req: NextRequest) {
  const { mnemonic, serializedNodes, identityPublicKey } = await req.json();
  if (!mnemonic || !serializedNodes) {
    return NextResponse.json({ error: 'mnemonic and serializedNodes required' }, { status: 400 });
  }
  if (!validateMnemonic(mnemonic, wordlist)) {
    return NextResponse.json({ error: 'invalid mnemonic' }, { status: 400 });
  }

  const seed = mnemonicToSeedSync(mnemonic);
  const root = HDKey.fromMasterSeed(seed);

  // Use identityPublicKey from the exit JSON if provided, otherwise decode from first node
  let protoIdentity = identityPublicKey || '';
  let protoSigning = '';
  if (!protoIdentity || !protoSigning) {
    const firstNodeHex = Object.values(serializedNodes)[0] as string;
    const firstNode = TreeNodeCodec.decode(hexToBytes(firstNodeHex));
    if (!protoIdentity) protoIdentity = bytesToHex(firstNode.ownerIdentityPublicKey);
    protoSigning = bytesToHex(firstNode.ownerSigningPublicKey);
  }

  // Find matching account
  let matchedAccount: number | null = null;
  const accountResults: Record<string, string> = {};
  for (let account = 0; account < 10; account++) {
    const key = root.derive(`m/8797555'/${account}'/0'`);
    const pub = Buffer.from(key.publicKey!).toString('hex');
    accountResults[`account ${account}`] = pub;
    if (pub === protoIdentity) matchedAccount = account;
  }

  // If matched, verify signing key and leaf derivation. Try multiple hash-input
  // variants because we don't know which encoding the SDK used for sha256.
  let signingKeyMatch = false;
  let matchedHashVariant: string | null = null;
  let leafDerivationResult: Record<string, unknown> | null = null;
  if (matchedAccount !== null) {
    const signingKey = root.derive(`m/8797555'/${matchedAccount}'/1'`);

    const hashVariantBytes = (id: string): { label: string; bytes: Buffer }[] => {
      const variants: { label: string; bytes: Buffer }[] = [
        { label: 'utf8', bytes: Buffer.from(id, 'utf8') },
        { label: 'utf8-nodashes', bytes: Buffer.from(id.replace(/-/g, ''), 'utf8') },
      ];
      const stripped = id.replace(/-/g, '');
      if (/^[0-9a-fA-F]{32}$/.test(stripped)) {
        variants.push({ label: 'uuid-bytes', bytes: Buffer.from(stripped, 'hex') });
      }
      return variants;
    };

    outer: for (const [, hex] of Object.entries(serializedNodes)) {
      const node = TreeNodeCodec.decode(hexToBytes(hex as string));
      const nodeProtoSigning = bytesToHex(node.ownerSigningPublicKey);
      if (!nodeProtoSigning) continue;

      for (const { label, bytes } of hashVariantBytes(node.id)) {
        const hash = createHash('sha256').update(bytes).digest();
        const leafChild = hash.readUInt32BE(0) % 0x80000000;
        const childKey = signingKey.deriveChild(leafChild + 0x80000000);
        const childPub = Buffer.from(childKey.publicKey!).toString('hex');

        if (childPub === nodeProtoSigning) {
          signingKeyMatch = true;
          matchedHashVariant = label;
          const xOnly = toXOnly(childKey.publicKey!);
          const p2tr = btc.p2tr(xOnly);
          const outputKey = Buffer.from(p2tr.script.slice(2)).toString('hex');

          leafDerivationResult = {
            nodeId: node.id,
            hashVariant: label,
            leafChild,
            path: `m/8797555'/${matchedAccount}'/1'/${leafChild}'`,
            derivedSigningPub: childPub,
            protoSigningPub: nodeProtoSigning,
            signingMatch: true,
            taprootOutputKey: outputKey,
          };
          break outer;
        }
      }
    }
  }

  return NextResponse.json({
    identityMatch: matchedAccount !== null,
    matchedAccount,
    protoIdentityPub: protoIdentity,
    protoSigningPub: protoSigning,
    signingKeyMatch,
    matchedHashVariant,
    leafDerivation: leafDerivationResult,
  });
}
