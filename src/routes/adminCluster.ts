import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../middleware/requireAdmin';
import { writeLimiter } from '../middleware/rateLimiter';
import { logger } from '../utils/logger';
import {
  ClusterError,
  clusterStatus,
  createInvite,
  joinCluster,
  rebuildFromThisNode,
  removePeer,
  resyncPeer,
  setNodeName,
  updatePeer,
  verifyNow,
} from '../cluster';

// ─── Cluster administration: /api/admin/cluster ──────────────────────────────
// A node joins with a one-time invite code created on any member. The code is
// returned exactly once, to the administrator who created it, and is never
// logged; nothing here ever returns stored key material.

const router = Router();

function actor(req: Request): string {
  return req.adminUser?.username ?? 'admin';
}

// Cluster operations report expected failures (bad address, expired code,
// peer not found) with their own status code and message.
async function guarded(res: Response, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (err) {
    if (err instanceof ClusterError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    throw err;
  }
}

const peerIdSchema = z.string().uuid();
const addressSchema = z.string().trim().min(1).max(255);

router.get('/', requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await clusterStatus());
});

const inviteSchema = z.object({ ownAddress: addressSchema });

router.post('/invites', requireAdmin, writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const body = inviteSchema.parse(req.body);
  await guarded(res, async () => {
    const invite = await createInvite({ ownAddress: body.ownAddress, createdBy: actor(req) });
    logger.info('Admin action: cluster invite created', { action: 'cluster_invite_created', adminUsername: actor(req), peerId: invite.id });
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json(invite);
  });
});

const joinSchema = z.object({ code: z.string().trim().min(10).max(2048), ownAddress: addressSchema });

router.post('/join', requireAdmin, writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const body = joinSchema.parse(req.body);
  await guarded(res, async () => {
    const peer = await joinCluster({ code: body.code, ownAddress: body.ownAddress, createdBy: actor(req) });
    logger.info('Admin action: cluster join started', { action: 'cluster_join_started', adminUsername: actor(req), peerId: peer.id });
    res.status(201).json(peer);
  });
});

const updatePeerSchema = z.object({
  address: addressSchema.optional(),
  name: z.string().trim().max(120).optional(),
  enabled: z.boolean().optional(),
});

router.patch('/peers/:id', requireAdmin, writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const id = peerIdSchema.parse(req.params['id']);
  const body = updatePeerSchema.parse(req.body);
  await guarded(res, async () => {
    await updatePeer(id, body);
    logger.info('Admin action: cluster peer updated', {
      action: 'cluster_peer_updated', adminUsername: actor(req), peerId: id, fields: Object.keys(body),
    });
    res.json({ ok: true });
  });
});

const resyncSchema = z.object({ acceptStale: z.boolean().optional() });

router.post('/peers/:id/resync', requireAdmin, writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const id = peerIdSchema.parse(req.params['id']);
  const body = resyncSchema.parse(req.body ?? {});
  await guarded(res, async () => {
    const result = await resyncPeer(id, body.acceptStale === true);
    logger.info('Admin action: cluster resync started', {
      action: 'cluster_resync_started', adminUsername: actor(req), peerId: id,
    });
    res.json(result);
  });
});

router.post('/peers/:id/verify', requireAdmin, writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const id = peerIdSchema.parse(req.params['id']);
  await guarded(res, async () => {
    const result = await verifyNow(id);
    logger.info('Admin action: cluster data check run', { action: 'cluster_verify_run', adminUsername: actor(req), peerId: id, repaired: result.repaired });
    res.json(result);
  });
});

router.delete('/peers/:id', requireAdmin, writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const id = peerIdSchema.parse(req.params['id']);
  await guarded(res, async () => {
    const result = await removePeer(id);
    logger.info('Admin action: cluster peer removed', { action: 'cluster_peer_removed', adminUsername: actor(req), peerId: id, deleted: result.deleted });
    res.json(result);
  });
});

// Makes this node's data the authoritative version for the whole cluster.
// Rows edited elsewhere since are overwritten, so the caller has to confirm.
const rebuildSchema = z.object({ confirmation: z.literal('REBUILD') });

router.post('/rebuild', requireAdmin, writeLimiter, async (req: Request, res: Response): Promise<void> => {
  rebuildSchema.parse(req.body);
  await guarded(res, async () => {
    const result = await rebuildFromThisNode();
    logger.info('Admin action: cluster versions rebuilt', { action: 'cluster_rebuild', adminUsername: actor(req), rows: result.rows });
    res.json(result);
  });
});

const nodeSchema = z.object({ name: z.string().trim().min(1).max(120) });

router.patch('/node', requireAdmin, writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const body = nodeSchema.parse(req.body);
  await guarded(res, async () => {
    await setNodeName(body.name);
    logger.info('Admin action: cluster node renamed', { action: 'cluster_node_renamed', adminUsername: actor(req) });
    res.json({ ok: true });
  });
});

export { router as clusterAdminRouter };
