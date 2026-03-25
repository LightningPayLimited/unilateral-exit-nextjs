import { NextRequest, NextResponse } from 'next/server';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync, mnemonicToEntropy, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { createHash, createHmac } from 'crypto';

export async function POST(req: NextRequest) {
  const { mnemonic, targetIdentityPub } = await req.json();
  if (!mnemonic || !targetIdentityPub) {
    return NextResponse.json({ error: 'mnemonic and targetIdentityPub required' }, { status: 400 });
  }
  if (!validateMnemonic(mnemonic, wordlist)) {
    return NextResponse.json({ error: 'invalid mnemonic' }, { status: 400 });
  }

  const target = targetIdentityPub.toLowerCase();
  const results: { method: string; identityPub: string; match: boolean }[] = [];

  tryMethod('BIP39 standard (no passphrase)', mnemonicToSeedSync(mnemonic), target, results);

  for (const pp of ['spark', 'Spark', 'breez', 'Breez', 'mnemonic', 'SPARK']) {
    tryMethod(`BIP39 passphrase="${pp}"`, mnemonicToSeedSync(mnemonic, pp), target, results);
  }

  const entropy = mnemonicToEntropy(mnemonic, wordlist);
  tryMethod('Raw entropy (16 bytes) as seed', entropy, target, results);
  tryMethod('SHA256(mnemonic string)', createHash('sha256').update(mnemonic).digest(), target, results);
  tryMethod('SHA512(mnemonic string)', createHash('sha512').update(mnemonic).digest(), target, results);
  tryMethod('HMAC-SHA512("Bitcoin seed", entropy)', createHmac('sha512', 'Bitcoin seed').update(entropy).digest(), target, results);
  tryMethod('HMAC-SHA512("Bitcoin seed", mnemonic)', createHmac('sha512', 'Bitcoin seed').update(mnemonic).digest(), target, results);
  tryMethod('Double SHA256(entropy)', createHash('sha256').update(createHash('sha256').update(entropy).digest()).digest(), target, results);
  tryMethod('SHA256(entropy)', createHash('sha256').update(entropy).digest(), target, results);

  return NextResponse.json({
    found: results.some(r => r.match),
    results,
    targetIdentity: target,
  });
}

function tryMethod(method: string, seed: Uint8Array, target: string, results: { method: string; identityPub: string; match: boolean }[]) {
  try {
    const root = HDKey.fromMasterSeed(seed);
    for (let account = 0; account < 5; account++) {
      const key = root.derive(`m/8797555'/${account}'/0'`);
      const pub = Buffer.from(key.publicKey!).toString('hex');
      const match = pub === target;
      if (match || account < 2) {
        results.push({ method: `${method} [account=${account}]`, identityPub: pub, match });
      }
      if (match) return;
    }
  } catch (e) {
    results.push({ method, identityPub: `error: ${e instanceof Error ? e.message : e}`, match: false });
  }
}
