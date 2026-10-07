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

type Tx = Prisma.TransactionClient;

// Every writing transaction reads the set of replication targets, and holds
// that read until it ends. Changing the set therefore has to wait for writes
// in flight — and while it waits, new writes queue up behind it. A long
// transaction (an import, a rollover) would turn that into a visible stall,
// so a change gives up after a few seconds instead; the caller retries.
async function changingTargets<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET SESSION innodb_lock_wait_timeout = 3');
    try {
      return await work(tx);
    } finally {
      await tx.$executeRawUnsafe('SET SESSION innodb_lock_wait_timeout = DEFAULT').catch(() => {});
    }
  }, { maxWait: 10_000, timeout: 20_000 });
}

export async function loadOrCreateNode(): Promise<{ nodeId: string; name: string }> {
  const existing = await prisma.clusterNode.findUnique({ where: { id: 1 } });
  if (existing) return { nodeId: existing.nodeId, name: existing.name || config.cluster.nodeName };
  try {
    const created = await prisma.clusterNode.create({
      data: { id: 1, nodeId: randomUUID(), name: config.cluster.nodeName },
    });
    return { nodeId: created.nodeId, name: created.name };
  } catch (err) {
    // Another start-up path created the row first.
    if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err;
    const row = await prisma.clusterNode.findUniqueOrThrow({ where: { id: 1 } });
    return { nodeId: row.nodeId, name: row.name || config.cluster.nodeName };
  }
}

export async function renameNode(name: string): Promise<void> {
  await prisma.clusterNode.update({ where: { id: 1 }, data: { name } });
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

export async function createPendingPeer(input: {
  address: string;
  name: string;
  pairingKey: string;
  createdBy: string;
}): Promise<ClusterPeer> {
  const id = randomUUID();
  return prisma.clusterPeer.create({
    data: {
      id,
      address: input.address,
      name: input.name,
      status: 'PENDING',
      pairingSecretEnc: wrap(Buffer.from(input.pairingKey, 'utf8'), `pairing:${id}`),
      pairingExpiresAt: new Date(Date.now() + config.cluster.pairingTtlMinutes * 60_000),
      createdBy: input.createdBy,
    },
  });
}

// Opens a new pairing window for an existing peer entry (first attempt
// expired or failed, or the link key is no longer usable).
export async function reopenPairing(id: string, pairingKey: string): Promise<ClusterPeer> {
  return changingTargets(async (tx) => {
    await tx.clusterTarget.deleteMany({ where: { peerId: id } });
    return tx.clusterPeer.update({
      where: { id },
      data: {
        status: 'PENDING',
        linkKeyEnc: null,
        pairingStateEnc: null,
        pairingSecretEnc: wrap(Buffer.from(pairingKey, 'utf8'), `pairing:${id}`),
        pairingExpiresAt: new Date(Date.now() + config.cluster.pairingTtlMinutes * 60_000),
        pairingFailures: 0,
        scanActive: false,
        scanTable: null,
        scanHash: null,
      },
    });
  });
}

// Completes a pairing: stores the wrapped link key, forgets the pairing key
// and starts routing changes to the peer — all in one transaction, so a peer
// is never a replication target without a usable key or the other way round.
export async function activatePeer(id: string, input: { nodeId: string; name: string; linkKey: Buffer }): Promise<ClusterPeer> {
  return changingTargets(async (tx) => {
    const current = await tx.clusterPeer.findUniqueOrThrow({ where: { id } });
    const peer = await tx.clusterPeer.update({
      where: { id },
      data: {
        nodeId: input.nodeId,
        name: current.name || input.name.slice(0, 120),
        status: 'ACTIVE',
        linkKeyEnc: wrap(input.linkKey, `link:${id}`),
        pairingSecretEnc: null,
        pairingStateEnc: null,
        pairingExpiresAt: null,
        pairingFailures: 0,
        lastSyncedAt: new Date(),
        // The peer receives everything this node holds. Because it becomes a
        // target in this same transaction — which waits for every write in
        // flight — nothing can fall between "already there when the transfer
        // started" and "queued because it changed afterwards".
        scanActive: true,
        scanTable: null,
        scanHash: null,
      },
    });
    await tx.clusterTarget.upsert({ where: { peerId: id }, create: { peerId: id }, update: {} });
    return peer;
  });
}

export async function setPeerStatus(id: string, status: PeerStatus): Promise<void> {
  await changingTargets(async (tx) => {
    const peer = await tx.clusterPeer.update({
      where: { id },
      data: {
        status,
        // Re-activating a link starts a complete transfer: changes made while
        // it was off were not queued for it.
        ...(status === 'ACTIVE'
          ? { scanActive: true, scanTable: null, scanHash: null }
          : { pairingSecretEnc: null, pairingStateEnc: null, pairingExpiresAt: null, scanActive: false }),
      },
    });
    if (status === 'ACTIVE' && peer.linkKeyEnc) {
      await tx.clusterTarget.upsert({ where: { peerId: id }, create: { peerId: id }, update: {} });
    } else {
      await tx.clusterTarget.deleteMany({ where: { peerId: id } });
    }
  });
}

export async function deletePeer(id: string): Promise<void> {
  await changingTargets(async (tx) => {
    await tx.clusterTarget.deleteMany({ where: { peerId: id } });
    await tx.clusterPeer.deleteMany({ where: { id } });
  });
  // Once the peer is no longer a target nobody adds to its queue any more,
  // so the queue can be dropped without competing with writers.
  await prisma.clusterOutbox.deleteMany({ where: { peerId: id } });
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
