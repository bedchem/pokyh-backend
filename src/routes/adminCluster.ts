import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../middleware/requireAdmin';
import { writeLimiter } from '../middleware/rateLimiter';
import { logger } from '../utils/logger';
import {
  ClusterError,
  addPeer,
  clusterStatus,
  newPairingKey,
  rebuildFromThisNode,
  removePeer,
  repairPeer,
  resyncPeer,
  setNodeName,
  updatePeer,
} from '../cluster';

// ─── Cluster administration: /api/admin/cluster ──────────────────────────────
// Adding a node is a two-sided, manual act: an administrator enters the other
// node's address and the same pairing key on both nodes. Nothing here ever
// returns key material — a pairing key is accepted, used once and discarded.

const router = Router();

function actor(req: Request): string {
  return req.adminUser?.username ?? 'admin';
}

// Cluster operations report expected failures (bad address, weak key, peer
// not found) with their own status code and message.
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

router.get('/', requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await clusterStatus());
});

// A strong pairing key to copy to the other node. It is not stored here.
router.post('/pairing-key', requireAdmin, writeLimiter, async (_req: Request, res: Response): Promise<void> => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ pairingKey: newPairingKey() });
});

const addPeerSchema = z.object({
  address: z.string().trim().min(1).max(255),
  name: z.string().trim().max(120).optional(),
  pairingKey: z.string().min(1).max(512),
});

router.post('/peers', requireAdmin, writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const body = addPeerSchema.parse(req.body);
  await guarded(res, async () => {
    const peer = await addPeer({ ...body, createdBy: actor(req) });
    logger.info('Admin action: cluster peer added', { action: 'cluster_peer_added', adminUsername: actor(req), peerId: peer.id });
    res.status(201).json(peer);
  });
});

const updatePeerSchema = z.object({
  address: z.string().trim().min(1).max(255).optional(),
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

const pairSchema = z.object({ pairingKey: z.string().min(1).max(512) });

// Opens a new pairing window for an existing peer entry.
router.post('/peers/:id/pair', requireAdmin, writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const id = peerIdSchema.parse(req.params['id']);
  const body = pairSchema.parse(req.body);
  await guarded(res, async () => {
    await repairPeer(id, body.pairingKey);
    logger.info('Admin action: cluster pairing reopened', { action: 'cluster_pairing_reopened', adminUsername: actor(req), peerId: id });
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

router.delete('/peers/:id', requireAdmin, writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const id = peerIdSchema.parse(req.params['id']);
  await guarded(res, async () => {
    await removePeer(id);
    logger.info('Admin action: cluster peer removed', { action: 'cluster_peer_removed', adminUsername: actor(req), peerId: id });
    res.status(204).send();
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
