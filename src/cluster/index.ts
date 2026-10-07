import type { ClusterPeer } from '@prisma/client';
import { prisma } from '../db';
import { config } from '../config';
import { logger } from '../utils/logger';
import { applyPush, closeApplier, deferredCount, retryDeferred, wantedFromOffer, whenApplierIdle } from './applier';
import { loadCatalog } from './catalog';
import {
  backfillVersions,
  ensureTriggers,
  pruneTombstones,
  rebuildVersions,
  startFullTransfer,
  trackedTables,
} from './capture';
import { configFingerprint, generatePairingKey, normalizePairingKey, pairingKeyProblem } from './crypto';
import { electLeader, estimateSkewMs, healthAfter, normalizePeerAddress, type Health } from './health';
import { setLeaderCheck, setRestoreWrapper } from './hooks';
import { forgetPairing, pairingProgressOf, pairingTick, setActivationHook } from './pairing';
import { heartbeatSchema, offerSchema, pushSchema, type Heartbeat } from './protocol';
import { hasPendingWork, queuedCounts, syncPeer } from './replicator';
import { emptyRemoteView, recordEvent, state, type PeerRuntime } from './runtime';
import {
  createPendingPeer,
  deletePeer,
  expirePairingWindows,
  getPeer,
  linkKeyOf,
  listPeers,
  loadOrCreateNode,
  renameNode,
  reopenPairing,
  setPeerStatus,
} from './store';
import { RpcError, dropSessionsOf, rpc, setRpcHandler, sweepSessions } from './transport';

// Entry point of the cluster layer: start-up, the periodic loops, the calls a
// peer may make, and the operations the admin API exposes.
//
// A node without configured peers is a plain standalone server. Nothing here
// installs a trigger, opens a connection or changes a query until an
// administrator adds the first peer.

const APP_VERSION = '1';
const PAIRING_TICK_MS = 5_000;
const MAINTENANCE_TICK_MS = 60_000;
const DEFERRED_RETRY_MS = 5_000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;
const LAST_SYNCED_PERSIST_MS = 10 * 60 * 1000;
const MAX_SYNC_BACKOFF_MS = 60_000;

const timers: NodeJS.Timeout[] = [];
let startedAt = 0;
let lastPruneAt = 0;
const lastSyncedPersisted = new Map<string, number>();

export class ClusterError extends Error {
  constructor(message: string, public readonly statusCode = 400) {
    super(message);
    this.name = 'ClusterError';
  }
}

function message(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 300);
}

// ─── Change capture ──────────────────────────────────────────────────────────

let captureInFlight: Promise<void> | null = null;

// Loads the table catalog, installs the capture triggers and registers every
// existing row. Safe to repeat; concurrent callers share one run.
function prepareCapture(): Promise<void> {
  if (!captureInFlight) {
    captureInFlight = (async () => {
      const catalog = await loadCatalog();
      state.catalog = catalog;
      // Existing rows are registered before the triggers exist: at that point
      // no write touches the version registry yet, so registering even a very
      // large table cannot get in any writer's way. Rows written in the short
      // span until the triggers are in place are picked up by a second pass.
      const trackedBefore = await trackedTables();
      let registered = await backfillVersions(catalog, state.nodeId, 'history');
      const triggers = await ensureTriggers(catalog, state.nodeId, trackedBefore);
      if (triggers.created > 0) registered += await backfillVersions(catalog, state.nodeId, 'history');
      state.captureReady = true;
      state.captureError = null;
      if (triggers.uncovered.length > 0) {
        // Typically the database was restored or altered outside this
        // application. Rows changed in the meantime carry no new version, so
        // peers would not pick those changes up by themselves.
        state.captureGap = true;
        recordEvent('error', `Change capture was missing on ${triggers.uncovered.length} table(s); changes made meanwhile were not recorded. Use "rebuild" to make this node's data the current version.`);
        logger.error('Cluster change capture had a gap', {
          action: 'cluster_capture_gap',
          tables: triggers.uncovered.slice(0, 20),
        });
      }
      if (triggers.created > 0 || triggers.dropped > 0 || registered > 0) {
        logger.info('Cluster change capture ready', {
          action: 'cluster_capture_ready',
          tables: catalog.ordered.length,
          triggersCreated: triggers.created,
          triggersDropped: triggers.dropped,
          rowsRegistered: registered,
        });
      }
    })()
      .catch((err) => {
        state.captureReady = false;
        state.captureError = message(err);
        logger.error('Cluster change capture could not be installed', {
          action: 'cluster_capture_failed',
          message: state.captureError,
        });
        throw err;
      })
      .finally(() => {
        captureInFlight = null;
      });
  }
  return captureInFlight;
}

// ─── Peers in memory ─────────────────────────────────────────────────────────

function loadPeerRuntime(row: ClusterPeer): PeerRuntime | null {
  if (row.status !== 'ACTIVE' || !row.nodeId) return null;
  const linkKey = linkKeyOf(row);
  const address = normalizePeerAddress(row.address);
  if (!linkKey || !address.ok) {
    recordEvent('error', `Peer ${row.name || row.address} cannot be used: ${!linkKey ? 'its stored key is unreadable (pair it again)' : address.ok ? '' : address.error}`);
    return null;
  }
  const previous = state.peers.get(row.id);
  const retentionMs = config.cluster.tombstoneRetentionDays * 24 * 60 * 60 * 1000;
  const runtime: PeerRuntime = {
    rowId: row.id,
    nodeId: row.nodeId,
    name: row.name,
    baseUrl: address.url,
    linkKey,
    health: previous?.health ?? 'UNKNOWN',
    failures: previous?.failures ?? 0,
    lastSeenAt: previous?.lastSeenAt ?? null,
    lastHeartbeatAt: previous?.lastHeartbeatAt ?? null,
    heartbeating: false,
    lastError: previous?.lastError ?? null,
    latencyMs: previous?.latencyMs ?? null,
    skewMs: previous?.skewMs ?? null,
    remote: previous?.remote ?? emptyRemoteView(),
    schemaMatch: previous?.schemaMatch ?? null,
    secretsMatch: previous?.secretsMatch ?? { jwt: null, apiKey: null, serverKey: null },
    session: null,
    handshake: null,
    syncing: false,
    lastSyncAt: previous?.lastSyncAt ?? null,
    lastSyncError: previous?.lastSyncError ?? null,
    nextSyncAt: 0,
    syncBackoffMs: 0,
    rowsSent: previous?.rowsSent ?? 0,
    rowsReceived: previous?.rowsReceived ?? 0,
    drainedAt: previous?.drainedAt ?? null,
    stale: Boolean(row.lastSyncedAt && Date.now() - row.lastSyncedAt.getTime() > retentionMs),
  };
  lastSyncedPersisted.set(row.id, row.lastSyncedAt?.getTime() ?? 0);
  state.peers.set(row.id, runtime);
  return runtime;
}

function unloadPeer(rowId: string): void {
  state.peers.delete(rowId);
  dropSessionsOf(rowId);
  lastSyncedPersisted.delete(rowId);
}

async function onPeerActivated(rowId: string): Promise<void> {
  const row = await getPeer(rowId);
  if (!row) return;
  // Sessions keyed with a previous link key are worthless now.
  unloadPeer(rowId);
  const runtime = loadPeerRuntime(row);
  if (!runtime) return;
  await prepareCapture();
  recordEvent('info', `Paired with ${runtime.name || runtime.baseUrl}; the initial transfer has started`);
  logger.info('Cluster peer paired', { action: 'cluster_peer_paired', peer: runtime.nodeId });
  void heartbeatPeer(runtime);
}

// ─── Leader ──────────────────────────────────────────────────────────────────

function leaderId(): string {
  const reachable = [...state.peers.values()].filter((peer) => peer.health === 'ONLINE').map((peer) => peer.nodeId);
  return electLeader(state.nodeId, reachable);
}

export function isLeader(): boolean {
  if (!state.started || state.peers.size === 0) return true;
  // Right after start no peer has answered yet. Claiming leadership in that
  // moment would run once-only jobs on every restarting node, so wait for the
  // first heartbeats (or for them to have had their chance).
  const settling = Date.now() - startedAt < config.cluster.heartbeatIntervalMs * 3;
  if (settling && [...state.peers.values()].some((peer) => peer.health === 'UNKNOWN')) return false;
  return leaderId() === state.nodeId;
}

// ─── Heartbeat ───────────────────────────────────────────────────────────────

async function heartbeatPayload(peer: PeerRuntime): Promise<Heartbeat> {
  return {
    t: Date.now(),
    name: state.nodeName,
    schema: state.catalog?.fingerprint ?? '',
    appVersion: APP_VERSION,
    leader: leaderId(),
    captureReady: state.captureReady,
    pending: await hasPendingWork(peer).catch(() => true),
    secrets: {
      jwt: configFingerprint(peer.linkKey, 'jwt', config.jwtSecret),
      apiKey: configFingerprint(peer.linkKey, 'api-key', config.apiKey),
      serverKey: configFingerprint(peer.linkKey, 'server-key', config.serverKey),
    },
    peers: [...state.peers.values()].map((other) => ({ id: other.nodeId, health: other.health })),
  };
}

function setHealth(peer: PeerRuntime, next: Health, reason?: string): void {
  if (peer.health === next) return;
  const previous = peer.health;
  peer.health = next;
  const label = peer.name || peer.baseUrl;
  if (next === 'ONLINE') {
    recordEvent('info', `${label} is online${previous === 'UNKNOWN' ? '' : ' again'}`);
    logger.info('Cluster peer online', { action: 'cluster_peer_online', peer: peer.nodeId, previous });
  } else {
    recordEvent(next === 'OFFLINE' ? 'error' : 'warn', `${label} is ${next === 'OFFLINE' ? 'offline' : 'not answering'}${reason ? ` (${reason})` : ''}`);
    logger.warn(`Cluster peer ${next === 'OFFLINE' ? 'offline' : 'suspect'}`, {
      action: next === 'OFFLINE' ? 'cluster_peer_offline' : 'cluster_peer_suspect',
      peer: peer.nodeId,
      reason: reason ?? null,
    });
  }
}

function absorbHeartbeat(peer: PeerRuntime, remote: Heartbeat): void {
  peer.remote = {
    name: remote.name,
    schema: remote.schema,
    appVersion: remote.appVersion,
    leader: remote.leader,
    captureReady: remote.captureReady,
    peers: remote.peers,
  };
  const localSchema = state.catalog?.fingerprint ?? '';
  const schemaMatch = Boolean(localSchema) && remote.schema === localSchema;
  if (peer.schemaMatch !== schemaMatch) {
    if (!schemaMatch) recordEvent('warn', `${peer.name || peer.baseUrl} runs a different database schema; replication with it is paused`);
    else if (peer.schemaMatch === false) recordEvent('info', `${peer.name || peer.baseUrl} runs the same database schema again; replication resumes`);
  }
  peer.schemaMatch = schemaMatch;
  peer.secretsMatch = {
    jwt: remote.secrets.jwt === configFingerprint(peer.linkKey, 'jwt', config.jwtSecret),
    apiKey: remote.secrets.apiKey === configFingerprint(peer.linkKey, 'api-key', config.apiKey),
    serverKey: remote.secrets.serverKey === configFingerprint(peer.linkKey, 'server-key', config.serverKey),
  };
  if (!remote.pending) peer.drainedAt = Date.now();
}

async function heartbeatPeer(peer: PeerRuntime): Promise<void> {
  if (peer.heartbeating) return;
  peer.heartbeating = true;
  const sentAt = Date.now();
  try {
    const reply = heartbeatSchema.parse(await rpc<unknown>(peer, 'hb', await heartbeatPayload(peer)));
    const receivedAt = Date.now();
    if (state.peers.get(peer.rowId) !== peer) return;

    // A peer that returns after being out of contact for longer than deleted
    // rows are remembered may still hold rows that were deleted here in the
    // meantime — and nothing would tell it so any more. Replication with it
    // waits for an administrator's decision instead of silently bringing
    // deleted data back.
    const lastContact = Math.max(peer.lastHeartbeatAt ?? 0, lastSyncedPersisted.get(peer.rowId) ?? 0);
    const retentionMs = config.cluster.tombstoneRetentionDays * 24 * 60 * 60 * 1000;
    if (!peer.stale && lastContact > 0 && receivedAt - lastContact > retentionMs) {
      peer.stale = true;
      recordEvent('error', `${peer.name || peer.baseUrl} was out of contact for longer than deleted rows are remembered; replication with it is on hold`);
      logger.error('Cluster peer returned after a long absence', { action: 'cluster_peer_stale', peer: peer.nodeId });
    }

    peer.failures = 0;
    peer.lastSeenAt = receivedAt;
    peer.lastHeartbeatAt = receivedAt;
    peer.lastError = null;
    peer.latencyMs = receivedAt - sentAt;
    peer.skewMs = estimateSkewMs(sentAt, receivedAt, reply.t);
    absorbHeartbeat(peer, reply);
    setHealth(peer, 'ONLINE');
    if (!peer.stale && receivedAt - (lastSyncedPersisted.get(peer.rowId) ?? 0) > LAST_SYNCED_PERSIST_MS) {
      lastSyncedPersisted.set(peer.rowId, receivedAt);
      await prisma.clusterPeer.updateMany({ where: { id: peer.rowId }, data: { lastSyncedAt: new Date(receivedAt) } });
    }
  } catch (err) {
    if (state.peers.get(peer.rowId) !== peer) return;
    peer.failures += 1;
    peer.lastError = message(err);
    setHealth(peer, healthAfter(peer.failures, config.cluster), peer.lastError);
  } finally {
    peer.heartbeating = false;
  }
}

// ─── Sending ─────────────────────────────────────────────────────────────────

function mayReplicateWith(peer: PeerRuntime): boolean {
  return !state.paused && state.captureReady && peer.schemaMatch === true && !peer.stale;
}

async function runSync(peer: PeerRuntime): Promise<void> {
  if (peer.syncing || peer.health !== 'ONLINE' || !mayReplicateWith(peer) || Date.now() < peer.nextSyncAt) return;
  peer.syncing = true;
  try {
    const row = await prisma.clusterPeer.findUnique({ where: { id: peer.rowId }, select: { resyncRequested: true } });
    if (row?.resyncRequested) {
      await rpc(peer, 'resync', {}, config.cluster.syncTimeoutMs);
      await prisma.clusterPeer.updateMany({ where: { id: peer.rowId }, data: { resyncRequested: false } });
      recordEvent('info', `Asked ${peer.name || peer.baseUrl} to send its complete state`);
    }
    // Keep going while there is a backlog, but yield regularly so a large
    // initial transfer never monopolises the timer.
    for (let round = 0; round < 25; round++) {
      if (state.paused || state.peers.get(peer.rowId) !== peer) break;
      if (!(await syncPeer(peer))) break;
    }
    peer.lastSyncAt = Date.now();
    peer.lastSyncError = null;
    peer.syncBackoffMs = 0;
  } catch (err) {
    peer.lastSyncError = message(err);
    peer.syncBackoffMs = Math.min(MAX_SYNC_BACKOFF_MS, Math.max(1_000, peer.syncBackoffMs * 2));
    peer.nextSyncAt = Date.now() + peer.syncBackoffMs;
    logger.warn('Cluster replication round failed', {
      action: 'cluster_sync_failed',
      peer: peer.nodeId,
      message: peer.lastSyncError,
      retryInMs: peer.syncBackoffMs,
    });
  } finally {
    peer.syncing = false;
  }
}

// ─── Calls from a peer ───────────────────────────────────────────────────────

async function handleCall(peer: PeerRuntime, method: string, params: unknown): Promise<unknown> {
  peer.lastSeenAt = Date.now();
  switch (method) {
    case 'hb': {
      absorbHeartbeat(peer, heartbeatSchema.parse(params));
      return heartbeatPayload(peer);
    }
    case 'offer': {
      if (!mayReplicateWith(peer)) throw new RpcError('paused', 'replication is paused on this node');
      return { want: await wantedFromOffer(offerSchema.parse(params).items) };
    }
    case 'push': {
      if (!mayReplicateWith(peer)) throw new RpcError('paused', 'replication is paused on this node');
      const body = pushSchema.parse(params);
      const results = await applyPush(peer, body.batches);
      if (body.drained) peer.drainedAt = Date.now();
      if (results.includes('d')) void retryDeferred().catch(() => {});
      return { results: results.join('') };
    }
    case 'resync': {
      if (!state.captureReady) throw new RpcError('paused', 'change capture is not ready on this node');
      await startFullTransfer(peer.rowId);
      recordEvent('info', `${peer.name || peer.baseUrl} asked for a complete resend`);
      return { ok: true };
    }
    case 'bye': {
      // The peer removed this node from its cluster.
      await setPeerStatus(peer.rowId, 'REMOVED');
      await prisma.clusterOutbox.deleteMany({ where: { peerId: peer.rowId } });
      unloadPeer(peer.rowId);
      recordEvent('warn', `${peer.name || peer.baseUrl} removed this node from its peers`);
      return { ok: true };
    }
    default:
      throw new RpcError('unknown_method', 'unknown call');
  }
}

// ─── Start / stop ────────────────────────────────────────────────────────────

function every(ms: number, job: () => Promise<void>): void {
  let running = false;
  timers.push(setInterval(() => {
    if (running || !state.started) return;
    running = true;
    job()
      .catch((err) => logger.warn('Cluster background task failed', { action: 'cluster_task_failed', message: message(err) }))
      .finally(() => { running = false; });
  }, ms));
}

async function maintenance(): Promise<void> {
  sweepSessions();
  const expired = await expirePairingWindows();
  if (expired > 0) recordEvent('warn', `${expired} pairing window(s) expired without completing`);
  if (state.captureReady && !state.paused) {
    if (Date.now() - lastPruneAt > PRUNE_EVERY_MS) {
      lastPruneAt = Date.now();
      await pruneTombstones();
    }
  }
}

// Called once the database is reachable. Never throws: a cluster problem must
// not keep the API itself from serving.
export async function startCluster(): Promise<void> {
  if (!config.cluster.enabled || state.started) return;
  try {
    const node = await loadOrCreateNode();
    state.nodeId = node.nodeId;
    state.nodeName = node.name;

    setRpcHandler(handleCall);
    setActivationHook(onPeerActivated);
    setLeaderCheck(isLeader);
    setRestoreWrapper(restoreWithinCluster);

    const peers = await listPeers();
    if (peers.length > 0) {
      await prepareCapture().catch(() => { /* reported in the status */ });
      for (const row of peers) loadPeerRuntime(row);
    }

    startedAt = Date.now();
    state.started = true;

    // Every peer is handled on its own: one that answers slowly, or not at
    // all, never delays the heartbeat or the transfer of another.
    every(config.cluster.heartbeatIntervalMs, async () => {
      for (const peer of state.peers.values()) void heartbeatPeer(peer);
    });
    every(config.cluster.syncIntervalMs, async () => {
      for (const peer of state.peers.values()) void runSync(peer);
    });
    every(PAIRING_TICK_MS, pairingTick);
    every(MAINTENANCE_TICK_MS, maintenance);
    // Changes that were set aside are retried soon: what they wait for (a
    // parent row, the other half of a swap) usually arrives within moments.
    every(DEFERRED_RETRY_MS, async () => {
      if (!state.captureReady || state.paused || state.peers.size === 0) return;
      if ((await deferredCount()) > 0) await retryDeferred();
    });

    if (state.peers.size > 0) {
      logger.info('Cluster started', { action: 'cluster_started', nodeId: state.nodeId, peers: state.peers.size });
      void Promise.all([...state.peers.values()].map((peer) => heartbeatPeer(peer)));
    }
  } catch (err) {
    logger.error('Cluster could not be started', { action: 'cluster_start_failed', message: message(err) });
  }
}

export async function stopCluster(): Promise<void> {
  for (const timer of timers.splice(0)) clearInterval(timer);
  state.started = false;
  await closeApplier();
}

// ─── Database restore ────────────────────────────────────────────────────────
// A restore replaces the data underneath the capture triggers and brings back
// replication bookkeeping from the moment of the backup. Around it, this node
// stops replicating, keeps its current identity and peers, re-installs the
// triggers and declares its restored rows the current version. Peers adopt
// those rows; rows they created after the backup are sent back and kept.

async function restoreWithinCluster(restore: () => Promise<void>): Promise<void> {
  const peerRows = state.started ? await prisma.clusterPeer.findMany() : [];
  if (!state.started || peerRows.length === 0) {
    await restore();
    return;
  }

  state.paused = true;
  state.captureReady = false;
  try {
    await whenApplierIdle();
    for (let waited = 0; waited < 30_000 && [...state.peers.values()].some((peer) => peer.syncing); waited += 100) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const nodeRow = await prisma.clusterNode.findUnique({ where: { id: 1 } });
    const targetRows = await prisma.clusterTarget.findMany();

    try {
      await restore();
    } finally {
      await prisma.$transaction(async (tx) => {
        await tx.clusterTarget.deleteMany();
        await tx.clusterPeer.deleteMany();
        await tx.clusterNode.deleteMany();
        if (nodeRow) await tx.clusterNode.create({ data: nodeRow });
        if (peerRows.length > 0) {
          await tx.clusterPeer.createMany({
            data: peerRows.map((row) => ({ ...row, resyncRequested: row.status === 'ACTIVE' ? true : row.resyncRequested })),
          });
        }
        if (targetRows.length > 0) await tx.clusterTarget.createMany({ data: targetRows });
      });
      try {
        const catalog = await loadCatalog();
        state.catalog = catalog;
        await ensureTriggers(catalog, state.nodeId);
        await rebuildVersions(catalog, state.nodeId);
        state.captureReady = true;
        state.captureError = null;
        state.captureGap = false;
        recordEvent('warn', 'Database restored on this node; a complete transfer to every peer has started and a complete resend was requested');
      } catch (err) {
        state.captureError = message(err);
        recordEvent('error', `Change capture could not be re-installed after the restore: ${state.captureError}`);
        throw err;
      }
    }
  } finally {
    state.paused = false;
  }
}

// ─── Admin operations ────────────────────────────────────────────────────────

export function newPairingKey(): string {
  return generatePairingKey();
}

export async function addPeer(input: { address: string; name?: string; pairingKey: string; createdBy: string }): Promise<{ id: string }> {
  if (!state.started) throw new ClusterError('The cluster layer is not running on this node', 503);
  const address = normalizePeerAddress(input.address);
  if (!address.ok) throw new ClusterError(address.error);
  const problem = pairingKeyProblem(input.pairingKey);
  if (problem) throw new ClusterError(problem);

  const existing = await listPeers();
  if (existing.some((peer) => {
    const other = normalizePeerAddress(peer.address);
    return other.ok && other.url === address.url && peer.status !== 'REMOVED';
  })) {
    throw new ClusterError('A peer with this address already exists', 409);
  }

  // Installed before the peer exists, so no change can slip past unrecorded
  // once pairing completes — and so a database account that may not create
  // triggers is reported now rather than as silent data divergence later.
  try {
    await prepareCapture();
  } catch (err) {
    throw new ClusterError(`Change capture could not be installed in the database: ${message(err)}`, 500);
  }

  const peer = await createPendingPeer({
    address: address.url,
    name: (input.name ?? '').trim().slice(0, 120),
    pairingKey: normalizePairingKey(input.pairingKey),
    createdBy: input.createdBy,
  });
  recordEvent('info', `Pairing opened for ${peer.name || peer.address}`);
  void pairingTick().catch(() => {});
  return { id: peer.id };
}

export async function repairPeer(id: string, pairingKey: string): Promise<void> {
  const peer = await getPeer(id);
  if (!peer) throw new ClusterError('Peer not found', 404);
  const problem = pairingKeyProblem(pairingKey);
  if (problem) throw new ClusterError(problem);
  try {
    await prepareCapture();
  } catch (err) {
    throw new ClusterError(`Change capture could not be installed in the database: ${message(err)}`, 500);
  }
  unloadPeer(id);
  forgetPairing(id);
  await reopenPairing(id, normalizePairingKey(pairingKey));
  recordEvent('info', `Pairing reopened for ${peer.name || peer.address}`);
  void pairingTick().catch(() => {});
}

export async function updatePeer(id: string, input: { address?: string; name?: string; enabled?: boolean }): Promise<void> {
  const peer = await getPeer(id);
  if (!peer) throw new ClusterError('Peer not found', 404);

  const data: { address?: string; name?: string } = {};
  if (input.address !== undefined) {
    const address = normalizePeerAddress(input.address);
    if (!address.ok) throw new ClusterError(address.error);
    data.address = address.url;
  }
  if (input.name !== undefined) data.name = input.name.trim().slice(0, 120);
  if (Object.keys(data).length > 0) await prisma.clusterPeer.update({ where: { id }, data });

  if (input.enabled === false && peer.status === 'ACTIVE') {
    await setPeerStatus(id, 'DISABLED');
    unloadPeer(id);
    recordEvent('warn', `Replication with ${peer.name || peer.address} disabled`);
    return;
  }
  if (input.enabled === true && peer.status === 'DISABLED') {
    if (!peer.linkKeyEnc || !peer.nodeId) throw new ClusterError('This peer has to be paired again before it can be enabled');
    await setPeerStatus(id, 'ACTIVE');
    const row = await getPeer(id);
    if (row && loadPeerRuntime(row)) {
      recordEvent('info', `Replication with ${peer.name || peer.address} enabled; a complete transfer has started`);
    }
    return;
  }

  // Address or name changed on a live peer: pick the new values up.
  if (state.peers.has(id)) {
    const row = await getPeer(id);
    if (row) {
      dropSessionsOf(id);
      loadPeerRuntime(row);
    }
  }
}

export async function removePeer(id: string): Promise<void> {
  const peer = await getPeer(id);
  if (!peer) throw new ClusterError('Peer not found', 404);
  const runtime = state.peers.get(id);
  if (runtime) {
    // Best effort: tell the other side so it stops queueing for us.
    await rpc(runtime, 'bye', {}).catch(() => {});
  }
  unloadPeer(id);
  forgetPairing(id);
  await deletePeer(id);
  recordEvent('warn', `Peer ${peer.name || peer.address} removed`);
}

// Starts a complete transfer to the peer and asks the peer to do the same in
// the other direction. With `acceptStale`, also lifts the hold placed on a
// peer that was out of contact for longer than deletions are remembered.
export async function resyncPeer(id: string, acceptStale: boolean): Promise<{ ok: true }> {
  const runtime = state.peers.get(id);
  if (!runtime) throw new ClusterError('Peer is not active', 409);
  if (runtime.stale) {
    if (!acceptStale) {
      throw new ClusterError(
        'This peer was out of contact for longer than deleted rows are remembered. Resyncing can bring deleted rows back; confirm explicitly to continue.',
        409,
      );
    }
    runtime.stale = false;
    lastSyncedPersisted.set(id, Date.now());
    await prisma.clusterPeer.updateMany({ where: { id }, data: { lastSyncedAt: new Date() } });
  }
  await prepareCapture();
  await startFullTransfer(id);
  await prisma.clusterPeer.updateMany({ where: { id }, data: { resyncRequested: true } });
  runtime.nextSyncAt = 0;
  recordEvent('info', `Complete resync with ${runtime.name || runtime.baseUrl} started`);
  return { ok: true };
}

// Declares this node's current data the authoritative version: every row gets
// a fresh version and is sent to all peers, and the peers are asked to send
// back whatever this node lacks. For the case where data was changed
// underneath the application (a manual restore, direct maintenance in SQL).
export async function rebuildFromThisNode(): Promise<{ rows: number }> {
  if (!state.started) throw new ClusterError('The cluster layer is not running on this node', 503);
  if ((await listPeers()).length === 0) throw new ClusterError('This node has no peers', 409);
  state.paused = true;
  try {
    await whenApplierIdle();
    for (let waited = 0; waited < 30_000 && [...state.peers.values()].some((peer) => peer.syncing); waited += 100) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const catalog = await loadCatalog();
    state.catalog = catalog;
    await ensureTriggers(catalog, state.nodeId);
    const rows = await rebuildVersions(catalog, state.nodeId);
    await prisma.clusterPeer.updateMany({ where: { status: 'ACTIVE' }, data: { resyncRequested: true } });
    state.captureReady = true;
    state.captureError = null;
    state.captureGap = false;
    recordEvent('warn', `This node's data was declared the current version (${rows} row(s)); a complete transfer to every peer has started`);
    return { rows };
  } catch (err) {
    if (err instanceof ClusterError) throw err;
    throw new ClusterError(`Rebuild failed: ${message(err)}`, 500);
  } finally {
    state.paused = false;
  }
}

export async function setNodeName(name: string): Promise<void> {
  const trimmed = name.trim().slice(0, 120);
  if (!trimmed) throw new ClusterError('Name is required');
  await renameNode(trimmed);
  state.nodeName = trimmed;
}

// ─── Status ──────────────────────────────────────────────────────────────────

export async function clusterStatus() {
  const rows = state.started ? await listPeers() : [];
  const queued = rows.length > 0 ? await queuedCounts().catch(() => new Map<string, number>()) : new Map<string, number>();
  const deferred = rows.length > 0 ? await deferredCount().catch(() => 0) : 0;
  const leader = state.started ? leaderId() : state.nodeId;

  return {
    enabled: config.cluster.enabled,
    running: state.started,
    paused: state.paused,
    node: {
      id: state.nodeId,
      name: state.nodeName,
      isLeader: isLeader(),
      leaderId: leader,
      schema: state.catalog?.fingerprint ?? null,
      replicatedTables: state.catalog?.ordered.length ?? 0,
      captureReady: state.captureReady,
      captureError: state.captureError,
      captureGap: state.captureGap,
      deferredChanges: deferred,
      uptimeSeconds: Math.floor(process.uptime()),
    },
    peers: rows.map((row) => {
      const runtime = state.peers.get(row.id);
      const pairing = pairingProgressOf(row.id);
      const warnings: string[] = [];
      if (runtime) {
        if (runtime.schemaMatch === false) warnings.push('Different database schema — replication paused until both nodes run the same version');
        if (runtime.stale) warnings.push('Out of contact for longer than deleted rows are remembered — resync needs confirmation');
        if (runtime.secretsMatch.jwt === false) warnings.push('JWT_SECRET differs — sessions issued by one node are not valid on the other');
        if (runtime.secretsMatch.apiKey === false) warnings.push('API_KEY differs between the nodes');
        if (runtime.secretsMatch.serverKey === false) warnings.push('SERVER_KEY differs between the nodes');
        if (runtime.skewMs !== null && Math.abs(runtime.skewMs) > config.cluster.maxClockSkewMs) {
          warnings.push(`Clocks differ by ${Math.round(Math.abs(runtime.skewMs) / 1000)} s — synchronise them (NTP), conflict resolution relies on time`);
        }
        if (runtime.remote.captureReady === false) warnings.push('Change capture is not ready on the other node');
      } else if (row.status === 'ACTIVE') {
        warnings.push('Stored key or address is unusable — pair this peer again');
      }
      return {
        id: row.id,
        nodeId: row.nodeId,
        name: row.name || runtime?.remote.name || '',
        address: row.address,
        status: row.status,
        health: runtime?.health ?? null,
        isLeader: Boolean(row.nodeId) && row.nodeId === leader,
        lastSeenAt: runtime?.lastSeenAt ? new Date(runtime.lastSeenAt).toISOString() : null,
        latencyMs: runtime?.latencyMs ?? null,
        clockSkewMs: runtime?.skewMs ?? null,
        queuedRows: queued.get(row.id) ?? 0,
        // A complete transfer (first pairing, resync) is still under way.
        fullTransfer: row.status === 'ACTIVE' && row.scanActive,
        rowsSent: runtime?.rowsSent ?? 0,
        rowsReceived: runtime?.rowsReceived ?? 0,
        lastSyncAt: runtime?.lastSyncAt ? new Date(runtime.lastSyncAt).toISOString() : null,
        lastError: runtime?.lastSyncError ?? runtime?.lastError ?? null,
        schemaMatch: runtime?.schemaMatch ?? null,
        pairing: row.status === 'PENDING'
          ? {
              expiresAt: row.pairingExpiresAt ? row.pairingExpiresAt.toISOString() : null,
              failures: row.pairingFailures,
              message: pairing?.message ?? 'Waiting for the first contact',
            }
          : null,
        knownPeers: runtime?.remote.peers ?? [],
        warnings,
        createdAt: row.createdAt.toISOString(),
      };
    }),
    events: [...state.events].reverse().slice(0, 50),
  };
}
