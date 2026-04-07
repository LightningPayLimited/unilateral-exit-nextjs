// Input JSON format from Lightning Pay wallet export
export interface UniexitData {
  network: string;
  identityPublicKey: string;
  leaves: ExtractedLeaf[];
  serializedNodes: Record<string, string>;
}

export interface ExtractedLeaf {
  leafId: string;
  treeId: string;
  value: number;
  ancestorChain: string[]; // ordered root-first: [rootId, ..., leafId]
}

// After protobuf decode
export interface DecodedNode {
  id: string;
  treeId: string;
  value: number;
  parentNodeId?: string;
  nodeTxHex: string;
  refundTxHex: string;
  vout: number;
  status: string;
  network: number;
}

// Broadcast planning
export interface BroadcastTree {
  treeId: string;
  totalValue: number; // sum of leaf values in this tree
  leaves: ExtractedLeaf[];
  steps: BroadcastStep[];
}

export interface BroadcastStep {
  id: string; // unique step id: `${nodeId}-${type}`
  nodeId: string;
  txHex: string;
  type: 'intermediate' | 'leaf-node' | 'leaf-refund';
  csvBlocks: number; // 0 for intermediates (CSV disabled)
  depth: number; // position in ancestor chain
}

export enum BroadcastPhase {
  INTERMEDIATES = 'INTERMEDIATES',
  WAITING_LEAF_CSV = 'WAITING_LEAF_CSV',
  LEAF_NODE = 'LEAF_NODE',
  WAITING_REFUND_CSV = 'WAITING_REFUND_CSV',
  LEAF_REFUND = 'LEAF_REFUND',
  COMPLETE = 'COMPLETE',
  ALREADY_EXITED = 'ALREADY_EXITED',
}

export enum StepStatus {
  PENDING = 'PENDING',
  BROADCASTING = 'BROADCASTING',
  BROADCAST = 'BROADCAST',
  CONFIRMED = 'CONFIRMED',
  WAITING_CSV = 'WAITING_CSV',
  FAILED = 'FAILED',
}

// Per-tree info recorded when a tree is detected as already-exited
// (e.g. cooperatively closed by Spark before we could broadcast).
export interface CoopExitInfo {
  // The tree input we tried to spend
  prevTxid: string;
  prevVout: number;
  // The tx that actually consumed it on-chain
  spendingTxid: string;
  spendingBlockHeight?: number;
}

// Persisted state
export interface ExitState {
  importedData: UniexitData | null;
  trees: BroadcastTree[];
  treePhases: Record<string, BroadcastPhase>;
  stepStatuses: Record<string, StepStatus>;
  stepTxids: Record<string, string>;
  stepErrors: Record<string, string>;
  csvTargetHeights: Record<string, number>;
  currentBlockHeight: number;
  coopExitInfo: Record<string, CoopExitInfo>; // keyed by treeId
  isRunning: boolean;
  mempoolBaseUrl: string;
  rpcUrl: string;
  rpcUser: string;
  rpcPassword: string;
}
