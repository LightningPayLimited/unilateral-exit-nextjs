import { NextRequest, NextResponse } from 'next/server';
import { TreeNodeCodec } from '@/lib/proto/tree-node';
import { hexToBytes, bytesToHex } from '@/lib/hex-utils';
import { parseTx, computeTxid } from '@/lib/tx-parser';

// For a given leaf, returns ALL transaction variants from the protobuf with
// their computed txids and (for refund variants) their input prevouts. The
// Spark protocol stores multiple parallel variants (CPFP / direct) and the
// "refundTx" field doesn't necessarily match the "nodeTx" we broadcast — the
// caller can use this info to find which refund variant correctly spends what
// we put on-chain.
export async function POST(req: NextRequest) {
  try {
    const { leafId, serializedNodes } = await req.json();
    if (!leafId || !serializedNodes) {
      return NextResponse.json({ error: 'leafId and serializedNodes required' }, { status: 400 });
    }
    const nodeHex = serializedNodes[leafId];
    if (!nodeHex) {
      return NextResponse.json({ error: `leafId ${leafId} not found in serializedNodes` }, { status: 400 });
    }

    const node = TreeNodeCodec.decode(hexToBytes(nodeHex));

    interface VariantInfo {
      field: string;
      txHex: string;
      txid: string;
      version: number;
      hasWitness: boolean;
      vsize: number;
      inputs: Array<{ prevTxid: string; prevVout: number; nSequence: number }>;
      outputs: Array<{ value: number; scriptHex: string; scriptType: string }>;
    }

    // Helper to parse outputs from raw tx bytes
    const parseOutputs = (txHex: string): Array<{ value: number; scriptHex: string; scriptType: string }> => {
      const buf = hexToBytes(txHex);
      let pos = 4; // skip version
      if (buf[pos] === 0x00 && buf[pos + 1] !== 0x00) pos += 2; // segwit marker
      // skip inputs
      const readVarInt = (offset: number): [number, number] => {
        const first = buf[offset];
        if (first < 0xfd) return [first, 1];
        if (first === 0xfd) return [buf[offset + 1] | (buf[offset + 2] << 8), 3];
        if (first === 0xfe) return [buf[offset + 1] | (buf[offset + 2] << 8) | (buf[offset + 3] << 16) | ((buf[offset + 4] << 24) >>> 0), 5];
        return [Number(buf[offset + 1]) + Number(buf[offset + 2]) * 256, 9]; // simplified
      };
      const [inCount, inCountLen] = readVarInt(pos);
      pos += inCountLen;
      for (let i = 0; i < inCount; i++) {
        pos += 32 + 4;
        const [scriptLen, scriptLenBytes] = readVarInt(pos);
        pos += scriptLenBytes + scriptLen + 4;
      }
      const [outCount, outCountLen] = readVarInt(pos);
      pos += outCountLen;
      const outs: Array<{ value: number; scriptHex: string; scriptType: string }> = [];
      for (let i = 0; i < outCount; i++) {
        const lo = buf[pos] | (buf[pos+1]<<8) | (buf[pos+2]<<16) | ((buf[pos+3]<<24)>>>0);
        const hi = buf[pos+4] | (buf[pos+5]<<8) | (buf[pos+6]<<16) | ((buf[pos+7]<<24)>>>0);
        const value = hi * 0x100000000 + (lo >>> 0);
        pos += 8;
        const [scriptLen, scriptLenBytes] = readVarInt(pos);
        pos += scriptLenBytes;
        const scriptHex = bytesToHex(buf.slice(pos, pos + scriptLen));
        pos += scriptLen;
        // Classify the script
        let scriptType = 'unknown';
        if (scriptHex.length === 68 && scriptHex.startsWith('5120')) scriptType = 'p2tr';
        else if (scriptHex.length === 44 && scriptHex.startsWith('0014')) scriptType = 'p2wpkh';
        else if (scriptHex.length === 68 && scriptHex.startsWith('0020')) scriptType = 'p2wsh';
        else if (scriptHex === '51') scriptType = 'op_true';
        else if (scriptHex === '0151') scriptType = 'push_op_true';
        else if (scriptHex === '51024e73') scriptType = 'p2a-anchor';
        outs.push({ value, scriptHex, scriptType });
      }
      return outs;
    };

    const variants: VariantInfo[] = [];
    const nodeFields: Array<{ name: string; bytes: Uint8Array }> = [
      { name: 'nodeTx', bytes: node.nodeTx },
      { name: 'refundTx', bytes: node.refundTx },
      { name: 'directTx', bytes: node.directTx },
      { name: 'directRefundTx', bytes: node.directRefundTx },
      { name: 'directFromCpfpRefundTx', bytes: node.directFromCpfpRefundTx },
    ];
    for (const f of nodeFields) {
      if (!f.bytes || f.bytes.length === 0) continue;
      try {
        const txHex = bytesToHex(f.bytes);
        const parsed = parseTx(txHex);
        const txid = await computeTxid(txHex);
        const outputs = parseOutputs(txHex);
        variants.push({
          field: f.name,
          txHex,
          txid,
          version: parsed.version,
          hasWitness: parsed.hasWitness,
          vsize: Math.ceil(f.bytes.length * 0.85), // rough estimate
          inputs: parsed.inputs.map(i => ({ prevTxid: i.prevTxid, prevVout: i.prevVout, nSequence: i.nSequence })),
          outputs,
        });
      } catch {
        // skip variant we can't parse
      }
    }

    // Backwards-compat: also return the legacy "refundInput" derived from refundTx
    const refundVariant = variants.find(v => v.field === 'refundTx');
    const refundInput = refundVariant?.inputs[0];

    return NextResponse.json({
      leafId,
      refundOutputValue: node.value,
      // Legacy single-variant fields
      refundInputTxid: refundInput?.prevTxid,
      refundInputVout: refundInput?.prevVout,
      // All variants for the caller to inspect
      variants,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'leaf-coop-spend error' }, { status: 500 });
  }
}
