import { NextRequest, NextResponse } from 'next/server';
import { TreeNodeCodec } from '@/lib/proto/tree-node';
import { hexToBytes, bytesToHex } from '@/lib/hex-utils';

export async function POST(req: NextRequest) {
  try {
    const { nodeHex } = await req.json();
    if (!nodeHex) {
      return NextResponse.json({ error: 'nodeHex required' }, { status: 400 });
    }
    const node = TreeNodeCodec.decode(hexToBytes(nodeHex));
    return NextResponse.json({
      id: node.id,
      treeId: node.treeId,
      value: node.value,
      nodeTxHex: bytesToHex(node.nodeTx),
      refundTxHex: bytesToHex(node.refundTx),
      directTxHex: bytesToHex(node.directTx),
      directRefundTxHex: bytesToHex(node.directRefundTx),
      directFromCpfpRefundTxHex: bytesToHex(node.directFromCpfpRefundTx),
      ownerSigningPublicKey: bytesToHex(node.ownerSigningPublicKey),
      verifyingPublicKey: bytesToHex(node.verifyingPublicKey),
      ownerIdentityPublicKey: bytesToHex(node.ownerIdentityPublicKey),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'decode error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
