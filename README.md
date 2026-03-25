# Spark Unilateral Exit Tool

A Next.js application for recovering funds from a [Spark](https://github.com/buildonspark/spark) Bitcoin Layer 2 wallet through unilateral exit. This tool broadcasts the pre-signed exit transaction chain on-chain when the Spark service is unavailable or unresponsive, and sweeps the recovered funds to a Bitcoin address you control.

## What is a Unilateral Exit?

In the Spark protocol, your funds are held in a tree of Bitcoin UTXOs controlled by FROST 2-of-2 threshold signatures (your key + Spark operators). Normally, funds move cooperatively. If the Spark service becomes unavailable, you can **unilaterally exit** by broadcasting pre-signed transactions that move your funds on-chain without any cooperation from the operators.

The exit process works in stages:

1. **Intermediate nodes** — broadcast the ancestor transactions from root to leaf (no timelock)
2. **Leaf node transaction** — broadcast after a CSV (CheckSequenceVerify) timelock expires
3. **Refund transaction** — broadcast after a second CSV timelock, sending funds to your signing key address
4. **Sweep** — spend from the refund output to your own wallet using your Spark mnemonic

## Prerequisites

- **Node.js** 18+
- **A Bitcoin Core node** (for `submitpackage` RPC, used for CPFP fee bumping of zero-fee TRUC transactions)
- **A Mempool/Esplora instance** (for transaction broadcasting and chain queries, or uses the public mempool.space as fallback)
- **Your Spark wallet mnemonic** (the seed phrase from your Spark/Breez SDK wallet)
- **The exit JSON file** exported from your Spark wallet containing `identityPublicKey`, `leaves`, and `serializedNodes`

## Getting Started

```bash
npm install
npm run dev
```

The app runs at `http://localhost:3001` by default.

### Environment Variables

Create a `.env.local` file:

```env
# Mempool/Esplora instance for chain queries and broadcasting
NEXT_PUBLIC_MEMPOOL_HOST=http://127.0.0.1:3006

# Mempool explorer URL for transaction links in the UI
NEXT_PUBLIC_MEMPOOL_EXPLORER=https://mempool.space

# Bitcoin Core RPC (for submitpackage CPFP)
NEXT_PUBLIC_RPC_HOST=http://127.0.0.1:8332
NEXT_PUBLIC_RPC_USER=your_rpc_user
NEXT_PUBLIC_RPC_PASSWORD=your_rpc_password
```

## Usage

### 1. Import Exit Data

On the home page, click **Load Exit Data** and select the JSON file exported from your Spark wallet. The file contains:

- `identityPublicKey` — your wallet's identity public key
- `leaves` — the leaf nodes with their tree IDs, values, and ancestor chains
- `serializedNodes` — protobuf-encoded tree nodes containing pre-signed transactions

The app decodes the tree structure and shows a summary of trees, leaves, total value, and the number of broadcast steps required.

### 2. Fund the CPFP Wallet

Go to the **Wallet** tab and create or import a wallet. This wallet provides UTXOs to pay mining fees via CPFP (Child Pays For Parent), since the pre-signed exit transactions are zero-fee TRUC (v3) transactions with ephemeral anchor outputs.

Send a small amount of Bitcoin to the displayed address (a few thousand sats is typically sufficient).

### 3. Start Broadcasting

Go to the **Exit** tab and click **Start Broadcasting**. The app will:

- Broadcast intermediate node transactions in order (root to leaf)
- Wait for each to confirm (TRUC policy: one unconfirmed tx per tree at a time)
- Build and submit CPFP packages via `submitpackage` RPC for zero-fee transactions
- Wait for CSV timelocks to expire after intermediates confirm
- Broadcast the leaf node transaction
- Wait for the leaf CSV timelock, then broadcast the refund transaction
- Detect trees that were already exited (cooperative close or operator-broadcast exits)

The broadcast loop runs continuously, polling every 2-15 seconds.

### 4. Sweep Recovered Funds

Once a tree reaches **Complete** or **Already Exited** status, a **Sweep Funds** panel appears on the tree card:

1. Enter your **Spark wallet mnemonic** (the seed phrase, not the CPFP wallet mnemonic)
2. Click **Verify Mnemonic** — the app derives your signing key and confirms it matches the tree data
3. Enter a **destination Bitcoin address** (any wallet you control)
4. Set a **fee rate** (sat/vB)
5. Click **Sweep** — the app finds the on-chain refund UTXOs, signs sweep transactions with your derived key, and broadcasts them

### Key Derivation

Spark uses a custom HD derivation path:

```
m/8797555'/{account}'/0'  — identity key
m/8797555'/{account}'/1'  — signing key (base)
```

For each leaf node, the signing key is further derived:

```
leaf_child = sha256(leaf_id)[0..4] as uint32 BE % 2^31
signing_key.derive_child(leaf_child + 2^31)  — leaf signing key (hardened)
```

The refund transaction destination is `p2tr(leaf_signing_key)` — a Taproot address derived from your leaf signing key with a BIP341 tweak. The sweep transaction spends from this address using a key-path spend.

## Architecture

```
src/
├── app/
│   ├── page.tsx              # Import screen — load exit JSON
│   ├── exit/page.tsx         # Exit progress — broadcast control
│   ├── wallet/page.tsx       # CPFP wallet management
│   ├── sweep/route.ts        # API: build and sign sweep transactions
│   ├── verify-mnemonic/      # API: verify mnemonic matches tree data
│   ├── decode-node/          # API: decode protobuf tree nodes
│   ├── decode-refund-tx/     # API: parse refund transaction details
│   ├── rpc/route.ts          # Proxy to Bitcoin Core RPC
│   └── scan-keys/            # API: scan derivation paths for key matching
├── components/
│   ├── broadcast-progress.tsx # Tree progress card with step details
│   ├── sweep-panel.tsx       # Sweep UI for completed trees
│   ├── leaf-row.tsx          # Individual step row with mempool links
│   └── status-badge.tsx      # Status indicator badges
├── context/
│   └── ExitContext.tsx        # Broadcast state management and loop
└── lib/
    ├── broadcaster.ts         # Mempool API, submitpackage RPC, phase logic
    ├── tree-parser.ts         # Parse exit JSON into broadcast trees
    ├── tx-parser.ts           # Raw Bitcoin transaction parser
    ├── wallet.ts              # CPFP wallet (HD key derivation, tx signing)
    ├── storage.ts             # LocalStorage persistence
    ├── types.ts               # TypeScript type definitions
    └── proto/
        └── tree-node.ts       # Protobuf decoder for Spark TreeNode
```

## Transaction Flow

```
Root UTXO
  └─ Intermediate Node Tx (no CSV, zero-fee + CPFP anchor)
       └─ Intermediate Node Tx ...
            └─ Leaf Node Tx (CSV timelock, zero-fee + CPFP anchor)
                 └─ Refund Tx (CSV timelock, sends to p2tr(your_signing_key))
                      └─ Sweep Tx (you sign, sends to your wallet)
```

Each tree also has **direct** transaction variants (no anchor output, fee paid from the output value) that the Spark operators may broadcast on your behalf. The app detects these via on-chain outspend lookups.

## Security Notes

- Your Spark mnemonic is only used client-side for key derivation and transaction signing. It is sent to the Next.js API routes which run on your local machine — never to any external service.
- The CPFP wallet mnemonic is separate from your Spark mnemonic and only used for fee-bumping.
- All pre-signed transactions are already signed with FROST threshold signatures and cannot be modified.
- Sweep transactions are standard Taproot key-path spends signed with your derived private key.

## License

MIT
