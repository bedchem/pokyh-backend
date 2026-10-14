import { randomUUID } from 'crypto';
import { Prisma, type ClusterPeer } from '@prisma/client';
import { prisma } from '../db';
import { config } from '../config';
import { deriveKek, unwrapSecret, wrapSecret } from './crypto';

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
export async function createPendingPeer(input: {
  role: PeerRole;
  address: string;
  name: string;
  secret: string;
  nodeId?: string | null;
  introducedBy?: string | null;
  createdBy: string;
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
      pairingExpiresAt: pairingWindowEnd(),
      createdBy: input.createdBy,
    },
  });
}

// Completes a pairing: stores the wrapped link key and forgets the pairing
// key. The peer receives everything through a complete transfer; changes from
// `feedFrom` on reach it through the change feed.
export async function activatePeer(id: string, input: { nodeId: string; name: string; linkKey: Buffer; address?: string; feedFrom: bigint }): Promise<ClusterPeer> {
  const current = await prisma.clusterPeer.findUniqueOrThrow({ where: { id } });
  return prisma.clusterPeer.update({
    where: { id },
    data: {
      nodeId: input.nodeId,
      name: current.name || input.name.slice(0, 120),
      ...(input.address ? { address: input.address } : {}),
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
