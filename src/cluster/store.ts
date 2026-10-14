import { randomUUID } from 'crypto';
import { Prisma, type ClusterPeer } from '@prisma/client';
import { prisma } from '../db';
import { config } from '../config';
import { deriveKek, unwrapSecret, wrapSecret } from './crypto';
import { formatEndpoint, parseEndpointList, type Endpoint } from './endpoints';

// Durable cluster facts: this node's identity, the configured peers and their
// wrapped key material.

export type PeerStatus = 'PENDING' | 'ACTIVE' | 'DISABLED' | 'EXPIRED' | 'LOCKED' | 'REMOVED';

let cachedKek: Buffer | null = null;

// Key-encryption key for everything stored in wrapped form. Taken from
// CLUSTER_SECRET when the operator provides one, otherwise derived from
// JWT_SECRET (domain-separated inside deriveKek), so a first setup needs no
// new secret. Changing the source makes stored link keys unreadable, which
// means the affected peers have to be paired again.
function kek(): Buffer {
  if (!cachedKek) cachedKek = deriveKek(config.cluster.secret || config.jwtSecret);
  return cachedKek;
}

export function wrap(plaintext: Buffer, context: string): string {
  return wrapSecret(kek(), plaintext, context);
}

export function unwrap(wrapped: string, context: string): Buffer {
  return unwrapSecret(kek(), wrapped, context);
}

// Secrets in replicated tables (relay keys) must be readable on every node,
// so they are wrapped with a key derived from JWT_SECRET, which all nodes
// share — domain-separated from the per-node key above. A node with a
// different JWT_SECRET cannot read them (the cluster page warns about that).
let cachedSharedKek: Buffer | null = null;

function sharedKek(): Buffer {
  if (!cachedSharedKek) cachedSharedKek = deriveKek(`cluster-shared-config:${config.jwtSecret}`);
  return cachedSharedKek;
}

export function wrapShared(plaintext: Buffer, context: string): string {
  return wrapSecret(sharedKek(), plaintext, `shared/${context}`);
}

export function unwrapShared(wrapped: string, context: string): Buffer {
  return unwrapSecret(sharedKek(), wrapped, `shared/${context}`);
}

// A peer's announced endpoints as stored (JSON array of written endpoints).
export function storedEndpoints(peer: { channelEndpoints: string | null; channelUrl: string | null }): Endpoint[] {
  let list: string[] = [];
  if (peer.channelEndpoints) {
    try {
      const parsed = JSON.parse(peer.channelEndpoints) as unknown;
      if (Array.isArray(parsed)) list = parsed.filter((item): item is string => typeof item === 'string');
    } catch {
      list = [];
    }
  }
  if (list.length === 0 && peer.channelUrl) list = [peer.channelUrl];
  return parseEndpointList(list).endpoints;
}

function endpointsColumn(endpoints: Endpoint[] | undefined): string | null {
  return endpoints && endpoints.length > 0 ? JSON.stringify(endpoints.map(formatEndpoint)) : null;
}

export async function loadOrCreateNode(): Promise<{ nodeId: string; name: string; advertiseUrl: string }> {
  const existing = await prisma.clusterNode.findUnique({ where: { id: 1 } });
  if (existing) return { nodeId: existing.nodeId, name: existing.name || config.cluster.nodeName, advertiseUrl: existing.advertiseUrl };
  try {
    const created = await prisma.clusterNode.create({
      data: { id: 1, nodeId: randomUUID(), name: config.cluster.nodeName },
    });
    return { nodeId: created.nodeId, name: created.name, advertiseUrl: created.advertiseUrl };
  } catch (err) {
    // Another start-up path created the row first.
    if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err;
    const row = await prisma.clusterNode.findUniqueOrThrow({ where: { id: 1 } });
    return { nodeId: row.nodeId, name: row.name || config.cluster.nodeName, advertiseUrl: row.advertiseUrl };
  }
}

export async function renameNode(name: string): Promise<void> {
  await prisma.clusterNode.update({ where: { id: 1 }, data: { name } });
}

export async function saveAdvertiseUrl(url: string): Promise<void> {
  await prisma.clusterNode.update({ where: { id: 1 }, data: { advertiseUrl: url } });
}

export function listPeers(): Promise<ClusterPeer[]> {
  return prisma.clusterPeer.findMany({ orderBy: { createdAt: 'asc' } });
}

export function getPeer(id: string): Promise<ClusterPeer | null> {
  return prisma.clusterPeer.findUnique({ where: { id } });
}

export function linkKeyOf(peer: ClusterPeer): Buffer | null {
  if (!peer.linkKeyEnc) return null;
  try {
    return unwrap(peer.linkKeyEnc, `link:${peer.id}`);
  } catch {
    return null;
  }
}

export function pairingSecretOf(peer: ClusterPeer): string | null {
  if (!peer.pairingSecretEnc) return null;
  try {
    return unwrap(peer.pairingSecretEnc, `pairing:${peer.id}`).toString('utf8');
  } catch {
    return null;
  }
}

export type PeerRole = 'HOST' | 'JOIN';

function pairingWindowEnd(): Date {
  return new Date(Date.now() + config.cluster.pairingTtlMinutes * 60_000);
}

// Opens a pairing window. HOST: this node waits for the other to contact it
// (an invite of ours, or an introduction where the other node calls us); the
// address may still be unknown. JOIN: this node contacts the other one at
// `address`, expecting the node id the invite named.
// What is known in advance about the other node's mutually authenticated
// channel: its certificate (or only its pin, from an invite code) and where
// it is reached. A HOST entry with a certificate accepts only that node.
export interface PeerTlsInput {
  url: string;
  pin: string;
  certPem: string | null;
  // Every way to reach it, in order; `url` is the first.
  endpoints?: Endpoint[];
}

export async function createPendingPeer(input: {
  role: PeerRole;
  address: string;
  name: string;
  secret: string;
  nodeId?: string | null;
  introducedBy?: string | null;
  createdBy: string;
  tls?: PeerTlsInput | null;
  // The pairing may only be completed over the mutually authenticated channel.
  tlsRequired?: boolean;
  expiresAt?: Date;
}): Promise<ClusterPeer> {
  const id = randomUUID();
  return prisma.clusterPeer.create({
    data: {
      id,
      role: input.role,
      address: input.address,
      name: input.name,
      // A HOST entry learns the node id when the other node proves the key;
      // until then it must not occupy the id (another entry may hold it).
      nodeId: input.role === 'JOIN' ? input.nodeId ?? null : null,
      introducedBy: input.introducedBy ?? null,
      status: 'PENDING',
      pairingSecretEnc: wrap(Buffer.from(input.secret, 'utf8'), `pairing:${id}`),
      pairingExpiresAt: input.expiresAt ?? pairingWindowEnd(),
      createdBy: input.createdBy,
      certPem: input.tls?.certPem ?? null,
      certPin: input.tls?.pin ?? null,
      channelUrl: input.tls?.url ?? null,
      channelEndpoints: endpointsColumn(input.tls?.endpoints),
      tlsRequired: input.tlsRequired ?? false,
    },
  });
}

// Stores what was learned about a peer's channel over an authenticated path.
export async function savePeerTls(id: string, tls: { url: string; pin: string; certPem: string; endpoints?: Endpoint[] }): Promise<void> {
  await prisma.clusterPeer.updateMany({
    where: { id },
    data: { channelUrl: tls.url, certPin: tls.pin, certPem: tls.certPem, channelEndpoints: endpointsColumn(tls.endpoints) },
  });
}

export async function lockPeerTls(id: string): Promise<void> {
  await prisma.clusterPeer.updateMany({ where: { id }, data: { tlsLocked: true } });
}

// Completes a pairing: stores the wrapped link key and forgets the pairing
// key. The peer receives everything through a complete transfer; changes from
// `feedFrom` on reach it through the change feed.
// With `tls` the pairing ran over the mutually authenticated channel: the
// peer's certificate is pinned and the link is locked to the channel.
export async function activatePeer(id: string, input: {
  nodeId: string;
  name: string;
  linkKey: Buffer;
  address?: string;
  feedFrom: bigint;
  tls?: { url: string; pin: string; certPem: string; endpoints?: Endpoint[] } | null;
}): Promise<ClusterPeer> {
  const current = await prisma.clusterPeer.findUniqueOrThrow({ where: { id } });
  return prisma.clusterPeer.update({
    where: { id },
    data: {
      nodeId: input.nodeId,
      name: current.name || input.name.slice(0, 120),
      ...(input.address ? { address: input.address } : {}),
      ...(input.tls
        ? {
            channelUrl: input.tls.url,
            certPin: input.tls.pin,
            certPem: input.tls.certPem,
            channelEndpoints: endpointsColumn(input.tls.endpoints),
            tlsLocked: true,
            tlsRequired: false,
          }
        : {}),
      status: 'ACTIVE',
      linkKeyEnc: wrap(input.linkKey, `link:${id}`),
      pairingSecretEnc: null,
      pairingStateEnc: null,
      pairingExpiresAt: null,
      pairingFailures: 0,
      lastSyncedAt: new Date(),
      scanActive: true,
      scanTable: null,
      scanHash: null,
      sentSeq: input.feedFrom,
    },
  });
}

// `feedFrom` is required when a link is switched on again: changes made while
// it was off reach the peer through a complete transfer.
export async function setPeerStatus(id: string, status: PeerStatus, feedFrom?: bigint): Promise<void> {
  await prisma.clusterPeer.update({
    where: { id },
    data: {
      status,
      ...(status === 'ACTIVE'
        ? { scanActive: true, scanTable: null, scanHash: null, ...(feedFrom !== undefined ? { sentSeq: feedFrom } : {}) }
        : { pairingSecretEnc: null, pairingStateEnc: null, pairingExpiresAt: null, scanActive: false }),
    },
  });
}

export async function deletePeer(id: string): Promise<void> {
  await prisma.clusterPeer.deleteMany({ where: { id } });
}

export async function notePairingFailure(id: string): Promise<void> {
  const peer = await prisma.clusterPeer.update({
    where: { id },
    data: { pairingFailures: { increment: 1 } },
  }).catch(() => null);
  if (peer && peer.status === 'PENDING' && peer.pairingFailures >= config.cluster.pairingMaxFailures) {
    await setPeerStatus(id, 'LOCKED');
  }
}

export async function expirePairingWindows(): Promise<number> {
  const expired = await prisma.clusterPeer.findMany({
    where: { status: 'PENDING', pairingExpiresAt: { lt: new Date() } },
    select: { id: true },
  });
  for (const peer of expired) await setPeerStatus(peer.id, 'EXPIRED');
  return expired.length;
}
