import { Router, Request, Response } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { inScope, requireAdmin, requirePermission, scopeSchool } from '../middleware/requireAdmin';
import { readLimiter, writeLimiter } from '../middleware/rateLimiter';
import { audit } from '../services/audit';
import { cached } from '../services/cache';
import { listSchools, schoolById, schoolOfUser } from '../services/schools';
import { recapPokyhFigures } from '../services/recaps';
import { RECAP_SECTIONS, formatSections, isDayKey, parseSections, recapReaches, recapStatus, type RecapReach } from '../services/recapRules';
import { knownClasses } from './popups';
import { likeText } from '../utils/like';
import { logger } from '../utils/logger';
import { NotFoundError, ValidationError } from '../utils/errors';

// ─── Recaps ───────────────────────────────────────────────────────────────────
// A look back at a period ("Dein Schuljahr"), shown in the app as a story.
// Admins make them under /api/admin/recaps: the period, when it can be
// opened, which parts it shows and who it is for — every student, or chosen
// schools, classes and students in any mix. Students list and open theirs
// under /recaps (API key + user session). Who a recap reaches is decided here,
// from the caller's own session (services/recapRules.ts); a recap meant for
// others is never handed out, not even its title.
//
// The WebUntis figures are worked out on the student's device; this server
// only answers the POKYH part (services/recaps.ts) and keeps whether the
// account opened and finished the recap (recap_views).

const MAX_TARGET_SCHOOLS = 200;
const MAX_TARGET_CLASSES = 300;
const MAX_TARGET_USERS = 1000;
/** Longest period a recap may look back over. */
const MAX_PERIOD_DAYS = 400;
const FEED_CACHE_SECONDS = 30;

const withTargets = {
  targetSchools: true,
  targetClasses: true,
  targetUsers: { include: { user: { select: { username: true, webuntisKlasseName: true, schoolId: true } } } },
  _count: { select: { views: true } },
} satisfies Prisma.RecapInclude;
type RecapWithTargets = Prisma.RecapGetPayload<{ include: typeof withTargets }>;

const daySchema = z.string().refine(isDayKey, 'Ungültiges Datum');

const recapSchema = z.object({
  title: z.string().trim().min(1).max(120),
  periodFrom: daySchema,
  periodTo: daySchema,
  startsAt: z.string().datetime({ offset: true }).nullable(),
  endsAt: z.string().datetime({ offset: true }).nullable(),
  sections: z.array(z.enum(RECAP_SECTIONS)).min(1).max(RECAP_SECTIONS.length),
  enabled: z.boolean(),
  // Edit only: forget who opened it, so it is new to everyone again.
  resetSeen: z.boolean().optional(),
  // All empty: every student. Otherwise only these schools, classes and
  // students (signed in).
  targetSchools: z.array(z.string().trim().toLowerCase().max(36)).max(MAX_TARGET_SCHOOLS).default([]),
  targetClasses: z.array(z.object({ schoolId: z.string().trim().toLowerCase().max(36), klasseId: z.number().int().positive() })).max(MAX_TARGET_CLASSES).default([]),
  targetUsers: z.array(z.string().trim().min(1).max(191)).max(MAX_TARGET_USERS).default([]),
  // Global view only: one school, or null/absent for every school.
  schoolId: z.string().trim().toLowerCase().max(36).nullable().optional(),
});
type RecapBody = z.infer<typeof recapSchema>;

function reachOf(r: RecapWithTargets): RecapReach {
  return {
    schoolId: r.schoolId,
    targetSchools: r.targetSchools.map((t) => t.schoolId),
    targetClasses: r.targetClasses.map((t) => ({ schoolId: t.schoolId, klasseId: t.klasseId })),
    targetUsers: r.targetUsers.map((t) => t.stableUid),
  };
}

// The accounts a recap reaches, as a query (the same rule as recapReaches).
function reachWhere(reach: RecapReach): Prisma.UserWhereInput {
  const school: Prisma.UserWhereInput = reach.schoolId ? { schoolId: reach.schoolId } : {};
  const students: Prisma.UserWhereInput = { role: { not: 'parent' } };
  const chosen = reach.targetSchools.length > 0 || reach.targetClasses.length > 0 || reach.targetUsers.length > 0;
  if (!chosen) return { ...school, ...students };
  const or: Prisma.UserWhereInput[] = [];
  if (reach.targetUsers.length > 0) or.push({ stableUid: { in: [...reach.targetUsers] } });
  if (reach.targetSchools.length > 0) or.push({ ...students, schoolId: { in: [...reach.targetSchools] } });
  for (const c of reach.targetClasses) or.push({ ...students, schoolId: c.schoolId, webuntisKlasseId: c.klasseId });
  return { ...school, OR: or };
}

async function adminRow(r: RecapWithTargets, schoolNames: Map<string, string>) {
  const reach = reachOf(r);
  const [reached, finished] = await Promise.all([
    prisma.user.count({ where: reachWhere(reach) }),
    prisma.recapView.count({ where: { recapId: r.id, finishedAt: { not: null } } }),
  ]);
  return {
    id: r.id,
    title: r.title,
    periodFrom: r.periodFrom,
    periodTo: r.periodTo,
    startsAt: r.startsAt?.toISOString() ?? null,
    endsAt: r.endsAt?.toISOString() ?? null,
    sections: parseSections(r.sections),
    enabled: r.enabled,
    status: recapStatus(r),
    schoolId: r.schoolId,
    schoolName: r.schoolId ? schoolNames.get(r.schoolId) ?? '' : null,
    targetSchools: r.targetSchools
      .map((t) => ({ id: t.schoolId, name: schoolNames.get(t.schoolId) ?? t.schoolId }))
      .sort((a, b) => a.name.localeCompare(b.name, 'de')),
    targetClasses: r.targetClasses
      .map((t) => ({ schoolId: t.schoolId, schoolName: schoolNames.get(t.schoolId) ?? '', id: t.klasseId, name: t.klasseName }))
      .sort((a, b) => a.schoolName.localeCompare(b.schoolName, 'de') || a.name.localeCompare(b.name, 'de')),
    targetUsers: r.targetUsers
      .map((t) => ({ stableUid: t.stableUid, username: t.user.username, klasseName: t.user.webuntisKlasseName, schoolName: t.user.schoolId ? schoolNames.get(t.user.schoolId) ?? '' : '' }))
      .sort((a, b) => a.username.localeCompare(b.username)),
    reached,
    opened: r._count.views,
    finished,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

async function schoolNameMap(): Promise<Map<string, string>> {
  return new Map((await listSchools()).map((s) => [s.id, s.shortName || s.name]));
}

function normalize(body: RecapBody) {
  if (body.periodTo < body.periodFrom) throw new ValidationError('Das Ende des Zeitraums muss nach seinem Anfang liegen');
  const span = (Date.parse(`${body.periodTo}T00:00:00Z`) - Date.parse(`${body.periodFrom}T00:00:00Z`)) / 86_400_000 + 1;
  if (span > MAX_PERIOD_DAYS) throw new ValidationError(`Der Zeitraum darf höchstens ${MAX_PERIOD_DAYS} Tage lang sein`);
  const startsAt = body.startsAt ? new Date(body.startsAt) : null;
  const endsAt = body.endsAt ? new Date(body.endsAt) : null;
  if (startsAt && endsAt && endsAt <= startsAt) throw new ValidationError('„Sichtbar bis“ muss nach „Sichtbar ab“ liegen');
  return {
    title: body.title,
    periodFrom: body.periodFrom,
    periodTo: body.periodTo,
    startsAt,
    endsAt,
    sections: formatSections(body.sections),
    enabled: body.enabled,
  };
}

// The school a recap written by this request belongs to: a school's view
// writes for its school; the global view for the one named, or every school.
async function recapSchool(req: Request, body: RecapBody, fallback: string | null = null): Promise<string | null> {
  const scoped = scopeSchool(req);
  if (scoped) return scoped;
  if (body.schoolId === undefined) return fallback;
  if (!body.schoolId) return null;
  const school = await schoolById(body.schoolId);
  if (!school) throw new ValidationError('Unbekannte Schule');
  return school.id;
}

// Checks the chosen schools, classes and students exist — inside the recap's
// school, if it has one — and returns what is stored.
async function resolveTargets(body: RecapBody, schoolId: string | null) {
  const schools = [...new Set(body.targetSchools)];
  const users = [...new Set(body.targetUsers)];
  const classKeys = new Set<string>();
  const classPicks = body.targetClasses.filter((c) => {
    const key = `${c.schoolId}:${c.klasseId}`;
    if (classKeys.has(key)) return false;
    classKeys.add(key);
    return true;
  });

  if (schools.length > 0) {
    // A school's recap reaches its own school only; choosing it is "everyone".
    if (schoolId && schools.some((id) => id !== schoolId)) throw new ValidationError('Eine Schul-Recap kann nur ihre eigene Schule ansprechen');
    const known = new Set((await listSchools()).map((s) => s.id));
    if (schools.some((id) => !known.has(id))) throw new ValidationError('Mindestens eine ausgewählte Schule existiert nicht (mehr)');
  }

  const classes: Array<{ schoolId: string; klasseId: number; klasseName: string }> = [];
  const bySchool = new Map<string, number[]>();
  for (const c of classPicks) {
    if (schoolId && c.schoolId !== schoolId) throw new ValidationError('Klassen müssen zur Schule der Recap gehören');
    bySchool.set(c.schoolId, [...(bySchool.get(c.schoolId) ?? []), c.klasseId]);
  }
  for (const [school, ids] of bySchool) {
    const known = await knownClasses(school);
    for (const id of ids) {
      const entry = known.get(id);
      if (!entry) throw new ValidationError('Mindestens eine ausgewählte Klasse existiert nicht (mehr)');
      classes.push({ schoolId: school, klasseId: id, klasseName: entry.name.slice(0, 100) });
    }
  }

  if (users.length > 0) {
    const found = await prisma.user.count({ where: { stableUid: { in: users }, ...(schoolId ? { schoolId } : {}) } });
    if (found !== users.length) throw new ValidationError('Mindestens ein ausgewählter Schüler existiert nicht (mehr)');
  }
  return { schools, classes, users };
}

function inViewScope(req: Request, recapSchoolId: string | null): boolean {
  // A school's view reaches its own recaps; every-school recaps are global.
  return inScope(req, recapSchoolId) && !(scopeSchool(req) !== null && recapSchoolId === null);
}

// ─── Admin router: /api/admin/recaps ─────────────────────────────────────────

const admin = Router();

admin.get('/', requireAdmin, requirePermission('recaps.view'), async (req: Request, res: Response): Promise<void> => {
  const schoolId = scopeSchool(req);
  const [recaps, names] = await Promise.all([
    prisma.recap.findMany({ where: schoolId ? { schoolId } : {}, orderBy: { createdAt: 'desc' }, include: withTargets }),
    schoolNameMap(),
  ]);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ recaps: await Promise.all(recaps.map((r) => adminRow(r, names))) });
});

// For choosing who a recap is for: the schools of the view, the classes of
// one school (?forSchool= in the global view), students by name.
admin.get('/targets', requireAdmin, requirePermission('recaps.manage'), async (req: Request, res: Response): Promise<void> => {
  const query = z.string().trim().max(100).default('').parse(req.query['q'] ?? '');
  const scoped = scopeSchool(req);
  const asked = typeof req.query['forSchool'] === 'string' ? (await schoolById(req.query['forSchool'].trim().toLowerCase()))?.id ?? null : null;
  const classSchool = scoped ?? asked;
  const schools = scoped ? (await listSchools()).filter((s) => s.id === scoped) : await listSchools();
  const counts = await prisma.user.groupBy({
    by: ['schoolId'],
    where: { role: { not: 'parent' }, ...(scoped ? { schoolId: scoped } : {}) },
    _count: { _all: true },
  });
  const perSchool = new Map(counts.map((c) => [c.schoolId, c._count._all]));
  const names = new Map(schools.map((s) => [s.id, s.shortName || s.name]));
  const users = query
    ? await prisma.user.findMany({
        where: { username: { contains: likeText(query) }, ...(classSchool ? { schoolId: classSchool } : {}) },
        select: { stableUid: true, username: true, webuntisKlasseName: true, schoolId: true, role: true },
        orderBy: { username: 'asc' },
        take: 25,
      })
    : [];
  const classes = classSchool
    ? [...(await knownClasses(classSchool)).entries()]
        .map(([id, entry]) => ({ schoolId: classSchool, schoolName: names.get(classSchool) ?? '', id, name: entry.name, users: entry.users }))
        .sort((a, b) => a.name.localeCompare(b.name, 'de'))
    : [];
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    schools: schools.map((s) => ({ id: s.id, name: s.shortName || s.name, active: s.active, users: perSchool.get(s.id) ?? 0 })),
    classes,
    users: users.map((u) => ({ stableUid: u.stableUid, username: u.username, klasseName: u.webuntisKlasseName, schoolName: u.schoolId ? names.get(u.schoolId) ?? '' : '', role: u.role })),
  });
});

admin.post('/', requireAdmin, requirePermission('recaps.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const body = recapSchema.parse(req.body);
  const data = normalize(body);
  const schoolId = await recapSchool(req, body);
  const targets = await resolveTargets(body, schoolId);
  const adminUsername = req.adminUser?.username ?? 'admin';
  const recap = await prisma.recap.create({
    data: {
      ...data,
      schoolId,
      createdBy: adminUsername,
      targetSchools: { create: targets.schools.map((id) => ({ schoolId: id })) },
      targetClasses: { create: targets.classes },
      targetUsers: { create: targets.users.map((stableUid) => ({ stableUid })) },
    },
    include: withTargets,
  });
  logger.info('Admin action: recap created', {
    action: 'recap_created', adminUsername, recapId: recap.id,
    targetSchools: targets.schools.length, targetClasses: targets.classes.length, targetUsers: targets.users.length,
  });
  audit(req, 'recap.create', { type: 'recap', id: recap.id }, { title: recap.title, period: `${recap.periodFrom}–${recap.periodTo}` }, schoolId);
  res.status(201).json({ recap: await adminRow(recap, await schoolNameMap()) });
});

admin.put('/:id', requireAdmin, requirePermission('recaps.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const id = z.string().uuid().parse(req.params['id']);
  const body = recapSchema.parse(req.body);
  const existing = await prisma.recap.findUnique({ where: { id }, select: { schoolId: true } });
  if (!existing || !inViewScope(req, existing.schoolId)) throw new NotFoundError('Recap nicht gefunden');
  const data = normalize(body);
  const schoolId = await recapSchool(req, body, existing.schoolId);
  const targets = await resolveTargets(body, schoolId);
  // One update: the old choice of recipients is replaced atomically.
  const [recap] = await prisma.$transaction([
    prisma.recap.update({
      where: { id },
      data: {
        ...data,
        schoolId,
        targetSchools: { deleteMany: {}, create: targets.schools.map((s) => ({ schoolId: s })) },
        targetClasses: { deleteMany: {}, create: targets.classes },
        targetUsers: { deleteMany: {}, create: targets.users.map((stableUid) => ({ stableUid })) },
      },
      include: withTargets,
    }),
    ...(body.resetSeen ? [prisma.recapView.deleteMany({ where: { recapId: id } })] : []),
  ]);
  const adminUsername = req.adminUser?.username ?? 'admin';
  logger.info('Admin action: recap updated', {
    action: 'recap_updated', adminUsername, recapId: id, resetSeen: !!body.resetSeen,
    targetSchools: targets.schools.length, targetClasses: targets.classes.length, targetUsers: targets.users.length,
  });
  audit(req, 'recap.update', { type: 'recap', id }, { title: recap.title, period: `${recap.periodFrom}–${recap.periodTo}` }, schoolId);
  const fresh = body.resetSeen ? await prisma.recap.findUniqueOrThrow({ where: { id }, include: withTargets }) : recap;
  res.json({ recap: await adminRow(fresh, await schoolNameMap()) });
});

async function recapInScope(req: Request, id: string): Promise<void> {
  const existing = await prisma.recap.findUnique({ where: { id }, select: { schoolId: true } });
  if (!existing || !inViewScope(req, existing.schoolId)) throw new NotFoundError('Recap nicht gefunden');
}

admin.patch('/:id/enabled', requireAdmin, requirePermission('recaps.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const id = z.string().uuid().parse(req.params['id']);
  const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
  await recapInScope(req, id);
  const recap = await prisma.recap.update({ where: { id }, data: { enabled }, include: withTargets });
  logger.info('Admin action: recap toggled', { action: 'recap_toggled', adminUsername: req.adminUser?.username, recapId: id, enabled });
  res.json({ recap: await adminRow(recap, await schoolNameMap()) });
});

admin.delete('/:id', requireAdmin, requirePermission('recaps.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const id = z.string().uuid().parse(req.params['id']);
  await recapInScope(req, id);
  await prisma.recap.delete({ where: { id } });
  logger.info('Admin action: recap deleted', { action: 'recap_deleted', adminUsername: req.adminUser?.username, recapId: id });
  audit(req, 'recap.delete', { type: 'recap', id });
  res.status(204).send();
});

// ─── Client router: /recaps ──────────────────────────────────────────────────

const client = Router();

interface FeedRecap extends RecapReach {
  id: string;
  title: string;
  periodFrom: string;
  periodTo: string;
  startsAt: string | null;
  endsAt: string | null;
  sections: string;
  updatedAt: string;
}

// Every enabled recap with its recipients; who it reaches is decided per
// request below. Kept briefly in the shared cache; any change drops it.
function enabledRecaps(): Promise<FeedRecap[]> {
  return cached('recaps:enabled', ['Recap', 'RecapTargetSchool', 'RecapTargetClass', 'RecapTargetUser'], FEED_CACHE_SECONDS, async () => {
    const rows = await prisma.recap.findMany({
      where: { enabled: true },
      include: { targetSchools: true, targetClasses: true, targetUsers: { select: { stableUid: true } } },
      orderBy: { periodTo: 'desc' },
    });
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      periodFrom: r.periodFrom,
      periodTo: r.periodTo,
      startsAt: r.startsAt?.toISOString() ?? null,
      endsAt: r.endsAt?.toISOString() ?? null,
      sections: r.sections,
      updatedAt: r.updatedAt.toISOString(),
      schoolId: r.schoolId,
      targetSchools: r.targetSchools.map((t) => t.schoolId),
      targetClasses: r.targetClasses.map((t) => ({ schoolId: t.schoolId, klasseId: t.klasseId })),
      targetUsers: r.targetUsers.map((t) => t.stableUid),
    }));
  });
}

// The recaps the caller may open now: inside their window and meant for them.
async function mine(req: Request): Promise<FeedRecap[]> {
  const user = req.user!;
  const schoolId = await schoolOfUser(user.stableUid);
  const now = Date.now();
  const account = {
    stableUid: user.stableUid,
    schoolId,
    klasseId: Number.isInteger(user.klasseId) && user.klasseId > 0 ? user.klasseId : 0,
    role: user.role,
  };
  return (await enabledRecaps()).filter((r) =>
    (!r.startsAt || Date.parse(r.startsAt) <= now)
    && (!r.endsAt || Date.parse(r.endsAt) > now)
    && recapReaches(r, account));
}

function clientRow(r: FeedRecap, view: { openedAt: Date; finishedAt: Date | null } | undefined) {
  return {
    id: r.id,
    title: r.title,
    periodFrom: r.periodFrom,
    periodTo: r.periodTo,
    endsAt: r.endsAt,
    sections: parseSections(r.sections),
    openedAt: view?.openedAt.toISOString() ?? null,
    finishedAt: view?.finishedAt?.toISOString() ?? null,
  };
}

// GET /recaps — the caller's recaps, the newest period first.
client.get('/', readLimiter, requireAuth, async (req: Request, res: Response): Promise<void> => {
  const recaps = await mine(req);
  const views = recaps.length
    ? await prisma.recapView.findMany({ where: { stableUid: req.user!.stableUid, recapId: { in: recaps.map((r) => r.id) } } })
    : [];
  const byId = new Map(views.map((v) => [v.recapId, v]));
  res.setHeader('Cache-Control', 'no-store');
  res.json({ recaps: recaps.map((r) => clientRow(r, byId.get(r.id))) });
});

const idParam = (req: Request) => z.string().uuid().parse(req.params['id']);

// GET /recaps/:id — one recap with the caller's POKYH figures for its period.
client.get('/:id', readLimiter, requireAuth, async (req: Request, res: Response): Promise<void> => {
  const id = idParam(req);
  const recap = (await mine(req)).find((r) => r.id === id);
  if (!recap) throw new NotFoundError('Recap nicht gefunden');
  const user = req.user!;
  const [view, schoolId] = await Promise.all([
    prisma.recapView.findUnique({ where: { recapId_stableUid: { recapId: id, stableUid: user.stableUid } } }),
    schoolOfUser(user.stableUid),
  ]);
  const sections = parseSections(recap.sections);
  const pokyh = sections.includes('pokyh')
    ? await recapPokyhFigures({ stableUid: user.stableUid, username: user.username, schoolId }, recap.periodFrom, recap.periodTo)
    : null;
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ recap: clientRow(recap, view ?? undefined), pokyh });
});

// POST /recaps/:id/view — opened (and, with finished: true, watched to the end).
client.post('/:id/view', writeLimiter, requireAuth, async (req: Request, res: Response): Promise<void> => {
  const id = idParam(req);
  const { finished } = z.object({ finished: z.boolean().default(false) }).parse(req.body ?? {});
  if (!(await mine(req)).some((r) => r.id === id)) throw new NotFoundError('Recap nicht gefunden');
  const stableUid = req.user!.stableUid;
  const now = new Date();
  const key = { recapId_stableUid: { recapId: id, stableUid } };
  await prisma.recapView.upsert({ where: key, create: { recapId: id, stableUid, openedAt: now }, update: {} });
  // The first time to the end counts; watching again changes nothing.
  if (finished) await prisma.recapView.updateMany({ where: { recapId: id, stableUid, finishedAt: null }, data: { finishedAt: now } });
  const view = await prisma.recapView.findUniqueOrThrow({ where: key });
  res.json({ openedAt: view.openedAt.toISOString(), finishedAt: view.finishedAt?.toISOString() ?? null });
});

export { admin as recapsAdminRouter, client as recapsRouter };
