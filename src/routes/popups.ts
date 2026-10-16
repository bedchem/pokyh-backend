import { Router, Request, Response } from 'express';
import { z } from 'zod';
import type { Popup, Prisma } from '@prisma/client';
import { prisma } from '../db';
import { optionalAuth } from '../middleware/auth';
import { inScope, requireAdmin, requirePermission, scopeSchool } from '../middleware/requireAdmin';
import { audit } from '../services/audit';
import { schoolById, schoolOfUser } from '../services/schools';
import { writeLimiter } from '../middleware/rateLimiter';
import { logger } from '../utils/logger';
import { NotFoundError, ValidationError } from '../utils/errors';
import { renderPopupContent } from '../services/popupRender';
import { likeText } from '../utils/like';

// ─── Announcement popups ──────────────────────────────────────────────────────
// Admin CRUD lives under /api/admin/popups (JWT admin), the client feed under
// /popups/active (API key, like every other app route). See the Popup model in
// prisma/schema.prisma for the scheduling semantics.
//
// A popup can be meant for chosen people only: single users and/or whole
// classes (WebUntis classes, the class every student signs in with). Such a
// popup reaches nobody else — the feed decides on the server, from the
// caller's own session, and never hands a targeted popup to a request
// without a valid user session.

const PLATFORMS = ['all', 'web', 'android'] as const;
const AUDIENCES = ['all', 'users', 'guests'] as const;
type PopupStatus = 'disabled' | 'scheduled' | 'active' | 'expired';
const MAX_TARGET_USERS = 500;
const MAX_TARGET_CLASSES = 200;

const withTargets = {
  targetUsers: { include: { user: { select: { username: true, webuntisKlasseName: true } } } },
  targetClasses: true,
} satisfies Prisma.PopupInclude;
type PopupWithTargets = Prisma.PopupGetPayload<{ include: typeof withTargets }>;

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

function adminRow(p: PopupWithTargets) {
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
    targetUsers: p.targetUsers
      .map((target) => ({ stableUid: target.stableUid, username: target.user.username, klasseName: target.user.webuntisKlasseName }))
      .sort((a, b) => a.username.localeCompare(b.username)),
    targetClasses: p.targetClasses
      .map((target) => ({ id: target.klasseId, name: target.klasseName }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    createdBy: p.createdBy,
    // Null: every school.
    schoolId: p.schoolId,
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
  // Empty both: everybody the platform and audience allow. Otherwise only
  // these users and the members of these classes (signed in).
  targetUsers: z.array(z.string().trim().min(1).max(191)).max(MAX_TARGET_USERS).default([]),
  targetClasses: z.array(z.number().int().positive()).max(MAX_TARGET_CLASSES).default([]),
  // Global view only: one school, or null/absent for every school.
  schoolId: z.string().trim().toLowerCase().max(36).nullable().optional(),
});

// The classes a popup can be meant for: every WebUntis class a user signed
// in with, and every class group created in the app, by id.
// WebUntis class ids are per school, so classes are always of one school.
async function knownClasses(schoolId: string | null): Promise<Map<number, { name: string; users: number }>> {
  const ofSchool = schoolId ? { schoolId } : {};
  const [fromUsers, groups] = await Promise.all([
    prisma.user.groupBy({ by: ['webuntisKlasseId', 'webuntisKlasseName'], where: { webuntisKlasseId: { gt: 0 }, ...ofSchool }, _count: { _all: true } }),
    prisma.class.findMany({ where: { webuntisKlasseId: { gt: 0 }, ...ofSchool }, select: { webuntisKlasseId: true, name: true } }),
  ]);
  const classes = new Map<number, { name: string; users: number }>();
  for (const row of fromUsers) {
    const known = classes.get(row.webuntisKlasseId);
    classes.set(row.webuntisKlasseId, {
      name: known?.name || row.webuntisKlasseName,
      users: (known?.users ?? 0) + row._count._all,
    });
  }
  for (const group of groups) {
    if (!classes.has(group.webuntisKlasseId)) classes.set(group.webuntisKlasseId, { name: group.name, users: 0 });
  }
  return classes;
}

// Checks the chosen people and classes exist — in the popup's school; returns
// what is stored.
async function resolveTargets(body: z.infer<typeof popupSchema>, schoolId: string | null) {
  const users = [...new Set(body.targetUsers)];
  const classIds = [...new Set(body.targetClasses)];
  if (users.length > 0) {
    const found = await prisma.user.count({ where: { stableUid: { in: users }, ...(schoolId ? { schoolId } : {}) } });
    if (found !== users.length) throw new ValidationError('Mindestens ein ausgewählter Benutzer existiert nicht (mehr)');
  }
  const classes: Array<{ klasseId: number; klasseName: string }> = [];
  if (classIds.length > 0) {
    // A class id names a class in one school only.
    if (!schoolId) throw new ValidationError('Klassen kann nur ein Popup für eine bestimmte Schule ansprechen');
    const known = await knownClasses(schoolId);
    for (const id of classIds) {
      const entry = known.get(id);
      if (!entry) throw new ValidationError('Mindestens eine ausgewählte Klasse existiert nicht (mehr)');
      classes.push({ klasseId: id, klasseName: entry.name.slice(0, 100) });
    }
  }
  return { users, classes };
}

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

// Chosen people are signed in by definition: such a popup is never shown to
// guests.
function audienceFor(body: z.infer<typeof popupSchema>): (typeof AUDIENCES)[number] {
  return body.targetUsers.length > 0 || body.targetClasses.length > 0 ? 'users' : body.audience;
}

// ─── Admin router: /api/admin/popups ─────────────────────────────────────────

const admin = Router();

// The school a popup written by this request is for: a school's view writes
// for its school; the global view for the one named, or for every school.
async function popupSchool(req: Request, body: z.infer<typeof popupSchema>): Promise<string | null> {
  const scoped = scopeSchool(req);
  if (scoped) return scoped;
  if (!body.schoolId) return null;
  const school = await schoolById(body.schoolId);
  if (!school) throw new ValidationError('Unbekannte Schule');
  return school.id;
}

admin.get('/', requireAdmin, requirePermission('popups.view'), async (req: Request, res: Response): Promise<void> => {
  const schoolId = scopeSchool(req);
  const popups = await prisma.popup.findMany({ where: schoolId ? { schoolId } : {}, orderBy: { createdAt: 'desc' }, include: withTargets });
  res.json({ popups: popups.map(adminRow) });
});

// For choosing who a popup is meant for: users by name (search), and every
// known class.
admin.get('/targets', requireAdmin, requirePermission('popups.manage'), async (req: Request, res: Response): Promise<void> => {
  const query = z.string().trim().max(100).default('').parse(req.query['q'] ?? '');
  // The global view picks among one school's people and classes (?forSchool=).
  const forSchool = typeof req.query['forSchool'] === 'string' ? (await schoolById(req.query['forSchool'].trim().toLowerCase()))?.id ?? null : null;
  const schoolId = scopeSchool(req) ?? forSchool;
  const users = await prisma.user.findMany({
    where: { ...(query ? { username: { contains: likeText(query) } } : {}), ...(schoolId ? { schoolId } : {}) },
    select: { stableUid: true, username: true, webuntisKlasseName: true },
    orderBy: { username: 'asc' },
    take: 25,
  });
  const classes = [...(schoolId ? await knownClasses(schoolId) : new Map<number, { name: string; users: number }>()).entries()]
    .map(([id, entry]) => ({ id, name: entry.name, users: entry.users }))
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    users: users.map((user) => ({ stableUid: user.stableUid, username: user.username, klasseName: user.webuntisKlasseName })),
    classes,
  });
});

// Live preview for the editor — the exact HTML clients would receive.
admin.post('/render', requireAdmin, requirePermission('popups.manage'), async (req: Request, res: Response): Promise<void> => {
  const { content } = z.object({ content: z.string().max(100_000) }).parse(req.body);
  res.json({ html: renderPopupContent(content) });
});

admin.post('/', requireAdmin, requirePermission('popups.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const body = popupSchema.parse(req.body);
  const data = { ...normalize(body), audience: audienceFor(body) };
  const schoolId = await popupSchool(req, body);
  const targets = await resolveTargets(body, schoolId);
  const adminUsername = req.adminUser?.username ?? 'admin';
  const popup = await prisma.popup.create({
    data: {
      ...data,
      schoolId,
      createdBy: adminUsername,
      targetUsers: { create: targets.users.map((stableUid) => ({ stableUid })) },
      targetClasses: { create: targets.classes },
    },
    include: withTargets,
  });
  logger.info('Admin action: popup created', {
    action: 'popup_created', adminUsername, popupId: popup.id, platform: popup.platform,
    targetUsers: targets.users.length, targetClasses: targets.classes.length,
  });
  audit(req, 'popup.create', { type: 'popup', id: popup.id }, { title: popup.title }, schoolId);
  res.status(201).json({ popup: adminRow(popup) });
});

admin.put('/:id', requireAdmin, requirePermission('popups.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const id = z.string().uuid().parse(req.params['id']);
  const body = popupSchema.parse(req.body);
  const existing = await prisma.popup.findUnique({ where: { id }, select: { id: true, schoolId: true } });
  // A school's view reaches its own popups; every-school popups are global.
  if (!existing || !inScope(req, existing.schoolId) || (scopeSchool(req) !== null && existing.schoolId === null)) throw new NotFoundError('Popup nicht gefunden');
  const schoolId = scopeSchool(req) ?? (body.schoolId === undefined ? existing.schoolId : await popupSchool(req, body));
  const targets = await resolveTargets(body, schoolId);
  // One update: the old choice of people is replaced atomically.
  const popup = await prisma.popup.update({
    where: { id },
    data: {
      ...normalize(body),
      audience: audienceFor(body),
      ...(body.resetSeen ? { revision: { increment: 1 } } : {}),
      schoolId,
      targetUsers: { deleteMany: {}, create: targets.users.map((stableUid) => ({ stableUid })) },
      targetClasses: { deleteMany: {}, create: targets.classes },
    },
    include: withTargets,
  });
  const adminUsername = req.adminUser?.username ?? 'admin';
  logger.info('Admin action: popup updated', {
    action: 'popup_updated', adminUsername, popupId: id, resetSeen: !!body.resetSeen,
    targetUsers: targets.users.length, targetClasses: targets.classes.length,
  });
  audit(req, 'popup.update', { type: 'popup', id }, { title: popup.title }, schoolId);
  res.json({ popup: adminRow(popup) });
});

async function popupInScope(req: Request, id: string): Promise<void> {
  const existing = await prisma.popup.findUnique({ where: { id }, select: { schoolId: true } });
  if (!existing || !inScope(req, existing.schoolId) || (scopeSchool(req) !== null && existing.schoolId === null)) throw new NotFoundError('Popup nicht gefunden');
}

admin.patch('/:id/enabled', requireAdmin, requirePermission('popups.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const id = z.string().uuid().parse(req.params['id']);
  const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
  await popupInScope(req, id);
  const popup = await prisma.popup.update({ where: { id }, data: { enabled }, include: withTargets });
  logger.info('Admin action: popup toggled', { action: 'popup_toggled', adminUsername: req.adminUser?.username, popupId: id, enabled });
  res.json({ popup: adminRow(popup) });
});

admin.delete('/:id', requireAdmin, requirePermission('popups.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const id = z.string().uuid().parse(req.params['id']);
  await popupInScope(req, id);
  await prisma.popup.delete({ where: { id } });
  logger.info('Admin action: popup deleted', { action: 'popup_deleted', adminUsername: req.adminUser?.username, popupId: id });
  audit(req, 'popup.delete', { type: 'popup', id });
  res.status(204).send();
});

// ─── Client router: /popups ──────────────────────────────────────────────────

const client = Router();

// GET /popups/active?platform=web|android&audience=user|guest
// Every popup currently inside its window for this platform and audience
// (default: signed-in user). Whether this device already saw it in the
// current slot is decided client-side. Popups meant for chosen users or
// classes are included only with a valid user session of one of them.
client.get('/active', optionalAuth, async (req: Request, res: Response): Promise<void> => {
  const platform = z.enum(['web', 'android']).parse(req.query['platform']);
  const audience = z.enum(['user', 'guest']).default('user').parse(req.query['audience']);
  const now = new Date();
  const user = audience === 'user' ? req.user : undefined;
  // Popups for every school, and those of the signed-in account's school.
  const schoolId = user ? await schoolOfUser(user.stableUid) : null;
  const meantFor: Prisma.PopupWhereInput[] = [{ targetUsers: { none: {} }, targetClasses: { none: {} } }];
  if (user) {
    meantFor.push({ targetUsers: { some: { stableUid: user.stableUid } } });
    if (Number.isInteger(user.klasseId) && user.klasseId > 0) meantFor.push({ targetClasses: { some: { klasseId: user.klasseId } } });
  }
  const popups = await prisma.popup.findMany({
    where: {
      enabled: true,
      platform: { in: ['all', platform] },
      audience: { in: ['all', audience === 'guest' ? 'guests' : 'users'] },
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
        { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
        { OR: meantFor },
        { OR: [{ schoolId: null }, ...(schoolId ? [{ schoolId }] : [])] },
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
