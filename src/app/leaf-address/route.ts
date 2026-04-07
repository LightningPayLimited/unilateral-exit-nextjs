import { NextRequest, NextResponse } from 'next/server';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { createHash } from 'crypto';
import * as btc from '@scure/btc-signer';

const HARDENED = 0x80000000;

// All three candidate ways the Spark SDK might feed a leaf id into sha256
// before computing the derivation child. The leaf id is typically a UUID like
// "019ae028-xxxx-xxxx-xxxx-xxxxxxxxxxxx" — the SDK could hash it as the literal
// utf8 string, the utf8 string with dashes stripped, or the raw 16 bytes the
// UUID encodes. We can't tell from outside which variant was used, so we
// enumerate all three and let the caller pick whichever address has funds.
function hashInputVariants(leafId: string): { label: string; bytes: Buffer }[] {
  const variants: { label: string; bytes: Buffer }[] = [
    { label: 'utf8', bytes: Buffer.from(leafId, 'utf8') },
    { label: 'utf8-nodashes', bytes: Buffer.from(leafId.replace(/-/g, ''), 'utf8') },
  ];
  // Only attempt the hex/uuid variant if the stripped form is exactly 32 hex chars
  const stripped = leafId.replace(/-/g, '');
  if (/^[0-9a-fA-F]{32}$/.test(stripped)) {
    variants.push({ label: 'uuid-bytes', bytes: Buffer.from(stripped, 'hex') });
  }
  return variants;
}

// Derive the on-chain p2tr address(es) that may hold funds for a Spark leaf:
//   leaf_child = sha256(<leaf_id encoded as variant>)[0..4] as uint32 BE % 2^31
//   key        = m/8797555'/{account}'/1'/{leaf_child}'
//   address    = p2tr(key)
//
// Returns one candidate per hash-input variant. The first variant ('utf8') is
// also exposed at the top level for backwards compatibility with callers that
// expect a single address.
export async function POST(req: NextRequest) {
  try {
    const { mnemonic, leafId, account } = await req.json();
    if (!mnemonic || !validateMnemonic(mnemonic, wordlist)) {
      return NextResponse.json({ error: 'valid mnemonic required' }, { status: 400 });
    }
    if (!leafId || account === undefined) {
      return NextResponse.json({ error: 'leafId and account required' }, { status: 400 });
    }

    const seed = mnemonicToSeedSync(mnemonic);
    const root = HDKey.fromMasterSeed(seed);
    const signingKey = root.derive(`m/8797555'/${account}'/1'`);

    const candidates = hashInputVariants(leafId).map(({ label, bytes }) => {
      const hash = createHash('sha256').update(bytes).digest();
      const leafChild = hash.readUInt32BE(0) % HARDENED;
      const childKey = signingKey.deriveChild(leafChild + HARDENED);
      if (!childKey.publicKey) {
        return { variant: label, error: 'derive failed' };
      }
      const xOnly = childKey.publicKey.slice(1);
      const p2tr = btc.p2tr(xOnly);
      return {
        variant: label,
        address: p2tr.address,
        derivationPath: `m/8797555'/${account}'/1'/${leafChild}'`,
        tweakedOutputKey: Buffer.from(p2tr.script.slice(2)).toString('hex'),
      };
    });

    const primary = candidates.find(c => c.variant === 'utf8' && 'address' in c);

    return NextResponse.json({
      // Backwards-compat single-address fields (utf8 variant)
      address: primary && 'address' in primary ? primary.address : undefined,
      derivationPath: primary && 'derivationPath' in primary ? primary.derivationPath : undefined,
      tweakedOutputKey: primary && 'tweakedOutputKey' in primary ? primary.tweakedOutputKey : undefined,
      // Full list of candidates the caller can iterate
      candidates,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'error' }, { status: 500 });
  }
}
