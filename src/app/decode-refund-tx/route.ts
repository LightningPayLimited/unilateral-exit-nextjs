import { NextRequest, NextResponse } from 'next/server';
import { parseTx, computeTxid } from '@/lib/tx-parser';

export async function POST(req: NextRequest) {
  try {
    const { txHex } = await req.json();
    if (!txHex) return NextResponse.json({ error: 'txHex required' }, { status: 400 });

    const parsed = parseTx(txHex);
    const txid = await computeTxid(txHex);

    // Read output value from the raw hex
    // For a simple decode, parse the first output value
    const { hexToBytes } = await import('@/lib/hex-utils');
    const buf = hexToBytes(txHex);
    let pos = 4; // skip version

    // Check segwit marker
    if (buf[pos] === 0x00) pos += 2;

    // Skip inputs
    const inputCount = buf[pos]; pos += 1;
    for (let i = 0; i < inputCount; i++) {
      pos += 32 + 4; // prevout
      const scriptLen = buf[pos]; pos += 1 + scriptLen;
      pos += 4; // nSequence
    }

    // Read first output value
    const outputCount = buf[pos]; pos += 1;
    const lo = buf[pos] | (buf[pos+1] << 8) | (buf[pos+2] << 16) | ((buf[pos+3] << 24) >>> 0);
    const hi = buf[pos+4] | (buf[pos+5] << 8) | (buf[pos+6] << 16) | ((buf[pos+7] << 24) >>> 0);
    const outputValue = hi * 0x100000000 + (lo >>> 0);

    return NextResponse.json({
      txid,
      outputValue,
      inputTxid: parsed.inputs[0]?.prevTxid,
      inputVout: parsed.inputs[0]?.prevVout,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'decode error' }, { status: 500 });
  }
}
