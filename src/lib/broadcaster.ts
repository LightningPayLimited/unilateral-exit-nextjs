/**
 * Mempool.space API client, bitcoind RPC, and broadcast orchestration.
 */

import type { BroadcastTree, BroadcastStep, ExitState } from './types';
import { BroadcastPhase, StepStatus } from './types';

const DEFAULT_MEMPOOL_URL = '/mempool';
const DEFAULT_RPC_URL = '/rpc';

export async function broadcastTx(
  txHex: string,
  baseUrl: string = DEFAULT_MEMPOOL_URL,
): Promise<{ txid?: string; error?: string }> {
  try {
    console.log(`[broadcast] POST ${baseUrl}/api/tx (${txHex.length / 2} bytes)`);
    const response = await fetch(`${baseUrl}/api/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: txHex,
    });

    const rawText = await response.text();
    console.log(`[broadcast] status=${response.status} response=${rawText.slice(0, 200)}`);

    if (response.ok) {
      return { txid: rawText.trim() };
    }

    let errorText = rawText;
    try {
      const parsed = JSON.parse(rawText);
      if (parsed.error) errorText = parsed.error;
    } catch {
      // Not JSON, use raw text
    }
    const errorLower = errorText.toLowerCase();
    console.log(`[broadcast] parsed error: ${errorLower}`);

    let rpcCode: number | null = null;
    const codeMatch = errorLower.match(/code["\s:]*(-?\d+)/);
    if (codeMatch) {
      rpcCode = parseInt(codeMatch[1], 10);
      console.log(`[broadcast] RPC error code: ${rpcCode}`);
    }

    if (errorLower.includes('already in') || errorLower.includes('txn-already-known') || errorLower.includes('already-in-chain')) {
      console.log('[broadcast] tx already known/in-chain, treating as success');
      return { txid: rawText.trim() };
    }

    if (errorLower.includes('missingorspent') || errorLower.includes('missing-inputs') || rpcCode === -25) {
      console.log('[broadcast] RPC -25 / inputs missing or spent');
      return { error: 'missing-inputs' };
    }

    if (errorLower.includes('non-bip68-final')) {
      console.log('[broadcast] CSV timelock not yet elapsed');
      return { error: 'csv-not-elapsed' };
    }

    if (rpcCode === -26) {
      if (errorLower.includes('too-long-mempool-chain') || errorLower.includes('unconfirmed-ancestor')) {
        console.log('[broadcast] TRUC/ancestor limit - need to wait for parent confirmation');
        return { error: 'wait-for-parent' };
      }
      console.log('[broadcast] RPC -26: policy rejection (likely needs CPFP fee bump)');
      return { error: 'needs-cpfp' };
    }

    // -27 = tx already in chain (confirmed)
    if (rpcCode === -27) {
      console.log('[broadcast] tx already confirmed in blockchain');
      return { error: 'already-confirmed' };
    }

    console.log('[broadcast] unhandled error:', errorText);
    return { error: errorText };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Network error';
    console.log('[broadcast] network error:', msg);
    return { error: msg };
  }
}

export async function getTxStatus(
  txid: string,
  baseUrl: string = DEFAULT_MEMPOOL_URL,
): Promise<{ confirmed: boolean; blockHeight?: number }> {
  try {
    const response = await fetch(`${baseUrl}/api/tx/${txid}`);
    if (!response.ok) return { confirmed: false };
    const data = await response.json();
    if (data.status?.confirmed) {
      return { confirmed: true, blockHeight: data.status.block_height };
    }
    return { confirmed: false };
  } catch {
    return { confirmed: false };
  }
}

export async function getCurrentBlockHeight(
  baseUrl: string = DEFAULT_MEMPOOL_URL,
): Promise<number> {
  const response = await fetch(`${baseUrl}/api/blocks/tip/height`);
  const text = await response.text();
  return parseInt(text, 10);
}

/**
 * Submit a package of transactions via bitcoind submitpackage RPC.
 */
export async function submitPackage(
  txHexs: string[],
  rpcUrl: string = DEFAULT_RPC_URL,
  rpcUser: string = '',
  rpcPassword: string = '',
): Promise<{ txids?: string[]; error?: string }> {
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (rpcUser) {
      headers['Authorization'] = 'Basic ' + btoa(`${rpcUser}:${rpcPassword}`);
    }

    console.log(`[submitpackage] submitting ${txHexs.length} txs to ${rpcUrl}`);
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'submitpackage',
        params: [txHexs],
      }),
    });

    const data = await response.json();
    console.log(`[submitpackage] response:`, JSON.stringify(data).slice(0, 500));

    if (data.error) {
      return { error: `RPC error ${data.error.code}: ${data.error.message}` };
    }

    if (data.result) {
      const txResults = data.result['tx-results'] || {};
      const packageMsg = data.result['package_msg'] || '';

      if (packageMsg === 'success') {
        const txids = Object.keys(txResults).map(
          wtxid => txResults[wtxid].txid || wtxid,
        );
        console.log(`[submitpackage] success: ${txids.join(', ')}`);
        return { txids };
      }

      const errors: string[] = [];
      for (const [wtxid, result] of Object.entries(txResults) as [string, any][]) {
        if (result.error) {
          errors.push(`${result.txid?.slice(0, 12) || wtxid.slice(0, 12)}: ${result.error}`);
        }
      }
      const errorMsg = errors.length > 0
        ? `Package failed: ${errors.join('; ')}`
        : `Package rejected: ${packageMsg}`;
      console.log(`[submitpackage] ${errorMsg}`);
      return { error: errorMsg };
    }

    return { error: 'Unknown RPC response' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Network error';
    console.log(`[submitpackage] error: ${msg}`);
    return { error: msg };
  }
}

/**
 * Get recommended fee rate from mempool.space.
 */
export async function getFeeRate(
  baseUrl: string = DEFAULT_MEMPOOL_URL,
): Promise<number> {
  try {
    const response = await fetch(`${baseUrl}/api/v1/fees/recommended`);
    const data = await response.json();
    return data.economyFee || data.hourFee || 2;
  } catch {
    return 2;
  }
}

/**
 * Determine the current phase for a tree based on step statuses.
 */
export function determinePhase(
  tree: BroadcastTree,
  stepStatuses: Record<string, StepStatus>,
): BroadcastPhase {
  const intermediateSteps = tree.steps.filter(s => s.type === 'intermediate');
  const leafNodeSteps = tree.steps.filter(s => s.type === 'leaf-node');
  const leafRefundSteps = tree.steps.filter(s => s.type === 'leaf-refund');

  const allRefundsConfirmed = leafRefundSteps.every(
    s => stepStatuses[s.id] === StepStatus.CONFIRMED,
  );
  if (allRefundsConfirmed && leafRefundSteps.length > 0) return BroadcastPhase.COMPLETE;

  const anyRefundActive = leafRefundSteps.some(s => {
    const st = stepStatuses[s.id];
    return st === StepStatus.BROADCAST || st === StepStatus.BROADCASTING;
  });
  if (anyRefundActive) return BroadcastPhase.LEAF_REFUND;

  const allLeafNodesConfirmed = leafNodeSteps.every(
    s => stepStatuses[s.id] === StepStatus.CONFIRMED,
  );
  const anyRefundWaitingCsv = leafRefundSteps.some(
    s => stepStatuses[s.id] === StepStatus.WAITING_CSV,
  );
  if (allLeafNodesConfirmed && anyRefundWaitingCsv) return BroadcastPhase.WAITING_REFUND_CSV;

  const anyLeafNodeActive = leafNodeSteps.some(s => {
    const st = stepStatuses[s.id];
    return st === StepStatus.BROADCAST || st === StepStatus.BROADCASTING;
  });
  if (anyLeafNodeActive) return BroadcastPhase.LEAF_NODE;

  const allIntermediatesConfirmed = intermediateSteps.every(
    s => stepStatuses[s.id] === StepStatus.CONFIRMED,
  );
  const anyLeafNodeWaitingCsv = leafNodeSteps.some(
    s => stepStatuses[s.id] === StepStatus.WAITING_CSV,
  );
  if (
    (allIntermediatesConfirmed || intermediateSteps.length === 0) &&
    anyLeafNodeWaitingCsv
  ) {
    return BroadcastPhase.WAITING_LEAF_CSV;
  }

  return BroadcastPhase.INTERMEDIATES;
}

/**
 * Get the next step to broadcast for a tree, respecting TRUC limits and CSV timelocks.
 */
export function getNextStep(
  tree: BroadcastTree,
  stepStatuses: Record<string, StepStatus>,
  csvTargetHeights: Record<string, number>,
  currentBlockHeight: number,
): BroadcastStep | null {
  const phase = determinePhase(tree, stepStatuses);

  switch (phase) {
    case BroadcastPhase.COMPLETE:
    case BroadcastPhase.ALREADY_EXITED:
      return null;

    case BroadcastPhase.INTERMEDIATES: {
      const intermediates = tree.steps.filter(s => s.type === 'intermediate');
      for (const step of intermediates) {
        const status = stepStatuses[step.id];
        if (!status || status === StepStatus.PENDING || status === StepStatus.FAILED) {
          return step;
        }
      }
      const leafNodes = tree.steps.filter(s => s.type === 'leaf-node');
      for (const step of leafNodes) {
        const status = stepStatuses[step.id];
        if (!status || status === StepStatus.PENDING) {
          return step;
        }
      }
      return null;
    }

    case BroadcastPhase.WAITING_LEAF_CSV: {
      const leafNodes = tree.steps.filter(s => s.type === 'leaf-node');
      for (const step of leafNodes) {
        const status = stepStatuses[step.id];
        if (status === StepStatus.WAITING_CSV) {
          const target = csvTargetHeights[step.id];
          if (target && currentBlockHeight >= target) {
            return step;
          }
        }
      }
      return null;
    }

    case BroadcastPhase.LEAF_NODE: {
      const leafNodes = tree.steps.filter(s => s.type === 'leaf-node');
      for (const step of leafNodes) {
        const status = stepStatuses[step.id];
        if (!status || status === StepStatus.PENDING || status === StepStatus.FAILED) {
          return step;
        }
      }
      return null;
    }

    case BroadcastPhase.WAITING_REFUND_CSV: {
      const leafRefunds = tree.steps.filter(s => s.type === 'leaf-refund');
      for (const step of leafRefunds) {
        const status = stepStatuses[step.id];
        if (status === StepStatus.WAITING_CSV) {
          const target = csvTargetHeights[step.id];
          if (target && currentBlockHeight >= target) {
            return step;
          }
        }
      }
      return null;
    }

    case BroadcastPhase.LEAF_REFUND: {
      const leafRefunds = tree.steps.filter(s => s.type === 'leaf-refund');
      for (const step of leafRefunds) {
        const status = stepStatuses[step.id];
        if (!status || status === StepStatus.PENDING || status === StepStatus.FAILED) {
          return step;
        }
      }
      return null;
    }
  }

  return null;
}
