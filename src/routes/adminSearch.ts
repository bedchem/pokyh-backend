import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../db';
import { config } from '../config';
import { requireAdmin } from '../middleware/requireAdmin';
import { GLOBAL_SCOPE, can, type Access, type Permission } from '../security/permissions';
import { defaultSchoolId, listSchools } from '../services/schools';
import { isOwner } from '../services/adminAccess';
import { likeText } from '../utils/like';

// ─── GET /api/admin/search?q=…&types=… ───────────────────────────────────────
// One search over everything an admin may see — accounts, classes, admins,
// dishes and comments of every school their rights reach — whichever view
// the panel currently shows. Each kind is filtered by its own permission per
// school: a kind the admin may not see anywhere is left out entirely (not
// even a count), and nothing from a school outside their rights is ever
// counted or returned. Addresses, user agents and passwords are never part of
// a result. The request log keeps the path only, so search terms (often
// names) are not stored.

const router = Router();

const KINDS = ['users', 'classes', 'admins', 'dishes', 'comments'] as const;
type Kind = typeof KINDS[number];

const NEEDS: Record<Kind, Permission> = {
  users: 'users.view',
  classes: 'classes.view',
  admins: 'admins.view',
  dishes: 'mensa.view',
  comments: 'comments.view',
};

// Per admin, not per address: the panel of a whole school can sit behind one.
const searchLimiter = rateLimit({
  windowMs: 60_000,
  max: config.adminSearchPerMinute,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Suchanfragen — bitte kurz warten.' },
  keyGenerator: (req) => `admin-search:${req.adminUser?.username ?? 'unknown'}`,
});

const querySchema = z.object({
  q: z.string().trim().min(2, 'Mindestens 2 Zeichen').max(64),
  types: z.string().max(100).optional(),
});

// The schools in which an admin holds a permission: all of them, or a list.
function reach(access: Access, permission: Permission): 'all' | string[] {
  if (can(access, permission, null)) return 'all';
  return [...access.schools.keys()].filter((id) => can(access, permission, id));
}

// Rows of those schools. A row without a school was written before schools
// existed (or by an older node) and belongs to the installation's own school.
function inSchools(scope: string[]) {
  return scope.includes(defaultSchoolId())
    ? { OR: [{ schoolId: { in: scope } }, { schoolId: null }] }
    : { schoolId: { in: scope } };
}

// Exact match first, then names starting with the term, then a word in them
// starting with it, then anything containing it; shorter before longer.
function rank(text: string, q: string): number {
  const t = text.toLowerCase();
  if (t === q) return 0;
  if (t.startsWith(q)) return 1;
  if (t.split(/[\s._-]+/).some((word) => word.startsWith(q))) return 2;
  return 3;
}

function best<T>(rows: T[], label: (row: T) => string, q: string, limit: number): T[] {
  return rows
    .map((row) => ({ row, label: label(row), score: rank(label(row), q) }))
    .sort((a, b) => a.score - b.score || a.label.length - b.label.length || a.label.localeCompare(b.label, 'de'))
    .slice(0, limit)
    .map((entry) => entry.row);
}

function unique<T>(rows: T[], key: (row: T) => string): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const k = key(row);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

router.get('/search', requireAdmin, searchLimiter, async (req: Request, res: Response): Promise<void> => {
  const { q: raw, types } = querySchema.parse(req.query);
  const q = raw.toLowerCase();
  const access = req.adminAccess!;
  const asked = types ? types.split(',').map((t) => t.trim()).filter((t): t is Kind => (KINDS as readonly string[]).includes(t)) : [...KINDS];
  const wanted = [...new Set(asked.length > 0 ? asked : KINDS)];
  // A single kind is the detailed search: more of it.
  const limit = wanted.length === 1 ? config.adminSearchDetailLimit : config.adminSearchLimit;
  const text = likeText(raw);
  const schools = new Map((await listSchools()).map((s) => [s.id, s.name]));
  const def = defaultSchoolId();
  const schoolName = (id: string | null) => schools.get(id ?? def) ?? null;

  const results: Partial<Record<Kind, { total: number; items: unknown[] }>> = {};
  const scopes = Object.fromEntries(wanted.map((kind) => [kind, reach(access, NEEDS[kind])])) as Record<Kind, 'all' | string[]>;
  const allowed = (kind: Kind) => wanted.includes(kind) && (scopes[kind] === 'all' || (scopes[kind] as string[]).length > 0);
  const restrict = (kind: Kind) => (scopes[kind] === 'all' ? [] : [inSchools(scopes[kind] as string[])]);

  const tasks: Promise<void>[] = [];

  if (allowed('users')) {
    tasks.push((async () => {
      const where = { AND: [{ username: { contains: text } }, ...restrict('users')] };
      const select = { stableUid: true, username: true, role: true, schoolId: true, webuntisKlasseName: true, isUntisUser: true };
      const [starts, contains, total] = await Promise.all([
        prisma.user.findMany({ where: { AND: [{ username: { startsWith: text } }, ...restrict('users')] }, select, orderBy: { username: 'asc' }, take: limit }),
        prisma.user.findMany({ where, select, orderBy: { username: 'asc' }, take: limit * 4 }),
        prisma.user.count({ where }),
      ]);
      const rows = best(unique([...starts, ...contains], (u) => u.stableUid), (u) => u.username, q, limit);
      const admins = new Set((await prisma.admin.findMany({ where: { stableUid: { in: rows.map((u) => u.stableUid) } }, select: { stableUid: true } })).map((a) => a.stableUid));
      results.users = {
        total,
        items: rows.map((u) => ({
          id: u.stableUid,
          username: u.username,
          role: u.role,
          className: u.webuntisKlasseName || null,
          local: !u.isUntisUser,
          admin: admins.has(u.stableUid) || isOwner(u.username),
          schoolId: u.schoolId ?? def,
          schoolName: schoolName(u.schoolId),
        })),
      };
    })());
  }

  if (allowed('classes')) {
    tasks.push((async () => {
      const where = { AND: [{ OR: [{ name: { contains: text } }, { code: raw.toUpperCase() }] }, ...restrict('classes')] };
      const [rows, total] = await Promise.all([
        prisma.class.findMany({ where, select: { id: true, name: true, code: true, webuntisKlasseId: true, schoolId: true, _count: { select: { members: true } } }, orderBy: { name: 'asc' }, take: limit * 4 }),
        prisma.class.count({ where }),
      ]);
      results.classes = {
        total,
        items: best(rows, (c) => (c.code.toLowerCase() === q ? q : c.name), q, limit).map((c) => ({
          id: c.id,
          name: c.name,
          code: c.code,
          webuntisKlasseId: c.webuntisKlasseId,
          members: c._count.members,
          schoolId: c.schoolId ?? def,
          schoolName: schoolName(c.schoolId),
        })),
      };
    })());
  }

  if (allowed('admins')) {
    tasks.push((async () => {
      const scope = scopes.admins;
      const [adminRows, grants] = await Promise.all([
        prisma.admin.findMany({ select: { stableUid: true } }),
        prisma.adminGrant.findMany({ where: { username: { contains: text } }, select: { username: true, scope: true } }),
      ]);
      const users = await prisma.user.findMany({
        where: { username: { contains: text }, OR: [{ stableUid: { in: adminRows.map((a) => a.stableUid) } }, { username: { in: grants.map((g) => g.username) } }, { username: { in: config.adminUsernames.map((n) => n.toLowerCase()) } }] },
        select: { username: true, schoolId: true },
      });
      const grantsOf = new Map<string, string[]>();
      for (const g of grants) grantsOf.set(g.username, [...(grantsOf.get(g.username) ?? []), g.scope]);
      const rows = users
        .map((u) => {
          const scopesOf = grantsOf.get(u.username) ?? [];
          // A school's admins see the rights held in their schools only, and
          // that someone is a global admin.
          const visible = scopesOf.filter((s) => s === GLOBAL_SCOPE || scope === 'all' || scope.includes(s));
          return {
            username: u.username,
            owner: isOwner(u.username),
            global: scopesOf.includes(GLOBAL_SCOPE),
            schools: visible.filter((s) => s !== GLOBAL_SCOPE).map((s) => schools.get(s) ?? s),
            schoolId: u.schoolId ?? def,
            schoolName: schoolName(u.schoolId),
            inReach: scope === 'all' || scope.includes(u.schoolId ?? def) || scopesOf.some((s) => scope.includes(s)),
          };
        })
        .filter((row) => row.inReach);
      // Operators without an app account, for who sees the whole installation.
      if (scope === 'all') {
        const known = new Set(rows.map((r) => r.username.toLowerCase()));
        for (const name of config.adminUsernames) {
          if (!known.has(name.toLowerCase()) && name.toLowerCase().includes(q)) {
            rows.push({ username: name, owner: true, global: true, schools: [], schoolId: def, schoolName: null, inReach: true });
          }
        }
      }
      results.admins = {
        total: rows.length,
        items: best(rows, (r) => r.username, q, limit).map(({ inReach: _inReach, ...row }) => row),
      };
    })());
  }

  if (allowed('dishes')) {
    tasks.push((async () => {
      const scope = scopes.dishes;
      const links = await prisma.mensaMenuSchool.findMany({ where: scope === 'all' ? {} : { schoolId: { in: scope } }, select: { menuId: true, schoolId: true } });
      const menus = await prisma.mensaMenu.findMany({
        where: scope === 'all' ? {} : { id: { in: links.map((l) => l.menuId) } },
        select: { id: true, name: true },
      });
      if (menus.length === 0) {
        results.dishes = { total: 0, items: [] };
        return;
      }
      const menuName = new Map(menus.map((m) => [m.id, m.name]));
      const schoolsOf = new Map<string, string[]>();
      for (const l of links) schoolsOf.set(l.menuId, [...(schoolsOf.get(l.menuId) ?? []), l.schoolId]);
      const where = {
        menuId: { in: menus.map((m) => m.id) },
        OR: [{ nameDe: { contains: text } }, { nameIt: { contains: text } }, { nameEn: { contains: text } }],
      };
      const rows = await prisma.dish.findMany({
        where,
        select: { id: true, nameDe: true, stableKey: true, menuId: true, plan: true, date: true, imageUrl: true },
        orderBy: { date: 'asc' },
        // A dish is served on many days: room for that before distinct ones.
        take: limit * 40,
      });
      // One entry per dish of a menu, not one per day it is served.
      const distinct = unique(rows, (d) => `${d.menuId}:${d.stableKey || d.nameDe.toLowerCase()}`);
      results.dishes = {
        total: distinct.length,
        items: best(distinct, (d) => d.nameDe, q, limit).map((d) => ({
          id: d.id,
          name: d.nameDe,
          key: d.stableKey,
          plan: d.plan,
          imageUrl: d.imageUrl || null,
          menuId: d.menuId,
          menuName: d.menuId ? menuName.get(d.menuId) ?? null : null,
          // The schools (within reach) that show this menu.
          schoolIds: d.menuId ? (schoolsOf.get(d.menuId) ?? []).filter((id) => scope === 'all' || scope.includes(id)) : [],
        })),
      };
    })());
  }

  if (allowed('comments')) {
    tasks.push((async () => {
      const scope = scopes.comments;
      const dishWhere = { AND: [{ OR: [{ body: { contains: text } }, { username: { contains: text } }] }, ...restrict('comments')] };
      const reminderWhere = {
        AND: [
          { OR: [{ body: { contains: text } }, { username: { contains: text } }] },
          ...(scope === 'all' ? [] : [{ reminder: { class: inSchools(scope) } }]),
        ],
      };
      const [dishRows, dishTotal, reminderRows, reminderTotal] = await Promise.all([
        prisma.dishComment.findMany({ where: dishWhere, select: { id: true, dishId: true, username: true, body: true, menuId: true, schoolId: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: limit }),
        prisma.dishComment.count({ where: dishWhere }),
        prisma.comment.findMany({ where: reminderWhere, select: { id: true, username: true, body: true, createdAt: true, reminder: { select: { title: true, class: { select: { schoolId: true, name: true } } } } }, orderBy: { createdAt: 'desc' }, take: limit }),
        prisma.comment.count({ where: reminderWhere }),
      ]);
      const dishNames = new Map(
        (await prisma.dish.findMany({ where: { stableKey: { in: [...new Set(dishRows.map((c) => c.dishId))] } }, select: { stableKey: true, nameDe: true }, distinct: ['stableKey'] }))
          .map((d) => [d.stableKey, d.nameDe]),
      );
      const items = [
        ...dishRows.map((c) => ({
          id: c.id,
          type: 'dish' as const,
          body: c.body.slice(0, 200),
          username: c.username,
          context: dishNames.get(c.dishId) ?? null,
          dishKey: c.dishId,
          menuId: c.menuId,
          createdAt: c.createdAt.toISOString(),
          schoolId: c.schoolId ?? def,
          schoolName: schoolName(c.schoolId),
        })),
        ...reminderRows.map((c) => ({
          id: c.id,
          type: 'reminder' as const,
          body: c.body.slice(0, 200),
          username: c.username,
          context: c.reminder.title,
          dishKey: null,
          menuId: null,
          createdAt: c.createdAt.toISOString(),
          schoolId: c.reminder.class.schoolId ?? def,
          schoolName: schoolName(c.reminder.class.schoolId),
        })),
      ].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
      results.comments = { total: dishTotal + reminderTotal, items };
    })());
  }

  await Promise.all(tasks);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ query: raw, results });
});

export { router as adminSearchRouter };
