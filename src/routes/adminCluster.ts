import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAdmin, requirePermission } from '../middleware/requireAdmin';
import { writeLimiter } from '../middleware/rateLimiter';
import { logger } from '../utils/logger';
import {
  ClusterError,
  addClusterRelay,
  clusterStatus,
  createInvite,
  createNodeInstall,
  createRelayCommand,
  reachStatus,
  removeClusterRelay,
  updateClusterRelay,
  updateReach,
  joinCluster,
  listNodeInstalls,
  rebuildFromThisNode,
  removePeer,
  resyncPeer,
  revokeNodeInstall,
  rotateCertificate,
  setNodeName,
  updatePeer,
  verifyNow,
  updateStatus,
  checkUpdatesNow,
  releaseCommit,
  retryUpdate,
  rollBack,
  saveUpdateSettings,
  testReachWay,
} from '../cluster';

// ─── Cluster administration: /api/admin/cluster ──────────────────────────────
// A node joins with a one-time invite code created on any member, or is set
// up from scratch with a one-line install command. Codes and commands are
// returned exactly once, to the administrator who created them, and are never
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

router.get('/', requireAdmin, requirePermission('cluster.manage'), async (_req: Request, res: Response): Promise<void> => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await clusterStatus());
});

const inviteSchema = z.object({ ownAddress: addressSchema });

router.post('/invites', requireAdmin, requirePermission('cluster.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const body = inviteSchema.parse(req.body);
  await guarded(res, async () => {
    const invite = await createInvite({ ownAddress: body.ownAddress, createdBy: actor(req) });
    logger.info('Admin action: cluster invite created', { action: 'cluster_invite_created', adminUsername: actor(req), peerId: invite.id });
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json(invite);
  });
});

const joinSchema = z.object({ code: z.string().trim().min(10).max(2048), ownAddress: addressSchema });

router.post('/join', requireAdmin, requirePermission('cluster.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
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

router.patch('/peers/:id', requireAdmin, requirePermission('cluster.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
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

router.post('/peers/:id/resync', requireAdmin, requirePermission('cluster.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
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

router.post('/peers/:id/verify', requireAdmin, requirePermission('cluster.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const id = peerIdSchema.parse(req.params['id']);
  await guarded(res, async () => {
    const result = await verifyNow(id);
    logger.info('Admin action: cluster data check run', { action: 'cluster_verify_run', adminUsername: actor(req), peerId: id, repaired: result.repaired });
    res.json(result);
  });
});

router.delete('/peers/:id', requireAdmin, requirePermission('cluster.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
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

router.post('/rebuild', requireAdmin, requirePermission('cluster.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
  rebuildSchema.parse(req.body);
  await guarded(res, async () => {
    const result = await rebuildFromThisNode();
    logger.info('Admin action: cluster versions rebuilt', { action: 'cluster_rebuild', adminUsername: actor(req), rows: result.rows });
    res.json(result);
  });
});

// ─── One-line node install ───────────────────────────────────────────────────

const installSchema = z.object({
  name: z.string().trim().min(1).max(120),
  // Optional: the new server's domain or IP; empty = detected.
  address: z.string().trim().max(253).optional(),
  acmeEmail: z.string().trim().max(254).optional(),
  // This node's public address as the browser shows it (window.location.origin).
  origin: z.string().trim().min(1).max(255),
  // How the new server is reached (installOptions.ts); empty: like this node.
  web: z.enum(['none', 'domain', 'proxy']).optional(),
  apiPort: z.number().int().optional(),
  apiBind: z.string().trim().max(64).optional(),
  apiFrom: z.string().trim().max(1000).optional(),
  clusterPort: z.number().int().optional(),
  clusterBind: z.string().trim().max(64).optional(),
  clusterFrom: z.string().trim().max(1000).optional(),
});

router.post('/node-installs', requireAdmin, requirePermission('cluster.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const body = installSchema.parse(req.body);
  await guarded(res, async () => {
    const install = await createNodeInstall({
      name: body.name,
      address: body.address ?? '',
      acmeEmail: body.acmeEmail ?? '',
      origin: body.origin,
      options: {
        web: body.web, apiPort: body.apiPort, apiBind: body.apiBind, apiFrom: body.apiFrom,
        clusterPort: body.clusterPort, clusterBind: body.clusterBind, clusterFrom: body.clusterFrom,
      },
      createdBy: actor(req),
    });
    logger.info('Admin action: one-line node install created', { action: 'cluster_install_created', adminUsername: actor(req), installId: install.id });
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json(install);
  });
});

router.get('/node-installs', requireAdmin, requirePermission('cluster.manage'), async (_req: Request, res: Response): Promise<void> => {
  await guarded(res, async () => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ installs: await listNodeInstalls() });
  });
});

router.delete('/node-installs/:id', requireAdmin, requirePermission('cluster.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const id = peerIdSchema.parse(req.params['id']);
  await guarded(res, async () => {
    await revokeNodeInstall(id);
    logger.info('Admin action: one-line node install revoked', { action: 'cluster_install_revoked', adminUsername: actor(req), installId: id });
    res.json({ ok: true });
  });
});

// Renews this node's certificate on every linked node at once.
router.post('/certificate/rotate', requireAdmin, requirePermission('cluster.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
  await guarded(res, async () => {
    const result = await rotateCertificate();
    logger.info('Admin action: cluster certificate renewed', { action: 'cluster_certificate_rotated', adminUsername: actor(req), peers: result.peers });
    res.json(result);
  });
});

// ─── How this node is reached, relays ────────────────────────────────────────

router.get('/reach', requireAdmin, requirePermission('cluster.manage'), async (_req: Request, res: Response): Promise<void> => {
  await guarded(res, async () => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(reachStatus());
  });
});

const reachEntrySchema = z.object({
  id: z.string().max(36).optional(),
  kind: z.enum(['direct', 'proxy-port', 'proxy-sni', 'proxy-path']),
  endpoint: z.string().trim().min(1).max(300),
  enabled: z.boolean(),
  backend: z.string().trim().max(270).optional(),
});
const reachSchema = z.object({ entries: z.array(reachEntrySchema).max(8) });

router.put('/reach', requireAdmin, requirePermission('cluster.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const body = reachSchema.parse(req.body);
  await guarded(res, async () => {
    const result = await updateReach(body.entries);
    logger.info('Admin action: cluster reachability changed', { action: 'cluster_reach_changed', adminUsername: actor(req), entries: body.entries.length });
    res.json(result);
  });
});

const relayKeySchema = z.object({ key: z.string().trim().min(10).max(4096) });

router.post('/relays', requireAdmin, requirePermission('cluster.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const body = relayKeySchema.parse(req.body);
  await guarded(res, async () => {
    const relay = await addClusterRelay(body.key, actor(req));
    logger.info('Admin action: cluster relay added', { action: 'cluster_relay_added', adminUsername: actor(req), relayId: relay.id });
    res.status(201).json(relay);
  });
});

const relayUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  usePorts: z.boolean().optional(),
  useSni: z.boolean().optional(),
  name: z.string().trim().max(60).optional(),
});

router.patch('/relays/:id', requireAdmin, requirePermission('cluster.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const id = peerIdSchema.parse(req.params['id']);
  const body = relayUpdateSchema.parse(req.body);
  await guarded(res, async () => {
    await updateClusterRelay(id, body);
    logger.info('Admin action: cluster relay updated', { action: 'cluster_relay_updated', adminUsername: actor(req), relayId: id, fields: Object.keys(body) });
    res.json({ ok: true });
  });
});

router.delete('/relays/:id', requireAdmin, requirePermission('cluster.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const id = peerIdSchema.parse(req.params['id']);
  await guarded(res, async () => {
    await removeClusterRelay(id);
    logger.info('Admin action: cluster relay removed', { action: 'cluster_relay_removed', adminUsername: actor(req), relayId: id });
    res.json({ ok: true });
  });
});

const relayCommandSchema = z.object({
  origin: z.string().trim().min(1).max(255),
  host: z.string().trim().max(253).default(''),
  port: z.number().int().min(1).max(65_535).default(4100),
  publicPort: z.boolean().default(true),
  domain: z.string().trim().max(253).default(''),
  name: z.string().trim().max(60).default('relay'),
});

router.post('/relay-command', requireAdmin, requirePermission('cluster.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const body = relayCommandSchema.parse(req.body);
  await guarded(res, async () => {
    const result = createRelayCommand(body);
    logger.info('Admin action: relay setup command created', { action: 'cluster_relay_command', adminUsername: actor(req) });
    res.setHeader('Cache-Control', 'no-store');
    res.json(result);
  });
});

const nodeSchema = z.object({ name: z.string().trim().min(1).max(120) });

router.patch('/node', requireAdmin, requirePermission('cluster.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const body = nodeSchema.parse(req.body);
  await guarded(res, async () => {
    await setNodeName(body.name);
    logger.info('Admin action: cluster node renamed', { action: 'cluster_node_renamed', adminUsername: actor(req) });
    res.json({ ok: true });
  });
});

// ─── Updates (src/cluster/updates.ts) ────────────────────────────────────────
// Settings are cluster-wide (replicated); retry and roll back act on this
// node only — the one whose admin panel is open.

router.get('/updates', requireAdmin, requirePermission('cluster.manage'), async (_req: Request, res: Response): Promise<void> => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await updateStatus());
});

const updateSettingsSchema = z.object({
  repo: z.string().trim().max(300),
  branch: z.string().trim().min(1).max(200),
  auto: z.boolean(),
  requireCi: z.boolean(),
});

router.put('/updates/settings', requireAdmin, requirePermission('cluster.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const parsed = updateSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid update settings' });
    return;
  }
  await guarded(res, async () => {
    const settings = await saveUpdateSettings(parsed.data, actor(req));
    logger.info('Cluster update settings changed', { action: 'cluster_update_settings', admin: actor(req), auto: settings.auto, requireCi: settings.requireCi });
    res.json(settings);
  });
});

router.post('/updates/check', requireAdmin, requirePermission('cluster.manage'), writeLimiter, async (_req: Request, res: Response): Promise<void> => {
  await guarded(res, async () => {
    await checkUpdatesNow();
    res.json(await updateStatus());
  });
});

router.post('/updates/release', requireAdmin, requirePermission('cluster.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const parsed = z.object({ commit: z.string().regex(/^[0-9a-f]{40}$/) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid commit' });
    return;
  }
  await guarded(res, async () => {
    await releaseCommit(parsed.data.commit, actor(req));
    logger.info('Cluster update released', { action: 'cluster_update_released', admin: actor(req), commit: parsed.data.commit });
    res.json({ ok: true });
  });
});

router.post('/updates/retry', requireAdmin, requirePermission('cluster.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
  await guarded(res, async () => {
    retryUpdate(actor(req));
    logger.info('Cluster update retried', { action: 'cluster_update_retry', admin: actor(req) });
    res.json({ ok: true });
  });
});

router.post('/updates/rollback', requireAdmin, requirePermission('cluster.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
  await guarded(res, async () => {
    rollBack(actor(req));
    logger.warn('Cluster node rolled back', { action: 'cluster_update_rollback', admin: actor(req) });
    res.json({ ok: true });
  });
});

// ─── Ways ────────────────────────────────────────────────────────────────────

const wayTestSchema = z.object({
  kind: z.enum(['direct', 'proxy-port', 'proxy-sni', 'proxy-path']),
  endpoint: z.string().trim().min(1).max(300),
});

// "Test this way": does it arrive at this node?
router.post('/reach/test', requireAdmin, requirePermission('cluster.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const parsed = wayTestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid way' });
    return;
  }
  await guarded(res, async () => {
    res.json(await testReachWay(parsed.data.kind, parsed.data.endpoint));
  });
});

export { router as clusterAdminRouter };
