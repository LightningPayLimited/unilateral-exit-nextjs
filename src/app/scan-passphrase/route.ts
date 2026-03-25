import { NextRequest, NextResponse } from 'next/server';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

export async function POST(req: NextRequest) {
  try {
    const { mnemonic, targetIdentityPub, passphrases } = await req.json();
    if (!mnemonic || !targetIdentityPub) {
      return NextResponse.json({ error: 'mnemonic and targetIdentityPub required' }, { status: 400 });
    }
    if (!validateMnemonic(mnemonic, wordlist)) {
      return NextResponse.json({ error: 'invalid mnemonic' }, { status: 400 });
    }

    const target = targetIdentityPub.toLowerCase();

    // Default passphrases to try
    const toTry: string[] = passphrases ?? [
      '', 'spark', 'Spark', 'SPARK', 'lightspark', 'Lightspark',
      'mnemonic', 'bitcoin', 'Bitcoin', 'wallet', 'Wallet',
      'spark-wallet', 'SparkWallet', 'spark_wallet',
      'password', 'Password', '123456', '1234',
      'spark1', 'mainnet', 'testnet',
    ];

    const results: { passphrase: string; identityPub: string; match: boolean }[] = [];

    for (const passphrase of toTry) {
      const seed = mnemonicToSeedSync(mnemonic, passphrase);
      const root = HDKey.fromMasterSeed(seed);

      // Check accounts 0-5 for identity key (keyIdx 0)
      for (let account = 0; account < 5; account++) {
        const key = root.derive(`m/8797555'/${account}'/0'`);
        const pub = Buffer.from(key.publicKey!).toString('hex');
        const match = pub === target;
        if (match) {
          results.push({
            passphrase: passphrase || '(empty)',
            identityPub: pub,
            match: true,
          });
        }
      }
    }

    // Also try: maybe the seed is derived differently (raw entropy, not BIP39)
    // BIP39 entropy for 12 words = 128 bits = 16 bytes
    // Some wallets use the entropy directly as seed instead of PBKDF2

    return NextResponse.json({
      found: results.length > 0,
      results: results.length > 0 ? results : 'No passphrase matched',
      triedCount: toTry.length,
      note: results.length === 0
        ? 'Try providing custom passphrases array, or check if the Spark app uses a non-standard seed derivation'
        : undefined,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
