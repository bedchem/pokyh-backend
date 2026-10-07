import { z } from 'zod';
import {
  HANDSHAKE_NONCE_BYTES,
  PAIRING_SALT_BYTES,
  SESSION_ID_BYTES,
  X25519_PUBLIC_BYTES,
} from './crypto';

// Wire formats of the node-to-node protocol. Everything a peer sends is
// validated against these schemas before it is used — a paired peer is
// trusted to hold the link key, not to be free of bugs.

export const CLUSTER_PATH = '/cluster/v1';

function fixedBytes(length: number) {
  return z.string().max(128).transform((value, ctx) => {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.length !== length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'unexpected length' });
      return z.NEVER;
    }
    return bytes;
  });
}

export function b64(bytes: Buffer): string {
  return bytes.toString('base64url');
}

const nodeId = z.string().regex(/^[A-Za-z0-9-]{8,36}$/);
const nodeName = z.string().max(120);
const mac = fixedBytes(32);

export const pairInitSchema = z.object({
  v: z.literal(1),
  from: nodeId,
  name: nodeName,
  salt: fixedBytes(PAIRING_SALT_BYTES),
  e: fixedBytes(X25519_PUBLIC_BYTES),
  n: fixedBytes(HANDSHAKE_NONCE_BYTES),
  mac,
});

export const pairAcceptSchema = z.object({
  id: nodeId,
  name: nodeName,
  e: fixedBytes(X25519_PUBLIC_BYTES),
  n: fixedBytes(HANDSHAKE_NONCE_BYTES),
  mac,
});

export const pairConfirmSchema = z.object({
  from: nodeId,
  mac,
});

export const sessionInitSchema = z.object({
  v: z.literal(1),
  from: nodeId,
  to: nodeId,
  e: fixedBytes(X25519_PUBLIC_BYTES),
  n: fixedBytes(HANDSHAKE_NONCE_BYTES),
  mac,
});

export const sessionAcceptSchema = z.object({
  sid: fixedBytes(SESSION_ID_BYTES),
  e: fixedBytes(X25519_PUBLIC_BYTES),
  n: fixedBytes(HANDSHAKE_NONCE_BYTES),
  mac,
});

// ─── Encrypted calls ─────────────────────────────────────────────────────────

const tableName = z.string().regex(/^[A-Za-z0-9_]{1,64}$/);
const pkHash = z.string().regex(/^[0-9a-f]{64}$/);
const version = z.string().regex(/^[0-9]{1,20}$/);
const wireValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const heartbeatSchema = z.object({
  t: z.number(),
  name: nodeName,
  schema: z.string().max(64),
  appVersion: z.string().max(40),
  leader: z.string().max(36),
  captureReady: z.boolean(),
  // Rows this node still has queued for the receiver.
  pending: z.boolean(),
  secrets: z.object({ jwt: z.string().max(64), apiKey: z.string().max(64), serverKey: z.string().max(64) }),
  peers: z.array(z.object({ id: nodeId, health: z.string().max(12) })).max(64),
});
export type Heartbeat = z.infer<typeof heartbeatSchema>;

// [table, key hash, version, origin, deleted]
export const offerSchema = z.object({
  items: z.array(z.tuple([tableName, pkHash, version, nodeId, z.union([z.literal(0), z.literal(1)])])).max(2000),
});
export type OfferItem = z.infer<typeof offerSchema>['items'][number];

export const wireItemSchema = z.object({
  h: pkHash,
  k: z.array(z.string().max(1024)).min(1).max(16),
  v: version,
  o: nodeId,
  d: z.union([z.literal(0), z.literal(1)]),
  r: z.array(wireValue).max(512).optional(),
});
export type WireItem = z.infer<typeof wireItemSchema>;

export const wireTableBatchSchema = z.object({
  t: tableName,
  cols: z.array(z.string().regex(/^[A-Za-z0-9_]{1,64}$/)).max(512),
  items: z.array(wireItemSchema).max(2000),
});
export type WireTableBatch = z.infer<typeof wireTableBatchSchema>;

export const pushSchema = z.object({
  batches: z.array(wireTableBatchSchema).max(256),
  // True when the sender has nothing further queued for the receiver.
  drained: z.boolean(),
});

// One letter per pushed item, in order: applied, stale, deferred, rejected.
export type ItemResult = 'a' | 's' | 'd' | 'r';
