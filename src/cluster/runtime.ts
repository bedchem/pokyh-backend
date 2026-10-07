import type { Catalog } from './catalog';
import type { Health } from './health';
import type { ReplayWindow } from './crypto';

// Shared in-memory state of the cluster layer. Durable facts (identity, peers,
// keys, queues) live in the database; everything here is rebuilt after a
// restart from the database and the first heartbeats.

export interface ClientSession {
  sid: Buffer;
  c2s: Buffer;
  s2c: Buffer;
  counter: bigint;
  createdAt: number;
}

export interface ServerSession {
  peerRowId: string;
  sid: Buffer;
  c2s: Buffer;
  s2c: Buffer;
  replay: ReplayWindow;
  createdAt: number;
  lastUsedAt: number;
}

export interface RemoteView {
  name: string | null;
  schema: string | null;
  appVersion: string | null;
  leader: string | null;
  captureReady: boolean | null;
  peers: Array<{ id: string; health: string }>;
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
  handshake: Promise<ClientSession> | null;
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
  catalog: null as Catalog | null,
  // True once the capture triggers are verified to be in place.
  captureReady: false,
  captureError: null as string | null,
  // Set when writes may have happened while no capture trigger was installed.
  captureGap: false,
  peers: new Map<string, PeerRuntime>(),
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
  return { name: null, schema: null, appVersion: null, leader: null, captureReady: null, peers: [] };
}

export function nowMicros(): bigint {
  return BigInt(Date.now()) * 1000n;
}
