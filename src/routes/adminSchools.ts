import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { prisma } from '../db';
import { config } from '../config';
import { allowDuringSecondFactorSetup, requireAdmin, requirePermission, scopeSchool } from '../middleware/requireAdmin';
import { writeLimiter } from '../middleware/rateLimiter';
import {
  GLOBAL_SCOPE,
  PERMISSIONS,
  PERMISSION_GROUPS,
  PRESETS,
  accessibleSchools,
  can,
  hasAnyPermission,
  permissionsIn,
} from '../security/permissions';
import { grantsOf, isOwner, parsePermissionList, setGrant } from '../services/adminAccess';
import { adminSecuritySummaries, changeSecondFactorRequirement } from '../services/adminSecurity';
import { audit } from '../services/audit';
import { announceChange } from '../services/adminLive';
import {
  DEFAULT_MENU_ID,
  defaultSchoolId,
  invalidateMenus,
  invalidateSchools,
  listSchools,
  schoolById,
} from '../services/schools';
import { invalidateDishesCache } from '../utils/cache';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../utils/errors';
import { intQueryParam } from '../utils/duration';
import { likeText } from '../utils/like';

// Schools, menus, administrators and their rights, and the audit trail —
// the parts of the panel that decide who sees what. Everything here is
// checked against the caller's permissions on every request
// (middleware/requireAdmin.ts, security/permissions.ts).

const router = Router();

// ─── GET /api/admin/me ───────────────────────────────────────────────────────
// Who is signed in and what they may do: the panel builds its navigation and
// its school selector from this. Hiding what is not allowed is convenience —
// every endpoint checks again.

router.get('/me', allowDuringSecondFactorSetup, requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const access = req.adminAccess!;
  const username = req.adminUser!.username;
  const reachable = accessibleSchools(access);
  const schools = await listSchools();
  const menus = await prisma.mensaMenuSchool.findMany({ select: { schoolId: true, menuId: true } });
  const menuOf = new Map(menus.map((m) => [m.schoolId, m.menuId]));
  const visible = reachable === 'all' ? schools : schools.filter((s) => reachable.includes(s.id));
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    username,
    owner: access.owner,
    // A second factor is required and none is set up yet: the panel shows
    // only that step until one is (requireAdmin refuses everything else).
    secondFactorSetupRequired: req.adminSecondFactorSetupPending === true,
    // The installation's local time zone (ANALYTICS_TIMEZONE): days and hours
    // in the panel are counted in it.
    timezone: config.usageAnalytics.timezone,
    hasAnyPermission: hasAnyPermission(access),
    // What holds across the whole installation (global grant).
    global: [...permissionsIn(access, GLOBAL_SCOPE)],
    // Global view available at all: some permission that works without a school.
    globalView: access.owner || access.global.size > 0,
    schools: visible.map((s) => ({
      id: s.id,
      slug: s.slug,
      name: s.name,
      shortName: s.shortName,
      active: s.active,
      isDefault: s.id === defaultSchoolId(),
      menuId: menuOf.get(s.id) ?? null,
      permissions: [...permissionsIn(access, s.id)],
    })),
  });
});

// ─── GET /api/admin/access/catalog ───────────────────────────────────────────

router.get('/access/catalog', requireAdmin, (_req: Request, res: Response): void => {
  res.json({ groups: PERMISSION_GROUPS, permissions: PERMISSIONS, presets: PRESETS });
});

// ─── Schools ─────────────────────────────────────────────────────────────────

function schoolRow(s: Awaited<ReturnType<typeof listSchools>>[number], extra: Record<string, unknown> = {}) {
  return {
    id: s.id,
    slug: s.slug,
    name: s.name,
    shortName: s.shortName,
    webuntisSchool: s.webuntisSchool,
    webuntisBase: s.webuntisBase,
    active: s.active,
    isDefault: s.id === defaultSchoolId(),
    // How it came: on its first WebUntis sign-in, or as the installation's
    // own school (WEBUNTIS_SCHOOL).
    origin: s.createdBy === 'webuntis' ? 'webuntis' : 'installation',
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    ...extra,
  };
}

router.get('/schools', requireAdmin, requirePermission('schools.view'), async (_req: Request, res: Response): Promise<void> => {
  const schools = await listSchools();
  const [users, admins, menus] = await Promise.all([
    prisma.user.groupBy({ by: ['schoolId'], _count: { _all: true } }),
    prisma.adminGrant.groupBy({ by: ['scope'], _count: { _all: true } }),
    prisma.mensaMenuSchool.findMany({ include: { menu: { select: { id: true, name: true } } } }),
  ]);
  const usersOf = new Map(users.map((u) => [u.schoolId, u._count._all]));
  const adminsOf = new Map(admins.map((a) => [a.scope, a._count._all]));
  const menuOf = new Map(menus.map((m) => [m.schoolId, m.menu]));
  res.json({
    schools: schools.map((s) => schoolRow(s, {
      users: usersOf.get(s.id) ?? 0,
      admins: adminsOf.get(s.id) ?? 0,
      menu: menuOf.get(s.id) ?? null,
    })),
  });
});

// One school's settings: also for that school's own admins.
router.get('/schools/:id', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const school = await schoolById(String(req.params['id']).toLowerCase());
  if (!school || !(can(req.adminAccess!, 'schools.view', null) || can(req.adminAccess!, 'school.settings.view', school.id))) {
    res.status(404).json({ error: 'Schule nicht gefunden' });
    return;
  }
  const menu = await prisma.mensaMenuSchool.findUnique({ where: { schoolId: school.id }, include: { menu: { select: { id: true, name: true } } } });
  res.json({ school: schoolRow(school, { menu: menu?.menu ?? null }) });
});

// Schools are not created here: each one is added on the first WebUntis
// sign-in of one of its accounts (services/schools.ts, schoolForLogin), and
// its WebUntis login name and server come from WebUntis. The panel names,
// switches off and equips them.
const schoolSchema = z.object({
  name: z.string().trim().min(2).max(160),
  shortName: z.string().trim().max(60).optional(),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'Kurzname: Kleinbuchstaben, Ziffern und -').optional(),
  active: z.boolean().optional(),
}).strict();

router.patch('/schools/:id', requireAdmin, writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const school = await schoolById(String(req.params['id']).toLowerCase());
  const access = req.adminAccess!;
  const global = can(access, 'schools.manage', null);
  if (!school || !(global || can(access, 'school.settings.manage', school.id))) {
    res.status(school && can(access, 'school.settings.view', school.id) ? 403 : 404).json({ error: school ? 'Keine Berechtigung' : 'Schule nicht gefunden' });
    return;
  }
  const body = schoolSchema.partial().parse(req.body);
  // A school's own admins rename it; everything else is the installation's.
  if (!global && (body.slug !== undefined || body.active !== undefined)) {
    throw new ForbiddenError('Nur Global-Admins ändern Kurzname und Status einer Schule');
  }
  if (body.active === false && school.id === defaultSchoolId()) {
    throw new ValidationError('Die Standardschule (WEBUNTIS_SCHOOL) kann nicht deaktiviert werden');
  }
  const updated = await prisma.school.update({
    where: { id: school.id },
    data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.shortName !== undefined ? { shortName: body.shortName } : {}),
      ...(body.slug !== undefined ? { slug: body.slug } : {}),
      ...(body.active !== undefined ? { active: body.active } : {}),
    },
  }).catch((err) => {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ConflictError('Dieser Kurzname ist schon vergeben');
    throw err;
  });
  invalidateSchools();
  audit(req, 'school.update', { type: 'school', id: school.id }, { fields: Object.keys(body) }, school.id);
  announceChange(['schools']);
  res.json({ school: schoolRow(updated) });
});

// ─── Menus ───────────────────────────────────────────────────────────────────
// A menu can serve several schools; a school shows at most one, and none at
// all when no menu is assigned to it.

router.get('/menus', requireAdmin, requirePermission('mensa.view'), async (req: Request, res: Response): Promise<void> => {
  const schoolId = scopeSchool(req);
  const menus = await prisma.mensaMenu.findMany({
    where: schoolId ? { schools: { some: { schoolId } } } : {},
    include: { schools: { select: { schoolId: true } } },
    orderBy: { name: 'asc' },
  });
  const counts = await prisma.dish.groupBy({ by: ['menuId'], _count: { _all: true }, where: { menuId: { in: menus.map((m) => m.id) } } });
  const dishesOf = new Map(counts.map((c) => [c.menuId, c._count._all]));
  const schools = new Map((await listSchools()).map((s) => [s.id, s.name]));
  res.json({
    menus: menus.map((m) => ({
      id: m.id,
      name: m.name,
      isDefault: m.id === DEFAULT_MENU_ID,
      dishes: dishesOf.get(m.id) ?? 0,
      schools: m.schools.map((s) => ({ id: s.schoolId, name: schools.get(s.schoolId) ?? s.schoolId })),
      createdAt: m.createdAt.toISOString(),
    })),
  });
});

const menuSchema = z.object({ name: z.string().trim().min(1).max(120) });

router.post('/menus', requireAdmin, requirePermission('schools.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const { name } = menuSchema.parse(req.body);
  const menu = await prisma.mensaMenu.create({ data: { id: randomUUID(), name, createdBy: req.adminUser!.username } });
  audit(req, 'menu.create', { type: 'menu', id: menu.id }, { name });
  announceChange(['schools', 'dishes']);
  res.status(201).json({ menu: { id: menu.id, name: menu.name, isDefault: false, dishes: 0, schools: [], createdAt: menu.createdAt.toISOString() } });
});

router.patch('/menus/:id', requireAdmin, requirePermission('schools.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const { name } = menuSchema.parse(req.body);
  const id = String(req.params['id']).toLowerCase();
  const menu = await prisma.mensaMenu.update({ where: { id }, data: { name } }).catch(() => null);
  if (!menu) throw new NotFoundError('Mensaplan nicht gefunden');
  audit(req, 'menu.rename', { type: 'menu', id }, { name });
  announceChange(['schools', 'dishes']);
  res.json({ menu: { id: menu.id, name: menu.name } });
});

// Deleting a menu deletes its dishes (and their pictures). Votes and
// comments stay, unreachable, until removed with the accounts or by an admin.
router.delete('/menus/:id', requireAdmin, requirePermission('schools.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params['id']).toLowerCase();
  const menu = await prisma.mensaMenu.findUnique({ where: { id }, include: { schools: true } });
  if (!menu) throw new NotFoundError('Mensaplan nicht gefunden');
  if (menu.schools.length > 0) throw new ConflictError('Der Mensaplan ist noch Schulen zugewiesen — zuerst die Zuweisung entfernen');
  const dishIds = (await prisma.dish.findMany({ where: { menuId: id }, select: { id: true } })).map((d) => d.id);
  await prisma.$transaction([
    prisma.dishImage.deleteMany({ where: { dishId: { in: dishIds } } }),
    prisma.dish.deleteMany({ where: { menuId: id } }),
    prisma.mensaMenu.delete({ where: { id } }),
  ]);
  invalidateDishesCache();
  invalidateMenus();
  audit(req, 'menu.delete', { type: 'menu', id }, { name: menu.name, dishes: dishIds.length });
  announceChange(['schools', 'dishes']);
  res.status(204).send();
});

// Assigns a menu to a school (or none). One menu per school; a menu may
// serve several schools.
router.put('/schools/:id/menu', requireAdmin, requirePermission('schools.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const school = await schoolById(String(req.params['id']).toLowerCase());
  if (!school) throw new NotFoundError('Schule nicht gefunden');
  const { menuId } = z.object({ menuId: z.string().trim().toLowerCase().max(36).nullable() }).parse(req.body);
  if (menuId && !(await prisma.mensaMenu.findUnique({ where: { id: menuId }, select: { id: true } }))) {
    throw new NotFoundError('Mensaplan nicht gefunden');
  }
  await prisma.$transaction([
    prisma.mensaMenuSchool.deleteMany({ where: { schoolId: school.id } }),
    ...(menuId ? [prisma.mensaMenuSchool.create({ data: { menuId, schoolId: school.id, assignedBy: req.adminUser!.username } })] : []),
  ]);
  invalidateMenus();
  invalidateDishesCache();
  audit(req, 'school.menu', { type: 'school', id: school.id }, { menuId }, school.id);
  announceChange(['schools', 'dishes']);
  res.json({ schoolId: school.id, menuId });
});

// The schools a menu serves, set in one step: listed schools show this menu
// from now on (a school that showed another one switches), schools no longer
// listed show none. One audit entry per school that changes.
router.put('/menus/:id/schools', requireAdmin, requirePermission('schools.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params['id']).toLowerCase();
  const menu = await prisma.mensaMenu.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!menu) throw new NotFoundError('Mensaplan nicht gefunden');
  const { schoolIds } = z.object({
    schoolIds: z.array(z.string().trim().toLowerCase().max(36)).max(config.schoolsMax),
  }).strict().parse(req.body);
  const wanted = [...new Set(schoolIds)];
  const known = new Set((await listSchools()).map((s) => s.id));
  const unknown = wanted.filter((sid) => !known.has(sid));
  if (unknown.length > 0) throw new ValidationError('Unbekannte Schule');

  const links = await prisma.mensaMenuSchool.findMany({ where: { schoolId: { in: wanted } }, select: { schoolId: true, menuId: true } });
  const current = (await prisma.mensaMenuSchool.findMany({ where: { menuId: id }, select: { schoolId: true } })).map((l) => l.schoolId);
  const previousOf = new Map(links.map((l) => [l.schoolId, l.menuId]));
  const added = wanted.filter((sid) => previousOf.get(sid) !== id);
  const removed = current.filter((sid) => !wanted.includes(sid));

  if (added.length > 0 || removed.length > 0) {
    await prisma.$transaction([
      // A school shows one menu: leaving its old one is part of joining this one.
      prisma.mensaMenuSchool.deleteMany({ where: { schoolId: { in: [...added, ...removed] } } }),
      ...(added.length > 0 ? [prisma.mensaMenuSchool.createMany({ data: added.map((schoolId) => ({ menuId: id, schoolId, assignedBy: req.adminUser!.username })) })] : []),
    ]);
    invalidateMenus();
    invalidateDishesCache();
    for (const sid of added) audit(req, 'school.menu', { type: 'school', id: sid }, { menuId: id, previousMenuId: previousOf.get(sid) ?? null }, sid);
    for (const sid of removed) audit(req, 'school.menu', { type: 'school', id: sid }, { menuId: null, previousMenuId: id }, sid);
    announceChange(['schools', 'dishes']);
  }
  res.json({
    menuId: id,
    schoolIds: wanted,
    added,
    removed,
    // Of the added ones, those that showed another menu before.
    moved: added.filter((sid) => previousOf.has(sid)),
  });
});

// ─── Administrators and their rights ─────────────────────────────────────────

// Every admin account with its grants. A school's view lists the admins who
// hold rights in that school, and the school's own accounts with panel access.
router.get('/admins', requireAdmin, requirePermission('admins.view'), async (req: Request, res: Response): Promise<void> => {
  const schoolId = scopeSchool(req);
  const [adminRows, grantRows] = await Promise.all([
    prisma.admin.findMany({ select: { stableUid: true, mustChangePassword: true, setupExpiresAt: true, createdAt: true } }),
    prisma.adminGrant.findMany({ orderBy: [{ username: 'asc' }, { scope: 'asc' }] }),
  ]);
  const users = await prisma.user.findMany({
    where: { OR: [{ stableUid: { in: adminRows.map((a) => a.stableUid) } }, { username: { in: config.adminUsernames.map((n) => n.toLowerCase()) } }] },
    select: { stableUid: true, username: true, schoolId: true },
  });
  const adminByUid = new Map(adminRows.map((a) => [a.stableUid, a]));
  const grantsByName = new Map<string, typeof grantRows>();
  for (const g of grantRows) grantsByName.set(g.username, [...(grantsByName.get(g.username) ?? []), g]);
  const schools = new Map((await listSchools()).map((s) => [s.id, s.name]));
  const seesGlobal = can(req.adminAccess!, 'admins.view', null);

  const rows = users
    .map((u) => {
      const grants = grantsByName.get(u.username) ?? [];
      const admin = adminByUid.get(u.stableUid);
      return {
        stableUid: u.stableUid,
        username: u.username,
        schoolId: u.schoolId,
        schoolName: u.schoolId ? schools.get(u.schoolId) ?? null : null,
        owner: isOwner(u.username),
        pending: admin?.mustChangePassword ?? false,
        setupExpiresAt: admin?.mustChangePassword ? admin.setupExpiresAt?.toISOString() ?? null : null,
        grants: grants
          // A school's view shows the rights in that school (and that someone
          // is a global admin), never their rights in other schools.
          .filter((g) => !schoolId || g.scope === schoolId || g.scope === GLOBAL_SCOPE)
          .map((g) => ({
            scope: g.scope,
            schoolName: g.scope === GLOBAL_SCOPE ? null : schools.get(g.scope) ?? null,
            preset: g.preset,
            permissions: g.scope === GLOBAL_SCOPE && schoolId && !seesGlobal ? [] : parsePermissionList(g.permissions),
            grantedBy: g.grantedBy,
            updatedAt: g.updatedAt.toISOString(),
          })),
      };
    })
    .filter((row) => !schoolId || row.schoolId === schoolId || row.grants.some((g) => g.scope === schoolId));
  // Operators from ADMIN_USERNAMES without an app account of their own.
  if (!schoolId) {
    const known = new Set(rows.map((r) => r.username.toLowerCase()));
    for (const name of config.adminUsernames) {
      if (known.has(name.toLowerCase())) continue;
      rows.push({ stableUid: '', username: name, schoolId: null, schoolName: null, owner: true, pending: false, setupExpiresAt: null, grants: [] });
    }
  }
  rows.sort((a, b) => Number(b.owner) - Number(a.owner) || a.username.localeCompare(b.username));
  // Second factor required / set up and the last panel login of each admin.
  const security = await adminSecuritySummaries(rows.map((r) => r.username));
  res.json({ admins: rows.map((r) => ({ ...r, security: security.get(r.username) ?? null })) });
});

const grantSchema = z.object({
  permissions: z.array(z.string().max(60)).max(100),
  preset: z.string().max(40).optional(),
});

// Sets one account's rights in one scope ("global" or a school id). An empty
// list removes them. All rules (subset, own account, school) in setGrant.
router.put('/admins/:username/grants/:scope', requireAdmin, writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const body = grantSchema.parse(req.body);
  const username = String(req.params['username']).trim().toLowerCase().slice(0, 191);
  const scope = String(req.params['scope']).trim().toLowerCase();
  const grant = await setGrant(req, username, scope, body.permissions, body.preset);
  res.json({ grant, grants: await grantsOf(username) });
});

router.delete('/admins/:username/grants/:scope', requireAdmin, writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const username = String(req.params['username']).trim().toLowerCase().slice(0, 191);
  const scope = String(req.params['scope']).trim().toLowerCase();
  await setGrant(req, username, scope, []);
  res.status(204).send();
});

// Whether an admin needs a second factor: true / false, or null for the
// installation default (ADMIN_REQUIRE_SECOND_FACTOR). Rules in
// changeSecondFactorRequirement().
router.put('/admins/:username/second-factor', requireAdmin, writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const { required } = z.object({ required: z.boolean().nullable() }).parse(req.body);
  const username = String(req.params['username']).trim().slice(0, 191);
  const state = await changeSecondFactorRequirement(req, username, required);
  res.json({ required: state.required, source: state.source, setupPending: state.setupPending });
});

// ─── GET /api/admin/audit-events ─────────────────────────────────────────────
// The admin audit trail. A school's view: that school's events; the global
// view: every event.

router.get('/audit-events', requireAdmin, requirePermission('audit.view'), async (req: Request, res: Response): Promise<void> => {
  const page = intQueryParam(req.query['page'], 1, 1, 1_000_000);
  const limit = intQueryParam(req.query['limit'], 50, 1, 200);
  const actor = typeof req.query['actor'] === 'string' ? req.query['actor'].trim().slice(0, 191) : '';
  const action = typeof req.query['action'] === 'string' ? req.query['action'].trim().slice(0, 60) : '';
  const from = typeof req.query['from'] === 'string' ? new Date(req.query['from']) : null;
  const to = typeof req.query['to'] === 'string' ? new Date(`${req.query['to']}T23:59:59.999Z`) : null;
  const schoolId = scopeSchool(req);
  const where: Prisma.AdminAuditEventWhereInput = {
    ...(schoolId ? { schoolId } : {}),
    ...(actor ? { actor: { contains: likeText(actor) } } : {}),
    ...(action ? { action: { startsWith: action } } : {}),
    ...(from && !Number.isNaN(from.getTime()) || to && !Number.isNaN(to?.getTime() ?? NaN)
      ? { createdAt: { ...(from && !Number.isNaN(from.getTime()) ? { gte: from } : {}), ...(to && !Number.isNaN(to.getTime()) ? { lte: to } : {}) } }
      : {}),
  };
  const [events, total] = await Promise.all([
    prisma.adminAuditEvent.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * limit, take: limit }),
    prisma.adminAuditEvent.count({ where }),
  ]);
  const schools = new Map((await listSchools()).map((s) => [s.id, s.name]));
  res.json({
    events: events.map((e) => {
      let detail: unknown = {};
      try { detail = JSON.parse(e.detail); } catch { detail = {}; }
      return {
        id: e.id,
        at: e.createdAt.toISOString(),
        actor: e.actor,
        action: e.action,
        targetType: e.targetType,
        targetId: e.targetId,
        schoolId: e.schoolId,
        schoolName: e.schoolId ? schools.get(e.schoolId) ?? null : null,
        detail,
        requestId: e.requestId,
      };
    }),
    total,
    page,
    limit,
    retentionDays: config.auditRetentionDays,
  });
});

export { router as adminAccessRouter };
