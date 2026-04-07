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

export async function POST(req: NextRequest) {
  try {
    const { mnemonic, leafId, account, destinationAddress, utxoTxid, utxoVout, utxoValue, feeRate, dryRun, hashVariant } = await req.json();

    if (!mnemonic || !validateMnemonic(mnemonic, wordlist)) {
      return NextResponse.json({ error: 'valid mnemonic required' }, { status: 400 });
    }
    if (!leafId || account === undefined || !destinationAddress || !utxoTxid || utxoValue === undefined) {
      return NextResponse.json({ error: 'leafId, account, destinationAddress, utxoTxid, utxoVout, utxoValue required' }, { status: 400 });
    }

    // Derive the signing key for this leaf
    const seed = mnemonicToSeedSync(mnemonic);
    const root = HDKey.fromMasterSeed(seed);
    const signingKey = root.derive(`m/8797555'/${account}'/1'`);
    const variant = (typeof hashVariant === 'string' && hashVariant) || 'utf8';
    const hash = createHash('sha256').update(leafIdHashBytes(leafId, variant)).digest();
    const leafChild = hash.readUInt32BE(0) % HARDENED;
    const childKey = signingKey.deriveChild(leafChild + HARDENED);

    if (!childKey.privateKey) {
      return NextResponse.json({ error: 'failed to derive private key' }, { status: 500 });
    }

    const privKey = childKey.privateKey;
    const xOnlyPub = childKey.publicKey!.slice(1);
    const p2tr = btc.p2tr(xOnlyPub);
    const sourceOutputKey = Buffer.from(p2tr.script.slice(2)).toString('hex');

    // Estimate tx size: P2TR key-path input ~58 vbytes, P2TR output ~43 vbytes, overhead ~11
    const estimatedVsize = 112;
    const rate = feeRate || 5;
    const fee = Math.ceil(estimatedVsize * rate);
    const sendAmount = utxoValue - fee;

    if (sendAmount <= 0) {
      return NextResponse.json({ error: `fee (${fee} sats) exceeds utxo value (${utxoValue} sats)` }, { status: 400 });
    }

    // Build the transaction
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

    // Decode destination address
    const destScript = btc.Address().decode(destinationAddress);
    tx.addOutputAddress(destinationAddress, BigInt(sendAmount));

    // Sign
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
