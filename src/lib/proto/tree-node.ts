/**
 * Extracted protobuf decoders for TreeNode and dependencies.
 * Source: @buildonspark/spark-sdk/src/proto/spark.ts
 * Only decode methods are included - encode/fromJSON/toJSON/create/fromPartial omitted.
 */

import { BinaryReader } from '@bufbuild/protobuf/wire';

// --- Timestamp ---

interface Timestamp {
  seconds: number;
  nanos: number;
}

function createBaseTimestamp(): Timestamp {
  return { seconds: 0, nanos: 0 };
}

const TimestampCodec = {
  decode(input: BinaryReader | Uint8Array, length?: number): Timestamp {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    const end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseTimestamp();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1: {
          if (tag !== 8) break;
          message.seconds = longToNumber(reader.int64());
          continue;
        }
        case 2: {
          if (tag !== 16) break;
          message.nanos = reader.int32();
          continue;
        }
      }
      if ((tag & 7) === 4 || tag === 0) break;
      reader.skip(tag & 7);
    }
    return message;
  },
};

// --- SigningKeyshare_PublicSharesEntry ---

interface SigningKeyshare_PublicSharesEntry {
  key: string;
  value: Uint8Array;
}

function createBasePublicSharesEntry(): SigningKeyshare_PublicSharesEntry {
  return { key: '', value: new Uint8Array(0) };
}

const PublicSharesEntryCodec = {
  decode(input: BinaryReader | Uint8Array, length?: number): SigningKeyshare_PublicSharesEntry {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    const end = length === undefined ? reader.len : reader.pos + length;
    const message = createBasePublicSharesEntry();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1: {
          if (tag !== 10) break;
          message.key = reader.string();
          continue;
        }
        case 2: {
          if (tag !== 18) break;
          message.value = reader.bytes();
          continue;
        }
      }
      if ((tag & 7) === 4 || tag === 0) break;
      reader.skip(tag & 7);
    }
    return message;
  },
};

// --- SigningKeyshare ---

export interface SigningKeyshare {
  ownerIdentifiers: string[];
  threshold: number;
  publicKey: Uint8Array;
  publicShares: { [key: string]: Uint8Array };
  updatedTime: Date | undefined;
}

function createBaseSigningKeyshare(): SigningKeyshare {
  return {
    ownerIdentifiers: [],
    threshold: 0,
    publicKey: new Uint8Array(0),
    publicShares: {},
    updatedTime: undefined,
  };
}

const SigningKeyshareCodec = {
  decode(input: BinaryReader | Uint8Array, length?: number): SigningKeyshare {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    const end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseSigningKeyshare();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1: {
          if (tag !== 10) break;
          message.ownerIdentifiers.push(reader.string());
          continue;
        }
        case 2: {
          if (tag !== 16) break;
          message.threshold = reader.uint32();
          continue;
        }
        case 3: {
          if (tag !== 26) break;
          message.publicKey = reader.bytes();
          continue;
        }
        case 4: {
          if (tag !== 34) break;
          const entry = PublicSharesEntryCodec.decode(reader, reader.uint32());
          if (entry.value !== undefined) {
            message.publicShares[entry.key] = entry.value;
          }
          continue;
        }
        case 5: {
          if (tag !== 42) break;
          message.updatedTime = fromTimestamp(TimestampCodec.decode(reader, reader.uint32()));
          continue;
        }
      }
      if ((tag & 7) === 4 || tag === 0) break;
      reader.skip(tag & 7);
    }
    return message;
  },
};

// --- TreeNode ---

export interface TreeNode {
  id: string;
  treeId: string;
  value: number;
  parentNodeId?: string;
  nodeTx: Uint8Array;
  refundTx: Uint8Array;
  vout: number;
  verifyingPublicKey: Uint8Array;
  ownerIdentityPublicKey: Uint8Array;
  signingKeyshare: SigningKeyshare | undefined;
  status: string;
  network: number;
  createdTime: Date | undefined;
  updatedTime: Date | undefined;
  ownerSigningPublicKey: Uint8Array;
  directTx: Uint8Array;
  directRefundTx: Uint8Array;
  directFromCpfpRefundTx: Uint8Array;
}

function createBaseTreeNode(): TreeNode {
  return {
    id: '',
    treeId: '',
    value: 0,
    parentNodeId: undefined,
    nodeTx: new Uint8Array(0),
    refundTx: new Uint8Array(0),
    vout: 0,
    verifyingPublicKey: new Uint8Array(0),
    ownerIdentityPublicKey: new Uint8Array(0),
    signingKeyshare: undefined,
    status: '',
    network: 0,
    createdTime: undefined,
    updatedTime: undefined,
    ownerSigningPublicKey: new Uint8Array(0),
    directTx: new Uint8Array(0),
    directRefundTx: new Uint8Array(0),
    directFromCpfpRefundTx: new Uint8Array(0),
  };
}

export const TreeNodeCodec = {
  decode(input: BinaryReader | Uint8Array, length?: number): TreeNode {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    const end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseTreeNode();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1: {
          if (tag !== 10) break;
          message.id = reader.string();
          continue;
        }
        case 2: {
          if (tag !== 18) break;
          message.treeId = reader.string();
          continue;
        }
        case 3: {
          if (tag !== 24) break;
          message.value = longToNumber(reader.uint64());
          continue;
        }
        case 4: {
          if (tag !== 34) break;
          message.parentNodeId = reader.string();
          continue;
        }
        case 5: {
          if (tag !== 42) break;
          message.nodeTx = reader.bytes();
          continue;
        }
        case 6: {
          if (tag !== 50) break;
          message.refundTx = reader.bytes();
          continue;
        }
        case 7: {
          if (tag !== 56) break;
          message.vout = reader.uint32();
          continue;
        }
        case 8: {
          if (tag !== 66) break;
          message.verifyingPublicKey = reader.bytes();
          continue;
        }
        case 9: {
          if (tag !== 74) break;
          message.ownerIdentityPublicKey = reader.bytes();
          continue;
        }
        case 10: {
          if (tag !== 82) break;
          message.signingKeyshare = SigningKeyshareCodec.decode(reader, reader.uint32());
          continue;
        }
        case 11: {
          if (tag !== 90) break;
          message.status = reader.string();
          continue;
        }
        case 12: {
          if (tag !== 96) break;
          message.network = reader.int32();
          continue;
        }
        case 13: {
          if (tag !== 106) break;
          message.createdTime = fromTimestamp(TimestampCodec.decode(reader, reader.uint32()));
          continue;
        }
        case 14: {
          if (tag !== 114) break;
          message.updatedTime = fromTimestamp(TimestampCodec.decode(reader, reader.uint32()));
          continue;
        }
        case 15: {
          if (tag !== 122) break;
          message.ownerSigningPublicKey = reader.bytes();
          continue;
        }
        case 16: {
          if (tag !== 130) break;
          message.directTx = reader.bytes();
          continue;
        }
        case 17: {
          if (tag !== 138) break;
          message.directRefundTx = reader.bytes();
          continue;
        }
        case 18: {
          if (tag !== 146) break;
          message.directFromCpfpRefundTx = reader.bytes();
          continue;
        }
      }
      if ((tag & 7) === 4 || tag === 0) break;
      reader.skip(tag & 7);
    }
    return message;
  },
};

// --- Utility functions ---

function longToNumber(int64: { toString(): string }): number {
  const num = globalThis.Number(int64.toString());
  if (num > globalThis.Number.MAX_SAFE_INTEGER) {
    throw new globalThis.Error('Value is larger than Number.MAX_SAFE_INTEGER');
  }
  if (num < globalThis.Number.MIN_SAFE_INTEGER) {
    throw new globalThis.Error('Value is smaller than Number.MIN_SAFE_INTEGER');
  }
  return num;
}

function fromTimestamp(t: Timestamp): Date {
  let millis = (t.seconds || 0) * 1_000;
  millis += (t.nanos || 0) / 1_000_000;
  return new globalThis.Date(millis);
}
