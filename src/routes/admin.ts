import { Router, Request, Response } from 'express';
import { z } from 'zod';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { rateLimit } from 'express-rate-limit';
import https from 'https';
import http from 'http';
import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import { createHash, randomBytes } from 'crypto';
import { config } from '../config';
import { prisma } from '../db';
import { requireAdmin } from '../middleware/requireAdmin';
import { generateClassCode, generateClassId } from '../utils/uid';
import { revokeUserTokens } from '../utils/revokedTokens';
import { logger } from '../utils/logger';
import { invalidateDishesCache } from '../utils/cache';
import { publishDishRatings } from '../services/dishRatings';
import { broadcastDishComments } from './dishComments';
import { getLearnConfig, updateLearnConfig } from '../services/learnConfig';
import { getLearnAiConfig, updateLearnAiConfig } from '../services/learnAiConfig';
import { ensureModelReady } from '../services/learnAiOllama';
import {
  grantAiAccess,
  grantAiAccessToTeam,
  listAiAccessGrants,
  listAiTeamAccessGrants,
  revokeAiAccess,
  revokeAiAccessFromTeam,
} from '../services/learnAiAccess';
import { seedStarterVocabCourses, ensureAllTeamMembersVocabAccess, ensureTeamMemberVocabAccess } from '../services/learnTeamVocab';
import { parseTags } from '../services/learnVocabularyText';
import { mergeVocabularyEntries } from '../services/learnVocabularyMerge';
import { getDictionarySuggestion } from '../services/learnDictionary';
import {
  getBackupConfig, updateBackupConfig, listBackups, runBackup, pruneOldBackups,
  resolveBackupPath, restoreBackup,
} from '../services/dbBackup';
import { writeLimiter } from '../middleware/rateLimiter';
import { issuedApiKeyScopes, parseApiKeyScopes, serializeApiKeyScopes } from '../security/apiKeyPolicy';
import {
  rotatePastWeeks, normalizePlanAroundAnchor,
  lastFutureMondayIso, firstMondayIso, otherPlan, snapForwardToSeason, isoAddDays,
} from '../utils/mensaRotate';
import { slugifyDishName } from '../utils/dishKey';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../utils/errors';

function safeParseTags(raw: string): string[] {
  try { return JSON.parse(raw) as string[]; } catch { return []; }
}

function dishRow(d: {
  id: string; nameDe: string; nameIt: string; nameEn: string;
  descDe: string; descIt: string; descEn: string;
  imageUrl: string; category: string; tags: string;
  prepTime: number; calories: number; price: number;
  protein: number; fat: number; allergens: string;
  isVegetarian: boolean; isVegan: boolean; date: Date; sortOrder: number;
  plan: string; stableKey: string; weekOrdinal: number;
  createdAt: Date; updatedAt: Date;
}) {
  return {
    id: d.id,
    nameDe: d.nameDe, nameIt: d.nameIt, nameEn: d.nameEn,
    descDe: d.descDe, descIt: d.descIt, descEn: d.descEn,
    imageUrl: d.imageUrl,
    category: d.category,
    tags: safeParseTags(d.tags),
    prepTime: d.prepTime,
    calories: d.calories,
    price: d.price,
    protein: d.protein,
    fat: d.fat,
    allergens: safeParseTags(d.allergens),
    isVegetarian: d.isVegetarian,
    isVegan: d.isVegan,
    date: d.date.toISOString().split('T')[0],
    sortOrder: d.sortOrder,
    plan: d.plan === 'winter' ? 'winter' : 'summer',
    stableKey: d.stableKey || slugifyDishName(d.nameDe),
    weekOrdinal: d.weekOrdinal || 0,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

function parsePlan(v: unknown, fallback: 'summer' | 'winter' = 'summer'): 'summer' | 'winter' {
  return v === 'winter' ? 'winter' : v === 'summer' ? 'summer' : fallback;
}

// Try to pull the intrinsic week number out of the source id used by
// mensa.plattnericus.dev, which formats ids as "w1_mo", "w2_tu", … "w6_su".
// Falls back to 0 (unknown) when the id doesn't match the pattern.
function weekOrdinalFromSourceId(sourceId: string | null | undefined): number {
  if (!sourceId) return 0;
  const m = /^w(\d+)[_-]/i.exec(sourceId);
  if (!m) return 0;
  const n = parseInt(m[1]!, 10);
  return Number.isFinite(n) && n > 0 && n < 1000 ? n : 0;
}

function fetchUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { 'User-Agent': 'pokyh-backend/1.0' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

const router = Router();

// Rate limiter for login (env-overridable, default 10 per 15 minutes per IP)
const loginLimiter = rateLimit({
  windowMs: config.rateLimit.adminLoginWindowMs,
  max: config.rateLimit.adminLoginMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later' },
});

// ─── POST /api/admin/auth/login ───────────────────────────────────────────────

router.post('/auth/login', loginLimiter, async (req: Request, res: Response): Promise<void> => {
  const { username, password } = req.body as { username?: string; password?: string };

  if (!username || !password) {
    res.status(400).json({ error: 'Username and password required' });
    return;
  }

  // Accept admins defined in env OR with an Admin DB record (per-user password)
  const user = await prisma.user.findUnique({ where: { username } });
  const adminRecord = user
    ? await prisma.admin.findUnique({ where: { stableUid: user.stableUid } })
    : null;

  const loginIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ?? req.socket.remoteAddress ?? 'unknown';
  const isEnvAdmin = config.adminUsernames.includes(username);
  if (!adminRecord && !isEnvAdmin) {
    logger.warn('Admin login failed: unknown user', { action: 'admin_login_failed', username, ip: loginIp });
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  // Per-user hash takes priority; fall back to shared ADMIN_PASSWORD_HASH
  const hashToCheck = adminRecord?.passwordHash ?? config.adminPasswordHash;
  if (!hashToCheck) {
    res.status(500).json({ error: 'Admin password not configured — run npm run make-admin to set one' });
    return;
  }

  const valid = await bcrypt.compare(password, hashToCheck);
  if (!valid) {
    logger.warn('Admin login failed: wrong password', { action: 'admin_login_failed', username, ip: loginIp });
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ?? req.socket.remoteAddress ?? 'unknown';
  const token = jwt.sign(
    { role: 'admin', sub: 'admin-panel', username },
    config.jwtSecret,
    { expiresIn: config.adminJwtExpiresIn } as jwt.SignOptions
  );

  logger.info('Admin login successful', { action: 'admin_login', username, ip, userAgent: req.headers['user-agent'] });
  res.json({ token });
});

// ─── GET /api/admin/stats ─────────────────────────────────────────────────────

router.get('/stats', requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const startOfWeek = new Date();
  startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
  startOfWeek.setHours(0, 0, 0, 0);

  const [
    totalUsers,
    totalAdmins,
    totalClasses,
    totalTodos,
    totalReminders,
    totalActiveSessions,
    requestsToday,
    newUsersToday,
    newUsersThisWeek,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.admin.count(),
    prisma.class.count(),
    prisma.todo.count(),
    prisma.reminder.count(),
    prisma.refreshToken.count({ where: { revokedAt: null, expiresAt: { gt: new Date() } } }),
    prisma.requestLog.count({ where: { createdAt: { gte: startOfToday } } }),
    prisma.user.count({ where: { createdAt: { gte: startOfToday } } }),
    prisma.user.count({ where: { createdAt: { gte: startOfWeek } } }),
  ]);

  type DayRow = { date: string | Date; count: bigint };
  type StatRow = { errors: bigint; avgMs: number | null };

  const [rawRows, todayStats] = await Promise.all([
    prisma.$queryRaw<DayRow[]>`
      SELECT DATE(created_at) as date, COUNT(*) as count
      FROM users
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 14 DAY)
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `,
    prisma.$queryRaw<StatRow[]>`
      SELECT
        SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END) AS errors,
        ROUND(AVG(duration)) AS avgMs
      FROM request_logs
      WHERE created_at >= ${startOfToday}
    `,
  ]);

  const usersByDay = rawRows.map((row) => ({
    date: row.date instanceof Date ? row.date.toISOString().slice(0, 10) : String(row.date).slice(0, 10),
    count: Number(row.count),
  }));

  const errorsToday = Number(todayStats[0]?.errors ?? 0);
  const avgResponseTimeToday = Number(todayStats[0]?.avgMs ?? 0);

  res.json({
    totalUsers,
    totalAdmins,
    totalClasses,
    totalTodos,
    totalReminders,
    totalActiveSessions,
    requestsToday,
    errorsToday,
    avgResponseTimeToday,
    newUsersToday,
    newUsersThisWeek,
    serverUptime: Math.floor(process.uptime()),
    usersByDay,
  });
});

// ─── POST /api/admin/users ────────────────────────────────────────────────────

router.post('/users', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const { username, password, webuntisKlasseId, webuntisKlasseName, role } = req.body as {
    username?: string;
    password?: string;
    webuntisKlasseId?: number;
    webuntisKlasseName?: string;
    role?: string;
  };

  // Only the two known account roles are accepted; default to "student".
  const accountRole = role === 'parent' ? 'parent' : 'student';

  if (!username || username.trim().length < 1) {
    res.status(400).json({ error: 'Username is required' });
    return;
  }

  if (password !== undefined && password !== '' && password.length < 8) {
    res.status(400).json({ error: 'Passwort muss mindestens 8 Zeichen lang sein' });
    return;
  }

  const existing = await prisma.user.findUnique({ where: { username: username.trim().toLowerCase() } });
  if (existing) {
    res.status(409).json({ error: `User "${username}" already exists` });
    return;
  }

  const passwordHash = password ? await bcrypt.hash(password, config.bcryptRounds) : undefined;
  const stableUid = uuidv4();
  const user = await prisma.user.create({
    data: {
      id: uuidv4(),
      stableUid,
      username: username.trim().toLowerCase(),
      webuntisKlasseId: webuntisKlasseId ?? 0,
      webuntisKlasseName: webuntisKlasseName?.trim() || '',
      isUntisUser: !passwordHash,
      role: accountRole,
      ...(passwordHash ? { passwordHash } : {}),
    },
  });

  res.status(201).json({
    stableUid: user.stableUid,
    username: user.username,
    webuntisKlasseId: user.webuntisKlasseId,
    webuntisKlasseName: user.webuntisKlasseName,
    isAdmin: false,
    role: user.role,
    todoCount: 0,
    classId: null,
    classCode: null,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  });
});

// ─── PATCH /api/admin/users/:stableUid/role ───────────────────────────────────
// Switch an account between "student" and "parent". Class memberships are kept
// in sync so a parent never appears in member lists (see ClassMember.role).

router.patch('/users/:stableUid/role', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const stableUid = String(req.params['stableUid'] ?? '');
  const { role } = req.body as { role?: unknown };

  if (role !== 'student' && role !== 'parent') {
    res.status(400).json({ error: 'role must be "student" or "parent"' });
    return;
  }

  const user = await prisma.user.findUnique({ where: { stableUid } });
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  await prisma.$transaction([
    prisma.user.update({ where: { stableUid }, data: { role } }),
    // Keep the membership role aligned with the account role.
    prisma.classMember.updateMany({ where: { stableUid }, data: { role } }),
  ]);

  const adminUsername = adminUsernameFromReq(req.headers['authorization']);
  logger.info('Admin action: set user role', { action: 'set_user_role', adminUsername, stableUid, role });

  res.json({ stableUid, role });
});

// ─── PATCH /api/admin/users/:stableUid/password ───────────────────────────────

router.patch('/users/:stableUid/password', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const stableUid = String(req.params['stableUid'] ?? '');
  const { password } = req.body as { password?: unknown };

  if (!stableUid) {
    res.status(400).json({ error: 'stableUid required' });
    return;
  }

  if (typeof password !== 'string' || password.length < 8) {
    res.status(400).json({ error: 'Passwort muss mindestens 8 Zeichen lang sein' });
    return;
  }

  const user = await prisma.user.findUnique({ where: { stableUid } });
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
  await prisma.user.update({
    where: { stableUid },
    data: { passwordHash, isUntisUser: false },
  });

  // A password reset is an incident-response action — it must actually cut
  // off a session an attacker already holds, not just block future logins.
  await prisma.refreshToken.updateMany({
    where: { stableUid, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  revokeUserTokens(stableUid);

  res.status(204).end();
});

// ─── GET /api/admin/users ─────────────────────────────────────────────────────

router.get('/users', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const search = typeof req.query['search'] === 'string' ? req.query['search'] : undefined;
  // Optional role filter: 'student' or 'parent'. Anything else means "no filter".
  const roleRaw = typeof req.query['role'] === 'string' ? req.query['role'] : undefined;
  const roleFilter = roleRaw === 'student' || roleRaw === 'parent' ? roleRaw : undefined;
  const page = Math.max(1, parseInt(String(req.query['page'] ?? '1'), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query['limit'] ?? '20'), 10)));
  const skip = (page - 1) * limit;

  const where = {
    ...(search ? { username: { contains: search } } : {}),
    ...(roleFilter ? { role: roleFilter } : {}),
  };

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { todos: true } },
        classMembers: {
          include: { class: { select: { id: true, code: true } } },
          take: 1,
          orderBy: { joinedAt: 'desc' },
        },
      },
    }),
    prisma.user.count({ where }),
  ]);

  // Fetch admins set for these users
  const uids = users.map((u) => u.stableUid);
  const admins = await prisma.admin.findMany({
    where: { stableUid: { in: uids } },
    select: { stableUid: true },
  });
  const adminSet = new Set(admins.map((a) => a.stableUid));

  const result = users.map((u) => {
    const membership = u.classMembers[0];
    return {
      stableUid: u.stableUid,
      username: u.username,
      webuntisKlasseId: u.webuntisKlasseId,
      webuntisKlasseName: u.webuntisKlasseName,
      classId: membership?.classId ?? null,
      classCode: membership?.class?.code ?? null,
      isAdmin: adminSet.has(u.stableUid),
      role: u.role,
      todoCount: u._count.todos,
      createdAt: u.createdAt.toISOString(),
      updatedAt: u.updatedAt.toISOString(),
    };
  });

  res.json({ users: result, total, page, limit });
});

// ─── GET /api/admin/users/:stableUid ─────────────────────────────────────────

router.get('/users/:stableUid', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const stableUid = String(req.params['stableUid']);

  const [user, isAdmin] = await Promise.all([
    prisma.user.findUnique({
      where: { stableUid },
      include: {
        todos: { orderBy: { createdAt: 'desc' } },
        classMembers: {
          include: { class: { select: { id: true, name: true, code: true } } },
          orderBy: { joinedAt: 'desc' },
        },
      },
    }),
    prisma.admin.findUnique({ where: { stableUid } }),
  ]);

  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  res.json({
    stableUid: user.stableUid,
    username: user.username,
    webuntisKlasseId: user.webuntisKlasseId,
    webuntisKlasseName: user.webuntisKlasseName,
    isAdmin: !!isAdmin,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
    todos: user.todos.map((t) => ({
      id: t.id,
      title: t.title,
      details: t.details,
      dueAt: t.dueAt ? t.dueAt.toISOString() : null,
      done: t.done,
      doneAt: t.doneAt ? t.doneAt.toISOString() : null,
      archivedAt: t.archivedAt ? t.archivedAt.toISOString() : null,
      createdAt: t.createdAt.toISOString(),
    })),
    classes: user.classMembers.map((m) => ({
      classId: m.classId,
      className: m.class.name,
      classCode: m.class.code,
      joinedAt: m.joinedAt.toISOString(),
    })),
  });
});

// ─── DELETE /api/admin/users/:stableUid ──────────────────────────────────────

router.delete('/users/:stableUid', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const stableUid = String(req.params['stableUid']);
  const adminJwt = req.headers['authorization']?.replace('Bearer ', '');
  let adminUsername = 'admin';
  try { if (adminJwt) adminUsername = (jwt.decode(adminJwt) as Record<string, string>)?.['username'] ?? 'admin'; } catch {}
  revokeUserTokens(stableUid);
  await prisma.user.delete({ where: { stableUid } }).catch(() => null);
  logger.info('Admin action: delete user', { action: 'delete_user', adminUsername, targetUid: stableUid });
  res.status(204).send();
});

// ─── PATCH /api/admin/users/:stableUid/todos/:todoId ─────────────────────────

router.patch('/users/:stableUid/todos/:todoId', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const stableUid = String(req.params['stableUid']);
  const todoId = String(req.params['todoId']);
  const { title, details, done, dueAt } = req.body as {
    title?: string;
    details?: string;
    done?: boolean;
    dueAt?: string | null;
  };

  const data: Record<string, unknown> = {};
  if (title !== undefined) data['title'] = title;
  if (details !== undefined) data['details'] = details;
  if (dueAt !== undefined) data['dueAt'] = dueAt ? new Date(dueAt) : null;
  if (done !== undefined) {
    data['done'] = done;
    data['doneAt'] = done ? new Date() : null;
  }

  const todo = await prisma.todo.update({
    where: { id: todoId, stableUid },
    data,
  });

  res.json({
    id: todo.id,
    title: todo.title,
    details: todo.details,
    dueAt: todo.dueAt ? todo.dueAt.toISOString() : null,
    done: todo.done,
    doneAt: todo.doneAt ? todo.doneAt.toISOString() : null,
    createdAt: todo.createdAt.toISOString(),
  });
});

// ─── DELETE /api/admin/users/:stableUid/todos/:todoId ────────────────────────

router.delete('/users/:stableUid/todos/:todoId', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const stableUid = String(req.params['stableUid']);
  const todoId = String(req.params['todoId']);
  await prisma.todo.deleteMany({ where: { id: todoId, stableUid } });
  res.status(204).send();
});

// ─── POST /api/admin/users/:stableUid/todos ───────────────────────────────────

router.post('/users/:stableUid/todos', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const stableUid = String(req.params['stableUid']);
  const { title, details, dueAt } = req.body as { title?: string; details?: string; dueAt?: string | null };

  if (!title || String(title).trim().length < 1) {
    res.status(400).json({ error: 'Title is required' });
    return;
  }

  const user = await prisma.user.findUnique({ where: { stableUid } });
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const todo = await prisma.todo.create({
    data: {
      stableUid,
      title: String(title).trim().slice(0, 500),
      details: details ? String(details).slice(0, 10000) : '',
      dueAt: dueAt ? new Date(dueAt) : null,
    },
  });

  res.status(201).json({
    id: todo.id,
    title: todo.title,
    details: todo.details,
    dueAt: todo.dueAt ? todo.dueAt.toISOString() : null,
    done: todo.done,
    doneAt: null,
    createdAt: todo.createdAt.toISOString(),
  });
});

// ─── DELETE /api/admin/users/:stableUid/classes/:classId ─────────────────────

router.delete('/users/:stableUid/classes/:classId', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const stableUid = String(req.params['stableUid']);
  const classId = String(req.params['classId']);
  await prisma.classMember.deleteMany({ where: { stableUid, classId } });
  res.status(204).send();
});

// ─── POST /api/admin/users/:stableUid/grant-admin ────────────────────────────

router.post('/users/:stableUid/grant-admin', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const stableUid = String(req.params['stableUid']);
  const adminJwt = req.headers['authorization']?.replace('Bearer ', '');
  let adminUsername = 'admin';
  try { if (adminJwt) adminUsername = (jwt.decode(adminJwt) as Record<string, string>)?.['username'] ?? 'admin'; } catch {}

  await prisma.admin.upsert({
    where: { stableUid },
    create: { stableUid, canCreateClass: true },
    update: { canCreateClass: true },
  });

  logger.info('Admin action: grant admin', { action: 'grant_admin', adminUsername, targetUid: stableUid });
  res.json({ ok: true });
});

// ─── DELETE /api/admin/users/:stableUid/revoke-admin ─────────────────────────

router.delete('/users/:stableUid/revoke-admin', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const stableUid = String(req.params['stableUid']);
  const adminJwt = req.headers['authorization']?.replace('Bearer ', '');
  let adminUsername = 'admin';
  try { if (adminJwt) adminUsername = (jwt.decode(adminJwt) as Record<string, string>)?.['username'] ?? 'admin'; } catch {}

  await prisma.admin.deleteMany({ where: { stableUid } });

  logger.info('Admin action: revoke admin', { action: 'revoke_admin', adminUsername, targetUid: stableUid });
  res.status(204).send();
});

// ─── GET /api/admin/classes ───────────────────────────────────────────────────

router.get('/classes', requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  const classes = await prisma.class.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      // A parent account's WebUntis klasseId is their child's class, so a
      // parent legitimately gets a ClassMember row too (see syncUserClass in
      // routes/auth.ts) — but they were never meant to be a visible class
      // *member*. Every other class route (classes.ts) already excludes
      // role: 'parent' from member lists/counts; this admin listing had been
      // missed, which is what made a parent account look "assigned to a
      // class" here.
      members: {
        where: { role: { not: 'parent' } },
        select: {
          stableUid: true,
          username: true,
          joinedAt: true,
        },
      },
    },
  });

  const result = classes.map((c) => ({
    id: c.id,
    name: c.name,
    code: c.code,
    webuntisKlasseId: c.webuntisKlasseId,
    createdBy: c.createdBy,
    createdByName: c.createdByName,
    createdAt: c.createdAt.toISOString(),
    memberCount: c.members.length,
    members: c.members.map((m) => ({
      stableUid: m.stableUid,
      username: m.username,
      joinedAt: m.joinedAt.toISOString(),
    })),
  }));

  res.json(result);
});

// ─── GET /api/admin/sessions ──────────────────────────────────────────────────

router.get('/sessions', requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  const tokens = await prisma.refreshToken.findMany({
    take: 50,
    orderBy: { createdAt: 'desc' },
    include: {
      user: { select: { username: true } },
    },
  });

  const now = new Date();
  const result = tokens.map((t) => ({
    id: t.id,
    stableUid: t.stableUid,
    username: t.user.username,
    createdAt: t.createdAt.toISOString(),
    expiresAt: t.expiresAt.toISOString(),
    revokedAt: t.revokedAt ? t.revokedAt.toISOString() : null,
    isActive: t.revokedAt === null && t.expiresAt > now,
  }));

  res.json(result);
});

// ─── DELETE /api/admin/sessions ── revoke all active + delete all expired/revoked
router.delete('/sessions', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const adminJwt = req.headers['authorization']?.replace('Bearer ', '');
  let adminUsername = 'admin';
  try { if (adminJwt) adminUsername = (jwt.decode(adminJwt) as Record<string, string>)?.['username'] ?? 'admin'; } catch {}

  const active = await prisma.refreshToken.findMany({
    where: { revokedAt: null },
    select: { stableUid: true },
  });

  await prisma.refreshToken.deleteMany({});

  const seen = new Set<string>();
  for (const t of active) {
    if (!seen.has(t.stableUid)) {
      seen.add(t.stableUid);
      revokeUserTokens(t.stableUid);
    }
  }

  logger.info('Admin action: delete all sessions', { action: 'delete_all_sessions', adminUsername, affectedUsers: seen.size });
  res.status(204).send();
});

// ─── DELETE /api/admin/sessions/inactive ── delete only revoked/expired sessions
router.delete('/sessions/inactive', requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  await prisma.refreshToken.deleteMany({
    where: {
      OR: [
        { revokedAt: { not: null } },
        { expiresAt: { lt: new Date() } },
      ],
    },
  });

  res.status(204).send();
});

// ─── DELETE /api/admin/sessions/:id ──────────────────────────────────────────

router.delete('/sessions/:id', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params['id']);

  const token = await prisma.refreshToken.findUnique({ where: { id }, select: { stableUid: true } });

  await prisma.refreshToken.updateMany({
    where: { id, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  // Force-expire any active access JWTs for this user immediately
  if (token) revokeUserTokens(token.stableUid);

  res.status(204).send();
});

// ─── GET /api/admin/logs ──────────────────────────────────────────────────────
// General request logs with optional filters

router.get('/logs', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const page = Math.max(1, parseInt(String(req.query['page'] ?? '1'), 10));
  const limit = Math.min(200, Math.max(1, parseInt(String(req.query['limit'] ?? '50'), 10)));
  const skip = (page - 1) * limit;
  const method = req.query['method'] ? String(req.query['method']).toUpperCase() : undefined;
  const status = req.query['status'] ? parseInt(String(req.query['status']), 10) : undefined;
  const pathFilter = req.query['path'] ? String(req.query['path']) : undefined;
  const username = req.query['username'] ? String(req.query['username']) : undefined;
  const scope = req.query['scope'] === 'learn' || req.query['scope'] === 'core' ? String(req.query['scope']) : undefined;
  const from = req.query['from'] ? new Date(String(req.query['from'])) : undefined;
  const to = req.query['to'] ? new Date(String(req.query['to']) + 'T23:59:59.999Z') : undefined;

  const where: Record<string, unknown> = {};
  if (method) where['method'] = method;
  if (status) where['status'] = { gte: status, lt: status + 100 };
  if (pathFilter) where['path'] = { contains: pathFilter };
  if (username) where['username'] = { contains: username };
  if (scope) where['scope'] = scope;
  if (from || to) {
    where['createdAt'] = {
      ...(from && !isNaN(from.getTime()) ? { gte: from } : {}),
      ...(to && !isNaN(to.getTime()) ? { lte: to } : {}),
    };
  }

  const [logs, total] = await Promise.all([
    prisma.requestLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
    prisma.requestLog.count({ where }),
  ]);

  res.json({ logs, total, page, limit });
});

// ─── GET /api/admin/logs/users/:stableUid ────────────────────────────────────
// Per-user request log

router.get('/logs/users/:stableUid', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const stableUid = String(req.params['stableUid']);
  const page = Math.max(1, parseInt(String(req.query['page'] ?? '1'), 10));
  const limit = Math.min(200, Math.max(1, parseInt(String(req.query['limit'] ?? '50'), 10)));
  const skip = (page - 1) * limit;

  const [logs, total, user] = await Promise.all([
    prisma.requestLog.findMany({
      where: { stableUid },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.requestLog.count({ where: { stableUid } }),
    prisma.user.findUnique({ where: { stableUid }, select: { username: true } }),
  ]);

  res.json({ logs, total, page, limit, user });
});

// ─── POST /api/admin/classes ──────────────────────────────────────────────────

router.post('/classes', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const { name, code, webuntisKlasseId } = req.body as {
    name?: string;
    code?: string;
    webuntisKlasseId?: number;
  };

  if (!name || name.trim().length < 1) {
    res.status(400).json({ error: 'Class name is required' });
    return;
  }

  const classCode = (code?.trim().toUpperCase() ?? generateClassCode()).slice(0, 6);

  const newClass = await prisma.class.create({
    data: {
      id: generateClassId(),
      name: name.trim(),
      code: classCode,
      webuntisKlasseId: webuntisKlasseId ?? 0,
      createdBy: 'admin',
      createdByName: config.adminUsername,
    },
    include: {
      members: { select: { stableUid: true, username: true, joinedAt: true } },
    },
  });

  res.status(201).json({
    id: newClass.id,
    name: newClass.name,
    code: newClass.code,
    webuntisKlasseId: newClass.webuntisKlasseId,
    createdBy: newClass.createdBy,
    createdByName: newClass.createdByName,
    createdAt: newClass.createdAt.toISOString(),
    memberCount: 0,
    members: [],
  });
});

// ─── DELETE /api/admin/classes/:id ───────────────────────────────────────────

router.delete('/classes/:id', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params['id']);
  await prisma.class.delete({ where: { id } }).catch(() => null);
  res.status(204).send();
});

// ─── GET /api/admin/classes/:id/reminders ────────────────────────────────────

router.get('/classes/:id/reminders', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params['id']);
  const reminders = await prisma.reminder.findMany({
    where: { classId: id },
    orderBy: { remindAt: 'asc' },
  });
  res.json(reminders.map((r) => ({
    id: r.id,
    classId: r.classId,
    title: r.title,
    body: r.body,
    remindAt: r.remindAt.toISOString(),
    createdBy: r.createdBy,
    createdByName: r.createdByName,
    createdByUsername: r.createdByUsername,
    archivedAt: r.archivedAt ? r.archivedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  })));
});

// ─── POST /api/admin/classes/:id/reminders ────────────────────────────────────

router.post('/classes/:id/reminders', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params['id']);
  const { title, body, remindAt } = req.body as { title?: string; body?: string; remindAt?: string };

  if (!title || String(title).trim().length < 1) {
    res.status(400).json({ error: 'Title is required' });
    return;
  }
  if (!remindAt) {
    res.status(400).json({ error: 'remindAt is required' });
    return;
  }

  const cls = await prisma.class.findUnique({ where: { id } });
  if (!cls) {
    res.status(404).json({ error: 'Class not found' });
    return;
  }

  const reminder = await prisma.reminder.create({
    data: {
      classId: id,
      title: String(title).trim().slice(0, 500),
      body: body ? String(body).slice(0, 10000) : '',
      remindAt: new Date(remindAt),
      createdBy: 'admin',
      createdByName: config.adminUsername,
      createdByUsername: 'admin',
    },
  });

  res.status(201).json({
    id: reminder.id,
    classId: reminder.classId,
    title: reminder.title,
    body: reminder.body,
    remindAt: reminder.remindAt.toISOString(),
    createdBy: reminder.createdBy,
    createdByName: reminder.createdByName,
    createdByUsername: reminder.createdByUsername,
    createdAt: reminder.createdAt.toISOString(),
  });
});

// ─── PATCH /api/admin/reminders/:id ──────────────────────────────────────────

router.patch('/reminders/:id', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params['id']);
  const { title, body, remindAt } = req.body as { title?: string; body?: string; remindAt?: string };

  const data: Record<string, unknown> = {};
  if (title !== undefined) data['title'] = String(title).trim().slice(0, 500);
  if (body !== undefined) data['body'] = String(body).slice(0, 10000);
  if (remindAt !== undefined) data['remindAt'] = new Date(remindAt);

  const reminder = await prisma.reminder.update({ where: { id }, data });

  res.json({
    id: reminder.id,
    classId: reminder.classId,
    title: reminder.title,
    body: reminder.body,
    remindAt: reminder.remindAt.toISOString(),
    createdBy: reminder.createdBy,
    createdByName: reminder.createdByName,
    createdByUsername: reminder.createdByUsername,
    createdAt: reminder.createdAt.toISOString(),
  });
});

// ─── DELETE /api/admin/reminders/:id ─────────────────────────────────────────

router.delete('/reminders/:id', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params['id']);
  await prisma.reminder.delete({ where: { id } }).catch(() => null);
  res.status(204).send();
});

// ─── POST /api/admin/classes/:id/members ─────────────────────────────────────

router.post('/classes/:id/members', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params['id']);
  const { username } = req.body as { username?: string };
  if (!username?.trim()) {
    res.status(400).json({ error: 'username required' });
    return;
  }
  const user = await prisma.user.findUnique({ where: { username: username.trim().toLowerCase() } });
  if (!user) {
    res.status(404).json({ error: `User "${username.trim()}" not found` });
    return;
  }
  const cls = await prisma.class.findUnique({ where: { id } });
  if (!cls) {
    res.status(404).json({ error: 'Class not found' });
    return;
  }
  await prisma.classMember.upsert({
    where: { classId_stableUid: { classId: id, stableUid: user.stableUid } },
    create: { classId: id, stableUid: user.stableUid, username: user.username },
    update: {},
  });
  res.json({ stableUid: user.stableUid, username: user.username, joinedAt: new Date().toISOString() });
});

// ─── GET /api/admin/stats/requests-chart ─────────────────────────────────────
// Requests per hour for the last 24 hours

router.get('/stats/requests-chart', requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  type HourRow = { hour: string; count: bigint; errors: bigint };

  const rows = await prisma.$queryRaw<HourRow[]>`
    SELECT
      DATE_FORMAT(created_at, '%Y-%m-%d %H:00') AS hour,
      COUNT(*) AS count,
      SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors
    FROM request_logs
    WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
    GROUP BY hour
    ORDER BY hour ASC
  `;

  // Fill gaps — ensure all 24 hours are present
  const map = new Map(rows.map((r) => [r.hour, { count: Number(r.count), errors: Number(r.errors) }]));
  const result = [];
  for (let i = 23; i >= 0; i--) {
    const d = new Date();
    d.setMinutes(0, 0, 0);
    d.setHours(d.getHours() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:00`;
    const label = `${String(d.getHours()).padStart(2, '0')}:00`;
    const data = map.get(key) ?? { count: 0, errors: 0 };
    result.push({ hour: label, count: data.count, errors: data.errors });
  }

  res.json(result);
});

// ─── GET /api/admin/stats/top-endpoints ──────────────────────────────────────

router.get('/stats/top-endpoints', requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  type EndpointRow = { path: string; count: bigint; avgMs: number };

  const rows = await prisma.$queryRaw<EndpointRow[]>`
    SELECT
      path,
      COUNT(*) AS count,
      ROUND(AVG(duration)) AS avgMs
    FROM request_logs
    WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
    GROUP BY path
    ORDER BY count DESC
    LIMIT 8
  `;

  res.json(rows.map((r) => ({
    path: r.path,
    count: Number(r.count),
    avgMs: Number(r.avgMs ?? 0),
  })));
});

// ─── GET /api/admin/classes/:id/todos ────────────────────────────────────────

router.get('/classes/:id/todos', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params['id']);

  const members = await prisma.classMember.findMany({
    where: { classId: id },
    select: { stableUid: true, username: true },
  });

  if (members.length === 0) {
    res.json([]);
    return;
  }

  const uids = members.map((m) => m.stableUid);
  const uidToUsername: Record<string, string> = Object.fromEntries(members.map((m) => [m.stableUid, m.username]));

  const todos = await prisma.todo.findMany({
    where: { stableUid: { in: uids } },
    orderBy: [{ done: 'asc' }, { createdAt: 'asc' }],
  });

  res.json(todos.map((t) => ({
    id: t.id,
    stableUid: t.stableUid,
    username: uidToUsername[t.stableUid] ?? '',
    title: t.title,
    details: t.details,
    dueAt: t.dueAt ? t.dueAt.toISOString() : null,
    done: t.done,
    doneAt: t.doneAt ? t.doneAt.toISOString() : null,
    archivedAt: t.archivedAt ? t.archivedAt.toISOString() : null,
    createdAt: t.createdAt.toISOString(),
  })));
});

// ─── GET /api/admin/dishes ───────────────────────────────────────────────────
// Optional ?plan=summer|winter filter. Omit to return both plans.

router.get('/dishes', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const planParam = req.query['plan'];
  const where = planParam === 'summer' || planParam === 'winter' ? { plan: planParam } : undefined;
  const dishes = await prisma.dish.findMany({
    where,
    orderBy: [{ date: 'asc' }, { sortOrder: 'asc' }, { nameDe: 'asc' }],
  });
  res.json(dishes.map(dishRow));
});

// ─── POST /api/admin/dishes ───────────────────────────────────────────────────

router.post('/dishes', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const b = req.body as Record<string, unknown>;
  if (!b['nameDe'] || String(b['nameDe']).trim().length < 1) {
    res.status(400).json({ error: 'nameDe is required' });
    return;
  }
  if (!b['date']) {
    res.status(400).json({ error: 'date is required' });
    return;
  }

  const dish = await prisma.dish.create({
    data: {
      nameDe: String(b['nameDe']).trim(),
      nameIt: b['nameIt'] ? String(b['nameIt']).trim() : '',
      nameEn: b['nameEn'] ? String(b['nameEn']).trim() : '',
      descDe: b['descDe'] ? String(b['descDe']) : '',
      descIt: b['descIt'] ? String(b['descIt']) : '',
      descEn: b['descEn'] ? String(b['descEn']) : '',
      imageUrl: b['imageUrl'] ? String(b['imageUrl']) : '',
      category: b['category'] ? String(b['category']).trim() : '',
      tags: JSON.stringify(Array.isArray(b['tags']) ? b['tags'] : []),
      prepTime: typeof b['prepTime'] === 'number' ? b['prepTime'] : 0,
      calories: typeof b['calories'] === 'number' ? b['calories'] : 0,
      price: typeof b['price'] === 'number' ? b['price'] : 0,
      protein: typeof b['protein'] === 'number' ? b['protein'] : 0,
      fat: typeof b['fat'] === 'number' ? b['fat'] : 0,
      allergens: JSON.stringify(Array.isArray(b['allergens']) ? b['allergens'] : []),
      isVegetarian: b['isVegetarian'] === true,
      isVegan: b['isVegan'] === true,
      date: new Date(String(b['date'])),
      sortOrder: typeof b['sortOrder'] === 'number' ? b['sortOrder'] : 0,
      plan: parsePlan(b['plan']),
      stableKey: slugifyDishName(String(b['nameDe']).trim()),
    },
  });

  invalidateDishesCache();
  res.status(201).json(dishRow(dish));
});

// ─── PATCH /api/admin/dishes/:id ──────────────────────────────────────────────

router.patch('/dishes/:id', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params['id']);
  const b = req.body as Record<string, unknown>;

  const data: Record<string, unknown> = {};
  if (b['nameDe'] !== undefined) {
    const trimmed = String(b['nameDe']).trim();
    data['nameDe'] = trimmed;
    // Keep stableKey aligned with nameDe so renaming a dish re-groups its
    // ratings/comments together with any other dish now sharing the same slug.
    data['stableKey'] = slugifyDishName(trimmed);
  }
  if (b['nameIt'] !== undefined) data['nameIt'] = String(b['nameIt']).trim();
  if (b['nameEn'] !== undefined) data['nameEn'] = String(b['nameEn']).trim();
  if (b['descDe'] !== undefined) data['descDe'] = String(b['descDe']);
  if (b['descIt'] !== undefined) data['descIt'] = String(b['descIt']);
  if (b['descEn'] !== undefined) data['descEn'] = String(b['descEn']);
  if (b['imageUrl'] !== undefined) data['imageUrl'] = String(b['imageUrl']);
  if (b['category'] !== undefined) data['category'] = String(b['category']).trim();
  if (b['tags'] !== undefined) data['tags'] = JSON.stringify(Array.isArray(b['tags']) ? b['tags'] : []);
  if (b['prepTime'] !== undefined) data['prepTime'] = Number(b['prepTime']);
  if (b['calories'] !== undefined) data['calories'] = Number(b['calories']);
  if (b['price'] !== undefined) data['price'] = Number(b['price']);
  if (b['protein'] !== undefined) data['protein'] = Number(b['protein']);
  if (b['fat'] !== undefined) data['fat'] = Number(b['fat']);
  if (b['allergens'] !== undefined) data['allergens'] = JSON.stringify(Array.isArray(b['allergens']) ? b['allergens'] : []);
  if (b['isVegetarian'] !== undefined) data['isVegetarian'] = b['isVegetarian'] === true;
  if (b['isVegan'] !== undefined) data['isVegan'] = b['isVegan'] === true;
  if (b['date'] !== undefined) data['date'] = new Date(String(b['date']));
  if (b['sortOrder'] !== undefined) data['sortOrder'] = Number(b['sortOrder']);
  if (b['plan'] !== undefined) data['plan'] = parsePlan(b['plan']);

  const dish = await prisma.dish.update({ where: { id }, data }).catch(() => null);
  if (!dish) { res.status(404).json({ error: 'Dish not found' }); return; }

  invalidateDishesCache();
  res.json(dishRow(dish));
});

// ─── DELETE /api/admin/dishes/:id ────────────────────────────────────────────

router.delete('/dishes/:id', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params['id']);
  await prisma.dish.delete({ where: { id } }).catch(() => null);
  invalidateDishesCache();
  res.status(204).send();
});

// ─── POST /api/admin/dishes/import-url ───────────────────────────────────────
// Fetches the external mensa.json URL and bulk-upserts all dishes

router.post('/dishes/import-url', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const url = String(req.body?.url ?? config.mensaImportUrl);
  const plan = parsePlan(req.body?.plan);

  let raw: string;
  try {
    raw = await fetchUrl(url);
  } catch {
    res.status(502).json({ error: 'Failed to fetch external URL' });
    return;
  }

  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    res.status(502).json({ error: 'Invalid JSON from external URL' });
    return;
  }

  type RawDish = Record<string, unknown>;
  const menu = (parsed as Record<string, unknown>)['menu'] as Record<string, unknown> | undefined;
  const list = (menu?.['dishes'] ?? []) as RawDish[];

  if (!Array.isArray(list) || list.length === 0) {
    res.status(422).json({ error: 'No dishes found in response' });
    return;
  }

  function parseName(v: unknown): { de: string; it: string; en: string } {
    if (typeof v === 'string') return { de: v, it: v, en: v };
    if (v && typeof v === 'object') {
      const m = v as Record<string, string>;
      const de = m['de'] ?? m['it'] ?? m['en'] ?? Object.values(m)[0] ?? '';
      return { de, it: m['it'] ?? de, en: m['en'] ?? de };
    }
    return { de: '', it: '', en: '' };
  }

  let imported = 0;
  let updated = 0;

  // Fallback ordinal source: sort JSON entries by date and number the distinct
  // Mondays 1..N so dishes whose sourceId doesn't encode a week still get a
  // stable position.
  const dateToOrdinalFallback = new Map<string, number>();
  {
    const dates = new Set<string>();
    for (const d of list) if (d['date']) dates.add(String(d['date']));
    const sortedDates = [...dates].sort();
    const mondayToOrdinal = new Map<string, number>();
    for (const iso of sortedDates) {
      const dt = new Date(iso + 'T00:00:00Z');
      const wd = dt.getUTCDay() || 7;
      const mon = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate() - wd + 1));
      const monIso = mon.toISOString().split('T')[0]!;
      if (!mondayToOrdinal.has(monIso)) mondayToOrdinal.set(monIso, mondayToOrdinal.size + 1);
      dateToOrdinalFallback.set(iso, mondayToOrdinal.get(monIso)!);
    }
  }

  for (const d of list) {
    const rawId = d['id'];
    const sourceId = rawId ? String(rawId) : null;
    const name = parseName(d['name']);
    const desc = parseName(d['description'] ?? '');
    const dateRaw = d['date'] ? String(d['date']) : null;
    if (!name.de.trim() || !dateRaw) continue;

    const data = {
      nameDe: name.de.trim(),
      nameIt: name.it.trim(),
      nameEn: name.en.trim(),
      descDe: desc.de,
      descIt: desc.it,
      descEn: desc.en,
      imageUrl: d['imageUrl'] ? String(d['imageUrl']) : '',
      category: d['category'] ? String(d['category']) : '',
      tags: JSON.stringify(Array.isArray(d['tags']) ? d['tags'] : []),
      prepTime: typeof d['prepTime'] === 'number' ? d['prepTime'] : 0,
      calories: typeof d['calories'] === 'number' ? d['calories'] : 0,
      price: typeof d['price'] === 'number' ? d['price'] : 0,
      protein: typeof d['protein'] === 'number' ? d['protein'] : 0,
      fat: typeof d['fat'] === 'number' ? d['fat'] : 0,
      allergens: JSON.stringify(Array.isArray(d['allergens']) ? d['allergens'] : []),
      isVegetarian: d['isVegetarian'] === true,
      isVegan: d['isVegan'] === true,
      date: new Date(dateRaw),
      plan,
      sourceId,
      stableKey: slugifyDishName(name.de.trim()),
      weekOrdinal: weekOrdinalFromSourceId(sourceId) || dateToOrdinalFallback.get(dateRaw) || 0,
    };

    // Match by (plan, sourceId) so the same source JSON can populate BOTH
    // plans independently. Fall back to plain id for legacy rows that were
    // imported before sourceId existed and don't yet have it.
    let existing = sourceId
      ? await prisma.dish.findFirst({ where: { plan, sourceId } })
      : null;
    if (!existing && sourceId) {
      const legacy = await prisma.dish.findUnique({ where: { id: sourceId } });
      if (legacy && legacy.plan === plan) existing = legacy;
    }

    if (existing) {
      await prisma.dish.update({ where: { id: existing.id }, data });
      updated++;
    } else {
      await prisma.dish.create({ data: { id: uuidv4(), ...data } });
      imported++;
    }
  }

  invalidateDishesCache();
  res.json({ imported, updated, total: imported + updated, plan });
});

// ─── POST /api/admin/dishes/reset ────────────────────────────────────────────
// Wipes every dish for the given plan and re-imports fresh from the source URL.
// Handy when local edits have drifted too far from the canonical mensa.json.

router.post('/dishes/reset', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const plan = parsePlan(req.body?.plan);
  const url = String(req.body?.url ?? config.mensaImportUrl);

  let raw: string;
  try {
    raw = await fetchUrl(url);
  } catch {
    res.status(502).json({ error: 'Failed to fetch external URL' });
    return;
  }

  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    res.status(502).json({ error: 'Invalid JSON from external URL' });
    return;
  }

  type RawDish = Record<string, unknown>;
  const menu = (parsed as Record<string, unknown>)['menu'] as Record<string, unknown> | undefined;
  const list = (menu?.['dishes'] ?? []) as RawDish[];
  if (!Array.isArray(list) || list.length === 0) {
    res.status(422).json({ error: 'No dishes found in response' });
    return;
  }

  function parseName(v: unknown): { de: string; it: string; en: string } {
    if (typeof v === 'string') return { de: v, it: v, en: v };
    if (v && typeof v === 'object') {
      const m = v as Record<string, string>;
      const de = m['de'] ?? m['it'] ?? m['en'] ?? Object.values(m)[0] ?? '';
      return { de, it: m['it'] ?? de, en: m['en'] ?? de };
    }
    return { de: '', it: '', en: '' };
  }

  // Fallback ordinal: number distinct Mondays 1..N by date order.
  const dateToOrdinalFallback = new Map<string, number>();
  {
    const dates = new Set<string>();
    for (const d of list) if (d['date']) dates.add(String(d['date']));
    const sortedDates = [...dates].sort();
    const mondayToOrdinal = new Map<string, number>();
    for (const iso of sortedDates) {
      const dt = new Date(iso + 'T00:00:00Z');
      const wd = dt.getUTCDay() || 7;
      const mon = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate() - wd + 1));
      const monIso = mon.toISOString().split('T')[0]!;
      if (!mondayToOrdinal.has(monIso)) mondayToOrdinal.set(monIso, mondayToOrdinal.size + 1);
      dateToOrdinalFallback.set(iso, mondayToOrdinal.get(monIso)!);
    }
  }

  const result = await prisma.$transaction(async (tx) => {
    const deleted = await tx.dish.deleteMany({ where: { plan } });
    let imported = 0;
    for (const d of list) {
      const rawId = d['id'];
      const sourceId = rawId ? String(rawId) : null;
      const name = parseName(d['name']);
      const desc = parseName(d['description'] ?? '');
      const dateRaw = d['date'] ? String(d['date']) : null;
      if (!name.de.trim() || !dateRaw) continue;

      await tx.dish.create({
        data: {
          // Fresh UUIDs so a source id can live in BOTH plans simultaneously.
          id: uuidv4(),
          nameDe: name.de.trim(),
          nameIt: name.it.trim(),
          nameEn: name.en.trim(),
          descDe: desc.de,
          descIt: desc.it,
          descEn: desc.en,
          imageUrl: d['imageUrl'] ? String(d['imageUrl']) : '',
          category: d['category'] ? String(d['category']) : '',
          tags: JSON.stringify(Array.isArray(d['tags']) ? d['tags'] : []),
          prepTime: typeof d['prepTime'] === 'number' ? d['prepTime'] : 0,
          calories: typeof d['calories'] === 'number' ? d['calories'] : 0,
          price: typeof d['price'] === 'number' ? d['price'] : 0,
          protein: typeof d['protein'] === 'number' ? d['protein'] : 0,
          fat: typeof d['fat'] === 'number' ? d['fat'] : 0,
          allergens: JSON.stringify(Array.isArray(d['allergens']) ? d['allergens'] : []),
          isVegetarian: d['isVegetarian'] === true,
          isVegan: d['isVegan'] === true,
          date: new Date(dateRaw),
          plan,
          sourceId,
          stableKey: slugifyDishName(name.de.trim()),
          weekOrdinal: weekOrdinalFromSourceId(sourceId) || dateToOrdinalFallback.get(dateRaw) || 0,
        },
      });
      imported++;
    }
    return { deleted: deleted.count, imported };
  });

  invalidateDishesCache();
  res.json({ ...result, plan });
});

// ─── POST /api/admin/dishes/cascade-shift ────────────────────────────────────
// Shifts date of every dish in `plan` with date >= fromWeek by offsetDays.
// Used to cascade a manual week-date change to all following weeks.

router.post('/dishes/cascade-shift', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const plan = parsePlan(req.body?.plan);
  const fromWeekRaw = req.body?.fromWeek ? String(req.body.fromWeek) : '';
  const offsetDays = Number(req.body?.offsetDays);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromWeekRaw)) {
    res.status(400).json({ error: 'fromWeek must be YYYY-MM-DD' });
    return;
  }
  if (!Number.isInteger(offsetDays) || offsetDays === 0) {
    res.status(400).json({ error: 'offsetDays must be a non-zero integer' });
    return;
  }
  if (Math.abs(offsetDays) > 365 * 5) {
    res.status(400).json({ error: 'offsetDays out of range' });
    return;
  }

  const fromDate = new Date(fromWeekRaw + 'T00:00:00Z');

  // Prisma updateMany can't express DATE_ADD, so we shift with one raw UPDATE
  // for atomicity and constant round-trips regardless of row count.
  const shifted = await prisma.$executeRaw`UPDATE dishes SET date = DATE_ADD(date, INTERVAL ${offsetDays} DAY) WHERE plan = ${plan} AND date >= ${fromDate}`;

  invalidateDishesCache();
  res.json({ shifted: Number(shifted) || 0 });
});

// ─── POST /api/admin/dishes/anchor-week ──────────────────────────────────────
// "Make week X land on this Monday AND make the whole plan a clean, consecutive
// weekly sequence".
//
// Semantic:
//   1. NORMALIZE the chosen plan so every week i is at target + (i - anchorIdx) * 7,
//      preserving each dish's weekday. Also fixes irregular gaps in one call.
//   2. ROTATE past weeks to end (season-aware — they snap into their own season
//      so summer weeks never land in Nov–Mar and vice versa).
//   3. HANDOFF (default on): align the OTHER plan's first week to right after
//      this plan's last future week, snapped into the other plan's season. So
//      the two plans together form a seamless rolling schedule.
//
// All in one transaction so the client never sees a torn state.

router.post('/dishes/anchor-week', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const plan = parsePlan(req.body?.plan);
  const chosenRaw = req.body?.chosenWeek ? String(req.body.chosenWeek) : '';
  const targetRaw = req.body?.targetMonday ? String(req.body.targetMonday) : '';
  const alignOther = req.body?.alignOtherPlan !== false; // default true

  if (!/^\d{4}-\d{2}-\d{2}$/.test(chosenRaw) || !/^\d{4}-\d{2}-\d{2}$/.test(targetRaw)) {
    res.status(400).json({ error: 'chosenWeek and targetMonday must be YYYY-MM-DD' });
    return;
  }

  const result = await prisma.$transaction(async (tx) => {
    const normalized = await normalizePlanAroundAnchor(tx, plan, chosenRaw, targetRaw);
    const rotated = await rotatePastWeeks(plan, tx);

    let otherAligned = 0;
    let otherAnchorDate: string | null = null;
    let otherRotated = 0;
    if (alignOther) {
      const lastMon = await lastFutureMondayIso(tx, plan);
      const otherFirst = await firstMondayIso(tx, otherPlan(plan));
      if (lastMon && otherFirst) {
        // First Monday after this plan's end, then snap into the other plan's
        // season (in case this plan ends deep inside its own season).
        const rawStart = isoAddDays(lastMon, 7);
        const snapped = snapForwardToSeason(new Date(rawStart + 'T00:00:00Z'), otherPlan(plan));
        otherAnchorDate = snapped.toISOString().split('T')[0]!;
        otherAligned = await normalizePlanAroundAnchor(tx, otherPlan(plan), otherFirst, otherAnchorDate);
        otherRotated = await rotatePastWeeks(otherPlan(plan), tx);
      }
    }

    return { normalized, rotated, otherAligned, otherAnchorDate, otherRotated };
  });

  invalidateDishesCache();
  res.json(result);
});

// ─── POST /api/admin/dishes/auto-rotate ──────────────────────────────────────
// Delegates to the shared rotate helper. Cheap to call repeatedly.

router.post('/dishes/auto-rotate', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const plan = parsePlan(req.body?.plan);
  const rotated = await rotatePastWeeks(plan);
  if (rotated > 0) invalidateDishesCache();
  res.json({ rotated });
});

// ─── GET /api/admin/dish-ratings ─────────────────────────────────────────────

router.get('/dish-ratings', requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  const [allDishes, rows] = await Promise.all([
    prisma.dish.findMany({ orderBy: { nameDe: 'asc' } }),
    prisma.dishRating.findMany({ orderBy: [{ dishId: 'asc' }, { createdAt: 'asc' }] }),
  ]);

  const uids = [...new Set(rows.map((r) => r.stableUid))];
  const users = uids.length > 0
    ? await prisma.user.findMany({ where: { stableUid: { in: uids } }, select: { stableUid: true, username: true } })
    : [];
  const uidToUsername: Record<string, string> = Object.fromEntries(users.map((u) => [u.stableUid, u.username]));

  // Ratings are keyed by stableKey. A single stableKey can be shared by a
  // Sommer- AND a Winterplan dish → aggregate them as one entry so the admin
  // sees the combined bewertungen.
  const ratingsByKey = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = ratingsByKey.get(row.dishId) ?? [];
    list.push(row);
    ratingsByKey.set(row.dishId, list);
  }

  // Group dishes by their stableKey; pick a canonical display dish (prefer
  // one with an image, then the earliest date).
  const dishesByKey = new Map<string, typeof allDishes>();
  for (const d of allDishes) {
    const k = d.stableKey || slugifyDishName(d.nameDe);
    const list = dishesByKey.get(k) ?? [];
    list.push(d);
    dishesByKey.set(k, list);
  }

  const allKeys = new Set<string>([...dishesByKey.keys(), ...ratingsByKey.keys()]);

  const result = [...allKeys]
    .map((key) => {
      const dishes = dishesByKey.get(key) ?? [];
      const canonical = dishes.slice().sort((a, b) => {
        const ai = a.imageUrl ? 0 : 1;
        const bi = b.imageUrl ? 0 : 1;
        if (ai !== bi) return ai - bi;
        return a.date.getTime() - b.date.getTime();
      })[0];
      const entries = ratingsByKey.get(key) ?? [];
      const avg = entries.length > 0 ? entries.reduce((s, e) => s + e.stars, 0) / entries.length : 0;
      const plans = [...new Set(dishes.map((d) => d.plan))].sort();
      return {
        dishId: key,
        name: canonical?.nameDe ?? key,
        imageUrl: canonical?.imageUrl ?? '',
        avgStars: Math.round(avg * 10) / 10,
        count: entries.length,
        plans, // e.g. ["summer"], ["winter"], or ["summer","winter"] when shared
        ratings: entries.map((e) => ({
          stableUid: e.stableUid,
          username: uidToUsername[e.stableUid] ?? e.username ?? e.stableUid,
          stars: e.stars,
          createdAt: e.createdAt.toISOString(),
          updatedAt: e.updatedAt.toISOString(),
        })),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  res.json(result);
});

// ─── PATCH /api/admin/dish-ratings/:dishId/:stableUid ────────────────────────

router.patch('/dish-ratings/:dishId/:stableUid', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const dishId = String(req.params['dishId']);
  const stableUid = String(req.params['stableUid']);
  const { stars } = req.body as { stars?: number };

  if (!stars || typeof stars !== 'number' || !Number.isInteger(stars) || stars < 1 || stars > 5) {
    res.status(400).json({ error: 'stars must be an integer 1-5' });
    return;
  }

  await prisma.dishRating.update({
    where: { dishId_stableUid: { dishId, stableUid } },
    data: { stars },
  });
  await publishDishRatings(dishId);

  res.status(204).send();
});

// ─── DELETE /api/admin/dish-ratings/:dishId/:stableUid ───────────────────────

router.delete('/dish-ratings/:dishId/:stableUid', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const dishId = String(req.params['dishId']);
  const stableUid = String(req.params['stableUid']);

  await prisma.dishRating.delete({
    where: { dishId_stableUid: { dishId, stableUid } },
  }).catch(() => null);
  await publishDishRatings(dishId);

  res.status(204).send();
});

// ─── GET /api/admin/comments ─────────────────────────────────────────────────
// Returns all reminder comments + dish comments, newest first, paginated

router.get('/comments', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const page = Math.max(1, parseInt(String(req.query['page'] ?? '1'), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query['limit'] ?? '50'), 10)));
  const skip = (page - 1) * limit;
  const type = String(req.query['type'] ?? 'all');
  const search = String(req.query['search'] ?? '').trim().toLowerCase();
  const sortBy = (['createdAt', 'username', 'body'] as const).includes(req.query['sortBy'] as 'createdAt')
    ? (req.query['sortBy'] as 'createdAt' | 'username' | 'body')
    : 'createdAt';
  const sortOrder = req.query['sortOrder'] === 'asc' ? 'asc' : 'desc';

  const where: Record<string, unknown> = search
    ? { OR: [{ body: { contains: search } }, { username: { contains: search } }] }
    : {};

  const orderBy = { [sortBy]: sortOrder };

  const [reminderComments, dishComments, totalReminder, totalDish] = await Promise.all([
    type === 'dish' ? Promise.resolve([]) : prisma.comment.findMany({
      where,
      orderBy,
      skip: type === 'all' ? 0 : skip,
      take: type === 'all' ? undefined : limit,
      include: { reminder: { select: { id: true, title: true, classId: true } } },
    }),
    type === 'reminder' ? Promise.resolve([]) : prisma.dishComment.findMany({
      where,
      orderBy,
      skip: type === 'all' ? 0 : skip,
      take: type === 'all' ? undefined : limit,
    }),
    type === 'dish' ? Promise.resolve(0) : prisma.comment.count({ where }),
    type === 'reminder' ? Promise.resolve(0) : prisma.dishComment.count({ where }),
  ]);

  // Resolve each dishComment's dishId (which is a stableKey after migration) to
  // a human name for the "contextTitle" column. One query, then Map lookup.
  const keys = [...new Set(dishComments.map((c) => c.dishId))];
  const dishesForKeys = keys.length > 0
    ? await prisma.dish.findMany({ where: { stableKey: { in: keys } }, select: { stableKey: true, nameDe: true } })
    : [];
  const keyToName = new Map(dishesForKeys.map((d) => [d.stableKey, d.nameDe]));

  const allComments = [
    ...reminderComments.map((c) => ({
      id: c.id,
      type: 'reminder' as const,
      stableUid: c.stableUid,
      username: c.username,
      body: c.body,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
      contextId: c.reminderId,
      contextTitle: c.reminder?.title ?? c.reminderId,
      classId: c.classId,
    })),
    ...dishComments.map((c) => ({
      id: c.id,
      type: 'dish' as const,
      stableUid: c.stableUid,
      username: c.username,
      body: c.body,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
      contextId: c.dishId,
      contextTitle: keyToName.get(c.dishId) ?? c.dishId,
      classId: null,
    })),
  ].sort((a, b) => {
    const va = a[sortBy] ?? '';
    const vb = b[sortBy] ?? '';
    return sortOrder === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
  });

  const paginated = type === 'all' ? allComments.slice(skip, skip + limit) : allComments;

  res.json({
    comments: paginated,
    total: totalReminder + totalDish,
    page,
    limit,
  });
});

// ─── DELETE /api/admin/comments/reminder/:id ─────────────────────────────────

router.delete('/comments/reminder/:id', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params['id']);
  await prisma.comment.delete({ where: { id } }).catch(() => null);
  res.status(204).send();
});

// ─── DELETE /api/admin/comments/dish/:id ─────────────────────────────────────

router.delete('/comments/dish/:id', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params['id']);
  const deleted = await prisma.dishComment.delete({ where: { id } }).catch(() => null);
  if (deleted) {
    const comments = await prisma.dishComment.findMany({ where: { dishId: deleted.dishId }, orderBy: { createdAt: 'asc' } });
    broadcastDishComments(deleted.dishId, deleted.dishId, comments);
  }
  res.status(204).send();
});

// ─── GET /api/admin/file-logs ─────────────────────────────────────────────────

router.get('/file-logs', requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  const logDir = path.join(process.cwd(), 'logs');
  let files: string[] = [];
  try { files = await fs.readdir(logDir); } catch { files = []; }

  const stats = await Promise.all(
    files
      .filter((f) => f.startsWith('app-') && f.endsWith('.log'))
      .map(async (f) => {
        const stat = await fs.stat(path.join(logDir, f)).catch(() => null);
        return {
          filename: f,
          date: f.replace('app-', '').replace('.log', ''),
          size: stat?.size ?? 0,
        };
      })
  );

  res.json(stats.sort((a, b) => b.date.localeCompare(a.date)));
});

// ─── GET /api/admin/file-logs/:date ──────────────────────────────────────────

router.get('/file-logs/:date', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const dateParam = String(req.params['date']);
  // Path traversal protection
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    res.status(400).json({ error: 'Invalid date format' });
    return;
  }

  const filename = `app-${dateParam}.log`;
  const filePath = path.join(process.cwd(), 'logs', filename);

  const page = Math.max(1, parseInt(String(req.query['page'] ?? '1'), 10));
  const limit = Math.min(500, Math.max(1, parseInt(String(req.query['limit'] ?? '100'), 10)));

  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch {
    res.status(404).json({ error: 'Log file not found' });
    return;
  }

  const lines = content.split('\n').filter(Boolean);
  const entries = lines.map((line) => {
    try { return JSON.parse(line); } catch { return { raw: line }; }
  });

  const total = entries.length;
  const skip = (page - 1) * limit;
  const paginated = entries.slice(skip, skip + limit);

  res.json({ entries: paginated, total, page, limit, date: dateParam });
});

// ─── Subject Images (admin) ───────────────────────────────────────────────────

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_IMG_BYTES = 3 * 1024 * 1024;

function normalizeSubjectKey(s: string): string {
  return s.toLowerCase().trim().slice(0, 200);
}

// GET /api/admin/subject-images/:subject/preview — serve image for admin panel
router.get('/subject-images/:subject/preview', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const subject = normalizeSubjectKey(req.params['subject'] as string);
  const row = await prisma.subjectImage.findUnique({ where: { subject } });
  if (!row) { res.status(404).end(); return; }
  const etag = `"${row.updatedAt.getTime()}"`;
  if (req.headers['if-none-match'] === etag) { res.status(304).end(); return; }
  res.setHeader('ETag', etag);
  res.setHeader('Content-Type', row.mimeType);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.end(row.data);
});

// GET /api/admin/subject-images — list all known subjects with image status
router.get('/subject-images', requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  const [subjects, images] = await Promise.all([
    prisma.knownSubject.findMany({ orderBy: { longName: 'asc' } }),
    prisma.subjectImage.findMany({ select: { subject: true, mimeType: true, updatedAt: true } }),
  ]);
  const imageMap = new Map(images.map(i => [i.subject, i]));
  const result = subjects.map(s => ({
    key:       s.key,
    longName:  s.longName,
    shortName: s.shortName,
    hasImage:  imageMap.has(s.key),
    mimeType:  imageMap.get(s.key)?.mimeType ?? null,
    updatedAt: imageMap.get(s.key)?.updatedAt.toISOString() ?? null,
  }));
  res.json(result);
});

// PUT /api/admin/subject-images/:subject — upload or replace image (with optional server-side crop)
const cropSchema = z.object({
  left:   z.number().int().min(0),
  top:    z.number().int().min(0),
  width:  z.number().int().min(1),
  height: z.number().int().min(1),
}).optional();

const subjectImageUploadSchema = z.object({
  data:     z.string().min(1),
  mimeType: z.string(),
  crop:     cropSchema,
});

router.put('/subject-images/:subject', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const subject = normalizeSubjectKey(req.params['subject'] as string);
  if (!subject) { res.status(400).json({ error: 'Invalid subject' }); return; }

  const body = subjectImageUploadSchema.parse(req.body);
  if (!ALLOWED_MIME.has(body.mimeType)) {
    res.status(422).json({ error: 'Unsupported image type' }); return;
  }
  let buf = Buffer.from(body.data, 'base64');
  if (buf.length > MAX_IMG_BYTES) {
    res.status(413).json({ error: 'Image too large (max 3 MB)' }); return;
  }

  let mimeType = body.mimeType;
  if (body.crop) {
    buf = Buffer.from(await sharp(buf)
      .extract({ left: body.crop.left, top: body.crop.top, width: body.crop.width, height: body.crop.height })
      .webp({ quality: 85 })
      .toBuffer());
    mimeType = 'image/webp';
  } else {
    buf = Buffer.from(await sharp(buf).webp({ quality: 85 }).toBuffer());
    mimeType = 'image/webp';
  }

  await prisma.subjectImage.upsert({
    where:  { subject },
    create: { subject, data: buf, mimeType },
    update: { data: buf, mimeType },
  });
  res.json({ ok: true, subject });
});

// DELETE /api/admin/subject-images/:subject — remove image
router.delete('/subject-images/:subject', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const subject = normalizeSubjectKey(req.params['subject'] as string);
  await prisma.subjectImage.delete({ where: { subject } }).catch(() => null);
  res.status(204).send();
});

// ─── Dish images (admin upload) ───────────────────────────────────────────────
// Builds the public URL a client uses to load a dish image (absolute when
// PUBLIC_BASE_URL is set, otherwise relative). Cache-busted on every upload.
function dishImageUrl(dishId: string): string {
  return `${config.publicBaseUrl}/dishes/${encodeURIComponent(dishId)}/image?v=${Date.now()}`;
}

// PUT /api/admin/dishes/:id/image — upload/replace a dish image (optional crop).
// Stored as WebP in the DB; the dish's imageUrl is pointed at the served route.
router.put('/dishes/:id/image', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params['id']);
  const dish = await prisma.dish.findUnique({ where: { id } });
  if (!dish) { res.status(404).json({ error: 'Dish not found' }); return; }

  const body = subjectImageUploadSchema.parse(req.body);
  if (!ALLOWED_MIME.has(body.mimeType)) {
    res.status(422).json({ error: 'Unsupported image type' }); return;
  }
  let buf = Buffer.from(body.data, 'base64');
  if (buf.length > MAX_IMG_BYTES) {
    res.status(413).json({ error: 'Image too large (max 3 MB)' }); return;
  }

  buf = body.crop
    ? Buffer.from(await sharp(buf)
        .extract({ left: body.crop.left, top: body.crop.top, width: body.crop.width, height: body.crop.height })
        .webp({ quality: 85 }).toBuffer())
    : Buffer.from(await sharp(buf).webp({ quality: 85 }).toBuffer());

  await prisma.dishImage.upsert({
    where: { dishId: id },
    create: { dishId: id, data: buf, mimeType: 'image/webp' },
    update: { data: buf, mimeType: 'image/webp' },
  });
  const imageUrl = dishImageUrl(id);
  await prisma.dish.update({ where: { id }, data: { imageUrl } });
  invalidateDishesCache();

  res.json({ ok: true, imageUrl });
});

// DELETE /api/admin/dishes/:id/image — remove the uploaded image
router.delete('/dishes/:id/image', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params['id']);
  await prisma.dishImage.delete({ where: { dishId: id } }).catch(() => null);
  await prisma.dish.update({ where: { id }, data: { imageUrl: '' } }).catch(() => null);
  invalidateDishesCache();
  res.status(204).send();
});

// ─── GET /api/admin/activity-logs ────────────────────────────────────────────
// Frontend activity logs (page views, downloads, logins, etc.)

router.get('/activity-logs', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const page  = Math.max(1, parseInt(String(req.query['page']  ?? '1'),   10));
  const limit = Math.min(200, Math.max(1, parseInt(String(req.query['limit'] ?? '50'), 10)));
  const skip  = (page - 1) * limit;
  const event    = req.query['event']    ? String(req.query['event'])    : undefined;
  const username = req.query['username'] ? String(req.query['username']) : undefined;
  const from = req.query['from'] ? new Date(String(req.query['from']))                        : undefined;
  const to   = req.query['to']   ? new Date(String(req.query['to']) + 'T23:59:59.999Z')       : undefined;

  const where: Record<string, unknown> = {};
  if (event)    where['event']    = event;
  if (username) where['username'] = { contains: username };
  if (from || to) {
    where['createdAt'] = {
      ...(from && !isNaN(from.getTime()) ? { gte: from } : {}),
      ...(to   && !isNaN(to.getTime())   ? { lte: to   } : {}),
    };
  }

  const [logs, total] = await Promise.all([
    prisma.frontendActivityLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
    prisma.frontendActivityLog.count({ where }),
  ]);

  res.json({ logs, total, page, limit });
});

// ─── GET /api/admin/activity-logs/stats ──────────────────────────────────────

router.get('/activity-logs/stats', requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  type EventRow = { event: string; count: bigint };
  type PageRow  = { page: string; count: bigint };

  const [totalToday, uniqueUsersToday, eventBreakdown, topPages] = await Promise.all([
    prisma.frontendActivityLog.count({ where: { createdAt: { gte: startOfToday } } }),
    prisma.$queryRaw<{ cnt: bigint }[]>`
      SELECT COUNT(DISTINCT username) AS cnt FROM frontend_activity_logs
      WHERE created_at >= ${startOfToday} AND username IS NOT NULL
    `,
    prisma.$queryRaw<EventRow[]>`
      SELECT event, COUNT(*) AS count FROM frontend_activity_logs
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
      GROUP BY event ORDER BY count DESC
    `,
    prisma.$queryRaw<PageRow[]>`
      SELECT page, COUNT(*) AS count FROM frontend_activity_logs
      WHERE page IS NOT NULL AND created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)
      GROUP BY page ORDER BY count DESC LIMIT 10
    `,
  ]);

  res.json({
    totalToday,
    uniqueUsersToday: Number(uniqueUsersToday[0]?.cnt ?? 0),
    eventBreakdown: eventBreakdown.map((r: EventRow) => ({ event: r.event, count: Number(r.count) })),
    topPages: topPages.map((r: PageRow) => ({ page: r.page, count: Number(r.count) })),
  });
});

// GET /api/admin/audit-log — recent admin actions from file logs (last 3 days)
router.get('/audit-log', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const limit = Math.min(200, parseInt(String(req.query['limit'] ?? '100'), 10) || 100);
  const logDir = path.join(process.cwd(), 'logs');
  const entries: unknown[] = [];

  for (let dayOffset = 0; dayOffset < 3; dayOffset++) {
    const d = new Date(Date.now() - dayOffset * 86400000).toISOString().slice(0, 10);
    const filename = `app-${d}.log`;
    if (path.basename(filename) !== filename) continue;
    const filePath = path.join(logDir, filename);
    const content = await fs.readFile(filePath, 'utf8').catch(() => '');
    const lines = content.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object' && 'action' in parsed) entries.push(parsed);
      } catch { /* skip malformed */ }
    }
    if (entries.length >= limit * 2) break;
  }

  entries.reverse();
  res.json({ entries: entries.slice(0, limit), total: entries.length });
});

// ─── GET /api/admin/todos ─────────────────────────────────────────────────────
// All todos across all users, server-side paginated. status=active|done|archived|all

router.get('/todos', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const page    = Math.max(1, parseInt(String(req.query['page']  ?? '1'),  10));
  const limit   = Math.min(200, Math.max(1, parseInt(String(req.query['limit'] ?? '50'), 10)));
  const skip    = (page - 1) * limit;
  const search  = String(req.query['search'] ?? '').trim();
  const status  = String(req.query['status'] ?? 'all');
  const uid     = String(req.query['stableUid'] ?? '').trim();

  const where: Record<string, unknown> = {};
  if (search) where['title'] = { contains: search };
  if (uid) where['stableUid'] = uid;
  if (status === 'active')        { where['done'] = false; where['archivedAt'] = null; }
  else if (status === 'done')     { where['done'] = true;  where['archivedAt'] = null; }
  else if (status === 'archived') { where['archivedAt'] = { not: null }; }
  // 'all' → no filter

  const [todos, total] = await Promise.all([
    prisma.todo.findMany({ where: where as never, orderBy: { createdAt: 'desc' }, skip, take: limit }),
    prisma.todo.count({ where: where as never }),
  ]);

  const uids = [...new Set(todos.map((t) => t.stableUid))];
  const users = uids.length
    ? await prisma.user.findMany({ where: { stableUid: { in: uids } }, select: { stableUid: true, username: true } })
    : [];
  const uidToUsername: Record<string, string> = Object.fromEntries(users.map((u) => [u.stableUid, u.username]));

  res.json({
    todos: todos.map((t) => ({
      id: t.id, stableUid: t.stableUid, username: uidToUsername[t.stableUid] ?? '',
      title: t.title, details: t.details,
      dueAt: t.dueAt ? t.dueAt.toISOString() : null,
      done: t.done,
      doneAt: t.doneAt ? t.doneAt.toISOString() : null,
      archivedAt: t.archivedAt ? t.archivedAt.toISOString() : null,
      createdAt: t.createdAt.toISOString(),
    })),
    total, page, limit,
  });
});

// ─── GET /api/admin/reminders ─────────────────────────────────────────────────
// All reminders across all classes, server-side paginated. status=active|archived|all

router.get('/reminders', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const page    = Math.max(1, parseInt(String(req.query['page']  ?? '1'),  10));
  const limit   = Math.min(200, Math.max(1, parseInt(String(req.query['limit'] ?? '50'), 10)));
  const skip    = (page - 1) * limit;
  const search  = String(req.query['search'] ?? '').trim();
  const status  = String(req.query['status'] ?? 'all');
  const classId = String(req.query['classId'] ?? '').trim();

  const where: Record<string, unknown> = {};
  if (search) where['title'] = { contains: search };
  if (classId) where['classId'] = classId;
  if (status === 'active')        { where['archivedAt'] = null; }
  else if (status === 'archived') { where['archivedAt'] = { not: null }; }

  const [reminders, total] = await Promise.all([
    prisma.reminder.findMany({ where: where as never, orderBy: { remindAt: 'desc' }, skip, take: limit }),
    prisma.reminder.count({ where: where as never }),
  ]);

  const classIds = [...new Set(reminders.map((r) => r.classId))];
  const classes = classIds.length
    ? await prisma.class.findMany({ where: { id: { in: classIds } }, select: { id: true, name: true } })
    : [];
  const classMap: Record<string, string> = Object.fromEntries(classes.map((c) => [c.id, c.name]));

  res.json({
    reminders: reminders.map((r) => ({
      id: r.id, classId: r.classId, className: classMap[r.classId] ?? '',
      title: r.title, body: r.body,
      remindAt: r.remindAt.toISOString(),
      createdBy: r.createdBy, createdByName: r.createdByName, createdByUsername: r.createdByUsername,
      archivedAt: r.archivedAt ? r.archivedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    })),
    total, page, limit,
  });
});

// ─── GET /api/admin/archive/todos ────────────────────────────────────────────
// Archived (expired >24h) todos — server-only, admin-viewable.

router.get('/archive/todos', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const page = Math.max(1, parseInt(String(req.query['page'] ?? '1'), 10));
  const limit = Math.min(200, Math.max(1, parseInt(String(req.query['limit'] ?? '50'), 10)));
  const skip = (page - 1) * limit;

  const [todos, total] = await Promise.all([
    prisma.todo.findMany({
      where: { archivedAt: { not: null } },
      orderBy: { archivedAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.todo.count({ where: { archivedAt: { not: null } } }),
  ]);

  const uids = [...new Set(todos.map((t) => t.stableUid))];
  const users = uids.length
    ? await prisma.user.findMany({ where: { stableUid: { in: uids } }, select: { stableUid: true, username: true } })
    : [];
  const uidToUsername: Record<string, string> = Object.fromEntries(users.map((u) => [u.stableUid, u.username]));

  res.json({
    todos: todos.map((t) => ({
      id: t.id,
      stableUid: t.stableUid,
      username: uidToUsername[t.stableUid] ?? '',
      title: t.title,
      details: t.details,
      dueAt: t.dueAt ? t.dueAt.toISOString() : null,
      done: t.done,
      doneAt: t.doneAt ? t.doneAt.toISOString() : null,
      archivedAt: t.archivedAt ? t.archivedAt.toISOString() : null,
      createdAt: t.createdAt.toISOString(),
    })),
    total, page, limit,
  });
});

// ─── GET /api/admin/archive/reminders ────────────────────────────────────────

router.get('/archive/reminders', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const page = Math.max(1, parseInt(String(req.query['page'] ?? '1'), 10));
  const limit = Math.min(200, Math.max(1, parseInt(String(req.query['limit'] ?? '50'), 10)));
  const skip = (page - 1) * limit;

  const [reminders, total] = await Promise.all([
    prisma.reminder.findMany({
      where: { archivedAt: { not: null } },
      orderBy: { archivedAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.reminder.count({ where: { archivedAt: { not: null } } }),
  ]);

  res.json({
    reminders: reminders.map((r) => ({
      id: r.id,
      classId: r.classId,
      title: r.title,
      body: r.body,
      remindAt: r.remindAt.toISOString(),
      createdBy: r.createdBy,
      createdByName: r.createdByName,
      createdByUsername: r.createdByUsername,
      archivedAt: r.archivedAt ? r.archivedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    })),
    total, page, limit,
  });
});

// ─── GET /api/admin/export ────────────────────────────────────────────────────
// Full database dump as a single JSON document (complete backup).

router.get('/export', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const [
    users, admins, classes, classMembers, todos, reminders, comments,
    dishComments, dishes, dishRatings, refreshTokens, pushSubscriptions,
    knownSubjects, subjectImages, dishImages, apiKeys, requestLogs, frontendActivityLogs,
  ] = await Promise.all([
    prisma.user.findMany(),
    prisma.admin.findMany(),
    prisma.class.findMany(),
    prisma.classMember.findMany(),
    prisma.todo.findMany(),
    prisma.reminder.findMany(),
    prisma.comment.findMany(),
    prisma.dishComment.findMany(),
    prisma.dish.findMany(),
    prisma.dishRating.findMany(),
    prisma.refreshToken.findMany(),
    prisma.pushSubscription.findMany(),
    prisma.knownSubject.findMany(),
    prisma.subjectImage.findMany(),
    prisma.dishImage.findMany(),
    prisma.apiKey.findMany(),
    prisma.requestLog.findMany(),
    prisma.frontendActivityLog.findMany(),
  ]);

  // Binary columns (image blobs) — encode as base64 so they survive JSON.
  const subjectImagesJson = subjectImages.map((s) => ({
    ...s,
    data: Buffer.from(s.data).toString('base64'),
  }));
  const dishImagesJson = dishImages.map((s) => ({
    ...s,
    data: Buffer.from(s.data).toString('base64'),
  }));

  const adminUsername = adminUsernameFromReq(req.headers['authorization']);
  logger.info('Admin action: export database', { action: 'export_db', adminUsername });

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="pokyh-export-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({
    version: 1,
    exportedAt: new Date().toISOString(),
    data: {
      users, admins, classes, classMembers, todos, reminders, comments,
      dishComments, dishes, dishRatings, refreshTokens, pushSubscriptions,
      knownSubjects, subjectImages: subjectImagesJson, dishImages: dishImagesJson,
      apiKeys, requestLogs, frontendActivityLogs,
    },
  });
});

// Helper: resolve the acting admin's username from the Bearer token (audit log).
function adminUsernameFromReq(authHeader: string | undefined): string {
  const jwtRaw = authHeader?.replace('Bearer ', '');
  try { if (jwtRaw) return (jwt.decode(jwtRaw) as Record<string, string>)?.['username'] ?? 'admin'; } catch { /* ignore */ }
  return 'admin';
}

// ─── POST /api/admin/import ───────────────────────────────────────────────────
// Restores a full database dump produced by /export. Wipes existing data and
// re-inserts everything in one transaction (all-or-nothing).

const importSchema = z.object({
  version: z.number(),
  data: z.record(z.array(z.record(z.any()))),
});

router.post('/import', requireAdmin, async (req2: Request, res: Response): Promise<void> => {
  const parsed = importSchema.safeParse(req2.body);
  if (!parsed.success) {
    res.status(422).json({ error: 'Invalid import format' });
    return;
  }
  const d = parsed.data.data as Record<string, Record<string, unknown>[]>;

  // The legacy admin backup predates Pokyh Learn and therefore does not carry
  // its related tables. Deleting users during a legacy restore would cascade
  // and silently erase Learn courses/progress, so refuse the unsafe operation
  // until a complete Learn-aware system backup format is introduced.
  const learnRecords = await Promise.all([
    prisma.learnProfile.count(),
    prisma.learnCourse.count(),
    prisma.learnEnrollment.count(),
    prisma.learnVocabularyEntry.count(),
    prisma.learnQuizAttempt.count(),
    prisma.learnTeam.count(),
  ]);
  if (learnRecords.some((count) => count > 0)) {
    res.status(409).json({
      error: 'Legacy database import is blocked while Pokyh Learn data exists. Use the Learn personal export/import flow or a Learn-aware backup before restoring.',
    });
    return;
  }

  // Revive types JSON can't carry: ISO date strings → Date, base64 → Buffer.
  const reviveDates = (rows: Record<string, unknown>[]): Record<string, unknown>[] =>
    rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) {
        if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v)) {
          const dt = new Date(v);
          out[k] = isNaN(dt.getTime()) ? v : dt;
        } else {
          out[k] = v;
        }
      }
      return out;
    });

  const decodeImageRows = (rows: Record<string, unknown>[] | undefined) =>
    (rows ?? []).map((s) => ({
      ...s,
      data: Buffer.from(String(s['data'] ?? ''), 'base64'),
      createdAt: s['createdAt'] ? new Date(String(s['createdAt'])) : undefined,
      updatedAt: s['updatedAt'] ? new Date(String(s['updatedAt'])) : undefined,
    }));
  const subjectImages = decodeImageRows(d['subjectImages']);
  const dishImages = decodeImageRows(d['dishImages']);

  try {
    await prisma.$transaction(async (tx) => {
      // Delete children first (FK-safe order).
      await tx.comment.deleteMany();
      await tx.classMember.deleteMany();
      await tx.reminder.deleteMany();
      await tx.todo.deleteMany();
      await tx.refreshToken.deleteMany();
      await tx.pushSubscription.deleteMany();
      await tx.dishRating.deleteMany();
      await tx.dishComment.deleteMany();
      await tx.dishImage.deleteMany();
      await tx.dish.deleteMany();
      await tx.knownSubject.deleteMany();
      await tx.subjectImage.deleteMany();
      await tx.apiKey.deleteMany();
      await tx.requestLog.deleteMany();
      await tx.frontendActivityLog.deleteMany();
      await tx.admin.deleteMany();
      await tx.class.deleteMany();
      await tx.user.deleteMany();

      // Insert parents first.
      const ins = async (rows: Record<string, unknown>[] | undefined, fn: (data: Record<string, unknown>[]) => Promise<unknown>) => {
        if (rows && rows.length) await fn(reviveDates(rows));
      };
      await ins(d['users'], (data) => tx.user.createMany({ data: data as never, skipDuplicates: true }));
      await ins(d['classes'], (data) => tx.class.createMany({ data: data as never, skipDuplicates: true }));
      await ins(d['admins'], (data) => tx.admin.createMany({ data: data as never, skipDuplicates: true }));
      await ins(d['classMembers'], (data) => tx.classMember.createMany({ data: data as never, skipDuplicates: true }));
      await ins(d['todos'], (data) => tx.todo.createMany({ data: data as never, skipDuplicates: true }));
      await ins(d['reminders'], (data) => tx.reminder.createMany({ data: data as never, skipDuplicates: true }));
      await ins(d['comments'], (data) => tx.comment.createMany({ data: data as never, skipDuplicates: true }));
      await ins(d['pushSubscriptions'], (data) => tx.pushSubscription.createMany({ data: data as never, skipDuplicates: true }));
      await ins(d['refreshTokens'], (data) => tx.refreshToken.createMany({ data: data as never, skipDuplicates: true }));
      await ins(d['dishes'], (data) => tx.dish.createMany({ data: data as never, skipDuplicates: true }));
      if (dishImages.length) await tx.dishImage.createMany({ data: dishImages as never, skipDuplicates: true });
      await ins(d['dishComments'], (data) => tx.dishComment.createMany({ data: data as never, skipDuplicates: true }));
      await ins(d['dishRatings'], (data) => tx.dishRating.createMany({ data: data as never, skipDuplicates: true }));
      await ins(d['knownSubjects'], (data) => tx.knownSubject.createMany({ data: data as never, skipDuplicates: true }));
      if (subjectImages.length) await tx.subjectImage.createMany({ data: subjectImages as never, skipDuplicates: true });
      await ins(d['apiKeys'], (data) => tx.apiKey.createMany({ data: data as never, skipDuplicates: true }));
      await ins(d['requestLogs'], (data) => tx.requestLog.createMany({ data: data as never, skipDuplicates: true }));
      await ins(d['frontendActivityLogs'], (data) => tx.frontendActivityLog.createMany({ data: data as never, skipDuplicates: true }));
    }, { timeout: 120000, maxWait: 20000 });
  } catch (err) {
    logger.error('Import failed', { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'Import failed — database left unchanged' });
    return;
  }

  // The dish catalog cache may now be stale.
  invalidateDishesCache();

  const adminUsername = adminUsernameFromReq(req2.headers['authorization']);
  logger.info('Admin action: import database', { action: 'import_db', adminUsername });
  res.json({ ok: true });
});

// ─── GET /api/admin/school-years ─────────────────────────────────────────────

import { computeSchoolYear, performRollover, rollbackRollover } from '../services/schoolYearArchiver';

router.get('/school-years', requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  const years = await prisma.schoolYear.findMany({ orderBy: { startYear: 'desc' } });
  const current = computeSchoolYear(new Date());
  res.json({
    current: { label: current.label, startYear: current.startYear },
    archived: years.map((y) => ({
      id: y.id, label: y.label, startYear: y.startYear,
      rolledAt: y.rolledAt.toISOString(), note: y.note, createdAt: y.createdAt.toISOString(),
    })),
  });
});

// ─── GET /api/admin/school-years/:id/users ────────────────────────────────────

router.get('/school-years/:id/users', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const id      = String(req.params['id']);
  const page    = Math.max(1, parseInt(String(req.query['page']  ?? '1'),  10));
  const limit   = Math.min(200, Math.max(1, parseInt(String(req.query['limit'] ?? '50'), 10)));
  const skip    = (page - 1) * limit;
  const search  = String(req.query['search'] ?? '').trim();
  const role    = String(req.query['role']   ?? '').trim();

  const where: Record<string, unknown> = { schoolYearId: id };
  if (search) where['username'] = { contains: search };
  if (role === 'student' || role === 'parent') where['role'] = role;

  const [users, total] = await Promise.all([
    prisma.archivedUser.findMany({ where: where as never, orderBy: { username: 'asc' }, skip, take: limit }),
    prisma.archivedUser.count({ where: where as never }),
  ]);
  res.json({ users, total, page, limit });
});

// ─── GET /api/admin/school-years/:id/classes ──────────────────────────────────

router.get('/school-years/:id/classes', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params['id']);
  const classes = await prisma.archivedClass.findMany({
    where: { schoolYearId: id }, orderBy: { name: 'asc' },
  });
  res.json(classes.map((c) => ({
    id: c.id, originalId: c.originalId, name: c.name, code: c.code,
    webuntisKlasseId: c.webuntisKlasseId, createdBy: c.createdBy,
    createdByName: c.createdByName, memberCount: c.memberCount,
    members: JSON.parse(c.membersJson) as unknown[],
    createdAt: c.createdAt.toISOString(),
  })));
});

// ─── GET /api/admin/school-years/:id/todos ────────────────────────────────────

router.get('/school-years/:id/todos', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const id      = String(req.params['id']);
  const page    = Math.max(1, parseInt(String(req.query['page']  ?? '1'),  10));
  const limit   = Math.min(200, Math.max(1, parseInt(String(req.query['limit'] ?? '50'), 10)));
  const skip    = (page - 1) * limit;
  const search  = String(req.query['search'] ?? '').trim();
  const status  = String(req.query['status'] ?? 'all');

  const where: Record<string, unknown> = { schoolYearId: id };
  if (search) where['title'] = { contains: search };
  if (status === 'active')        { where['done'] = false; where['archivedAt'] = null; }
  else if (status === 'done')     { where['done'] = true;  where['archivedAt'] = null; }
  else if (status === 'archived') { where['archivedAt'] = { not: null }; }

  const [todos, total] = await Promise.all([
    prisma.archivedTodo.findMany({ where: where as never, orderBy: { createdAt: 'desc' }, skip, take: limit }),
    prisma.archivedTodo.count({ where: where as never }),
  ]);
  res.json({
    todos: todos.map((t) => ({
      id: t.id, originalId: t.originalId, stableUid: t.stableUid, username: t.username,
      title: t.title, details: t.details,
      dueAt: t.dueAt ? t.dueAt.toISOString() : null,
      done: t.done,
      doneAt: t.doneAt ? t.doneAt.toISOString() : null,
      archivedAt: t.archivedAt ? t.archivedAt.toISOString() : null,
      createdAt: t.createdAt.toISOString(),
    })),
    total, page, limit,
  });
});

// ─── GET /api/admin/school-years/:id/reminders ────────────────────────────────

router.get('/school-years/:id/reminders', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const id      = String(req.params['id']);
  const page    = Math.max(1, parseInt(String(req.query['page']  ?? '1'),  10));
  const limit   = Math.min(200, Math.max(1, parseInt(String(req.query['limit'] ?? '50'), 10)));
  const skip    = (page - 1) * limit;
  const search  = String(req.query['search'] ?? '').trim();
  const status  = String(req.query['status'] ?? 'all');

  const where: Record<string, unknown> = { schoolYearId: id };
  if (search) where['title'] = { contains: search };
  if (status === 'active')        { where['archivedAt'] = null; }
  else if (status === 'archived') { where['archivedAt'] = { not: null }; }

  const [reminders, total] = await Promise.all([
    prisma.archivedReminder.findMany({ where: where as never, orderBy: { remindAt: 'desc' }, skip, take: limit }),
    prisma.archivedReminder.count({ where: where as never }),
  ]);
  res.json({
    reminders: reminders.map((r) => ({
      id: r.id, originalId: r.originalId, classId: r.classId, className: r.className,
      title: r.title, body: r.body,
      remindAt: r.remindAt.toISOString(),
      createdBy: r.createdBy, createdByName: r.createdByName, createdByUsername: r.createdByUsername,
      archivedAt: r.archivedAt ? r.archivedAt.toISOString() : null,
      comments: JSON.parse(r.commentsJson) as unknown[],
      createdAt: r.createdAt.toISOString(),
    })),
    total, page, limit,
  });
});

// ─── POST /api/admin/school-years/rollover ────────────────────────────────────

router.post('/school-years/rollover', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const note = String(req.body?.['note'] ?? '').slice(0, 500);
  try {
    const result = await performRollover(note || 'Manuell');
    const adminUsername = adminUsernameFromReq(req.headers['authorization']);
    logger.info('Admin action: school year rollover', { action: 'school_year_rollover', adminUsername, result });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(409).json({ error: err instanceof Error ? err.message : 'Rollover fehlgeschlagen' });
  }
});

// ─── POST /api/admin/school-years/:id/rollback ────────────────────────────────
// Undo a rollover: restore the archived year into the live tables and delete the
// archive. Only the most recently archived year may be rolled back.

router.post('/school-years/:id/rollback', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params['id']);
  try {
    const result = await rollbackRollover(id);
    const adminUsername = adminUsernameFromReq(req.headers['authorization']);
    logger.info('Admin action: school year rollback', { action: 'school_year_rollback', adminUsername, result });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(409).json({ error: err instanceof Error ? err.message : 'Rollback fehlgeschlagen' });
  }
});

// ─── GET /api/admin/api-keys ──────────────────────────────────────────────────
// Lists admin-issued API keys (metadata only — the plaintext key is never
// stored or returned again after creation). This is separate from, and
// additive to, the static master API_KEY env var, which is not listed here.

router.get('/api-keys', requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  const keys = await prisma.apiKey.findMany({ orderBy: { createdAt: 'desc' } });
  res.json({
    apiKeys: keys.map((k) => ({
      id: k.id,
      name: k.name,
      purpose: k.purpose,
      platform: k.platform,
      scopes: parseApiKeyScopes(k.scopes),
      createdBy: k.createdBy,
      createdAt: k.createdAt.toISOString(),
      expiresAt: k.expiresAt ? k.expiresAt.toISOString() : null,
      revokedAt: k.revokedAt ? k.revokedAt.toISOString() : null,
      lastUsedAt: k.lastUsedAt ? k.lastUsedAt.toISOString() : null,
    })),
  });
});

// ─── POST /api/admin/api-keys ─────────────────────────────────────────────────
// Generates a new API key. The plaintext value is returned exactly once in
// this response and is never stored or retrievable again — only its SHA-256
// hash is kept, matching how the static master key is compared.

const createApiKeySchema = z.object({
  name: z.string().trim().min(1).max(191),
  purpose: z.string().trim().max(255).optional(),
  platform: z.string().trim().max(80).optional(),
  scopes: z.array(z.enum(['core:read', 'core:write', 'auth:session', 'learn:catalog', 'learn:read', 'learn:write']))
    .min(1)
    .max(issuedApiKeyScopes.length)
    .default(['core:read']),
  expiresAt: z.string().datetime({ offset: true }).optional().refine(
    (value) => !value || new Date(value).getTime() > Date.now(),
    { message: 'expiresAt must be in the future' },
  ),
});

router.post('/api-keys', requireAdmin, writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const parsed = createApiKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ error: parsed.error.errors.map((e) => e.message).join('; ') });
    return;
  }
  const { name, purpose, platform, scopes, expiresAt } = parsed.data;
  const plaintext = `pk_${randomBytes(32).toString('hex')}`;
  const keyHash = createHash('sha256').update(plaintext).digest('hex');
  const adminUsername = adminUsernameFromReq(req.headers['authorization']);

  const record = await prisma.apiKey.create({
    data: {
      keyHash,
      name,
      purpose: purpose ?? '',
      platform: platform ?? '',
      scopes: serializeApiKeyScopes(scopes),
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      createdBy: adminUsername,
    },
  });

  logger.info('Admin action: API key created', {
    action: 'api_key_created', adminUsername, apiKeyId: record.id, name, scopes,
  });

  res.status(201).json({
    id: record.id,
    name: record.name,
    purpose: record.purpose,
    platform: record.platform,
    scopes: parseApiKeyScopes(record.scopes),
    expiresAt: record.expiresAt ? record.expiresAt.toISOString() : null,
    createdAt: record.createdAt.toISOString(),
    key: plaintext,
  });
});

// ─── PATCH /api/admin/api-keys/:id/revoke ─────────────────────────────────────

router.patch('/api-keys/:id/revoke', requireAdmin, writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params['id']);
  const adminUsername = adminUsernameFromReq(req.headers['authorization']);
  try {
    const record = await prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
    logger.info('Admin action: API key revoked', { action: 'api_key_revoked', adminUsername, apiKeyId: record.id, name: record.name });
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: 'API key not found' });
  }
});

// ─── GET /api/admin/learn-config ──────────────────────────────────────────────
// Live Learn configuration (DB-backed, falls back to LEARN_* env defaults —
// see src/services/learnConfig.ts). LEARN_ALLOWED_ORIGINS is a security-
// boundary value and is intentionally never exposed or editable here. The
// WebUntis authorization reference is write-only: only whether one is set is
// reported, never the value itself.

router.get('/learn-config', requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  const cfg = await getLearnConfig();
  res.json({
    legalGateEnabled: cfg.legalGateEnabled,
    legalGateReady: cfg.legalGateReady,
    hasWebUntisAuthorizationReference: Boolean(cfg.webUntisAuthorizationReference),
    privacyNoticeUrl: cfg.privacyNoticeUrl,
    privacyNoticeVersion: cfg.privacyNoticeVersion,
    dictionaryEnabled: cfg.dictionaryEnabled,
    dictionaryProvider: cfg.dictionaryProvider,
    dictionaryBaseUrl: cfg.dictionaryBaseUrl,
    dictionaryContactEmail: cfg.dictionaryContactEmail,
    dictionaryAllowedPairs: cfg.dictionaryAllowedPairs.join(','),
    dictionaryTimeoutMs: cfg.dictionaryTimeoutMs,
    dictionaryCacheTtlMs: cfg.dictionaryCacheTtlMs,
    dictionaryMaxCacheEntries: cfg.dictionaryMaxCacheEntries,
    dictionaryValidationEnabled: cfg.dictionaryValidationEnabled,
    dictionaryValidationProvider: cfg.dictionaryValidationProvider,
    dictionaryValidationBaseUrl: cfg.dictionaryValidationBaseUrl,
    dictionaryValidationTimeoutMs: cfg.dictionaryValidationTimeoutMs,
    dictionaryValidationCacheTtlMs: cfg.dictionaryValidationCacheTtlMs,
    dictionaryValidationMaxCacheEntries: cfg.dictionaryValidationMaxCacheEntries,
    reviewInitialIntervalDays: cfg.reviewInitialIntervalDays,
    reviewMaxIntervalDays: cfg.reviewMaxIntervalDays,
    reviewMinimumEase: cfg.reviewMinimumEase,
    reviewMaximumEase: cfg.reviewMaximumEase,
    reviewCorrectEaseStep: cfg.reviewCorrectEaseStep,
    reviewIncorrectEasePenalty: cfg.reviewIncorrectEasePenalty,
    reviewWrongDelayMinutes: cfg.reviewWrongDelayMinutes,
    analyticsRetentionDays: cfg.analyticsRetentionDays,
    importMaxCourses: cfg.importMaxCourses,
    importMaxSectionsPerCourse: cfg.importMaxSectionsPerCourse,
    importMaxVocabularyPerCourse: cfg.importMaxVocabularyPerCourse,
  });
});

// ─── PATCH /api/admin/learn-config ────────────────────────────────────────────

const learnConfigSchema = z.object({
  legalGateEnabled: z.boolean().optional(),
  webUntisAuthorizationReference: z.string().trim().max(255).optional(),
  privacyNoticeUrl: z.string().trim().max(500).optional(),
  privacyNoticeVersion: z.string().trim().max(80).optional(),
  dictionaryEnabled: z.boolean().optional(),
  dictionaryProvider: z.string().trim().max(40).optional(),
  dictionaryBaseUrl: z.string().trim().max(500).optional(),
  dictionaryContactEmail: z.string().trim().max(255).optional(),
  dictionaryAllowedPairs: z.string().trim().max(500).optional(),
  dictionaryTimeoutMs: z.number().int().positive().optional(),
  dictionaryCacheTtlMs: z.number().int().positive().optional(),
  dictionaryMaxCacheEntries: z.number().int().positive().optional(),
  dictionaryValidationEnabled: z.boolean().optional(),
  dictionaryValidationProvider: z.literal('dictionaryapi').optional(),
  dictionaryValidationBaseUrl: z.string().trim().url().max(500).optional(),
  dictionaryValidationTimeoutMs: z.number().int().positive().optional(),
  dictionaryValidationCacheTtlMs: z.number().int().positive().optional(),
  dictionaryValidationMaxCacheEntries: z.number().int().positive().optional(),
  reviewInitialIntervalDays: z.number().int().min(1).max(30).optional(),
  reviewMaxIntervalDays: z.number().int().min(1).max(3650).optional(),
  reviewMinimumEase: z.number().min(1).max(5).optional(),
  reviewMaximumEase: z.number().min(1).max(5).optional(),
  reviewCorrectEaseStep: z.number().min(0).max(1).optional(),
  reviewIncorrectEasePenalty: z.number().min(0).max(1).optional(),
  reviewWrongDelayMinutes: z.number().int().min(0).max(1440).optional(),
  analyticsRetentionDays: z.number().int().min(30).max(3650).optional(),
  importMaxCourses: z.number().int().positive().optional(),
  importMaxSectionsPerCourse: z.number().int().positive().optional(),
  importMaxVocabularyPerCourse: z.number().int().positive().optional(),
});

router.patch('/learn-config', requireAdmin, writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const parsed = learnConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ error: parsed.error.errors.map((e) => e.message).join('; ') });
    return;
  }
  const current = await getLearnConfig();
  const effectiveMinimumEase = parsed.data.reviewMinimumEase ?? current.reviewMinimumEase;
  const effectiveMaximumEase = parsed.data.reviewMaximumEase ?? current.reviewMaximumEase;
  const effectiveInitialInterval = parsed.data.reviewInitialIntervalDays ?? current.reviewInitialIntervalDays;
  const effectiveMaxInterval = parsed.data.reviewMaxIntervalDays ?? current.reviewMaxIntervalDays;
  if (effectiveMinimumEase > effectiveMaximumEase) {
    res.status(422).json({ error: 'Minimum review ease cannot exceed maximum review ease' });
    return;
  }
  if (effectiveInitialInterval > effectiveMaxInterval) {
    res.status(422).json({ error: 'Initial review interval cannot exceed maximum review interval' });
    return;
  }
  const adminUsername = adminUsernameFromReq(req.headers['authorization']);
  await updateLearnConfig(parsed.data, adminUsername);
  logger.info('Admin action: Learn config updated', { action: 'learn_config_updated', adminUsername, fields: Object.keys(parsed.data) });
  res.json({ ok: true });
});

// ─── Learn AI assistant ("KIbo") administration ────────────────────────────
// Same DB-backed-with-env-fallback pattern as /learn-config above, kept as a
// sibling singleton (LearnAiConfig) rather than merged into LearnConfig's
// already-large row. Access is separate from this config: it always
// additionally requires a LearnAiAccessGrant (personal) or
// LearnAiTeamAccessGrant (team) — this config's `enabled` flag is only the
// platform-wide kill-switch, never a substitute for a grant.

router.get('/learn-ai/config', requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  const cfg = await getLearnAiConfig();
  res.json(cfg);
});

const learnAiConfigSchema = z.object({
  enabled: z.boolean().optional(),
  modelName: z.string().trim().min(1).max(120).optional(),
  contextTokens: z.number().int().min(512).max(32_768).optional(),
  numPredictFast: z.number().int().min(32).max(4_096).optional(),
  rateLimitMessagesPerHour: z.number().int().min(1).max(1_000).optional(),
  ollamaBaseUrl: z.string().trim().min(1).max(300).optional(),
  ollamaTimeoutMs: z.number().int().positive().optional(),
  personalizedContextEnabled: z.boolean().optional(),
  uploadsEnabled: z.boolean().optional(),
  uploadMaxBytes: z.number().int().min(1024).max(20 * 1024 * 1024).optional(),
});

router.patch('/learn-ai/config', requireAdmin, writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const parsed = learnAiConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ error: parsed.error.errors.map((e) => e.message).join('; ') });
    return;
  }
  const adminUsername = adminUsernameFromReq(req.headers['authorization']);
  await updateLearnAiConfig(parsed.data, adminUsername);
  logger.info('Admin action: Learn AI config updated', { action: 'learn_ai_config_updated', adminUsername, fields: Object.keys(parsed.data) });
  // Re-check readiness whenever the config changes (fire-and-forget, same as
  // boot): ensureModelReady() reads the model name fresh and is a cheap
  // no-op if it's already present, so this never re-downloads anything that
  // is already pulled — it only matters the one time an admin actually
  // switches to a model that isn't local yet.
  void ensureModelReady();
  res.json({ ok: true });
});

router.get('/learn-ai/grants', requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  const grants = await listAiAccessGrants();
  res.json({ grants });
});

const learnAiGrantSchema = z.object({
  username: z.string().trim().min(1).max(100),
  note: z.string().trim().max(500).optional(),
});

router.post('/learn-ai/grants', requireAdmin, writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const body = learnAiGrantSchema.parse(req.body);
  const user = await prisma.user.findUnique({ where: { username: body.username }, select: { stableUid: true } });
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  const adminUsername = adminUsernameFromReq(req.headers['authorization']);
  await grantAiAccess(user.stableUid, adminUsername, body.note ?? '');
  logger.info('Admin action: Learn AI access granted', { action: 'learn_ai_access_granted', adminUsername, targetUsername: body.username });
  res.json({ ok: true });
});

router.delete('/learn-ai/grants/:stableUid', requireAdmin, writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const stableUid = String(req.params['stableUid']);
  const adminUsername = adminUsernameFromReq(req.headers['authorization']);
  await revokeAiAccess(stableUid, adminUsername);
  logger.info('Admin action: Learn AI access revoked', { action: 'learn_ai_access_revoked', adminUsername, targetStableUid: stableUid });
  res.json({ ok: true });
});

router.get('/learn-ai/team-grants', requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  const grants = await listAiTeamAccessGrants();
  res.json({ grants });
});

const learnAiTeamGrantSchema = z.object({
  teamId: z.string().trim().min(1),
  note: z.string().trim().max(500).optional(),
});

router.post('/learn-ai/team-grants', requireAdmin, writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const body = learnAiTeamGrantSchema.parse(req.body);
  const team = await prisma.learnTeam.findUnique({ where: { id: body.teamId }, select: { id: true, name: true } });
  if (!team) {
    res.status(404).json({ error: 'Team not found' });
    return;
  }
  const adminUsername = adminUsernameFromReq(req.headers['authorization']);
  await grantAiAccessToTeam(team.id, adminUsername, body.note ?? '');
  logger.info('Admin action: Learn AI team access granted', { action: 'learn_ai_team_access_granted', adminUsername, teamId: team.id });
  res.json({ ok: true });
});

router.delete('/learn-ai/team-grants/:teamId', requireAdmin, writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const teamId = String(req.params['teamId']);
  const adminUsername = adminUsernameFromReq(req.headers['authorization']);
  await revokeAiAccessFromTeam(teamId, adminUsername);
  logger.info('Admin action: Learn AI team access revoked', { action: 'learn_ai_team_access_revoked', adminUsername, teamId });
  res.json({ ok: true });
});

// ─── Learn group administration ────────────────────────────────────────────
// This lives in the existing api.pokyh.com/admin authority rather than in a
// learner-owned route. Members can use an assigned group for course access,
// but only a canonical Pokyh administrator can create groups, change members,
// attach team courses or remove groups.

async function learnAdminActor(req: Request): Promise<{ stableUid: string; username: string }> {
  const username = adminUsernameFromReq(req.headers['authorization']);
  const user = await prisma.user.findUnique({
    where: { username },
    select: { stableUid: true, username: true },
  });
  if (!user) throw new ForbiddenError('The signed-in administrator is not a canonical POKYH user');
  return user;
}

// ─── Learn course and direct-access administration ─────────────────────────
// These routes intentionally live under /api/admin/learn rather than reusing
// the learner JWT router. The existing admin token is the only browser
// credential accepted here, and every mutation is re-authorised server-side.
// Metadata and direct grants are enough to operate the service; authored
// lesson/vocabulary content and learner answers are never returned.

const adminLearnCourseStatusSchema = z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']);
const adminLearnCourseVisibilitySchema = z.enum(['PRIVATE', 'TEAM', 'PUBLIC']);
const adminLearnCoursePermissionSchema = z.enum(['VIEW', 'EDIT', 'MANAGE']);

const adminLearnCourseListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  q: z.string().trim().min(1).max(120).optional(),
  status: adminLearnCourseStatusSchema.optional(),
  visibility: adminLearnCourseVisibilitySchema.optional(),
  // Lets the admin Teams page fetch one team's own courses instead of the
  // whole catalogue — the UI otherwise gets confusing once many teams exist.
  teamId: z.string().uuid().optional(),
});

const adminLearnCourseAccessQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const adminLearnCourseLifecycleSchema = z.object({
  status: adminLearnCourseStatusSchema,
});

const adminLearnCourseAccessSchema = z.object({
  // Administrators can use an existing POKYH username or canonical stable UID;
  // the server resolves it before any durable record is written.
  userId: z.string().trim().min(1).max(100),
  permission: adminLearnCoursePermissionSchema,
});

const adminLearnCourseDeleteSchema = z.object({
  confirmation: z.string().trim().min(1).max(191),
});

const adminLearnVocabularyQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  q: z.string().trim().min(1).max(120).optional(),
});

// Deliberately not .strict() at the entry level: a personal-export course's
// vocabulary items (which also carry sourceRef/sectionRef/review fields, see
// GET /learn/library/export in routes/learn.ts) parse here too — the extra
// fields are simply dropped — so a list exported by that unrelated feature
// is still a usable import source for this one. targetText is allowed to be
// empty: this feature's own GET .../vocabulary/export faithfully dumps every
// row, including a learner-authored word that was FLAGGED and never got a
// translation, so rejecting an empty targetText here would make re-importing
// an unmodified real-world export fail outright. mergeVocabularyEntries()
// skips any such row (outcome `skipped_missing_translation`) instead of ever
// persisting a blank translation — the "always carry a complete translation"
// requirement is enforced at merge time, per row, not by failing the whole
// file at the schema boundary.
const adminLearnVocabularyImportEntrySchema = z.object({
  sourceLanguage: z.string().trim().min(1).max(20),
  targetLanguage: z.string().trim().min(1).max(20),
  sourceText: z.string().trim().min(1).max(500),
  targetText: z.string().trim().max(500),
  article: z.string().trim().max(40).default(''),
  partOfSpeech: z.string().trim().max(80).default(''),
  notes: z.string().trim().max(2000).default(''),
  tags: z.array(z.string().trim().min(1).max(80)).max(25).default([]),
});

// Deliberately not .strict() at the envelope level either: this feature's own
// GET .../vocabulary/export response includes exportedAt/course metadata
// fields alongside kind/version/vocabulary, and re-importing exactly what was
// just exported (unmodified, or lightly edited) must work — the kind/version
// literals already reject an unrelated file format (e.g. the personal-export
// envelope, which carries a different kind) without needing .strict() here.
function buildAdminVocabularyImportSchema(maxEntries: number) {
  return z.object({
    kind: z.literal('pokyh-learn-vocabulary-list-export'),
    version: z.literal(1),
    vocabulary: z.array(adminLearnVocabularyImportEntrySchema).min(1).max(Math.max(1, maxEntries)),
  });
}

const adminLearnVocabularyEntrySelect = {
  id: true,
  sourceLanguage: true,
  targetLanguage: true,
  sourceText: true,
  targetText: true,
  normalizedSource: true,
  normalizedTarget: true,
  article: true,
  partOfSpeech: true,
  notes: true,
  tagsJson: true,
  verificationStatus: true,
  verificationSource: true,
  createdAt: true,
  updatedAt: true,
  creator: { select: { username: true } },
};

function adminLearnVocabularyEntryRow(entry: {
  id: string;
  sourceLanguage: string;
  targetLanguage: string;
  sourceText: string;
  targetText: string;
  article: string;
  partOfSpeech: string;
  notes: string;
  tagsJson: string;
  verificationStatus: string;
  verificationSource: string;
  createdAt: Date;
  updatedAt: Date;
  creator: { username: string };
}) {
  return {
    id: entry.id,
    sourceLanguage: entry.sourceLanguage,
    targetLanguage: entry.targetLanguage,
    sourceText: entry.sourceText,
    targetText: entry.targetText,
    article: entry.article,
    partOfSpeech: entry.partOfSpeech,
    notes: entry.notes,
    tags: parseTags(entry.tagsJson),
    verificationStatus: entry.verificationStatus,
    verificationSource: entry.verificationSource,
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
    creator: { username: entry.creator.username },
  };
}

const adminLearnCourseMetadataSelect = {
  id: true,
  slug: true,
  title: true,
  summary: true,
  subject: true,
  language: true,
  level: true,
  visibility: true,
  status: true,
  coverImageUrl: true,
  createdBy: true,
  ownerLocked: true,
  createdAt: true,
  updatedAt: true,
  creator: { select: { username: true } },
  team: { select: { id: true, name: true } },
  _count: { select: { sections: true, vocabulary: true, enrollments: true, accessGrants: true } },
};

function learnCourseAdminRow(course: {
  id: string;
  slug: string;
  title: string;
  summary: string;
  subject: string;
  language: string;
  level: string;
  visibility: string;
  status: string;
  coverImageUrl: string;
  ownerLocked: boolean;
  createdAt: Date;
  updatedAt: Date;
  creator: { username: string };
  team: { id: string; name: string } | null;
  _count: { sections: number; vocabulary: number; enrollments: number; accessGrants: number };
}) {
  return {
    id: course.id,
    slug: course.slug,
    title: course.title,
    summary: course.summary,
    subject: course.subject,
    language: course.language,
    level: course.level,
    visibility: course.visibility,
    status: course.status,
    coverImageUrl: course.coverImageUrl,
    ownerLocked: course.ownerLocked,
    createdAt: course.createdAt.toISOString(),
    updatedAt: course.updatedAt.toISOString(),
    creator: { username: course.creator.username },
    team: course.team,
    counts: {
      sections: course._count.sections,
      vocabulary: course._count.vocabulary,
      enrollments: course._count.enrollments,
      directAccess: course._count.accessGrants,
    },
  };
}

router.get('/learn/courses', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const query = adminLearnCourseListQuerySchema.parse(req.query);
  const where = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.visibility ? { visibility: query.visibility } : {}),
    ...(query.teamId ? { teamId: query.teamId } : {}),
    ...(query.q ? {
      OR: [
        { title: { contains: query.q } },
        { slug: { contains: query.q } },
        { subject: { contains: query.q } },
        { language: { contains: query.q } },
      ],
    } : {}),
  };
  const [total, courses] = await Promise.all([
    prisma.learnCourse.count({ where }),
    prisma.learnCourse.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      select: adminLearnCourseMetadataSelect,
    }),
  ]);
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({
    courses: courses.map(learnCourseAdminRow),
    total,
    page: query.page,
    limit: query.limit,
  });
});

router.get('/learn/courses/:courseId/access', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const courseId = z.string().uuid().parse(req.params['courseId']);
  const query = adminLearnCourseAccessQuerySchema.parse(req.query);
  const course = await prisma.learnCourse.findUnique({
    where: { id: courseId },
    select: adminLearnCourseMetadataSelect,
  });
  if (!course) throw new NotFoundError('Learn course not found');

  const [total, access] = await Promise.all([
    prisma.learnCourseAccess.count({ where: { courseId } }),
    prisma.learnCourseAccess.findMany({
      where: { courseId },
      orderBy: { updatedAt: 'desc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      select: {
        stableUid: true,
        permission: true,
        createdAt: true,
        updatedAt: true,
        user: { select: { username: true, isUntisUser: true } },
      },
    }),
  ]);
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({
    course: learnCourseAdminRow(course),
    access: {
      items: access.map((grant) => ({
        stableUid: grant.stableUid,
        permission: grant.permission,
        createdAt: grant.createdAt.toISOString(),
        updatedAt: grant.updatedAt.toISOString(),
        user: grant.user,
      })),
      total,
      page: query.page,
      limit: query.limit,
    },
  });
});

router.patch('/learn/courses/:courseId/lifecycle', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const courseId = z.string().uuid().parse(req.params['courseId']);
  const body = adminLearnCourseLifecycleSchema.parse(req.body);
  const actor = await learnAdminActor(req);
  try {
    const course = await prisma.learnCourse.update({
      where: { id: courseId },
      data: { status: body.status },
      select: adminLearnCourseMetadataSelect,
    });
    logger.info('Admin action: Learn course lifecycle updated', {
      action: 'learn_course_lifecycle_updated', adminUsername: actor.username, courseId, status: body.status,
    });
    res.json({ course: learnCourseAdminRow(course) });
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as { code?: string }).code === 'P2025') {
      throw new NotFoundError('Learn course not found');
    }
    throw error;
  }
});

router.post('/learn/courses/:courseId/access', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const courseId = z.string().uuid().parse(req.params['courseId']);
  const body = adminLearnCourseAccessSchema.parse(req.body);
  const actor = await learnAdminActor(req);
  const [course, user] = await Promise.all([
    prisma.learnCourse.findUnique({ where: { id: courseId }, select: { id: true, createdBy: true } }),
    prisma.user.findFirst({
      where: { OR: [{ stableUid: body.userId }, { username: body.userId }] },
      select: { stableUid: true, username: true, isUntisUser: true },
    }),
  ]);
  if (!course) throw new NotFoundError('Learn course not found');
  if (!user) throw new NotFoundError('POKYH user not found');
  if (!user.isUntisUser) throw new ValidationError('Only verified WebUntis users can receive Learn access');
  if (user.stableUid === course.createdBy) throw new ValidationError('The course owner already has management access');

  const [, grant] = await prisma.$transaction([
    prisma.learnProfile.upsert({
      where: { stableUid: user.stableUid },
      create: { stableUid: user.stableUid },
      update: {},
    }),
    prisma.learnCourseAccess.upsert({
      where: { courseId_stableUid: { courseId, stableUid: user.stableUid } },
      create: { courseId, stableUid: user.stableUid, permission: body.permission, grantedBy: actor.stableUid },
      update: { permission: body.permission, grantedBy: actor.stableUid },
    }),
  ]);
  logger.info('Admin action: Learn course access saved', {
    action: 'learn_course_access_saved', adminUsername: actor.username, courseId, targetStableUid: user.stableUid, permission: body.permission,
  });
  res.status(201).json({
    access: {
      stableUid: grant.stableUid,
      permission: grant.permission,
      createdAt: grant.createdAt.toISOString(),
      updatedAt: grant.updatedAt.toISOString(),
      user: { username: user.username, isUntisUser: user.isUntisUser },
    },
  });
});

router.delete('/learn/courses/:courseId/access/:stableUid', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const courseId = z.string().uuid().parse(req.params['courseId']);
  const stableUid = z.string().trim().min(1).max(100).parse(req.params['stableUid']);
  const actor = await learnAdminActor(req);
  const deleted = await prisma.learnCourseAccess.deleteMany({ where: { courseId, stableUid } });
  if (deleted.count === 0) throw new NotFoundError('Learn course access grant not found');
  logger.info('Admin action: Learn course access revoked', {
    action: 'learn_course_access_revoked', adminUsername: actor.username, courseId, targetStableUid: stableUid,
  });
  res.status(204).send();
});

// ─── Learn vocabulary list administration ───────────────────────────────────
// A "vocabulary list" is a LearnCourse's vocabulary entries — there is no
// separate list model. Unlike the learner-facing GET /learn/vocabulary
// (routes/learn.ts), these views intentionally include targetText: this is
// the admin's own authoritative view of curated content, not a quiz surface
// a learner could read answers from.

router.get('/learn/courses/:courseId/vocabulary', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const courseId = z.string().uuid().parse(req.params['courseId']);
  const query = adminLearnVocabularyQuerySchema.parse(req.query);
  const course = await prisma.learnCourse.findUnique({ where: { id: courseId }, select: adminLearnCourseMetadataSelect });
  if (!course) throw new NotFoundError('Learn course not found');

  const where = {
    courseId,
    ...(query.q ? {
      OR: [
        { sourceText: { contains: query.q } },
        { targetText: { contains: query.q } },
      ],
    } : {}),
  };
  const [total, entries] = await Promise.all([
    prisma.learnVocabularyEntry.count({ where }),
    prisma.learnVocabularyEntry.findMany({
      where,
      orderBy: [{ sourceText: 'asc' }, { createdAt: 'asc' }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      select: adminLearnVocabularyEntrySelect,
    }),
  ]);
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({
    course: learnCourseAdminRow(course),
    vocabulary: {
      items: entries.map(adminLearnVocabularyEntryRow),
      total,
      page: query.page,
      limit: query.limit,
    },
  });
});

router.get('/learn/courses/:courseId/vocabulary/export', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const courseId = z.string().uuid().parse(req.params['courseId']);
  const actor = await learnAdminActor(req);
  const course = await prisma.learnCourse.findUnique({
    where: { id: courseId },
    select: { id: true, slug: true, title: true, language: true },
  });
  if (!course) throw new NotFoundError('Learn course not found');

  const entries = await prisma.learnVocabularyEntry.findMany({
    where: { courseId },
    orderBy: [{ sourceText: 'asc' }, { createdAt: 'asc' }],
    select: adminLearnVocabularyEntrySelect,
  });

  logger.info('Admin action: Learn vocabulary list exported', {
    action: 'learn_vocabulary_list_exported', adminUsername: actor.username, courseId, count: entries.length,
  });

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="pokyh-learn-vocab-${course.slug}-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({
    kind: 'pokyh-learn-vocabulary-list-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    course: { id: course.id, slug: course.slug, title: course.title, language: course.language },
    vocabulary: entries.map((entry) => ({
      sourceLanguage: entry.sourceLanguage,
      targetLanguage: entry.targetLanguage,
      sourceText: entry.sourceText,
      targetText: entry.targetText,
      article: entry.article,
      partOfSpeech: entry.partOfSpeech,
      notes: entry.notes,
      tags: parseTags(entry.tagsJson),
      verificationStatus: entry.verificationStatus,
      verificationSource: entry.verificationSource,
    })),
  });
});

router.post('/learn/courses/:courseId/vocabulary/import', requireAdmin, writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const courseId = z.string().uuid().parse(req.params['courseId']);
  const actor = await learnAdminActor(req);
  const course = await prisma.learnCourse.findUnique({
    where: { id: courseId },
    select: { id: true, _count: { select: { vocabulary: true } } },
  });
  if (!course) throw new NotFoundError('Learn course not found');

  const learnCfg = await getLearnConfig();
  const importSchema = buildAdminVocabularyImportSchema(learnCfg.importMaxVocabularyPerCourse);
  const body = importSchema.parse(req.body);

  const existing = await prisma.learnVocabularyEntry.findMany({
    where: { courseId },
    select: { sourceText: true, targetText: true, normalizedSource: true, normalizedTarget: true },
  });

  const merge = await mergeVocabularyEntries({
    existing,
    incoming: body.vocabulary,
    createdBy: actor.stableUid,
    dictionaryLookup: learnCfg.dictionaryEnabled
      ? async ({ sourceText, sourceLanguage, targetLanguage }) => {
        const suggestion = await getDictionarySuggestion({ sourceText, sourceLanguage, targetLanguage });
        return { translation: suggestion.translation };
      }
      : undefined,
  });

  if (course._count.vocabulary + merge.toCreate.length > learnCfg.importMaxVocabularyPerCourse) {
    throw new ValidationError(
      `This import would exceed the configured limit of ${learnCfg.importMaxVocabularyPerCourse} vocabulary entries for one list`,
    );
  }

  if (merge.toCreate.length > 0) {
    await prisma.$transaction(
      merge.toCreate.map((row) => prisma.learnVocabularyEntry.create({
        data: { ...row, courseId, sectionId: null },
      })),
    );
  }

  const updatedCourse = await prisma.learnCourse.findUnique({ where: { id: courseId }, select: adminLearnCourseMetadataSelect });

  logger.info('Admin action: Learn vocabulary list imported', {
    action: 'learn_vocabulary_list_imported', adminUsername: actor.username, courseId, ...merge.summary,
  });

  res.status(201).json({
    course: updatedCourse ? learnCourseAdminRow(updatedCourse) : null,
    summary: merge.summary,
    results: merge.results,
  });
});

router.delete('/learn/courses/:courseId', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const courseId = z.string().uuid().parse(req.params['courseId']);
  const body = adminLearnCourseDeleteSchema.parse(req.body);
  const actor = await learnAdminActor(req);
  const course = await prisma.learnCourse.findUnique({
    where: { id: courseId },
    select: { id: true, slug: true },
  });
  if (!course) throw new NotFoundError('Learn course not found');
  if (body.confirmation !== course.slug) {
    throw new ValidationError('Type the exact course slug to confirm permanent deletion');
  }
  await prisma.learnCourse.delete({ where: { id: courseId } });
  logger.info('Admin action: Learn course deleted', {
    action: 'learn_course_deleted', adminUsername: actor.username, courseId,
  });
  res.status(204).send();
});

const adminLearnTeamCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional().default(''),
});

const adminLearnTeamUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(1000).optional(),
}).refine((body) => Object.keys(body).length > 0, { message: 'At least one team field is required' });

const adminLearnTeamMemberSchema = z.object({
  userId: z.string().trim().min(1).max(100),
  role: z.enum(['MANAGER', 'MEMBER']).default('MEMBER'),
});

const adminLearnTeamDeleteSchema = z.object({
  confirmName: z.string().trim().min(1).max(120),
});

const adminLearnTeamOwnerSchema = z.object({
  stableUid: z.string().trim().min(1).max(100),
});

function learnTeamAdminRow(team: {
  id: string;
  name: string;
  description: string;
  createdAt: Date;
  updatedAt: Date;
  creator: { username: string } | null;
  members: Array<{ stableUid: string; role: string; joinedAt: Date; user: { username: string; isUntisUser: boolean } | null }>;
  _count: { members: number; courses: number };
}) {
  return {
    id: team.id,
    name: team.name,
    description: team.description,
    createdAt: team.createdAt.toISOString(),
    updatedAt: team.updatedAt.toISOString(),
    creator: team.creator,
    memberCount: team._count.members,
    courseCount: team._count.courses,
    members: team.members.map((member) => ({
      stableUid: member.stableUid,
      role: member.role,
      joinedAt: member.joinedAt.toISOString(),
      user: member.user,
    })),
  };
}

const learnTeamAdminInclude = {
  creator: { select: { username: true } },
  members: {
    orderBy: { joinedAt: 'asc' as const },
    select: {
      stableUid: true,
      role: true,
      joinedAt: true,
      user: { select: { username: true, isUntisUser: true } },
    },
  },
  _count: { select: { members: true, courses: true } },
};

router.get('/learn/teams', requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  const teams = await prisma.learnTeam.findMany({
    orderBy: { updatedAt: 'desc' },
    include: learnTeamAdminInclude,
  });
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ teams: teams.map(learnTeamAdminRow) });
});

router.post('/learn/teams', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const body = adminLearnTeamCreateSchema.parse(req.body);
  const actor = await learnAdminActor(req);
  const team = await prisma.$transaction(async (tx) => {
    const created = await tx.learnTeam.create({
      data: {
        name: body.name,
        description: body.description,
        createdBy: actor.stableUid,
        members: { create: { stableUid: actor.stableUid, role: 'OWNER' } },
      },
      include: learnTeamAdminInclude,
    });
    await seedStarterVocabCourses(tx, created.id, created.name, actor.stableUid);
    await ensureAllTeamMembersVocabAccess(tx, created.id);
    return created;
  });
  logger.info('Admin action: Learn team created', { action: 'learn_team_created', adminUsername: actor.username, teamId: team.id });
  res.status(201).json({ team: learnTeamAdminRow(team) });
});

// Retrofits the starter vocabulary courses (and access to them for every
// current member) onto a team created before this existed. Idempotent —
// safe to call repeatedly.
router.post('/learn/teams/:teamId/seed-vocab-courses', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const teamId = z.string().uuid().parse(req.params['teamId']);
  const actor = await learnAdminActor(req);
  const team = await prisma.learnTeam.findUnique({ where: { id: teamId }, select: { id: true, name: true } });
  if (!team) throw new NotFoundError('Learn team not found');
  const created = await seedStarterVocabCourses(prisma, team.id, team.name, actor.stableUid);
  await ensureAllTeamMembersVocabAccess(prisma, team.id);
  logger.info('Admin action: Learn team starter vocab courses seeded', {
    action: 'learn_team_vocab_courses_seeded', adminUsername: actor.username, teamId, created,
  });
  res.json({ created });
});

router.patch('/learn/teams/:teamId', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const teamId = z.string().uuid().parse(req.params['teamId']);
  const body = adminLearnTeamUpdateSchema.parse(req.body);
  const actor = await learnAdminActor(req);
  try {
    const team = await prisma.learnTeam.update({
      where: { id: teamId },
      data: body,
      include: learnTeamAdminInclude,
    });
    logger.info('Admin action: Learn team updated', { action: 'learn_team_updated', adminUsername: actor.username, teamId });
    res.json({ team: learnTeamAdminRow(team) });
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as { code?: string }).code === 'P2025') throw new NotFoundError('Learn team not found');
    throw error;
  }
});

router.post('/learn/teams/:teamId/members', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const teamId = z.string().uuid().parse(req.params['teamId']);
  const body = adminLearnTeamMemberSchema.parse(req.body);
  const actor = await learnAdminActor(req);
  const [team, user] = await Promise.all([
    prisma.learnTeam.findUnique({ where: { id: teamId }, select: { id: true } }),
    prisma.user.findFirst({
      where: { OR: [{ stableUid: body.userId }, { username: body.userId }] },
      select: { stableUid: true, username: true, isUntisUser: true },
    }),
  ]);
  if (!team) throw new NotFoundError('Learn team not found');
  if (!user) throw new NotFoundError('POKYH user not found');
  if (!user.isUntisUser) throw new ValidationError('Only verified WebUntis users can join a Learn team');
  const member = await prisma.learnTeamMember.upsert({
    where: { teamId_stableUid: { teamId, stableUid: user.stableUid } },
    create: { teamId, stableUid: user.stableUid, role: body.role },
    update: { role: body.role },
  });
  await prisma.learnProfile.upsert({
    where: { stableUid: user.stableUid },
    create: { stableUid: user.stableUid },
    update: {},
  });
  await ensureTeamMemberVocabAccess(prisma, teamId, user.stableUid);
  logger.info('Admin action: Learn team member saved', {
    action: 'learn_team_member_saved', adminUsername: actor.username, teamId, targetStableUid: user.stableUid, role: body.role,
  });
  res.json({ member: { ...member, username: user.username } });
});

router.delete('/learn/teams/:teamId/members/:stableUid', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const teamId = z.string().uuid().parse(req.params['teamId']);
  const stableUid = z.string().trim().min(1).max(100).parse(req.params['stableUid']);
  const actor = await learnAdminActor(req);
  const member = await prisma.learnTeamMember.findUnique({
    where: { teamId_stableUid: { teamId, stableUid } },
    select: { role: true },
  });
  if (!member) throw new NotFoundError('Learn team member not found');
  if (member.role === 'OWNER') {
    const ownerCount = await prisma.learnTeamMember.count({ where: { teamId, role: 'OWNER' } });
    if (ownerCount <= 1) throw new ConflictError('Assign another team owner before removing the last owner');
  }
  await prisma.learnTeamMember.delete({ where: { teamId_stableUid: { teamId, stableUid } } });
  logger.info('Admin action: Learn team member removed', {
    action: 'learn_team_member_removed', adminUsername: actor.username, teamId, targetStableUid: stableUid,
  });
  res.status(204).send();
});

// Makes an existing team member an additional owner, alongside every other
// current owner — this repo's own ownerCount<=1 guard on member removal
// (above) already anticipated multiple simultaneous owners as a valid
// state, so promoting one never demotes another. There was previously no
// way to assign OWNER at all after team creation — the member-role
// endpoints above deliberately only accept MANAGER/MEMBER, and the admin
// UI never offered OWNER as a role choice, so this is a dedicated, explicit
// action rather than folding OWNER into the generic role dropdown (which
// could otherwise make an accidental ownership grant as easy as any other
// role edit).
router.post('/learn/teams/:teamId/owner', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const teamId = z.string().uuid().parse(req.params['teamId']);
  const body = adminLearnTeamOwnerSchema.parse(req.body);
  const actor = await learnAdminActor(req);
  const target = await prisma.learnTeamMember.findUnique({
    where: { teamId_stableUid: { teamId, stableUid: body.stableUid } },
    select: { role: true, user: { select: { username: true } } },
  });
  if (!target) throw new NotFoundError('This person must already be a team member before becoming its owner');
  if (target.role === 'OWNER') {
    res.json({ ok: true });
    return;
  }
  await prisma.learnTeamMember.update({
    where: { teamId_stableUid: { teamId, stableUid: body.stableUid } },
    data: { role: 'OWNER' },
  });
  logger.info('Admin action: Learn team owner added', {
    action: 'learn_team_owner_added', adminUsername: actor.username, teamId, targetStableUid: body.stableUid,
  });
  res.json({ ok: true });
});

router.delete('/learn/teams/:teamId', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const teamId = z.string().uuid().parse(req.params['teamId']);
  const body = adminLearnTeamDeleteSchema.parse(req.body);
  const actor = await learnAdminActor(req);
  const team = await prisma.learnTeam.findUnique({
    where: { id: teamId },
    select: { id: true, name: true, _count: { select: { courses: true } } },
  });
  if (!team) throw new NotFoundError('Learn team not found');
  if (body.confirmName !== team.name) throw new ValidationError('Confirmation must exactly match the team name');
  if (team._count.courses > 0) throw new ConflictError('Detach or archive every team course before deleting this group');
  await prisma.learnTeam.delete({ where: { id: teamId } });
  logger.info('Admin action: Learn team deleted', { action: 'learn_team_deleted', adminUsername: actor.username, teamId });
  res.status(204).send();
});

// ─── GET /api/admin/backups ────────────────────────────────────────────────────
// Full-database (mysqldump) scheduled + manual backups. Files live on the
// `backups` volume, not in the database itself — see src/services/dbBackup.ts.

router.get('/backups', requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  const [backupConfig, files] = await Promise.all([getBackupConfig(), listBackups()]);
  res.json({
    config: {
      enabled: backupConfig.enabled,
      scheduleHour: backupConfig.scheduleHour,
      retentionDays: backupConfig.retentionDays,
      lastRunAt: backupConfig.lastRunAt ? backupConfig.lastRunAt.toISOString() : null,
      lastRunStatus: backupConfig.lastRunStatus,
    },
    files,
  });
});

const backupConfigSchema = z.object({
  enabled: z.boolean().optional(),
  scheduleHour: z.number().int().min(0).max(23).optional(),
  retentionDays: z.number().int().min(1).max(365).optional(),
});

router.patch('/backups/config', requireAdmin, writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const parsed = backupConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ error: parsed.error.errors.map((e) => e.message).join('; ') });
    return;
  }
  const adminUsername = adminUsernameFromReq(req.headers['authorization']);
  await updateBackupConfig(parsed.data, adminUsername);
  logger.info('Admin action: backup config updated', { action: 'backup_config_updated', adminUsername, fields: Object.keys(parsed.data) });
  res.json({ ok: true });
});

router.post('/backups/run', requireAdmin, writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const adminUsername = adminUsernameFromReq(req.headers['authorization']);
  try {
    const result = await runBackup('manual');
    logger.info('Admin action: manual backup created', { action: 'backup_manual_run', adminUsername, filename: result.filename, sizeBytes: result.sizeBytes });
    res.status(201).json(result);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Backup failed' });
  }
});

router.get('/backups/:filename/download', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const filename = String(req.params['filename']);
  const filePath = resolveBackupPath(filename);
  if (!filePath) throw new ValidationError('Invalid backup filename');
  const adminUsername = adminUsernameFromReq(req.headers['authorization']);
  logger.info('Admin action: backup downloaded', { action: 'backup_downloaded', adminUsername, filename });
  res.download(filePath, filename, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Backup not found' });
  });
});

router.delete('/backups/:filename', requireAdmin, writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const filePath = resolveBackupPath(String(req.params['filename']));
  if (!filePath) throw new ValidationError('Invalid backup filename');
  const adminUsername = adminUsernameFromReq(req.headers['authorization']);
  try {
    await fs.unlink(filePath);
  } catch {
    throw new NotFoundError('Backup not found');
  }
  logger.info('Admin action: backup deleted', { action: 'backup_deleted', adminUsername, filename: req.params['filename'] });
  res.status(204).send();
});

const restoreBackupSchema = z.object({ confirmation: z.string() });

// Restoring overwrites every table in the live database. Requires the exact
// filename typed back as confirmation, mirroring this file's other
// irreversible-action pattern (e.g. course/team deletion by exact-name match).
router.post('/backups/:filename/restore', requireAdmin, writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const filename = String(req.params['filename']);
  const body = restoreBackupSchema.parse(req.body);
  if (body.confirmation !== filename) throw new ValidationError('Confirmation must exactly match the backup filename');
  if (!resolveBackupPath(filename)) throw new ValidationError('Invalid backup filename');
  const adminUsername = adminUsernameFromReq(req.headers['authorization']);
  try {
    await restoreBackup(filename);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Restore failed' });
    return;
  }
  logger.info('Admin action: backup restored', { action: 'backup_restored', adminUsername, filename });
  res.json({ ok: true });
});

router.post('/backups/prune', requireAdmin, writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const adminUsername = adminUsernameFromReq(req.headers['authorization']);
  const pruned = await pruneOldBackups();
  logger.info('Admin action: backup retention pruned manually', { action: 'backup_pruned_manual', adminUsername, pruned });
  res.json({ pruned });
});

export { router as adminRouter };
