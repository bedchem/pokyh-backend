import { config } from '../config';
import { logger } from '../utils/logger';
import { prisma } from '../db';
import { normalizePeerAddress } from './health';
import { newInviteSecret } from './invite';
import { expectationFor, expectedNodeOf, pairingTick } from './pairing';
import { introduceSchema } from './protocol';
import { recordEvent, state, type PeerRuntime } from './runtime';
import { createPendingPeer, listPeers } from './store';
import { RpcError, rpc } from './transport';

// Keeps every node linked directly with every other (CLUSTER_AUTO_MESH), so
// changes never depend on a detour and the loss of one node never cuts two
// others apart.
//
// Each heartbeat carries the sender's links, its open pairings and the nodes
// it refuses (links an administrator removed or switched off). A node that is
// linked with two peers which are not linked with each other introduces them:
// it hands both the same fresh one-time secret over their encrypted links, and
// they pair exactly as with an invite code. Only one node introduces a given
// pair — the one with the smallest id among the nodes linked with both — and
// a pair is introduced again only after the previous attempt has had its full
// pairing window to complete.

const lastIntroduced = new Map<string, number>();

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// The address the other nodes should use for a peer: what it announces for
// itself, else the one this node uses.
function reachableAddress(peer: PeerRuntime): string {
  return peer.remote.addr || peer.baseUrl;
}

function linkedWith(peer: PeerRuntime, nodeId: string): boolean {
  return peer.remote.peers.some((other) => other.id === nodeId);
}

export async function meshTick(): Promise<void> {
  if (!config.cluster.autoMesh) return;
  const online = [...state.peers.values()].filter((peer) => peer.health === 'ONLINE' && peer.schemaMatch === true);
  const now = Date.now();
  const windowMs = config.cluster.pairingTtlMinutes * 60_000 + 30_000;

  for (let i = 0; i < online.length; i++) {
    for (let j = i + 1; j < online.length; j++) {
      const [host, joiner] = online[i]!.nodeId < online[j]!.nodeId ? [online[i]!, online[j]!] : [online[j]!, online[i]!];
      if (linkedWith(host, joiner.nodeId) || linkedWith(joiner, host.nodeId)) continue;
      if (host.remote.pairing.includes(joiner.nodeId) || joiner.remote.pairing.includes(host.nodeId)) continue;
      if (host.remote.blocked.includes(joiner.nodeId) || joiner.remote.blocked.includes(host.nodeId)) continue;
      const key = pairKey(host.nodeId, joiner.nodeId);
      if (now - (lastIntroduced.get(key) ?? 0) < windowMs) continue;

      // The designated introducer: smallest id among this node and every
      // node linked with both of them.
      const common = host.remote.peers.map((other) => other.id).filter((id) => joiner.remote.peers.some((other) => other.id === id));
      if (common.some((id) => id < state.nodeId)) continue;

      const address = reachableAddress(joiner);
      lastIntroduced.set(key, now);
      const secret = newInviteSecret();
      try {
        const hostReply = await rpc<{ ok: boolean; reason?: string }>(host, 'introduce', {
          node: joiner.nodeId, name: joiner.name || joiner.remote.name || '', addr: address, role: 'HOST', secret,
        });
        if (!hostReply.ok) continue;
        const joinReply = await rpc<{ ok: boolean; reason?: string }>(joiner, 'introduce', {
          node: host.nodeId, name: host.name || host.remote.name || '', addr: reachableAddress(host), role: 'JOIN', secret,
        });
        if (!joinReply.ok) continue;
        recordEvent('info', `Introduced ${host.name || host.baseUrl} and ${joiner.name || joiner.baseUrl} to each other`);
        logger.info('Cluster nodes introduced', { action: 'cluster_mesh_introduced', host: host.nodeId, joiner: joiner.nodeId });
      } catch (err) {
        logger.warn('Cluster introduction failed', {
          action: 'cluster_mesh_introduce_failed',
          message: err instanceof Error ? err.message.split('\n')[0] : String(err),
        });
      }
    }
  }
}

// A peer introduces this node to another one.
export async function handleIntroduce(from: PeerRuntime, params: unknown): Promise<{ ok: boolean; reason?: string }> {
  if (!config.cluster.autoMesh) return { ok: false, reason: 'disabled' };
  const input = introduceSchema.parse(params);
  if (input.node === state.nodeId) return { ok: false, reason: 'self' };

  const peers = await listPeers();
  const existing = peers.filter((peer) => peer.nodeId === input.node || expectedNodeOf(peer) === input.node);
  if (existing.some((peer) => peer.status === 'ACTIVE')) return { ok: true, reason: 'linked' };
  // An administrator removed or switched off the link: stay out of it.
  if (existing.some((peer) => peer.status === 'REMOVED' || peer.status === 'DISABLED')) return { ok: false, reason: 'refused' };
  const open = existing.filter((peer) => peer.status === 'PENDING' && peer.pairingExpiresAt && peer.pairingExpiresAt.getTime() > Date.now());
  if (open.length > 0) return { ok: false, reason: 'busy' };
  // Expired or locked attempts give way to the new one.
  for (const peer of existing) await prisma.clusterPeer.deleteMany({ where: { id: peer.id } });

  if (input.role === 'JOIN') {
    const address = normalizePeerAddress(input.addr);
    if (!address.ok) throw new RpcError('bad_request', `introduced address is unusable: ${address.error}`);
    await createPendingPeer({
      role: 'JOIN',
      address: address.url,
      name: input.name.trim().slice(0, 120),
      secret: input.secret,
      nodeId: input.node,
      introducedBy: from.nodeId,
      createdBy: 'cluster',
    });
    void pairingTick().catch(() => {});
  } else {
    const peer = await createPendingPeer({
      role: 'HOST',
      address: '',
      name: input.name.trim().slice(0, 120),
      secret: input.secret,
      introducedBy: from.nodeId,
      createdBy: 'cluster',
    });
    await prisma.clusterPeer.update({ where: { id: peer.id }, data: { pairingStateEnc: expectationFor(peer.id, input.node) } });
  }
  recordEvent('info', `${from.name || from.baseUrl} introduced ${input.name || input.node}; pairing directly`);
  return { ok: true };
}
