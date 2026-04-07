import { NextRequest, NextResponse } from 'next/server';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { createHash } from 'crypto';
import * as btc from '@scure/btc-signer';
import { TreeNodeCodec } from '@/lib/proto/tree-node';
import { hexToBytes, bytesToHex } from '@/lib/hex-utils';
import { computeTxid } from '@/lib/tx-parser';

// Diagnostic route. Compares the leaf p2tr address that /leaf-address would
// derive (for each hash-input variant) against the ACTUAL output script of the
// leaf's refundTx. The refund tx output script is the source of truth — it's
// where unilateral-exit funds will land on-chain. If none of the derived
// candidates match it, the address-derivation logic in /leaf-address is wrong
// (most likely the refund output uses a taptree, which adds a merkle-root tweak
// that simple p2tr(xOnly) does not account for).

const HARDENED = 0x80000000;

function readU32LE(buf: Uint8Array, offset: number): number {
  return (
    buf[offset] |
    (buf[offset + 1] << 8) |
    (buf[offset + 2] << 16) |
    ((buf[offset + 3] << 24) >>> 0)
  );
}

function readU64LE(buf: Uint8Array, offset: number): number {
  const lo = readU32LE(buf, offset);
  const hi = readU32LE(buf, offset + 4);
  return hi * 0x100000000 + (lo >>> 0);
}

function readVarInt(buf: Uint8Array, offset: number): [number, number] {
  const first = buf[offset];
  if (first < 0xfd) return [first, 1];
  if (first === 0xfd) return [buf[offset + 1] | (buf[offset + 2] << 8), 3];
  if (first === 0xfe) return [readU32LE(buf, offset + 1), 5];
  return [readU64LE(buf, offset + 1), 9];
}

interface ParsedOutput {
  vout: number;
  value: number;
  scriptHex: string;
}

function parseTxOutputs(txHex: string): ParsedOutput[] {
  const buf = hexToBytes(txHex);
  let pos = 4; // skip version
  if (buf[pos] === 0x00 && buf[pos + 1] !== 0x00) pos += 2; // segwit marker+flag
  const [inputCount, inputCountBytes] = readVarInt(buf, pos);
  pos += inputCountBytes;
  for (let i = 0; i < inputCount; i++) {
    pos += 32 + 4; // prevout txid + vout
    const [scriptLen, scriptLenBytes] = readVarInt(buf, pos);
    pos += scriptLenBytes + scriptLen;
    pos += 4; // nSequence
  }
  const [outputCount, outputCountBytes] = readVarInt(buf, pos);
  pos += outputCountBytes;
  const outputs: ParsedOutput[] = [];
  for (let i = 0; i < outputCount; i++) {
    const value = readU64LE(buf, pos);
    pos += 8;
    const [scriptLen, scriptLenBytes] = readVarInt(buf, pos);
    pos += scriptLenBytes;
    const scriptHex = bytesToHex(buf.slice(pos, pos + scriptLen));
    pos += scriptLen;
    outputs.push({ vout: i, value, scriptHex });
  }
  return outputs;
}

interface ClassifiedOutput extends ParsedOutput {
  scriptType: string;
  taprootOutputKey?: string;
  address?: string;
}

function classifyOutput(o: ParsedOutput): ClassifiedOutput {
  // p2tr: OP_1 (0x51) + OP_PUSHBYTES_32 (0x20) + 32 bytes
  if (o.scriptHex.length === 68 && o.scriptHex.startsWith('5120')) {
    const taprootOutputKey = o.scriptHex.slice(4);
    let address: string | undefined;
    try {
      address = btc.Address().encode({ type: 'tr', pubkey: hexToBytes(taprootOutputKey) });
    } catch {
      // ignore encode failure
    }
    return { ...o, scriptType: 'p2tr', taprootOutputKey, address };
  }
  if (o.scriptHex.length === 44 && o.scriptHex.startsWith('0014')) {
    return { ...o, scriptType: 'p2wpkh' };
  }
  if (o.scriptHex.length === 68 && o.scriptHex.startsWith('0020')) {
    return { ...o, scriptType: 'p2wsh' };
  }
  return { ...o, scriptType: 'unknown' };
}

export async function POST(req: NextRequest) {
  try {
    const { mnemonic, leafId, account, serializedNodes } = await req.json();

    if (!mnemonic || !validateMnemonic(mnemonic, wordlist)) {
      return NextResponse.json({ error: 'valid mnemonic required' }, { status: 400 });
    }
    if (!leafId || account === undefined || !serializedNodes) {
      return NextResponse.json({ error: 'leafId, account, serializedNodes required' }, { status: 400 });
    }
    const nodeHex = serializedNodes[leafId];
    if (!nodeHex) {
      return NextResponse.json(
        { error: `leafId ${leafId} not found in serializedNodes`, knownIds: Object.keys(serializedNodes).slice(0, 10) },
        { status: 400 },
      );
    }

    // Decode the leaf node from its protobuf
    const node = TreeNodeCodec.decode(hexToBytes(nodeHex));
    const refundHex = bytesToHex(node.refundTx);
    const nodeTxHex = bytesToHex(node.nodeTx);

    const refundOutputs = parseTxOutputs(refundHex).map(classifyOutput);
    const nodeTxOutputs = parseTxOutputs(nodeTxHex).map(classifyOutput);

    const refundOutput0 = refundOutputs[0];
    const refundOutput0Key = refundOutput0?.taprootOutputKey;

    // Derive the candidate addresses (mirrors /leaf-address exactly)
    const seed = mnemonicToSeedSync(mnemonic);
    const root = HDKey.fromMasterSeed(seed);
    const signingKey = root.derive(`m/8797555'/${account}'/1'`);

    const variants: Array<{ label: string; bytes: Buffer }> = [
      { label: 'utf8', bytes: Buffer.from(leafId, 'utf8') },
      { label: 'utf8-nodashes', bytes: Buffer.from(leafId.replace(/-/g, ''), 'utf8') },
    ];
    const stripped = leafId.replace(/-/g, '');
    if (/^[0-9a-fA-F]{32}$/.test(stripped)) {
      variants.push({ label: 'uuid-bytes', bytes: Buffer.from(stripped, 'hex') });
    }

    const protoOwnerSigningPubKey = bytesToHex(node.ownerSigningPublicKey);

    const candidates = variants.map(({ label, bytes }) => {
      const hash = createHash('sha256').update(bytes).digest();
      const leafChild = hash.readUInt32BE(0) % HARDENED;
      const childKey = signingKey.deriveChild(leafChild + HARDENED);
      const fullPub = bytesToHex(childKey.publicKey!);
      const xOnly = childKey.publicKey!.slice(1);
      const p2tr = btc.p2tr(xOnly);
      const derivedTweakedOutputKey = bytesToHex(p2tr.script.slice(2));
      return {
        variant: label,
        derivationPath: `m/8797555'/${account}'/1'/${leafChild}'`,
        derivedOwnerSigningPubKey: fullPub,
        ownerSigningPubKeyMatchesProto: fullPub === protoOwnerSigningPubKey,
        internalXOnly: bytesToHex(xOnly),
        derivedTweakedOutputKey,
        derivedAddress: p2tr.address,
        matchesRefundOutput0:
          refundOutput0Key !== undefined && derivedTweakedOutputKey === refundOutput0Key,
      };
    });

    let analysis: string;
    if (!refundOutput0) {
      analysis = 'Refund tx has no outputs (or could not be parsed).';
    } else if (refundOutput0.scriptType !== 'p2tr') {
      analysis = `Refund tx output 0 is ${refundOutput0.scriptType}, not p2tr — sweep assumptions are wrong.`;
    } else if (candidates.some(c => c.matchesRefundOutput0)) {
      const matched = candidates.find(c => c.matchesRefundOutput0)!;
      analysis = `OK: variant "${matched.variant}" derives the same output key as the refund tx output. Sweep address derivation is correct. If UTXOs are still missing, the funds went somewhere other than the unilateral leaf p2tr (e.g. cooperative exit paid to a user-supplied L1 destination, or the refund tx was never confirmed).`;
    } else if (candidates.some(c => c.ownerSigningPubKeyMatchesProto)) {
      analysis =
        'PROBLEM: a derived owner signing pubkey matches the proto, but NONE of the derived p2tr(xOnly) addresses match the refund tx output script. This strongly suggests the refund output uses a taptree (script tree) — the on-chain output key is tweak(xOnly, merkleRoot), not tweak(xOnly, ""). /leaf-address and /sweep need to be updated to compute the merkle root from the leaf scripts and pass it to btc.p2tr(internalKey, scriptTree) so the tweaked output key matches.';
    } else {
      analysis =
        'PROBLEM: no derived owner signing pubkey matches the proto AND no derived address matches the refund output. The hash variant or derivation path is wrong for this leaf.';
    }

    // Compute refund tx and node tx ids from the pre-signed hex.
    const refundTxid = await computeTxid(refundHex);
    const nodeTxid = await computeTxid(nodeTxHex);

    return NextResponse.json({
      leafId,
      account,
      protoOwnerSigningPubKey,
      protoVerifyingPubKey: bytesToHex(node.verifyingPublicKey),
      refundTx: { txid: refundTxid, outputs: refundOutputs },
      nodeTx: { txid: nodeTxid, outputs: nodeTxOutputs },
      candidates,
      analysis,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'diagnose error' }, { status: 500 });
  }
}
