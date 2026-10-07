import type { Request, Response } from 'express';
import type { ClusterPeer } from '@prisma/client';
import { config } from '../config';
import { logger } from '../utils/logger';
import {
  HANDSHAKE_NONCE_BYTES,
  PAIRING_SALT_BYTES,
  derivePairingPsk,
  generateEphemeral,
  pairInitMac,
  pairKeys,
  randomToken,
  safeEqual,
  sharedSecret,
} from './crypto';
import { normalizePeerAddress } from './health';
import { b64, pairAcceptSchema, pairConfirmSchema, pairInitSchema } from './protocol';
import { recordEvent, state } from './runtime';
import {
  activatePeer,
  deletePeer,
  listPeers,
  notePairingFailure,
  pairingSecretOf,
  unwrap,
  wrap,
} from './store';
import { prisma } from '../db';
import { openSession, postJson } from './transport';

// One-time pairing of two nodes.
//
// Both operators add the other node's address together with the same pairing
// key. The node with the smaller id then drives a three-step exchange:
//
//   1. init     initiator → responder   proves knowledge of the pairing key
//   2. accept   responder → initiator   proves the same, completes the key
//                                       exchange and confirms the derived key
//   3. confirm  initiator → responder   confirms the derived key in turn
//
// Only after step 3 does either side store the link key and treat the other
// as a peer. The pairing key itself is wiped at that point.

type ActivationHook = (peerRowId: string) => Promise<void>;

let onActivated: ActivationHook = async () => {};

export function setActivationHook(hook: ActivationHook): void {
  onActivated = hook;
}

const HANDSHAKE_TTL_MS = 2 * 60 * 1000;
const RETRY_AFTER_REFUSAL_MS = 20_000;
const MAX_CANDIDATES = 5;

interface ResponderHandshake {
  peerRowId: string;
  initiatorId: string;
  initiatorName: string;
  linkKey: Buffer;
  confirmInitiator: Buffer;
  expiresAt: number;
}

const responderHandshakes = new Map<string, ResponderHandshake>();

export interface PairingProgress {
  lastAttemptAt: number | null;
  message: string;
}

const progress = new Map<string, PairingProgress>();
const waitUntil = new Map<string, number>();
const inFlight = new Set<string>();

export function pairingProgressOf(peerRowId: string): PairingProgress | null {
  return progress.get(peerRowId) ?? null;
}

export function forgetPairing(peerRowId: string): void {
  progress.delete(peerRowId);
  waitUntil.delete(peerRowId);
  for (const [key, handshake] of responderHandshakes) {
    if (handshake.peerRowId === peerRowId) responderHandshakes.delete(key);
  }
}

function note(peerRowId: string, message: string): void {
  progress.set(peerRowId, { lastAttemptAt: Date.now(), message });
}

// Stretching a pairing key is deliberately expensive in time and memory.
// Running one derivation at a time bounds what a burst of pairing requests
// can cost this process.
let derivationQueue: Promise<unknown> = Promise.resolve();

function derivePsk(secret: string, salt: Buffer): Promise<Buffer> {
  const next = derivationQueue.catch(() => undefined).then(() => derivePairingPsk(secret, salt));
  derivationQueue = next;
  return next;
}

function openWindow(peer: ClusterPeer): boolean {
  return peer.status === 'PENDING'
    && Boolean(peer.pairingSecretEnc)
    && (!peer.pairingExpiresAt || peer.pairingExpiresAt.getTime() > Date.now());
}

// A node id can only belong to one peer entry. When a node is paired again
// through a new entry, the old entry (and its queue) is replaced.
async function removeOtherEntriesFor(nodeId: string, keepRowId: string): Promise<void> {
  const others = await prisma.clusterPeer.findMany({ where: { nodeId, NOT: { id: keepRowId } }, select: { id: true } });
  for (const other of others) {
    state.peers.delete(other.id);
    await deletePeer(other.id);
  }
}

// ─── Responder ───────────────────────────────────────────────────────────────

export async function handlePairInit(req: Request, res: Response): Promise<void> {
  const parsed = pairInitSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Rejected' }); return; }
  const body = parsed.data;

  const candidates = (await listPeers()).filter(openWindow).slice(0, MAX_CANDIDATES);
  if (candidates.length === 0) { res.status(404).json({ error: 'Not found' }); return; }

  const init = { from: body.from, name: body.name, salt: body.salt, e: body.e, n: body.n };
  let matched: { peer: ClusterPeer; psk: Buffer } | null = null;
  for (const peer of candidates) {
    const secret = pairingSecretOf(peer);
    if (!secret) continue;
    const psk = await derivePsk(secret, init.salt);
    if (safeEqual(body.mac, pairInitMac(psk, init))) {
      matched = { peer, psk };
      break;
    }
  }
  if (!matched) {
    for (const peer of candidates) await notePairingFailure(peer.id);
    recordEvent('warn', 'A pairing attempt with a wrong pairing key was rejected');
    logger.warn('Cluster pairing attempt rejected', { action: 'cluster_pairing_rejected' });
    res.status(403).json({ error: 'Rejected' });
    return;
  }

  // From here on the caller has proven knowledge of the pairing key.
  if (body.from === state.nodeId) {
    note(matched.peer.id, 'The other node reports the same node identity as this one');
    res.status(409).json({ error: 'same_node' });
    return;
  }
  if (state.nodeId < body.from) {
    // This node drives the exchange; it will contact the caller shortly.
    waitUntil.delete(matched.peer.id);
    res.status(409).json({ error: 'initiator' });
    return;
  }

  let keys;
  const ephemeral = generateEphemeral();
  const accept = { id: state.nodeId, name: state.nodeName, e: ephemeral.publicKey, n: randomToken(HANDSHAKE_NONCE_BYTES) };
  try {
    keys = pairKeys(matched.psk, sharedSecret(ephemeral.privateKey, init.e), init, accept);
  } catch {
    res.status(400).json({ error: 'Rejected' });
    return;
  }
  responderHandshakes.set(body.from, {
    peerRowId: matched.peer.id,
    initiatorId: body.from,
    initiatorName: body.name,
    linkKey: keys.linkKey,
    confirmInitiator: keys.confirmInitiator,
    expiresAt: Date.now() + HANDSHAKE_TTL_MS,
  });
  note(matched.peer.id, 'Pairing key accepted, waiting for confirmation');
  res.json({ id: accept.id, name: accept.name, e: b64(accept.e), n: b64(accept.n), mac: b64(keys.confirmResponder) });
}

export async function handlePairConfirm(req: Request, res: Response): Promise<void> {
  const parsed = pairConfirmSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Rejected' }); return; }
  const handshake = responderHandshakes.get(parsed.data.from);
  if (!handshake || handshake.expiresAt < Date.now()) {
    responderHandshakes.delete(parsed.data.from);
    res.status(404).json({ error: 'Not found' });
    return;
  }
  if (!safeEqual(parsed.data.mac, handshake.confirmInitiator)) {
    responderHandshakes.delete(parsed.data.from);
    await notePairingFailure(handshake.peerRowId);
    res.status(403).json({ error: 'Rejected' });
    return;
  }
  await removeOtherEntriesFor(handshake.initiatorId, handshake.peerRowId);
  await activatePeer(handshake.peerRowId, {
    nodeId: handshake.initiatorId,
    name: handshake.initiatorName,
    linkKey: handshake.linkKey,
  });
  // Only forgotten once the link is stored: if storing it had to give up (the
  // database was busy), the initiator's next confirmation finds it again.
  responderHandshakes.delete(parsed.data.from);
  progress.delete(handshake.peerRowId);
  await onActivated(handshake.peerRowId);
  res.json({ ok: true });
}

// ─── Initiator ───────────────────────────────────────────────────────────────

interface StoredHandshake {
  peerNodeId: string;
  peerName: string;
  linkKey: string;
  confirm: string;
}

function readStoredHandshake(peer: ClusterPeer): StoredHandshake | null {
  if (!peer.pairingStateEnc) return null;
  try {
    return JSON.parse(unwrap(peer.pairingStateEnc, `pairing-state:${peer.id}`).toString('utf8')) as StoredHandshake;
  } catch {
    return null;
  }
}

async function finish(peer: ClusterPeer, stored: StoredHandshake): Promise<void> {
  await removeOtherEntriesFor(stored.peerNodeId, peer.id);
  await activatePeer(peer.id, {
    nodeId: stored.peerNodeId,
    name: stored.peerName,
    linkKey: Buffer.from(stored.linkKey, 'base64url'),
  });
  progress.delete(peer.id);
  await onActivated(peer.id);
}

async function confirmStep(peer: ClusterPeer, baseUrl: string, stored: StoredHandshake): Promise<void> {
  const reply = await postJson(baseUrl, '/pair/confirm', { from: state.nodeId, mac: stored.confirm }, config.cluster.requestTimeoutMs);
  if (reply.status === 200) {
    await finish(peer, stored);
    return;
  }
  if (reply.status === 404 || reply.status === 403) {
    // The other node no longer holds this exchange. Either it already
    // completed it (our earlier confirmation arrived but its answer was
    // lost) — then the derived key works — or the exchange is gone and has
    // to start over.
    try {
      await openSession(baseUrl, stored.peerNodeId, Buffer.from(stored.linkKey, 'base64url'));
      await finish(peer, stored);
    } catch {
      await prisma.clusterPeer.update({ where: { id: peer.id }, data: { pairingStateEnc: null } });
      note(peer.id, 'Pairing exchange expired on the other node, starting over');
    }
    return;
  }
  note(peer.id, `Other node answered HTTP ${reply.status} while confirming`);
}

async function initiate(peer: ClusterPeer): Promise<void> {
  const address = normalizePeerAddress(peer.address);
  if (!address.ok) { note(peer.id, address.error); return; }

  const stored = readStoredHandshake(peer);
  if (stored) {
    await confirmStep(peer, address.url, stored);
    return;
  }

  const secret = pairingSecretOf(peer);
  if (!secret) { note(peer.id, 'Pairing key can no longer be read, enter it again'); return; }

  const ephemeral = generateEphemeral();
  const init = {
    from: state.nodeId,
    name: state.nodeName,
    salt: randomToken(PAIRING_SALT_BYTES),
    e: ephemeral.publicKey,
    n: randomToken(HANDSHAKE_NONCE_BYTES),
  };
  const psk = await derivePsk(secret, init.salt);
  const reply = await postJson(address.url, '/pair/init', {
    v: 1,
    from: init.from,
    name: init.name,
    salt: b64(init.salt),
    e: b64(init.e),
    n: b64(init.n),
    mac: b64(pairInitMac(psk, init)),
  }, config.cluster.requestTimeoutMs);

  if (reply.status === 404) { note(peer.id, 'Other node has no open pairing for this node yet'); return; }
  if (reply.status === 403) {
    await notePairingFailure(peer.id);
    note(peer.id, 'Other node rejected the pairing key');
    return;
  }
  if (reply.status === 429) {
    waitUntil.set(peer.id, Date.now() + RETRY_AFTER_REFUSAL_MS);
    note(peer.id, 'Other node is rate limiting pairing attempts');
    return;
  }
  if (reply.status === 409) {
    const error = (reply.json as { error?: string } | null)?.error;
    waitUntil.set(peer.id, Date.now() + RETRY_AFTER_REFUSAL_MS);
    note(peer.id, error === 'same_node'
      ? 'Other node has the same node identity as this one — one of the two databases is a copy'
      : 'Pairing key accepted, the other node completes the pairing');
    return;
  }
  if (reply.status !== 200) { note(peer.id, `Other node answered HTTP ${reply.status}`); return; }

  const parsed = pairAcceptSchema.safeParse(reply.json);
  if (!parsed.success) { note(peer.id, 'Other node sent a malformed pairing answer'); return; }
  const accept = { id: parsed.data.id, name: parsed.data.name, e: parsed.data.e, n: parsed.data.n };
  if (accept.id === state.nodeId) {
    note(peer.id, 'Other node has the same node identity as this one — one of the two databases is a copy');
    return;
  }
  const keys = pairKeys(psk, sharedSecret(ephemeral.privateKey, accept.e), init, accept);
  if (!safeEqual(parsed.data.mac, keys.confirmResponder)) {
    await notePairingFailure(peer.id);
    note(peer.id, 'Other node could not prove knowledge of the pairing key');
    return;
  }

  // Persisted before confirming, so a restart between the two steps resumes
  // at the confirmation instead of leaving the two nodes with different keys.
  const handshake: StoredHandshake = {
    peerNodeId: accept.id,
    peerName: accept.name,
    linkKey: keys.linkKey.toString('base64url'),
    confirm: b64(keys.confirmInitiator),
  };
  await prisma.clusterPeer.update({
    where: { id: peer.id },
    data: { pairingStateEnc: wrap(Buffer.from(JSON.stringify(handshake), 'utf8'), `pairing-state:${peer.id}`) },
  });
  await confirmStep(peer, address.url, handshake);
}

// Called periodically: advances every open pairing by one step.
export async function pairingTick(): Promise<void> {
  const now = Date.now();
  for (const [key, handshake] of responderHandshakes) {
    if (handshake.expiresAt < now) responderHandshakes.delete(key);
  }
  const pending = (await listPeers()).filter(openWindow);
  for (const peer of pending) {
    if (inFlight.has(peer.id) || (waitUntil.get(peer.id) ?? 0) > now) continue;
    inFlight.add(peer.id);
    try {
      await initiate(peer);
    } catch (err) {
      note(peer.id, `Other node is not reachable (${err instanceof Error ? err.message.split('\n')[0] : String(err)})`);
    } finally {
      inFlight.delete(peer.id);
    }
  }
}
