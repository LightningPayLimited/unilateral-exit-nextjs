import { NextRequest, NextResponse } from 'next/server';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { createHash } from 'crypto';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';

const HARDENED = 0x80000000;

// Same enumeration as /leaf-address — keep these in sync.
function leafIdHashBytes(leafId: string, variant: string): Buffer {
  switch (variant) {
    case 'utf8-nodashes':
      return Buffer.from(leafId.replace(/-/g, ''), 'utf8');
    case 'uuid-bytes': {
      const stripped = leafId.replace(/-/g, '');
      if (!/^[0-9a-fA-F]{32}$/.test(stripped)) {
        throw new Error('uuid-bytes variant requires a 32-hex-char leafId');
      }
      return Buffer.from(stripped, 'hex');
    }
    case 'utf8':
    default:
      return Buffer.from(leafId, 'utf8');
  }
}

// Estimate vsize of a single P2TR key-path input + one output of arbitrary type.
// Returns the total in vbytes.
function estimateSweepVsize(outputScriptLen: number): number {
  // Header: version(4) + locktime(4) + segwit marker/flag(2 weight = 0.5 vb)
  const overhead = 10.5;
  // P2TR key-path input: prevout(36) + scriptSig(1) + sequence(4) + witness(64+1+1)/4 ≈ 57.5
  const inputVbytes = 57.5;
  // Output: value(8) + scriptLen varint(1 for ≤252) + script
  const outputVbytes = 8 + 1 + outputScriptLen;
  return Math.ceil(overhead + inputVbytes + outputVbytes);
}

// Dust threshold per output type (BIP176 / Bitcoin Core defaults).
function dustThreshold(scriptLen: number): number {
  // Approx: 3 * (8 + 1 + scriptLen + 32 vbytes input cost) but for known types:
  if (scriptLen === 22) return 294;  // p2wpkh
  if (scriptLen === 34) return 330;  // p2tr / p2wsh
  if (scriptLen === 25) return 546;  // p2pkh
  if (scriptLen === 23) return 540;  // p2sh
  return 546; // safe default
}

export async function POST(req: NextRequest) {
  try {
    const { mnemonic, leafId, account, destinationAddress, utxoTxid, utxoVout, utxoValue, feeRate, dryRun, hashVariant } = await req.json();

    if (!mnemonic || !validateMnemonic(mnemonic, wordlist)) {
      return NextResponse.json({ error: 'valid mnemonic required' }, { status: 400 });
    }
    if (!leafId || account === undefined || !destinationAddress || !utxoTxid || utxoValue === undefined) {
      return NextResponse.json({ error: 'leafId, account, destinationAddress, utxoTxid, utxoVout, utxoValue required' }, { status: 400 });
    }

    // Validate destination address up front so we fail with a clear error.
    let destScript: Uint8Array;
    try {
      const decoded = btc.Address().decode(destinationAddress);
      destScript = btc.OutScript.encode(decoded);
    } catch (e) {
      return NextResponse.json({ error: `Invalid destination address: ${e instanceof Error ? e.message : e}` }, { status: 400 });
    }

    // Derive the signing key for this leaf:
    //   m/8797555'/{account}'/1'/{leaf_child}'
    //   leaf_child = sha256(leafId)[0..4] interpreted as uint32 BE, mod 2^31
    const seed = mnemonicToSeedSync(mnemonic);
    const root = HDKey.fromMasterSeed(seed);
    const signingKey = root.derive(`m/8797555'/${account}'/1'`);
    const variant = (typeof hashVariant === 'string' && hashVariant) || 'utf8';
    const hash = createHash('sha256').update(leafIdHashBytes(leafId, variant)).digest();
    const leafChild = hash.readUInt32BE(0) % HARDENED;
    const childKey = signingKey.deriveChild(leafChild + HARDENED);

    if (!childKey.privateKey || !childKey.publicKey) {
      return NextResponse.json({ error: 'failed to derive leaf private key' }, { status: 500 });
    }

    const privKey = childKey.privateKey;
    const xOnlyPub = childKey.publicKey.slice(1);
    const p2tr = btc.p2tr(xOnlyPub);
    const sourceOutputKey = Buffer.from(p2tr.script.slice(2)).toString('hex');

    // Fee estimation based on actual destination script length
    const estimatedVsize = estimateSweepVsize(destScript.length);
    const rate = feeRate || 5;
    const fee = Math.ceil(estimatedVsize * rate);
    const sendAmount = utxoValue - fee;
    const dust = dustThreshold(destScript.length);

    if (sendAmount <= 0) {
      return NextResponse.json({
        error: `fee (${fee} sats @ ${rate} sat/vB on ${estimatedVsize} vB) exceeds utxo value (${utxoValue} sats)`,
      }, { status: 400 });
    }
    if (sendAmount < dust) {
      return NextResponse.json({
        error: `output amount (${sendAmount} sats) is below dust threshold (${dust} sats) for destination address`,
      }, { status: 400 });
    }

    // Build the P2TR key-path sweep transaction.
    // scure-btc-signer applies the BIP341 tweak automatically when tapInternalKey is set.
    const tx = new btc.Transaction();
    tx.addInput({
      txid: utxoTxid,
      index: utxoVout ?? 0,
      witnessUtxo: {
        script: p2tr.script,
        amount: BigInt(utxoValue),
      },
      tapInternalKey: xOnlyPub,
    });
    tx.addOutputAddress(destinationAddress, BigInt(sendAmount));

    tx.sign(privKey);
    tx.finalize();

    const txHex = hex.encode(tx.extract());
    const txId = tx.id;

    return NextResponse.json({
      sourceOutputKey,
      leafPath: `m/8797555'/${account}'/1'/${leafChild}'`,
      hashVariant: variant,
      utxoValue,
      fee,
      feeRate: rate,
      estimatedVsize,
      sendAmount,
      destinationAddress,
      txid: txId,
      txHex: dryRun ? txHex.slice(0, 40) + '...(dry run)' : txHex,
      dryRun: !!dryRun,
      note: dryRun ? 'Set dryRun:false to get the full signed tx hex for broadcasting' : 'Broadcast this txHex via mempool API or bitcoin-cli',
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'sweep error' }, { status: 500 });
  }
}
