import { Router, Request, Response } from 'express';
import { z } from 'zod';
import type { Popup } from '@prisma/client';
import { prisma } from '../db';
import { requireAdmin } from '../middleware/requireAdmin';
import { writeLimiter } from '../middleware/rateLimiter';
import { logger } from '../utils/logger';
import { NotFoundError, ValidationError } from '../utils/errors';
import { renderPopupContent } from '../services/popupRender';

// ─── Announcement popups ──────────────────────────────────────────────────────
// Admin CRUD lives under /api/admin/popups (JWT admin), the client feed under
// /popups/active (API key, like every other app route). See the Popup model in
// prisma/schema.prisma for the scheduling semantics.

const PLATFORMS = ['all', 'web', 'android'] as const;
const AUDIENCES = ['all', 'users', 'guests'] as const;
type PopupStatus = 'disabled' | 'scheduled' | 'active' | 'expired';

// Length of one display slot, or null for a popup that is shown once.
function slotMs(p: Pick<Popup, 'mode' | 'showCount' | 'startsAt' | 'endsAt'>): number | null {
  if (p.mode !== 'recurring' || !p.startsAt || !p.endsAt) return null;
  return Math.floor((p.endsAt.getTime() - p.startsAt.getTime()) / p.showCount);
}

function statusOf(p: Popup, now = Date.now()): PopupStatus {
  if (!p.enabled) return 'disabled';
  if (p.endsAt && p.endsAt.getTime() <= now) return 'expired';
  if (p.startsAt && p.startsAt.getTime() > now) return 'scheduled';
  return 'active';
}

function adminRow(p: Popup) {
  return {
    id: p.id,
    title: p.title,
    content: p.content,
    contentHtml: p.contentHtml,
    platform: p.platform,
    audience: p.audience,
    mode: p.mode,
    showCount: p.showCount,
    startsAt: p.startsAt?.toISOString() ?? null,
    endsAt: p.endsAt?.toISOString() ?? null,
    slotMs: slotMs(p),
    enabled: p.enabled,
    revision: p.revision,
    status: statusOf(p),
    createdBy: p.createdBy,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

const popupSchema = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().max(100_000),
  platform: z.enum(PLATFORMS),
  audience: z.enum(AUDIENCES),
  mode: z.enum(['once', 'recurring']),
  showCount: z.number().int().min(1).max(1000),
  startsAt: z.string().datetime({ offset: true }).nullable(),
  endsAt: z.string().datetime({ offset: true }).nullable(),
  enabled: z.boolean(),
  // Edit only: bump the revision so every client shows it again.
  resetSeen: z.boolean().optional(),
});

function normalize(body: z.infer<typeof popupSchema>) {
  const startsAt = body.startsAt ? new Date(body.startsAt) : null;
  const endsAt = body.endsAt ? new Date(body.endsAt) : null;
  if (startsAt && endsAt && endsAt <= startsAt) throw new ValidationError('Das Ende muss nach dem Start liegen');
  if (body.mode === 'recurring') {
    if (!startsAt || !endsAt) throw new ValidationError('Für wiederholte Anzeige werden Start und Ende benötigt');
    if (body.showCount < 2) throw new ValidationError('Wiederholte Anzeige braucht mindestens 2 Anzeigen');
  }
  return {
    title: body.title,
    content: body.content,
    contentHtml: renderPopupContent(body.content),
    platform: body.platform,
    audience: body.audience,
    mode: body.mode,
    showCount: body.mode === 'once' ? 1 : body.showCount,
    startsAt,
    endsAt,
    enabled: body.enabled,
  };
}

// ─── Admin router: /api/admin/popups ─────────────────────────────────────────

const admin = Router();

admin.get('/', requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  const popups = await prisma.popup.findMany({ orderBy: { createdAt: 'desc' } });
  res.json({ popups: popups.map(adminRow) });
});

// Live preview for the editor — the exact HTML clients would receive.
admin.post('/render', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const { content } = z.object({ content: z.string().max(100_000) }).parse(req.body);
  res.json({ html: renderPopupContent(content) });
});

admin.post('/', requireAdmin, writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const data = normalize(popupSchema.parse(req.body));
  const adminUsername = req.adminUser?.username ?? 'admin';
  const popup = await prisma.popup.create({ data: { ...data, createdBy: adminUsername } });
  logger.info('Admin action: popup created', { action: 'popup_created', adminUsername, popupId: popup.id, platform: popup.platform });
  res.status(201).json({ popup: adminRow(popup) });
});

admin.put('/:id', requireAdmin, writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const id = z.string().uuid().parse(req.params['id']);
  const body = popupSchema.parse(req.body);
  const existing = await prisma.popup.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw new NotFoundError('Popup nicht gefunden');
  const popup = await prisma.popup.update({
    where: { id },
    data: { ...normalize(body), ...(body.resetSeen ? { revision: { increment: 1 } } : {}) },
  });
  const adminUsername = req.adminUser?.username ?? 'admin';
  logger.info('Admin action: popup updated', { action: 'popup_updated', adminUsername, popupId: id, resetSeen: !!body.resetSeen });
  res.json({ popup: adminRow(popup) });
});

admin.patch('/:id/enabled', requireAdmin, writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const id = z.string().uuid().parse(req.params['id']);
  const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
  const popup = await prisma.popup.update({ where: { id }, data: { enabled } });
  logger.info('Admin action: popup toggled', { action: 'popup_toggled', adminUsername: req.adminUser?.username, popupId: id, enabled });
  res.json({ popup: adminRow(popup) });
});

admin.delete('/:id', requireAdmin, writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const id = z.string().uuid().parse(req.params['id']);
  await prisma.popup.delete({ where: { id } });
  logger.info('Admin action: popup deleted', { action: 'popup_deleted', adminUsername: req.adminUser?.username, popupId: id });
  res.status(204).send();
});

// ─── Client router: /popups ──────────────────────────────────────────────────

const client = Router();

// GET /popups/active?platform=web|android&audience=user|guest
// Every popup currently inside its window for this platform and audience
// (default: signed-in user). Whether this device already saw it in the
// current slot is decided client-side.
client.get('/active', async (req: Request, res: Response): Promise<void> => {
  const platform = z.enum(['web', 'android']).parse(req.query['platform']);
  const audience = z.enum(['user', 'guest']).default('user').parse(req.query['audience']);
  const now = new Date();
  const popups = await prisma.popup.findMany({
    where: {
      enabled: true,
      platform: { in: ['all', platform] },
      audience: { in: ['all', audience === 'guest' ? 'guests' : 'users'] },
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
        { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
      ],
    },
    orderBy: { createdAt: 'asc' },
  });
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    now: now.toISOString(),
    popups: popups.map((p) => ({
      id: p.id,
      revision: p.revision,
      title: p.title,
      html: p.contentHtml,
      showCount: p.showCount,
      startsAt: p.startsAt?.toISOString() ?? null,
      endsAt: p.endsAt?.toISOString() ?? null,
      slotMs: slotMs(p),
    })),
  });
});

export { admin as popupsAdminRouter, client as popupsRouter };
