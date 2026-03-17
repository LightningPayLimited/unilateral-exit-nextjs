/**
 * Minimal Bitcoin transaction parser.
 * Extracts nSequence, txid, and input prevouts from raw tx bytes.
 */

import { hexToBytes, bytesToHex } from './hex-utils';

// Read a little-endian uint32
function readU32LE(buf: Uint8Array, offset: number): number {
  return (
    buf[offset] |
    (buf[offset + 1] << 8) |
    (buf[offset + 2] << 16) |
    ((buf[offset + 3] << 24) >>> 0)
  );
}

// Read a little-endian uint64 as number (safe for values < 2^53)
function readU64LE(buf: Uint8Array, offset: number): number {
  const lo = readU32LE(buf, offset);
  const hi = readU32LE(buf, offset + 4);
  return hi * 0x100000000 + (lo >>> 0);
}

// Read a Bitcoin varint, return [value, bytesConsumed]
function readVarInt(buf: Uint8Array, offset: number): [number, number] {
  const first = buf[offset];
  if (first < 0xfd) return [first, 1];
  if (first === 0xfd) return [buf[offset + 1] | (buf[offset + 2] << 8), 3];
  if (first === 0xfe) return [readU32LE(buf, offset + 1), 5];
  return [readU64LE(buf, offset + 1), 9];
}

// Reverse a byte array (for txid display)
function reverseBytes(buf: Uint8Array): Uint8Array {
  const out = new Uint8Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    out[i] = buf[buf.length - 1 - i];
  }
  return out;
}

export interface ParsedInput {
  prevTxid: string; // reversed hex (display order)
  prevVout: number;
  nSequence: number;
}

export interface ParsedTx {
  version: number;
  inputs: ParsedInput[];
  hasWitness: boolean;
  // Raw serialization without witness (for txid computation)
  serializedNoWitness: Uint8Array;
}

/**
 * Parse a raw Bitcoin transaction from hex.
 * Supports both legacy and segwit (witness) formats.
 */
export function parseTx(txHex: string): ParsedTx {
  const buf = hexToBytes(txHex);
  let pos = 0;

  const version = readU32LE(buf, pos);
  pos += 4;

  // Check for segwit marker
  let hasWitness = false;
  if (buf[pos] === 0x00 && buf[pos + 1] !== 0x00) {
    hasWitness = true;
    pos += 2; // skip marker (0x00) and flag (0x01)
  }

  // Inputs
  const [inputCount, inputCountBytes] = readVarInt(buf, pos);
  pos += inputCountBytes;

  const inputs: ParsedInput[] = [];

  for (let i = 0; i < inputCount; i++) {
    // Previous txid (32 bytes, internal byte order)
    const prevTxidBytes = buf.slice(pos, pos + 32);
    const prevTxid = bytesToHex(reverseBytes(prevTxidBytes));
    pos += 32;

    // Previous vout
    const prevVout = readU32LE(buf, pos);
    pos += 4;

    // scriptSig
    const [scriptLen, scriptLenBytes] = readVarInt(buf, pos);
    pos += scriptLenBytes + scriptLen;

    // nSequence
    const nSequence = readU32LE(buf, pos);
    pos += 4;

    inputs.push({ prevTxid, prevVout, nSequence });
  }

  // Outputs (skip for now, just need to traverse)
  const [outputCount, outputCountBytes] = readVarInt(buf, pos);
  pos += outputCountBytes;

  for (let i = 0; i < outputCount; i++) {
    pos += 8; // value (8 bytes)
    const [scriptLen, scriptLenBytes] = readVarInt(buf, pos);
    pos += scriptLenBytes + scriptLen;
  }

  const outputEnd = pos;

  // Witness data (if present)
  if (hasWitness) {
    for (let i = 0; i < inputCount; i++) {
      const [witnessCount, witnessCountBytes] = readVarInt(buf, pos);
      pos += witnessCountBytes;
      for (let j = 0; j < witnessCount; j++) {
        const [itemLen, itemLenBytes] = readVarInt(buf, pos);
        pos += itemLenBytes + itemLen;
      }
    }
  }

  // Build serialization without witness for txid computation
  const noWitnessParts: Uint8Array[] = [];
  noWitnessParts.push(buf.slice(0, 4)); // version

  // From after version (skipping marker/flag if witness) to end of outputs
  const inputOutputStart = hasWitness ? 6 : 4;
  noWitnessParts.push(buf.slice(inputOutputStart, outputEnd));

  // Locktime (last 4 bytes of buf)
  noWitnessParts.push(buf.slice(buf.length - 4));

  // Concatenate
  const totalLen = noWitnessParts.reduce((s, p) => s + p.length, 0);
  const serializedNoWitness = new Uint8Array(totalLen);
  let offset = 0;
  for (const part of noWitnessParts) {
    serializedNoWitness.set(part, offset);
    offset += part.length;
  }

  return { version, inputs, hasWitness, serializedNoWitness };
}

/**
 * Extract CSV block count from nSequence.
 * BIP68: if bit 31 is set, sequence is NOT interpreted as relative timelock.
 * If bit 22 is set, it's time-based (not block-based).
 * Otherwise, lower 16 bits are the block count.
 */
export function extractCsvBlocks(nSequence: number): number {
  // Bit 31 set = CSV disabled
  if (nSequence & 0x80000000) return 0;
  // Bit 22 set = time-based (we don't handle this, but shouldn't occur in our data)
  if (nSequence & 0x00400000) return 0;
  // Lower 16 bits = block count
  return nSequence & 0x0000ffff;
}

/**
 * Compute txid from raw tx hex.
 * txid = double SHA-256 of serialized tx without witness, byte-reversed.
 */
export async function computeTxid(txHex: string): Promise<string> {
  const parsed = parseTx(txHex);
  const hash1 = await sha256(parsed.serializedNoWitness);
  const hash2 = await sha256(hash1);
  return bytesToHex(reverseBytes(hash2));
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  try {
    if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
      const buf = new ArrayBuffer(data.length);
      new Uint8Array(buf).set(data);
      const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', buf);
      return new Uint8Array(hashBuffer);
    }
  } catch {
    // fallthrough to pure JS
  }
  return sha256Pure(data);
}

// Minimal pure-JS SHA-256 for environments without SubtleCrypto
function sha256Pure(data: Uint8Array): Uint8Array {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  const msgLen = data.length;
  const bitLen = msgLen * 8;
  const padLen = (msgLen % 64 < 56 ? 56 : 120) - (msgLen % 64);
  const padded = new Uint8Array(msgLen + 1 + padLen + 8);
  padded.set(data);
  padded[msgLen] = 0x80;
  const lenView = new DataView(padded.buffer, padded.byteOffset + padded.length - 8, 8);
  lenView.setUint32(0, Math.floor(bitLen / 0x100000000), false);
  lenView.setUint32(4, bitLen >>> 0, false);

  const W = new Int32Array(64);
  const view = new DataView(padded.buffer, padded.byteOffset, padded.length);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) W[i] = view.getInt32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = (rotr(W[i-15], 7) ^ rotr(W[i-15], 18) ^ (W[i-15] >>> 3));
      const s1 = (rotr(W[i-2], 17) ^ rotr(W[i-2], 19) ^ (W[i-2] >>> 10));
      W[i] = (W[i-16] + s0 + W[i-7] + s1) | 0;
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + W[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + temp1) | 0;
      d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }

  const result = new Uint8Array(32);
  const rv = new DataView(result.buffer);
  rv.setUint32(0, h0, false); rv.setUint32(4, h1, false);
  rv.setUint32(8, h2, false); rv.setUint32(12, h3, false);
  rv.setUint32(16, h4, false); rv.setUint32(20, h5, false);
  rv.setUint32(24, h6, false); rv.setUint32(28, h7, false);
  return result;
}

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}
