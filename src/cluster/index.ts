import type { ClusterPeer } from '@prisma/client';
import { prisma } from '../db';
import { config } from '../config';
import { logger } from '../utils/logger';
import { applyPush, closeApplier, deferredCount, retryDeferred, wantedFromOffer, whenApplierIdle } from './applier';
import { loadCatalog } from './catalog';
import {
  backfillVersions,
  ensureTriggers,
  feedHead,
  pruneTombstones,
  rebuildVersions,
  repairFeedOrder,
  retireLegacyCapture,
  startFullTransfer,
  trackedTables,
} from './capture';
import { configFingerprint } from './crypto';
import { ClusterError } from './errors';
import { formatEndpoint, parseEndpointList, writtenPort } from './endpoints';
import { isChannelUrl } from './installToken';
import { runBootstrap, stopBootstrap, type BootstrapJoin, type BootstrapStatus } from './joinFile';
import { estimateSkewMs, healthAfter, normalizePeerAddress, rendezvousOwner, type Health } from './health';
import { setRestoreWrapper, setWorkPolicy } from './hooks';
import { decodeInvite, encodeInvite, newInviteSecret } from './invite';
import { listenerState } from './listener';
import { handleIntroduce, meshTick } from './mesh';
import {
  currentPathTo,
  loadOrCreateIdentity,
  mtlsState,
  ownIdentity,
  replaceIdentity,
  setTlsGate,
  startMtlsListener,
  stopMtlsListener,
} from './mtls';
import { envEndpoints, loadReach, panelEntries, relayReach, saveReach, type ReachEntry } from './reach';
import { proxySnippets, validProxyRoute, type ProxySnippets } from './proxySnippets';
import { addRelay, relayStatus, removeRelay, setRelayEndpointsHook, startRelays, stopRelays, updateRelay } from './relayClient';
import { routeLabel } from './relayProtocol';
import { createRelayCommand as relayCommand, type RelayCommandInput } from './relaySetup';
import { advertisedAddress, expectedNodeOf, forgetPairing, ownChannel, pairingProgressOf, pairingTick, setActivationHook } from './pairing';
import { certRotateSchema, heartbeatSchema, offerSchema, pushSchema, type Heartbeat } from './protocol';
import {
  completeInstallFor,
  createInstall,
  expireInstalls,
  installWindowOpen,
  listInstalls,
  refreshInstallWindows,
  revokeInstall,
} from './provision';
import { hasPendingWork, pendingCount, readFeedHead, stableFeedPosition, syncPeer } from './replicator';
import { allowlist, createClusterRouter } from './router';
import { emptyRemoteView, newFeedProgress, recordEvent, state, type PeerRuntime, type PeerTls } from './runtime';
import {
  createPendingPeer,
  deletePeer,
  expirePairingWindows,
  getPeer,
  linkKeyOf,
  listPeers,
  loadOrCreateNode,
  lockPeerTls,
  renameNode,
  saveAdvertiseUrl,
  savePeerTls,
  setPeerStatus,
  storedEndpoints,
} from './store';
import { RpcError, dropSessionsOf, pinAccepted, rpc, setChannelHook, setRpcHandler, sweepSessions } from './transport';
import { createNodeCertificate, inspectNodeCertificate } from './x509';
import { handleDigest, handleRows, verifyPeer } from './verify';
import {
  checkNow as checkUpdatesNow,
  handleBuildCall,
  releaseCommit,
  retryUpdate,
  rollBack,
  saveSettings as saveUpdateSettings,
  startUpdates,
  stopUpdates,
  updateAdvert,
  updateStatus,
} from './updates';

// Entry point of the cluster layer: start-up, the periodic loops, the calls a
// peer may make, and the operations the admin API exposes.
//
// A node without configured peers is a plain standalone server. Nothing here
// installs a trigger, opens a connection or changes a query until the first
// invite is created or used.
//
// No node is in charge. Every node accepts writes, every node holds all data,
// and every node keeps checking the others: heartbeats find a node that went
// away and the one that came back, the change feed catches up whatever was
// missed, the data check (verify.ts) repairs what slipped through, the mesh
// check (mesh.ts) links nodes that are not linked yet, and background work is
// shared out by key over whichever nodes are reachable (hooks.ts).

const APP_VERSION = '3';
const PAIRING_TICK_MS = 5_000;
const MAINTENANCE_TICK_MS = 60_000;
const DEFERRED_RETRY_MS = 5_000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;
const LAST_SYNCED_PERSIST_MS = 10 * 60 * 1000;
const MAX_SYNC_BACKOFF_MS = 60_000;
// A peer's previous certificate stays accepted this long after it renewed it.
const ROTATION_GRACE_MS = 15 * 60 * 1000;
// A certificate this close to its end is reported.
const CERTIFICATE_WARN_MS = 180 * 24 * 60 * 60 * 1000;

const timers: NodeJS.Timeout[] = [];
let startedAt = 0;
let lastPruneAt = 0;
let lastHead = 0n;
const lastSyncedPersisted = new Map<string, number>();

export { ClusterError };

function message(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 300);
}

function labelOf(peer: { name: string; baseUrl?: string; address?: string }): string {
  return peer.name || peer.baseUrl || peer.address || 'a node';
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
      // The triggers of the previous design are replaced by now.
      await retireLegacyCapture();
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

async function ensureCapture(): Promise<void> {
  try {
    await prepareCapture();
  } catch (err) {
    throw new ClusterError(`Change capture could not be installed in the database: ${message(err)}`, 500);
  }
}

// ─── Peers in memory ─────────────────────────────────────────────────────────

// The peer's pinned certificate, if it is stored and still acceptable.
function peerTlsOf(row: ClusterPeer): PeerTls | null {
  if (!row.certPem || !row.certPin || !row.channelUrl) return null;
  try {
    const facts = inspectNodeCertificate(row.certPem);
    const endpoints = storedEndpoints(row);
    if (facts.pin !== row.certPin || endpoints.length === 0) return null;
    return { url: endpoints[0]!.url, endpoints, pin: facts.pin, certPem: facts.pem, previous: null };
  } catch {
    return null;
  }
}

function loadPeerRuntime(row: ClusterPeer): PeerRuntime | null {
  if (row.status !== 'ACTIVE' || !row.nodeId) return null;
  const linkKey = linkKeyOf(row);
  const address = normalizePeerAddress(row.address);
  if (!linkKey || !address.ok) {
    recordEvent('error', `Peer ${row.name || row.address} cannot be used: ${!linkKey ? 'its stored key is unreadable (invite it again)' : address.ok ? '' : address.error}`);
    return null;
  }
  const previous = state.peers.get(row.id);
  const retentionMs = config.cluster.tombstoneRetentionDays * 24 * 60 * 60 * 1000;
  const tls = peerTlsOf(row);
  if (row.tlsLocked && !tls) {
    recordEvent('error', `Peer ${row.name || row.address} is locked to the mutually authenticated channel, but its stored certificate is unusable — invite it again`);
  }
  const samePin = Boolean(tls && previous?.tls && previous.tls.pin === tls.pin);
  if (tls && samePin && previous?.tls?.previous) tls.previous = previous.tls.previous;
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
    tls,
    tlsLocked: row.tlsLocked,
    tlsOutOk: samePin ? previous!.tlsOutOk : false,
    tlsInOk: samePin ? previous!.tlsInOk : false,
    tlsRetryAt: previous?.tlsRetryAt ?? 0,
    syncing: false,
    lastSyncAt: previous?.lastSyncAt ?? null,
    lastSyncError: previous?.lastSyncError ?? null,
    nextSyncAt: 0,
    syncBackoffMs: 0,
    rowsSent: previous?.rowsSent ?? 0,
    rowsReceived: previous?.rowsReceived ?? 0,
    drainedAt: previous?.drainedAt ?? null,
    stale: Boolean(row.lastSyncedAt && Date.now() - row.lastSyncedAt.getTime() > retentionMs),
    transferActive: row.scanActive,
    feed: previous && previous.feed.cursor === row.sentSeq ? previous.feed : newFeedProgress(row.sentSeq),
    verify: previous?.verify ?? { running: false, lastAt: row.lastVerifiedAt?.getTime() ?? null, repaired: 0, lastError: null },
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
  await completeInstallFor(rowId).catch(() => {});
  await refreshPeerLists().catch(() => {});
  const row = await getPeer(rowId);
  if (!row) return;
  // Sessions keyed with a previous link key are worthless now.
  unloadPeer(rowId);
  const runtime = loadPeerRuntime(row);
  if (!runtime) return;
  await prepareCapture();
  recordEvent('info', `Paired with ${labelOf(runtime)}; the initial transfer has started`);
  logger.info('Cluster peer paired', { action: 'cluster_peer_paired', peer: runtime.nodeId });
  // The waiting side stores the link before it answers the confirmation, and
  // the joining side only once it has that answer: a heartbeat sent from here
  // at once would be turned away. It follows shortly after the answer.
  if (row.role === 'HOST') {
    setTimeout(() => {
      if (state.peers.get(rowId) !== runtime) return;
      void heartbeatPeer(runtime).then(() => meshTick()).catch(() => {});
    }, 1_000).unref();
    return;
  }
  await heartbeatPeer(runtime);
  // A new member is introduced to the others right away, not at the next tick.
  void meshTick().catch(() => {});
}

// ─── Sharing out background work ─────────────────────────────────────────────

function settling(): boolean {
  // Right after start no peer has answered yet. Deciding in that moment would
  // let every restarting node take on everything, so wait for the first
  // heartbeats (or for them to have had their chance).
  return Date.now() - startedAt < config.cluster.heartbeatIntervalMs * 3
    && [...state.peers.values()].some((peer) => peer.health === 'UNKNOWN');
}

function reachableNodeIds(): string[] {
  return [state.nodeId, ...[...state.peers.values()].filter((peer) => peer.health === 'ONLINE').map((peer) => peer.nodeId)];
}

export function ownsWork(key: string): boolean {
  if (!state.started || state.peers.size === 0) return true;
  if (settling()) return false;
  return rendezvousOwner(key, reachableNodeIds()) === state.nodeId;
}

export function mayRunExclusive(job: string): boolean {
  if (!state.started || state.peers.size === 0) return true;
  if (settling()) return false;
  const peers = [...state.peers.values()];
  // Only while this node sees every linked node: two halves of a separated
  // cluster can then never both run it.
  if (peers.some((peer) => peer.health !== 'ONLINE' || peer.stale)) return false;
  return rendezvousOwner(job, [state.nodeId, ...peers.map((peer) => peer.nodeId)]) === state.nodeId;
}

// ─── Heartbeat ───────────────────────────────────────────────────────────────

let refusedNodes: string[] = [];
let pairingNodes: string[] = [];
// A pairing window this node waits in is open: an unknown certificate may
// then reach the pairing endpoints of the channel (mtls.ts).
let hostWindowOpen = false;

async function refreshPeerLists(): Promise<void> {
  const rows = await listPeers();
  refusedNodes = rows.filter((row) => (row.status === 'REMOVED' || row.status === 'DISABLED') && row.nodeId).map((row) => row.nodeId!);
  pairingNodes = rows
    .filter((row) => row.status === 'PENDING' && row.pairingExpiresAt && row.pairingExpiresAt.getTime() > Date.now())
    .map((row) => row.nodeId ?? expectedNodeOf(row))
    .filter((id): id is string => Boolean(id));
  hostWindowOpen = rows.some((row) => row.role === 'HOST' && row.status === 'PENDING' && row.pairingExpiresAt !== null && row.pairingExpiresAt.getTime() > Date.now());
}

async function refreshHostWindows(): Promise<void> {
  if (!mtlsState.listening) return;
  hostWindowOpen = (await prisma.clusterPeer.count({
    where: { role: 'HOST', status: 'PENDING', pairingExpiresAt: { gt: new Date() } },
  })) > 0;
}

// ─── The mutually authenticated channel ──────────────────────────────────────

// A direction of a link worked over the channel. Once both have, the link is
// locked to it: from then on nothing else is tried or accepted.
function onChannelVerified(peer: PeerRuntime): void {
  if (peer.tlsLocked || !peer.tlsOutOk || !peer.tlsInOk) return;
  peer.tlsLocked = true;
  if (peer.session?.channel === 'plain') peer.session = null;
  for (const [key, session] of state.serverSessions) {
    if (session.peerRowId === peer.rowId && session.channelPin === null) state.serverSessions.delete(key);
  }
  void lockPeerTls(peer.rowId)
    .then(() => {
      recordEvent('info', `${labelOf(peer)}: the link now runs over the mutually authenticated channel only`);
      logger.info('Cluster link locked to the mutually authenticated channel', { action: 'cluster_tls_locked', peer: peer.nodeId });
    })
    .catch((err) => logger.warn('Cluster link lock could not be stored', { action: 'cluster_tls_lock_failed', message: message(err) }));
}

const certificateMismatchNoted = new Set<string>();

// A peer announced its channel over the authenticated link. A link made
// before the channel existed moves there by itself; a different certificate
// than the pinned one is never adopted this way (only by a renewal).
function absorbChannel(peer: PeerRuntime, advert: { url: string; cert: string; endpoints?: string[] } | null | undefined): void {
  if (!advert || !ownChannel()) return;
  const endpoints = parseEndpointList(advert.endpoints ?? [advert.url]).endpoints;
  if (endpoints.length === 0) return;
  let facts;
  try {
    facts = inspectNodeCertificate(advert.cert);
  } catch {
    return;
  }
  if (peer.tls) {
    if (peer.tls.pin !== facts.pin) {
      if (!certificateMismatchNoted.has(peer.rowId)) {
        certificateMismatchNoted.add(peer.rowId);
        recordEvent('warn', `${labelOf(peer)} announces a certificate other than the pinned one; it is ignored`);
      }
      return;
    }
    // Its ways to be reached changed (a relay, a proxy, a new address):
    // learned over the authenticated link, used from now on.
    const before = peer.tls.endpoints.map(formatEndpoint).join(' ');
    if (endpoints.map(formatEndpoint).join(' ') !== before) {
      peer.tls.endpoints = endpoints;
      peer.tls.url = endpoints[0]!.url;
      void savePeerTls(peer.rowId, { url: peer.tls.url, endpoints, pin: facts.pin, certPem: peer.tls.certPem }).catch(() => {});
    }
    return;
  }
  if (peer.tlsLocked) return;
  peer.tls = { url: endpoints[0]!.url, endpoints, pin: facts.pin, certPem: facts.pem, previous: null };
  peer.tlsRetryAt = 0;
  void savePeerTls(peer.rowId, { url: endpoints[0]!.url, endpoints, pin: facts.pin, certPem: facts.pem })
    .then(() => recordEvent('info', `${labelOf(peer)} offers the mutually authenticated channel; the link moves there`))
    .catch((err) => logger.warn('Peer certificate could not be stored', { action: 'cluster_tls_pin_failed', message: message(err) }));
}

function heartbeatPayload(peer: PeerRuntime): Heartbeat {
  return {
    t: Date.now(),
    name: state.nodeName,
    schema: state.catalog?.fingerprint ?? '',
    appVersion: APP_VERSION,
    captureReady: state.captureReady,
    pending: hasPendingWork(peer, lastHead),
    secrets: {
      jwt: configFingerprint(peer.linkKey, 'jwt', config.jwtSecret),
      apiKey: configFingerprint(peer.linkKey, 'api-key', config.apiKey),
      serverKey: configFingerprint(peer.linkKey, 'server-key', config.serverKey),
    },
    peers: [...state.peers.values()].map((other) => ({ id: other.nodeId, health: other.health, address: other.baseUrl })),
    pairing: pairingNodes.slice(0, 64),
    blocked: refusedNodes.slice(0, 64),
    addr: advertisedAddress(),
    tls: (() => {
      const channel = ownChannel();
      return channel ? { url: channel.url, cert: channel.certPem, endpoints: channel.endpoints.map(formatEndpoint) } : null;
    })(),
    via: peer.tls ? currentPathTo(peer.tls.pin) : null,
    upd: updateAdvert(),
  };
}

function setHealth(peer: PeerRuntime, next: Health, reason?: string): void {
  if (peer.health === next) return;
  const previous = peer.health;
  peer.health = next;
  const label = labelOf(peer);
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
    captureReady: remote.captureReady,
    peers: remote.peers,
    pairing: remote.pairing,
    blocked: remote.blocked,
    addr: remote.addr,
    via: remote.via ?? null,
    update: remote.upd ?? null,
  };
  const localSchema = state.catalog?.fingerprint ?? '';
  const schemaMatch = Boolean(localSchema) && remote.schema === localSchema;
  if (peer.schemaMatch !== schemaMatch) {
    if (!schemaMatch) recordEvent('warn', `${labelOf(peer)} runs a different database schema; replication with it is paused`);
    else if (peer.schemaMatch === false) recordEvent('info', `${labelOf(peer)} runs the same database schema again; replication resumes`);
  }
  peer.schemaMatch = schemaMatch;
  peer.secretsMatch = {
    jwt: remote.secrets.jwt === configFingerprint(peer.linkKey, 'jwt', config.jwtSecret),
    apiKey: remote.secrets.apiKey === configFingerprint(peer.linkKey, 'api-key', config.apiKey),
    serverKey: remote.secrets.serverKey === configFingerprint(peer.linkKey, 'server-key', config.serverKey),
  };
  if (!remote.pending) peer.drainedAt = Date.now();
  absorbChannel(peer, remote.tls);
}

async function heartbeatPeer(peer: PeerRuntime): Promise<void> {
  if (peer.heartbeating) return;
  peer.heartbeating = true;
  const sentAt = Date.now();
  try {
    const reply = heartbeatSchema.parse(await rpc<unknown>(peer, 'hb', heartbeatPayload(peer)));
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
      recordEvent('error', `${labelOf(peer)} was out of contact for longer than deleted rows are remembered; replication with it is on hold`);
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

async function runSync(peer: PeerRuntime, head: bigint): Promise<void> {
  if (peer.syncing || peer.health !== 'ONLINE' || !mayReplicateWith(peer) || Date.now() < peer.nextSyncAt) return;
  peer.syncing = true;
  try {
    const row = await prisma.clusterPeer.findUnique({ where: { id: peer.rowId }, select: { resyncRequested: true } });
    if (row?.resyncRequested) {
      await rpc(peer, 'resync', {}, config.cluster.syncTimeoutMs);
      await prisma.clusterPeer.updateMany({ where: { id: peer.rowId }, data: { resyncRequested: false } });
      recordEvent('info', `Asked ${labelOf(peer)} to send its complete state`);
    }
    // Keep going while there is a backlog, but yield regularly so a large
    // initial transfer never monopolises the timer.
    for (let round = 0; round < 25; round++) {
      if (state.paused || state.peers.get(peer.rowId) !== peer) break;
      if (!(await syncPeer(peer, head))) break;
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
      const results = body.batches.length > 0 ? await applyPush(peer, body.batches) : [];
      if (body.drained) peer.drainedAt = Date.now();
      if (results.includes('d') || (body.drained && (await deferredCount()) > 0)) void retryDeferred().catch(() => {});
      return { results: results.join('') };
    }
    case 'resync': {
      if (!state.captureReady) throw new RpcError('paused', 'change capture is not ready on this node');
      await startFullTransfer(peer.rowId);
      recordEvent('info', `${labelOf(peer)} asked for a complete resend`);
      return { ok: true };
    }
    case 'introduce':
      return handleIntroduce(peer, params);
    case 'cert.rotate': {
      // The peer renewed its certificate; told over the current, still
      // authenticated link. The previous one is accepted for a while longer.
      const input = certRotateSchema.parse(params);
      let facts;
      try {
        facts = inspectNodeCertificate(input.cert);
      } catch (err) {
        throw new RpcError('bad_request', `certificate is unusable: ${message(err)}`);
      }
      if (!peer.tls) throw new RpcError('bad_request', 'this link has no pinned certificate');
      if (facts.pin !== peer.tls.pin) {
        peer.tls = {
          url: peer.tls.url,
          endpoints: peer.tls.endpoints,
          pin: facts.pin,
          certPem: facts.pem,
          previous: { pin: peer.tls.pin, certPem: peer.tls.certPem, until: Date.now() + ROTATION_GRACE_MS },
        };
        await savePeerTls(peer.rowId, { url: peer.tls.url, endpoints: peer.tls.endpoints, pin: facts.pin, certPem: facts.pem });
        certificateMismatchNoted.delete(peer.rowId);
        recordEvent('info', `${labelOf(peer)} renewed its certificate`);
        logger.info('Cluster peer certificate renewed', { action: 'cluster_tls_peer_rotated', peer: peer.nodeId });
      }
      return { ok: true };
    }
    case 'verify.digest':
      if (!mayReplicateWith(peer)) throw new RpcError('paused', 'replication is paused on this node');
      return handleDigest(params);
    case 'verify.rows':
      if (!mayReplicateWith(peer)) throw new RpcError('paused', 'replication is paused on this node');
      return handleRows(params);
    case 'update.build':
      // Another node takes this node's build to update to its version.
      return handleBuildCall(params);
    case 'bye': {
      // The peer removed this node from its cluster.
      await setPeerStatus(peer.rowId, 'REMOVED');
      unloadPeer(peer.rowId);
      recordEvent('warn', `${labelOf(peer)} removed this node from its peers`);
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

async function syncTick(): Promise<void> {
  if (state.peers.size === 0 || !state.captureReady) return;
  lastHead = await readFeedHead();
  for (const peer of state.peers.values()) void runSync(peer, lastHead);
}

// One peer at a time, whichever has waited longest; only when the two are in
// step, so the check does not chase changes that are still on their way.
async function verifyTick(): Promise<void> {
  const intervalMs = config.cluster.verifyIntervalMinutes * 60_000;
  const due = [...state.peers.values()]
    .filter((peer) => peer.health === 'ONLINE' && mayReplicateWith(peer) && !peer.verify.running)
    .filter((peer) => Date.now() - (peer.verify.lastAt ?? 0) > intervalMs)
    .filter((peer) => !hasPendingWork(peer, lastHead) && peer.drainedAt !== null && Date.now() - peer.drainedAt < 60_000)
    .sort((a, b) => (a.verify.lastAt ?? 0) - (b.verify.lastAt ?? 0));
  const next = due[0];
  if (!next) return;
  const scan = await prisma.clusterPeer.findUnique({ where: { id: next.rowId }, select: { scanActive: true } });
  if (scan?.scanActive) return;
  await verifyPeer(next);
}

async function maintenance(): Promise<void> {
  sweepSessions();
  const expired = await expirePairingWindows();
  if (expired > 0) recordEvent('warn', `${expired} invite(s) expired without being used`);
  await expireInstalls();
  await refreshPeerLists();
  if (state.captureReady && !state.paused) {
    if (Date.now() - lastPruneAt > PRUNE_EVERY_MS) {
      lastPruneAt = Date.now();
      await pruneTombstones();
    }
    await meshTick();
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
    state.advertiseUrl = node.advertiseUrl;
    await loadOrCreateIdentity(node.nodeId);
    await loadReach().catch(() => {});

    setRpcHandler(handleCall);
    setChannelHook(onChannelVerified);
    setTlsGate({
      isPinned: (pin) => [...state.peers.values()].some((peer) => pinAccepted(peer, pin)),
      pairingOpen: () => hostWindowOpen,
      installOpen: installWindowOpen,
    });
    setActivationHook(onPeerActivated);
    setWorkPolicy({ owns: ownsWork, exclusive: mayRunExclusive });
    setRestoreWrapper(restoreWithinCluster);

    const peers = await listPeers();
    if (peers.some((row) => row.status === 'ACTIVE')) {
      await prepareCapture().catch(() => { /* reported in the status */ });
      await repairFeedOrder().catch((err) => logger.warn('Cluster feed check failed', { action: 'cluster_feed_check_failed', message: message(err) }));
      for (const row of peers) loadPeerRuntime(row);
    } else {
      // Nothing to replicate: whatever an earlier design left behind goes.
      await retireLegacyCapture().catch(() => {});
    }
    const head = await feedHead().catch(() => ({ max: 0n, next: 0n }));
    state.startupSeq = head.max;
    lastHead = head.max;
    await refreshPeerLists().catch(() => {});

    await refreshInstallWindows().catch(() => {});

    startedAt = Date.now();
    state.started = true;
    await startMtlsListener(createClusterRouter('mtls'));
    // A change in this node's ways to be reached (a relay connection up or
    // down) reaches the other nodes with the next heartbeat, sent right away.
    setRelayEndpointsHook(() => {
      for (const peer of state.peers.values()) void heartbeatPeer(peer);
    });
    if (config.cluster.mtlsPort > 0) await startRelays();

    // Every peer is handled on its own: one that answers slowly, or not at
    // all, never delays the heartbeat or the transfer of another.
    every(config.cluster.heartbeatIntervalMs, async () => {
      for (const peer of state.peers.values()) void heartbeatPeer(peer);
    });
    every(config.cluster.syncIntervalMs, syncTick);
    every(PAIRING_TICK_MS, pairingTick);
    every(PAIRING_TICK_MS, refreshHostWindows);
    every(MAINTENANCE_TICK_MS, maintenance);
    every(MAINTENANCE_TICK_MS, verifyTick);
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
    // Updates roll out by themselves, one node after the other (updates.ts).
    startUpdates();
    // A server set up by the one-line installer joins the cluster now.
    await runBootstrap({ join: joinFromBootstrap, status: bootstrapStatus });
  } catch (err) {
    logger.error('Cluster could not be started', { action: 'cluster_start_failed', message: message(err) });
  }
}

export async function stopCluster(): Promise<void> {
  for (const timer of timers.splice(0)) clearInterval(timer);
  stopUpdates();
  stopBootstrap();
  stopRelays();
  state.started = false;
  await stopMtlsListener();
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

    try {
      await restore();
    } finally {
      await prisma.$transaction(async (tx) => {
        await tx.clusterPeer.deleteMany();
        await tx.clusterNode.deleteMany();
        if (nodeRow) await tx.clusterNode.create({ data: nodeRow });
        if (peerRows.length > 0) {
          await tx.clusterPeer.createMany({
            data: peerRows.map((row) => ({ ...row, resyncRequested: row.status === 'ACTIVE' ? true : row.resyncRequested })),
          });
        }
      });
      try {
        const catalog = await loadCatalog();
        state.catalog = catalog;
        await ensureTriggers(catalog, state.nodeId);
        await rebuildVersions(catalog, state.nodeId);
        for (const peer of state.peers.values()) peer.feed = newFeedProgress(0n);
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

function requireRunning(): void {
  if (!state.started) throw new ClusterError('The cluster layer is not running on this node', 503);
}

async function rememberOwnAddress(input: string): Promise<string> {
  const address = normalizePeerAddress(input);
  if (!address.ok) throw new ClusterError(`Address of this node: ${address.error}`);
  if (address.url !== state.advertiseUrl) {
    await saveAdvertiseUrl(address.url);
    state.advertiseUrl = address.url;
  }
  return address.url;
}

// Creates a one-time invite code for a new node. `ownAddress` is where the
// new node will reach this one.
export async function createInvite(input: { ownAddress: string; createdBy: string }): Promise<{ id: string; code: string; expiresAt: string }> {
  requireRunning();
  const ownAddress = await rememberOwnAddress(input.ownAddress);
  // Installed before anyone can join, so no change can slip past unrecorded
  // once pairing completes — and so a database account that may not create
  // triggers is reported now rather than as silent data divergence later.
  await ensureCapture();
  const secret = newInviteSecret();
  const peer = await createPendingPeer({ role: 'HOST', address: '', name: '', secret, createdBy: input.createdBy });
  const expiresAt = peer.pairingExpiresAt ?? new Date(Date.now() + config.cluster.pairingTtlMinutes * 60_000);
  const channel = ownChannel();
  const code = encodeInvite({
    address: ownAddress,
    nodeId: state.nodeId,
    name: state.nodeName,
    secret,
    expiresAt,
    channel: channel ? { url: channel.url, pin: channel.pin, endpoints: channel.endpoints.map(formatEndpoint) } : null,
  });
  await refreshPeerLists().catch(() => {});
  recordEvent('info', `Invite created (valid until ${expiresAt.toISOString().slice(11, 16)} UTC)`);
  return { id: peer.id, code, expiresAt: expiresAt.toISOString() };
}

// Joins the cluster another node invited this one to.
export async function joinCluster(input: { code: string; ownAddress: string; createdBy: string }): Promise<{ id: string }> {
  requireRunning();
  const decoded = decodeInvite(input.code);
  if (!decoded.ok) throw new ClusterError(decoded.error);
  const invite = decoded.invite;
  if (invite.nodeId === state.nodeId) throw new ClusterError('This invite code was created on this node — use it on the new node');
  const target = normalizePeerAddress(invite.address);
  if (!target.ok) throw new ClusterError(`The invite code contains an unusable address: ${target.error}`);
  await rememberOwnAddress(input.ownAddress);
  await ensureCapture();

  const existing = (await listPeers()).filter((peer) => peer.nodeId === invite.nodeId);
  if (existing.some((peer) => peer.status === 'ACTIVE')) throw new ClusterError('This node is already linked with that node', 409);
  for (const peer of existing) {
    forgetPairing(peer.id);
    await deletePeer(peer.id);
  }
  // Both nodes have the mutually authenticated channel: pair there, pinned to
  // the certificate the code names.
  const channelEndpoints = invite.channel ? parseEndpointList(invite.channel.endpoints ?? [invite.channel.url]).endpoints : [];
  const overTls = Boolean(invite.channel && channelEndpoints.length > 0 && ownChannel());
  const peer = await createPendingPeer({
    role: 'JOIN',
    address: target.url,
    name: invite.name,
    secret: invite.secret,
    nodeId: invite.nodeId,
    createdBy: input.createdBy,
    tls: overTls ? { url: channelEndpoints[0]!.url, endpoints: channelEndpoints, pin: invite.channel!.pin, certPem: null } : null,
  });
  recordEvent('info', `Joining ${invite.name || target.url}${overTls ? ' over the mutually authenticated channel' : ''}`);
  void pairingTick().catch(() => {});
  return { id: peer.id };
}

// ─── How this node is reached ────────────────────────────────────────────────

function announceReachChange(): void {
  for (const peer of state.peers.values()) void heartbeatPeer(peer);
}

// Proxy configuration for each way set to go through a proxy.
function snippetsFor(entry: ReachEntry): ProxySnippets | null {
  if (entry.kind === 'direct' || !entry.backend) return null;
  const endpoint = parseEndpointList([entry.endpoint]).endpoints[0];
  if (!endpoint) return null;
  const url = new URL(endpoint.url);
  const route = {
    listenPort: writtenPort(endpoint.url) ?? 443,
    serverNames: entry.kind === 'proxy-sni' ? [endpoint.sni ?? url.hostname] : [],
    backend: entry.backend,
  };
  return validProxyRoute(route) ? proxySnippets(route) : null;
}

export function reachStatus() {
  requireRunning();
  const channel = ownChannel();
  const env = envEndpoints();
  const relays = relayStatus();
  return {
    port: config.cluster.mtlsPort,
    listening: mtlsState.listening,
    effective: channel ? channel.endpoints.map(formatEndpoint) : [],
    env: env.endpoints.map(formatEndpoint),
    envInvalid: env.invalid,
    entries: panelEntries().map((entry) => ({ ...entry, snippets: snippetsFor(entry) })),
    relayEndpoints: relayReach().map(formatEndpoint),
    relayLabel: config.cluster.relayLabel || routeLabel(state.nodeName, state.nodeId),
    relays: relays.map((relay) => ({
      ...relay,
      // A relay behind the administrator's proxy on 443: what that proxy has to do.
      snippets: relay.domain && relay.useSni
        ? proxySnippets({ listenPort: 443, serverNames: [`*.${relay.domain}`], backend: '127.0.0.1:4100' })
        : null,
    })),
    peers: [...state.peers.values()].map((peer) => ({
      id: peer.rowId,
      name: labelOf(peer),
      // How this node reaches the peer, and how the peer reaches this node.
      outgoing: peer.tls ? currentPathTo(peer.tls.pin) : null,
      incoming: peer.remote.via,
    })),
  };
}

export async function updateReach(entries: Array<Partial<ReachEntry>>): Promise<ReturnType<typeof reachStatus>> {
  requireRunning();
  try {
    await saveReach(entries);
  } catch (err) {
    throw new ClusterError(message(err));
  }
  announceReachChange();
  recordEvent('info', 'The ways to reach this node were changed');
  return reachStatus();
}

export async function addClusterRelay(key: string, createdBy: string): Promise<{ id: string; name: string }> {
  requireRunning();
  return addRelay(key, createdBy);
}

export async function updateClusterRelay(id: string, input: { enabled?: boolean; usePorts?: boolean; useSni?: boolean; name?: string }): Promise<void> {
  requireRunning();
  await updateRelay(id, input);
}

export async function removeClusterRelay(id: string): Promise<void> {
  requireRunning();
  await removeRelay(id);
}

export function createRelayCommand(input: RelayCommandInput) {
  requireRunning();
  return relayCommand(input);
}

// ─── One-line node install ───────────────────────────────────────────────────

export async function createNodeInstall(input: { name: string; address: string; withAi: boolean; acmeEmail: string; origin: string; createdBy: string }) {
  requireRunning();
  // In place before anyone can join, as for an invite.
  await ensureCapture();
  const created = await createInstall(input);
  await refreshPeerLists().catch(() => {});
  return created;
}

export async function listNodeInstalls() {
  requireRunning();
  return listInstalls();
}

export async function revokeNodeInstall(id: string): Promise<void> {
  requireRunning();
  const result = await revokeInstall(id);
  if (result.peerId) forgetPairing(result.peerId);
  await refreshPeerLists().catch(() => {});
}

// The one-time join instruction the installer left for this node.
async function joinFromBootstrap(input: BootstrapJoin): Promise<void> {
  if (input.nodeId === state.nodeId) throw new ClusterError('The join instruction names this node itself');
  // A node reachable only through a relay has its address once it is parked.
  for (let waited = 0; !ownChannel() && waited < 60_000; waited += 1_000) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (!ownChannel()) throw new ClusterError('The mutually authenticated channel is not running on this node (CLUSTER_MTLS_PORT, CLUSTER_MTLS_URL)');
  await ensureCapture();
  const existing = (await listPeers()).filter((peer) => peer.nodeId === input.nodeId);
  if (existing.some((peer) => peer.status === 'ACTIVE')) return;
  for (const peer of existing) {
    forgetPairing(peer.id);
    await deletePeer(peer.id);
  }
  await createPendingPeer({
    role: 'JOIN',
    address: input.url,
    name: input.name,
    secret: input.secret,
    nodeId: input.nodeId,
    createdBy: 'installer',
    tls: { url: input.url, endpoints: input.endpoints, pin: input.pin, certPem: input.certPem },
    tlsRequired: true,
    expiresAt: input.expiresAt,
  });
  recordEvent('info', `Joining ${input.name || input.url} as set up by the one-line installer`);
  void pairingTick().catch(() => {});
}

async function bootstrapStatus(peerNodeId: string): Promise<BootstrapStatus> {
  const own = ownIdentity()?.pin ?? '';
  const row = (await listPeers()).find((peer) => peer.nodeId === peerNodeId);
  if (!row) return { state: 'failed', message: 'The join entry is gone — create a new one-line command', peerName: '', rowsReceived: 0, ownPin: own };
  const base = { peerName: row.name, ownPin: own };
  if (row.status === 'PENDING') {
    return { ...base, state: 'joining', message: pairingProgressOf(row.id)?.message ?? 'Contacting the other node', rowsReceived: 0 };
  }
  if (row.status !== 'ACTIVE') {
    const reason = row.status === 'LOCKED' ? 'the other node refused the install secret' : row.status === 'EXPIRED' ? 'the pairing window expired' : `the entry is ${row.status.toLowerCase()}`;
    return { ...base, state: 'failed', message: `Joining failed: ${reason}`, rowsReceived: 0 };
  }
  const runtime = state.peers.get(row.id);
  if (!runtime || runtime.health !== 'ONLINE') {
    return { ...base, state: 'paired', message: 'Paired; connecting', rowsReceived: runtime?.rowsReceived ?? 0 };
  }
  const synced = runtime.drainedAt !== null && !runtime.transferActive && (await deferredCount().catch(() => 1)) === 0;
  return {
    ...base,
    state: synced ? 'synced' : 'paired',
    message: synced ? 'All of the cluster\'s data received' : 'Receiving the cluster\'s data',
    rowsReceived: runtime.rowsReceived,
  };
}

// Renews this node's certificate. Every linked node learns the new one over
// the current link first; only when all have, this node switches to it.
export async function rotateCertificate(): Promise<{ pin: string; peers: number }> {
  requireRunning();
  const current = ownIdentity();
  if (!current) throw new ClusterError('This node has no certificate yet', 409);
  const peers = [...state.peers.values()];
  const away = peers.filter((peer) => peer.health !== 'ONLINE');
  if (away.length > 0) {
    throw new ClusterError(`Every linked node has to be online to renew the certificate (not online: ${away.map(labelOf).join(', ')})`, 409);
  }
  const next = createNodeCertificate(`pokyh-node-${state.nodeId}`);
  const told: PeerRuntime[] = [];
  try {
    for (const peer of peers) {
      await rpc(peer, 'cert.rotate', { cert: next.certPem });
      told.push(peer);
    }
  } catch (err) {
    for (const peer of told) await rpc(peer, 'cert.rotate', { cert: current.certPem }).catch(() => {});
    throw new ClusterError(`Certificate renewal aborted, nothing changed: ${message(err)}`, 502);
  }
  await replaceIdentity(state.nodeId, next);
  for (const peer of peers) peer.session = null;
  recordEvent('info', `Certificate renewed; ${peers.length} node(s) pinned the new one`);
  logger.info('Cluster certificate renewed', { action: 'cluster_tls_rotated', peers: peers.length });
  return { pin: next.pin, peers: peers.length };
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
    recordEvent('warn', `Replication with ${peer.name || peer.address} switched off`);
    return;
  }
  if (input.enabled === true && peer.status === 'DISABLED') {
    if (!peer.linkKeyEnc || !peer.nodeId) throw new ClusterError('This peer has to be invited again before it can be switched on');
    await setPeerStatus(id, 'ACTIVE', stableFeedPosition());
    const row = await getPeer(id);
    if (row && loadPeerRuntime(row)) {
      recordEvent('info', `Replication with ${peer.name || peer.address} switched on; a complete transfer has started`);
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

// Removing an active link keeps a record of it (REMOVED): the mesh check then
// never links the two nodes again by itself. Removing that record — or an
// invite, or a pairing that did not complete — deletes the entry for good.
export async function removePeer(id: string): Promise<{ deleted: boolean }> {
  const peer = await getPeer(id);
  if (!peer) throw new ClusterError('Peer not found', 404);
  const runtime = state.peers.get(id);
  unloadPeer(id);
  forgetPairing(id);
  if (peer.status === 'ACTIVE' || peer.status === 'DISABLED') {
    // Best effort: tell the other side so it stops sending to us.
    if (runtime) await rpc(runtime, 'bye', {}).catch(() => {});
    await setPeerStatus(id, 'REMOVED');
    recordEvent('warn', `Link with ${peer.name || peer.address} removed`);
    await refreshPeerLists().catch(() => {});
    return { deleted: false };
  }
  await deletePeer(id);
  await refreshPeerLists().catch(() => {});
  recordEvent('info', `Entry ${peer.name || peer.address || 'invite'} deleted`);
  return { deleted: true };
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
  recordEvent('info', `Complete resync with ${labelOf(runtime)} started`);
  return { ok: true };
}

// Runs the data check with one peer now.
export async function verifyNow(id: string): Promise<{ repaired: number }> {
  const runtime = state.peers.get(id);
  if (!runtime) throw new ClusterError('Peer is not active', 409);
  if (runtime.health !== 'ONLINE' || !mayReplicateWith(runtime)) throw new ClusterError('The peer is not reachable or replication with it is paused', 409);
  if (runtime.verify.running) throw new ClusterError('A data check with this peer is already running', 409);
  const repaired = await verifyPeer(runtime);
  if (runtime.verify.lastError) throw new ClusterError(`Data check failed: ${runtime.verify.lastError}`, 502);
  return { repaired };
}

// Declares this node's current data the authoritative version: every row gets
// a fresh version and is sent to all peers, and the peers are asked to send
// back whatever this node lacks. For the case where data was changed
// underneath the application (a manual restore, direct maintenance in SQL).
export async function rebuildFromThisNode(): Promise<{ rows: number }> {
  requireRunning();
  if (!(await listPeers()).some((peer) => peer.status === 'ACTIVE')) throw new ClusterError('This node has no peers', 409);
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
    for (const peer of state.peers.values()) peer.feed = newFeedProgress(0n);
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

function channelStatus() {
  const warnings: string[] = [];
  if (config.cluster.mtlsPort > 0 && !mtlsState.listening) {
    warnings.push(`The mutually authenticated channel on port ${config.cluster.mtlsPort} is not listening${mtlsState.error ? ` (${mtlsState.error})` : ''}`);
  }
  if (config.cluster.mtlsPort > 0 && mtlsState.listening && !ownChannel()) {
    warnings.push('The address of the mutually authenticated channel is unknown — set CLUSTER_MTLS_URL (https://host:port)');
  }
  const own = ownIdentity();
  if (own && own.notAfter.getTime() - Date.now() < CERTIFICATE_WARN_MS) {
    warnings.push(`This node's certificate ends on ${own.notAfter.toISOString().slice(0, 10)} — renew it`);
  }
  if (!config.cluster.publicPath && config.cluster.port === 0) {
    warnings.push('Neither CLUSTER_PUBLIC_PATH nor CLUSTER_PORT is enabled — other nodes cannot reach this one');
  }
  if (config.cluster.port > 0 && !listenerState.listening) {
    warnings.push(`The cluster port ${config.cluster.port} is not listening${listenerState.error ? ` (${listenerState.error})` : ''}`);
  }
  if (allowlist.invalid.length > 0) {
    warnings.push(`CLUSTER_ALLOWLIST has entries that are not addresses or ranges: ${allowlist.invalid.slice(0, 3).join(', ')}`);
  }
  if (config.cluster.port > 0 && allowlist.size === 0) {
    warnings.push('The cluster port accepts connections from any address — set CLUSTER_ALLOWLIST to the other nodes');
  }
  if (config.cluster.publicPath && allowlist.size > 0 && config.trustProxy === false) {
    warnings.push('CLUSTER_ALLOWLIST also applies to the API port, but TRUST_PROXY is off — behind a reverse proxy every request then looks like it comes from the proxy');
  }
  const channel = ownChannel();
  return {
    publicPath: config.cluster.publicPath,
    port: config.cluster.port,
    bindAddress: config.cluster.bindAddress,
    listening: listenerState.listening,
    mtls: {
      port: config.cluster.mtlsPort,
      bindAddress: config.cluster.mtlsBindAddress,
      listening: mtlsState.listening,
      url: channel?.url ?? null,
      pin: own?.pin ?? null,
      certificateEnds: own ? own.notAfter.toISOString() : null,
    },
    allowlistEntries: allowlist.size,
    autoMesh: config.cluster.autoMesh,
    warnings,
  };
}

export async function clusterStatus() {
  const rows = state.started ? await listPeers() : [];
  const deferred = rows.length > 0 ? await deferredCount().catch(() => 0) : 0;
  const reachable = state.started ? reachableNodeIds().length : 1;

  const peers = await Promise.all(rows.map(async (row) => {
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
      if (runtime.remote.appVersion && runtime.remote.appVersion !== APP_VERSION) warnings.push('The other node runs a different cluster version');
    } else if (row.status === 'ACTIVE') {
      warnings.push('Stored key or address is unusable — invite this node again');
    }
    const pendingRows = runtime ? await pendingCount(runtime).catch(() => 0) : 0;
    return {
      id: row.id,
      nodeId: row.nodeId,
      name: row.name || runtime?.remote.name || '',
      address: row.address,
      status: row.status,
      role: row.role,
      introducedBy: row.introducedBy,
      health: runtime?.health ?? null,
      lastSeenAt: runtime?.lastSeenAt ? new Date(runtime.lastSeenAt).toISOString() : null,
      latencyMs: runtime?.latencyMs ?? null,
      clockSkewMs: runtime?.skewMs ?? null,
      pendingRows,
      // A complete transfer (first pairing, resync) is still under way.
      fullTransfer: row.status === 'ACTIVE' && row.scanActive,
      rowsSent: runtime?.rowsSent ?? 0,
      rowsReceived: runtime?.rowsReceived ?? 0,
      lastSyncAt: runtime?.lastSyncAt ? new Date(runtime.lastSyncAt).toISOString() : null,
      lastError: runtime?.lastSyncError ?? runtime?.lastError ?? null,
      schemaMatch: runtime?.schemaMatch ?? null,
      verify: runtime
        ? {
            lastAt: runtime.verify.lastAt ? new Date(runtime.verify.lastAt).toISOString() : null,
            repaired: runtime.verify.repaired,
            running: runtime.verify.running,
            error: runtime.verify.lastError,
          }
        : null,
      pairing: row.status === 'PENDING'
        ? {
            expiresAt: row.pairingExpiresAt ? row.pairingExpiresAt.toISOString() : null,
            failures: row.pairingFailures,
            message: pairing?.message ?? (row.role === 'HOST' ? 'Waiting for the invited node' : 'Contacting the other node'),
          }
        : null,
      knownPeers: runtime?.remote.peers.map((other) => ({ id: other.id, health: other.health })) ?? [],
      tls: row.certPin
        ? {
            pin: row.certPin,
            url: row.channelUrl,
            locked: runtime?.tlsLocked ?? row.tlsLocked,
            // Not locked yet: whether calls currently go over the channel.
            active: runtime ? runtime.tlsLocked || (runtime.tls !== null && Date.now() >= runtime.tlsRetryAt) : false,
          }
        : null,
      warnings,
      createdAt: row.createdAt.toISOString(),
    };
  }));

  return {
    enabled: config.cluster.enabled,
    running: state.started,
    paused: state.paused,
    node: {
      id: state.nodeId,
      name: state.nodeName,
      advertiseUrl: advertisedAddress(),
      advertiseFromEnv: Boolean(config.cluster.advertiseUrl),
      schema: state.catalog?.fingerprint ?? null,
      replicatedTables: state.catalog?.ordered.length ?? 0,
      captureReady: state.captureReady,
      captureError: state.captureError,
      captureGap: state.captureGap,
      deferredChanges: deferred,
      uptimeSeconds: Math.floor(process.uptime()),
      // Background work is shared over this many nodes right now.
      workNodes: reachable,
      exclusiveJobsHere: mayRunExclusive('archiver') || mayRunExclusive('school-year-rollover'),
      verifyIntervalMinutes: config.cluster.verifyIntervalMinutes,
      inviteMinutes: config.cluster.pairingTtlMinutes,
      installMinutes: config.cluster.installTtlMinutes,
      // Default for the AI choice of a server set up with the one-line installer.
      aiEnabled: config.learnAi.enabled,
    },
    channel: channelStatus(),
    peers,
    events: [...state.events].reverse().slice(0, 50),
  };
}

// ─── Updates ─────────────────────────────────────────────────────────────────

export { updateStatus, checkUpdatesNow, releaseCommit, retryUpdate, rollBack, saveUpdateSettings };
