/**
 * Parse exported unilateral exit JSON into broadcast trees.
 */

import { hexToBytes, bytesToHex } from './hex-utils';
import { TreeNodeCodec } from './proto/tree-node';
import { parseTx, extractCsvBlocks } from './tx-parser';
import type { UniexitData, DecodedNode, BroadcastTree, BroadcastStep, ExtractedLeaf } from './types';

/**
 * Decode all serialized nodes from the JSON export.
 */
function decodeNodes(serializedNodes: Record<string, string>): Map<string, DecodedNode> {
  const nodes = new Map<string, DecodedNode>();

  for (const [id, hex] of Object.entries(serializedNodes)) {
    const bytes = hexToBytes(hex);
    const treeNode = TreeNodeCodec.decode(bytes);
    nodes.set(id, {
      id: treeNode.id,
      treeId: treeNode.treeId,
      value: treeNode.value,
      parentNodeId: treeNode.parentNodeId,
      nodeTxHex: bytesToHex(treeNode.nodeTx),
      refundTxHex: bytesToHex(treeNode.refundTx),
      vout: treeNode.vout,
      status: treeNode.status,
      network: treeNode.network,
    });
  }

  return nodes;
}

/**
 * Parse the full tree state JSON into broadcast trees with ordered steps.
 */
export function parseTreeState(data: UniexitData): BroadcastTree[] {
  const nodes = decodeNodes(data.serializedNodes);

  // Group leaves by treeId
  const treeLeaves = new Map<string, ExtractedLeaf[]>();
  for (const leaf of data.leaves) {
    const existing = treeLeaves.get(leaf.treeId) ?? [];
    existing.push(leaf);
    treeLeaves.set(leaf.treeId, existing);
  }

  const trees: BroadcastTree[] = [];

  for (const [treeId, leaves] of treeLeaves) {
    // Collect all unique ancestor node IDs across leaves
    const intermediateIds = new Set<string>();
    const intermediateOrder: string[] = [];

    for (const leaf of leaves) {
      const startIdx = nodes.has(leaf.ancestorChain[0]) ? 0 : 1;
      for (let i = startIdx; i < leaf.ancestorChain.length - 1; i++) {
        const nodeId = leaf.ancestorChain[i];
        if (!intermediateIds.has(nodeId)) {
          intermediateIds.add(nodeId);
          intermediateOrder.push(nodeId);
        }
      }
    }

    // Build broadcast steps
    const steps: BroadcastStep[] = [];

    // Intermediate nodes: broadcast nodeTx only (CSV disabled for these)
    for (let i = 0; i < intermediateOrder.length; i++) {
      const nodeId = intermediateOrder[i];
      const node = nodes.get(nodeId);
      if (!node) {
        console.warn(`Intermediate node ${nodeId} not found in serializedNodes`);
        continue;
      }

      const parsed = parseTx(node.nodeTxHex);
      const csvBlocks = extractCsvBlocks(parsed.inputs[0].nSequence);

      steps.push({
        id: `${nodeId}-intermediate`,
        nodeId,
        txHex: node.nodeTxHex,
        type: 'intermediate',
        csvBlocks,
        depth: i + 1,
      });
    }

    // Leaf nodes: broadcast nodeTx (with CSV), then refundTx (with CSV)
    for (const leaf of leaves) {
      const leafId = leaf.leafId;
      const node = nodes.get(leafId);
      if (!node) {
        console.warn(`Leaf node ${leafId} not found in serializedNodes`);
        continue;
      }

      const parsedNodeTx = parseTx(node.nodeTxHex);
      const nodeCsv = extractCsvBlocks(parsedNodeTx.inputs[0].nSequence);

      steps.push({
        id: `${leafId}-leaf-node`,
        nodeId: leafId,
        txHex: node.nodeTxHex,
        type: 'leaf-node',
        csvBlocks: nodeCsv,
        depth: leaf.ancestorChain.length - 1,
      });

      const parsedRefundTx = parseTx(node.refundTxHex);
      const refundCsv = extractCsvBlocks(parsedRefundTx.inputs[0].nSequence);

      steps.push({
        id: `${leafId}-leaf-refund`,
        nodeId: leafId,
        txHex: node.refundTxHex,
        type: 'leaf-refund',
        csvBlocks: refundCsv,
        depth: leaf.ancestorChain.length,
      });
    }

    const totalValue = leaves.reduce((sum, l) => sum + l.value, 0);

    trees.push({
      treeId,
      totalValue,
      leaves,
      steps,
    });
  }

  return trees;
}
