import type { Catalog } from './catalog';
import type { Endpoint } from './endpoints';
import type { Health } from './health';
import type { ReplayWindow } from './crypto';

// Shared in-memory state of the cluster layer. Durable facts (identity, peers,
// keys, queues) live in the database; everything here is rebuilt after a
// restart from the database and the first heartbeats.

// 'tls': over the mutually authenticated channel (mtls.ts), with the session
// bound to the certificates of that connection; 'plain': over the public
// path or CLUSTER_PORT, protected by the frame layer alone.
export type Channel = 'tls' | 'plain';

export interface ClientSession {
  channel: Channel;
  sid: Buffer;
  c2s: Buffer;
  s2c: Buffer;
  counter: bigint;
  createdAt: number;
}

export interface ServerSession {
  peerRowId: string;
  // Pin of the client certificate the session was opened with; every call of
  // the session must come over a connection with that certificate. Null for
  // a session opened outside the mutually authenticated channel.
  channelPin: string | null;
  sid: Buffer;
  c2s: Buffer;
  s2c: Buffer;
  replay: ReplayWindow;
  createdAt: number;
  lastUsedAt: number;
}

// A peer's pinned certificate and where its channel is reached.
export interface PeerTls {
  url: string;
  // Every way it announced, in its order of preference; `url` is the first.
  endpoints: Endpoint[];
  pin: string;
  certPem: string;
  // The certificate it used before a rotation, accepted until `until`.
  previous: { pin: string; certPem: string; until: number } | null;
}

export interface RemoteView {
  name: string | null;
  schema: string | null;
  appVersion: string | null;
  captureReady: boolean | null;
  // The peers the other node is linked with, and the ones it is pairing with.
  peers: Array<{ id: string; health: string; address: string }>;
  pairing: string[];
  blocked: string[];
  // The address the other node announces for itself.
  addr: string;
  // The way the other node currently reaches this one (its report).
  via: string | null;
}

// Where a peer stands in this node's change feed. The durable part
// (`cursor`, cluster_peers.sent_seq) only ever moves to positions whose
// changes are all committed and delivered; the rest lives in memory and is
// rebuilt after a restart by offering instead of sending.
export interface FeedProgress {
  cursor: bigint;
  // Furthest position read so far; reading continues from here.
  readTo: bigint;
  // Rows delivered beyond the cursor, by table|hash → version, so the regular
  // re-read of the recent span does not send them again.
  sent: Map<string, { version: bigint; seq: bigint }>;
  // When the oldest change not yet sent was first seen, and when the newest
  // change in the feed appeared.
  pendingSince: number | null;
  lastNewAt: number;
  lastHead: bigint;
  // A sweep in progress (replicator.ts), and when the last one finished.
  sweep: { pos: bigint; until: bigint; stable: bigint } | null;
  lastSweepAt: number;
  lastPersistAt: number;
  // When the peer was last told that nothing further is waiting for it.
  drainAnnouncedAt: number;
}

export function newFeedProgress(cursor: bigint): FeedProgress {
  return {
    cursor,
    readTo: cursor,
    sent: new Map(),
    pendingSince: null,
    lastNewAt: Date.now(),
    lastHead: 0n,
    sweep: null,
    lastSweepAt: 0,
    lastPersistAt: 0,
    drainAnnouncedAt: 0,
  };
}

export interface VerifyState {
  running: boolean;
  lastAt: number | null;
  // Rows that differed and were offered to the peer in the last check.
  repaired: number;
  lastError: string | null;
}

export interface PeerRuntime {
  rowId: string;
  nodeId: string;
  name: string;
  baseUrl: string;
  linkKey: Buffer;
  health: Health;
  failures: number;
  lastSeenAt: number | null;
  // Last successful heartbeat sent by this node; drives the long-absence check.
  lastHeartbeatAt: number | null;
  heartbeating: boolean;
  lastError: string | null;
  latencyMs: number | null;
  skewMs: number | null;
  remote: RemoteView;
  // null until the first heartbeat told us.
  schemaMatch: boolean | null;
  secretsMatch: { jwt: boolean | null; apiKey: boolean | null; serverKey: boolean | null };
  session: ClientSession | null;
  handshake: { channel: Channel; promise: Promise<ClientSession> } | null;
  // The mutually authenticated channel: the pinned certificate, whether the
  // link is locked to it (no other path accepted any more), which directions
  // have worked over it since the start, and until when a failed attempt
  // makes calls use the other path (only while not locked).
  tls: PeerTls | null;
  tlsLocked: boolean;
  tlsOutOk: boolean;
  tlsInOk: boolean;
  tlsRetryAt: number;
  syncing: boolean;
  lastSyncAt: number | null;
  lastSyncError: string | null;
  nextSyncAt: number;
  syncBackoffMs: number;
  rowsSent: number;
  rowsReceived: number;
  // When the peer last reported that it has nothing further queued for us.
  drainedAt: number | null;
  // Set when the peer was out of contact for longer than deleted rows are
  // remembered; replication then waits for an administrator's decision.
  stale: boolean;
  // A complete transfer to the peer is under way (cluster_peers.scan_active).
  transferActive: boolean;
  feed: FeedProgress;
  verify: VerifyState;
}

export interface ClusterEvent {
  at: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export const state = {
  started: false,
  // Replication is paused while the database is being restored.
  paused: false,
  nodeId: '',
  nodeName: '',
  // Saved address of this node (see pairing.advertisedAddress).
  advertiseUrl: '',
  catalog: null as Catalog | null,
  // True once the capture triggers are verified to be in place.
  captureReady: false,
  captureError: null as string | null,
  // Set when writes may have happened while no capture trigger was installed.
  captureGap: false,
  peers: new Map<string, PeerRuntime>(),
  // Feed position at start-up. Rows recorded up to here may have reached a
  // peer before the restart, so they are offered by version, not sent.
  startupSeq: 0n,
  serverSessions: new Map<string, ServerSession>(),
  events: [] as ClusterEvent[],
};

const MAX_EVENTS = 100;

export function recordEvent(level: ClusterEvent['level'], message: string): void {
  state.events.push({ at: new Date().toISOString(), level, message });
  if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
}

export function peerByNodeId(nodeId: string): PeerRuntime | undefined {
  for (const peer of state.peers.values()) {
    if (peer.nodeId === nodeId) return peer;
  }
  return undefined;
}

export function emptyRemoteView(): RemoteView {
  return { name: null, schema: null, appVersion: null, captureReady: null, peers: [], pairing: [], blocked: [], addr: '', via: null };
}

export function nowMicros(): bigint {
  return BigInt(Date.now()) * 1000n;
}
