import { Router, Request, Response } from 'express';
import { z } from 'zod';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { rateLimit } from 'express-rate-limit';
import https from 'https';
import http from 'http';
import { config } from '../config';
import { prisma } from '../db';
import { requireAdmin } from '../middleware/requireAdmin';
import { generateClassCode, generateClassId } from '../utils/uid';
import { revokeUserTokens } from '../utils/revokedTokens';

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
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
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

// Rate limiter for login: max 10 per 15 minutes per IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
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

  const isEnvAdmin = config.adminUsernames.includes(username);
  if (!adminRecord && !isEnvAdmin) {
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
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const token = jwt.sign(
    { role: 'admin', sub: 'admin-panel', username },
    config.jwtSecret,
    { expiresIn: '7d' }
  );

  res.json({ token });
});

// ─── GET /api/admin/stats ─────────────────────────────────────────────────────

router.get('/stats', requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  const [
    totalUsers,
    totalAdmins,
    totalClasses,
    totalTodos,
    totalReminders,
    totalActiveSessions,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.admin.count(),
    prisma.class.count(),
    prisma.todo.count(),
    prisma.reminder.count(),
    prisma.refreshToken.count({
      where: {
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    }),
  ]);

  // Last 14 days user registrations grouped by day
  type DayRow = { date: string; count: bigint };
  const rawRows = await prisma.$queryRaw<DayRow[]>`
    SELECT DATE(created_at) as date, COUNT(*) as count
    FROM users
    WHERE created_at >= DATE_SUB(NOW(), INTERVAL 14 DAY)
    GROUP BY DATE(created_at)
    ORDER BY date ASC
  `;

  const usersByDay = rawRows.map((row) => ({
    date: String(row.date),
    count: Number(row.count),
  }));

  res.json({
    totalUsers,
    totalAdmins,
    totalClasses,
    totalTodos,
    totalReminders,
    totalActiveSessions,
    usersByDay,
  });
});

// ─── POST /api/admin/users ────────────────────────────────────────────────────

router.post('/users', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const { username, webuntisKlasseId, webuntisKlasseName } = req.body as {
    username?: string;
    webuntisKlasseId?: number;
    webuntisKlasseName?: string;
  };

  if (!username || username.trim().length < 1) {
    res.status(400).json({ error: 'Username is required' });
    return;
  }

  const existing = await prisma.user.findUnique({ where: { username: username.trim() } });
  if (existing) {
    res.status(409).json({ error: `User "${username}" already exists` });
    return;
  }

  const stableUid = uuidv4();
  const user = await prisma.user.create({
    data: {
      id: uuidv4(),
      stableUid,
      username: username.trim(),
      webuntisKlasseId: webuntisKlasseId ?? 0,
      webuntisKlasseName: webuntisKlasseName?.trim() || 'Unknown',
    },
  });

  res.status(201).json({
    stableUid: user.stableUid,
    username: user.username,
    webuntisKlasseId: user.webuntisKlasseId,
    webuntisKlasseName: user.webuntisKlasseName,
    isAdmin: false,
    todoCount: 0,
    classId: null,
    classCode: null,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  });
});

// ─── GET /api/admin/users ─────────────────────────────────────────────────────

router.get('/users', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const search = typeof req.query['search'] === 'string' ? req.query['search'] : undefined;
  const page = Math.max(1, parseInt(String(req.query['page'] ?? '1'), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query['limit'] ?? '20'), 10)));
  const skip = (page - 1) * limit;

  const where = search
    ? { username: { contains: search } }
    : {};

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
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
    todos: user.todos.map((t) => ({
      id: t.id,
      title: t.title,
      details: t.details,
      dueAt: t.dueAt ? t.dueAt.toISOString() : null,
      done: t.done,
      doneAt: t.doneAt ? t.doneAt.toISOString() : null,
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
  revokeUserTokens(stableUid);
  await prisma.user.delete({ where: { stableUid } }).catch(() => null);
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

  await prisma.admin.upsert({
    where: { stableUid },
    create: { stableUid, canCreateClass: true },
    update: { canCreateClass: true },
  });

  res.json({ ok: true });
});

// ─── DELETE /api/admin/users/:stableUid/revoke-admin ─────────────────────────

router.delete('/users/:stableUid/revoke-admin', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const stableUid = String(req.params['stableUid']);

  await prisma.admin.deleteMany({ where: { stableUid } });

  res.status(204).send();
});

// ─── GET /api/admin/classes ───────────────────────────────────────────────────

router.get('/classes', requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  const classes = await prisma.class.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      members: {
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
  const path = req.query['path'] ? String(req.query['path']) : undefined;
  const username = req.query['username'] ? String(req.query['username']) : undefined;

  const where: Record<string, unknown> = {};
  if (method) where['method'] = method;
  if (status) where['status'] = { gte: status, lt: status + 100 };
  if (path) where['path'] = { contains: path };
  if (username) where['username'] = { contains: username };

  const [logs, total] = await Promise.all([
    prisma.requestLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
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
    createdAt: t.createdAt.toISOString(),
  })));
});

// ─── GET /api/admin/dishes ───────────────────────────────────────────────────

router.get('/dishes', requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  const dishes = await prisma.dish.findMany({
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
    },
  });

  res.status(201).json(dishRow(dish));
});

// ─── PATCH /api/admin/dishes/:id ──────────────────────────────────────────────

router.patch('/dishes/:id', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params['id']);
  const b = req.body as Record<string, unknown>;

  const data: Record<string, unknown> = {};
  if (b['nameDe'] !== undefined) data['nameDe'] = String(b['nameDe']).trim();
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

  const dish = await prisma.dish.update({ where: { id }, data }).catch(() => null);
  if (!dish) { res.status(404).json({ error: 'Dish not found' }); return; }

  res.json(dishRow(dish));
});

// ─── DELETE /api/admin/dishes/:id ────────────────────────────────────────────

router.delete('/dishes/:id', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params['id']);
  await prisma.dish.delete({ where: { id } }).catch(() => null);
  res.status(204).send();
});

// ─── POST /api/admin/dishes/import-url ───────────────────────────────────────
// Fetches the external mensa.json URL and bulk-upserts all dishes

router.post('/dishes/import-url', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const url = String(req.body?.url ?? 'https://mensa.plattnericus.dev/mensa.json');

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

  for (const d of list) {
    const rawId = d['id'];
    const id = rawId ? String(rawId) : uuidv4();
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
    };

    const existing = await prisma.dish.findUnique({ where: { id } });
    if (existing) {
      await prisma.dish.update({ where: { id }, data });
      updated++;
    } else {
      await prisma.dish.create({ data: { id, ...data } });
      imported++;
    }
  }

  res.json({ imported, updated, total: imported + updated });
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

  const ratingsByDish = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = ratingsByDish.get(row.dishId) ?? [];
    list.push(row);
    ratingsByDish.set(row.dishId, list);
  }

  const dishMap = new Map(allDishes.map((d) => [d.id, d]));
  const allDishIds = new Set([...allDishes.map((d) => d.id), ...ratingsByDish.keys()]);

  const result = [...allDishIds]
    .map((dishId) => {
      const dish = dishMap.get(dishId);
      const entries = ratingsByDish.get(dishId) ?? [];
      const avg = entries.length > 0 ? entries.reduce((s, e) => s + e.stars, 0) / entries.length : 0;
      return {
        dishId,
        name: dish?.nameDe ?? dishId,
        imageUrl: dish?.imageUrl ?? '',
        avgStars: Math.round(avg * 10) / 10,
        count: entries.length,
        ratings: entries.map((e) => ({
          stableUid: e.stableUid,
          username: uidToUsername[e.stableUid] ?? e.stableUid,
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

  res.status(204).send();
});

// ─── DELETE /api/admin/dish-ratings/:dishId/:stableUid ───────────────────────

router.delete('/dish-ratings/:dishId/:stableUid', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const dishId = String(req.params['dishId']);
  const stableUid = String(req.params['stableUid']);

  await prisma.dishRating.delete({
    where: { dishId_stableUid: { dishId, stableUid } },
  }).catch(() => null);

  res.status(204).send();
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
  res.setHeader('Content-Type', row.mimeType);
  res.setHeader('Cache-Control', 'public, max-age=3600');
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

// PUT /api/admin/subject-images/:subject — upload or replace image
const subjectImageUploadSchema = z.object({
  data:     z.string().min(1),
  mimeType: z.string(),
});

router.put('/subject-images/:subject', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const subject = normalizeSubjectKey(req.params['subject'] as string);
  if (!subject) { res.status(400).json({ error: 'Invalid subject' }); return; }

  const body = subjectImageUploadSchema.parse(req.body);
  if (!ALLOWED_MIME.has(body.mimeType)) {
    res.status(422).json({ error: 'Unsupported image type' }); return;
  }
  const buf = Buffer.from(body.data, 'base64');
  if (buf.length > MAX_IMG_BYTES) {
    res.status(413).json({ error: 'Image too large (max 3 MB)' }); return;
  }

  await prisma.subjectImage.upsert({
    where:  { subject },
    create: { subject, data: buf, mimeType: body.mimeType },
    update: { data: buf, mimeType: body.mimeType },
  });
  res.json({ ok: true, subject });
});

// DELETE /api/admin/subject-images/:subject — remove image
router.delete('/subject-images/:subject', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const subject = normalizeSubjectKey(req.params['subject'] as string);
  await prisma.subjectImage.delete({ where: { subject } }).catch(() => null);
  res.status(204).send();
});

export { router as adminRouter };
