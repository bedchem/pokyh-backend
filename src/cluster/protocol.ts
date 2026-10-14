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

const address = z.string().min(1).max(255);
// Over the channel, the initiator announces every way to reach it, separated
// by spaces (endpoints.ts).
const addressList = z.string().min(1).max(2_600);

// Version 3: over the mutually authenticated channel, with the certificates
// of the connection bound into the handshake (crypto.ts).
const handshakeVersion = z.union([z.literal(2), z.literal(3)]);

export const pairInitSchema = z.object({
  v: handshakeVersion,
  from: nodeId,
  name: nodeName,
  // Where the initiator can be reached; the responder stores it as the
  // peer's address. Covered by the MAC, so it cannot be swapped in transit.
  addr: addressList,
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
  v: handshakeVersion,
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

const channelAdvert = z.object({
  url: z.string().max(255),
  cert: z.string().max(4096),
  // Every way to reach it, in order (endpoints.ts); `url` is the first.
  endpoints: z.array(z.string().max(300)).max(8).optional(),
});

// What a node tells the others about its version and updates (updates.ts).
const commitHash = z.string().regex(/^[0-9a-f]{40}$/);
export const updateAdvertSchema = z.object({
  commit: commitHash.nullable(),
  // Updated by Pokyh's updater (false: e.g. Dokploy).
  self: z.boolean(),
  state: z.string().max(20),
  target: commitHash.nullable(),
  // The commit an update to failed on the sender; stops the rollout.
  failed: commitHash.nullable(),
  // The sender's build, offered to nodes that update after it.
  build: z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.number().int().min(1).max(512 * 1024 * 1024) }).nullable(),
});
export type UpdateAdvert = z.infer<typeof updateAdvertSchema>;

export const heartbeatSchema = z.object({
  t: z.number(),
  name: nodeName,
  schema: z.string().max(64),
  appVersion: z.string().max(40),
  captureReady: z.boolean(),
  // Rows this node still has to deliver to the receiver.
  pending: z.boolean(),
  secrets: z.object({ jwt: z.string().max(64), apiKey: z.string().max(64), serverKey: z.string().max(64) }),
  // The sender's links and the pairings it has open, so nodes can see which
  // pairs of them are not linked yet (see mesh.ts).
  peers: z.array(z.object({ id: nodeId, health: z.string().max(12), address: z.string().max(255) })).max(64),
  pairing: z.array(nodeId).max(64),
  // Nodes the sender refuses to link with (removed or switched off by an
  // administrator), and the address it can be reached at.
  blocked: z.array(nodeId).max(64),
  addr: z.string().max(255),
  // The sender's mutually authenticated channel and certificate, so a link
  // made before the channel existed moves onto it by itself. Null while the
  // sender has no channel.
  tls: channelAdvert.nullable().optional(),
  // The way the sender currently reaches the receiver (for its status page).
  via: z.string().max(300).nullable().optional(),
  // Version and update state (older nodes send none).
  upd: updateAdvertSchema.nullable().optional(),
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

// A common peer asks the receiver to pair with another node (mesh.ts).
// HOST: wait for that node to call; JOIN: call it at `addr`.
// With `tls`, the two pair over the mutually authenticated channel and each
// learns the other's certificate from the introducer, which holds both pinned.
export const introduceSchema = z.object({
  node: nodeId,
  name: nodeName,
  addr: z.string().max(255),
  role: z.union([z.literal('HOST'), z.literal('JOIN')]),
  secret: z.string().min(32).max(128),
  tls: channelAdvert.nullable().optional(),
});

// A peer replaces its certificate (mtls.ts rotation); sent over the current,
// still authenticated link.
export const certRotateSchema = z.object({
  cert: z.string().max(4096),
});

// Data checks (verify.ts). A digest summarises rows per group: count and an
// XOR of per-row hashes, so two nodes compare thousands of rows with a few
// numbers and descend only into groups that differ.
export const digestRequestSchema = z.object({
  t: tableName.nullable(),
  p: z.string().regex(/^[0-9a-f]{0,6}$/),
  // Tombstones older than this version are left out on both sides: they may
  // already be pruned on one of them.
  floor: version,
});
export const digestReplySchema = z.object({
  groups: z.array(z.tuple([z.string().max(64), z.number().int().nonnegative(), z.string().regex(/^[0-9]{1,20}$/)])).max(4096),
});
export const rowsRequestSchema = z.object({
  t: tableName,
  // Empty for a table small enough to be compared row by row at once.
  p: z.string().regex(/^[0-9a-f]{0,6}$/),
  floor: version,
});
export const rowsReplySchema = z.object({
  // [key hash, version, origin, deleted]
  rows: z.array(z.tuple([pkHash, version, nodeId, z.union([z.literal(0), z.literal(1)])])).max(20_000),
  truncated: z.boolean(),
});
