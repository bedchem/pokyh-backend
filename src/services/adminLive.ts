import { Request, Response, NextFunction } from 'express';
import { prisma } from '../db';
import { sseManager } from './sse';

// Keeps the admin panel and the apps in step without polling:
//
//   1. Every successful change that reaches the API — from the web app, the
//      Android app or another administrator — is announced on one admin
//      stream. The announcement carries only the *area* that changed, never
//      data; the panel then refetches through its normal, authorised
//      endpoints.
//   2. Changes an administrator makes to todos, reminders and reminder
//      comments are pushed to the app streams the same way the user routes
//      push their own changes, so the apps update at once too.
//
// Both hooks run after the response has been sent and never alter or block a
// request.

export const ADMIN_LIVE_KEY = 'admin:live';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// Plain reads by the apps move the request counters; announce those at most
// this often so an open dashboard stays current without being flooded.
const REQUEST_TICK_MS = 10_000;
let lastRequestTick = 0;
// The usage heartbeat arrives every minute from every open app. The Analytics
// page hears about it at most this often: live, but not a refetch per ping.
const USAGE_TICK_MS = 5_000;
let lastUsageTick = 0;
let usageTrailing: NodeJS.Timeout | null = null;

// At most one announcement per window; a ping inside the window is announced
// when it ends, so the last of a burst is never left for the page's timer.
function announceUsage(): void {
  const wait = lastUsageTick + USAGE_TICK_MS - Date.now();
  if (wait <= 0) {
    lastUsageTick = Date.now();
    announceChange(['analytics']);
    return;
  }
  if (usageTrailing) return;
  usageTrailing = setTimeout(() => {
    usageTrailing = null;
    lastUsageTick = Date.now();
    announceChange(['analytics']);
  }, wait);
  usageTrailing.unref?.();
}

// Path segment -> the panel areas it affects.
const AREAS: Record<string, string[]> = {
  auth: ['users', 'sessions'],
  setup: ['users'],
  users: ['users'],
  'grant-admin': ['users'],
  'revoke-admin': ['users'],
  sessions: ['sessions'],
  classes: ['classes'],
  todos: ['todos'],
  reminders: ['reminders'],
  comments: ['comments'],
  'dish-comments': ['comments'],
  'dish-ratings': ['ratings', 'dishes'],
  dishes: ['dishes'],
  'subject-images': ['subject-images'],
  popups: ['popups'],
  recaps: ['recaps'],
  'activity-log': ['activity'],
  'api-keys': ['api-keys'],
  backups: ['backups'],
  cluster: ['cluster'],
  // These replace or move whole data sets.
  import: ['all'],
  restore: ['all'],
  'school-years': ['all'],
  // Schools, menus and administrators' rights.
  schools: ['schools'],
  menus: ['schools', 'dishes'],
  admins: ['access', 'users'],
  grants: ['access', 'users'],
  // Error reports of the apps; the panel's own reports change nothing shown.
  'client-errors': ['client-errors'],
  // Registering a push token changes nothing the panel shows.
  push: [],
  // The usage heartbeat is announced on its own, throttled (see adminLive).
  usage: [],
};

function areasFor(path: string): string[] {
  const areas = new Set<string>();
  let known = false;
  for (const segment of path.split('/')) {
    const mapped = AREAS[segment];
    if (!mapped) continue;
    known = true;
    for (const area of mapped) areas.add(area);
  }
  // An unknown route may have changed anything.
  return known ? [...areas] : ['all'];
}

export function announceChange(areas: string[]): void {
  if (areas.length === 0 || sseManager.getClientCount(ADMIN_LIVE_KEY) === 0) return;
  sseManager.broadcast(ADMIN_LIVE_KEY, 'change', { areas, at: Date.now() });
}

function isBackgroundPath(path: string): boolean {
  return path === '/health' || path === '/readyz' || path.startsWith('/admin') || path.startsWith('/sse')
    || path.startsWith('/api/admin') || path.startsWith('/cluster/');
}

export function adminLive(req: Request, res: Response, next: NextFunction): void {
  res.on('finish', () => {
    if (sseManager.getClientCount(ADMIN_LIVE_KEY) === 0) return;
    const path = (req.originalUrl || req.url).split('?')[0] ?? '';

    if (path.startsWith('/usage/')) {
      // Someone just opened Pokyh: shown at once. Further pings of a visit
      // only move the time and are throttled.
      if (res.statusCode < 400 && res.locals['usageNewVisit'] === true) announceChange(['analytics']);
      else if (res.statusCode < 400) announceUsage();
      return;
    }

    if (MUTATING.has(req.method)) {
      if (res.statusCode < 400) announceChange(areasFor(path));
      return;
    }

    if (isBackgroundPath(path)) return;
    const now = Date.now();
    if (now - lastRequestTick >= REQUEST_TICK_MS) {
      lastRequestTick = now;
      announceChange(['requests']);
    }
  });
  next();
}

// ─── Admin changes -> app streams ────────────────────────────────────────────

const USER_TODOS = /^\/api\/admin\/users\/([^/]+)\/todos(?:\/|$)/;
const CLASS_REMINDERS = /^\/api\/admin\/classes\/([^/]+)\/reminders\/?$/;
const REMINDER = /^\/api\/admin\/reminders\/([^/]+)\/?$/;
const REMINDER_COMMENT = /^\/api\/admin\/comments\/reminder\/([^/]+)\/?$/;

// Same events and payloads as routes/todos.ts, routes/reminders.ts and
// routes/reminderComments.ts send after a user's own change.
async function pushTodos(stableUid: string): Promise<void> {
  const key = `todos:${stableUid}`;
  if (sseManager.getClientCount(key) === 0) return;
  const todos = await prisma.todo.findMany({ where: { stableUid, archivedAt: null }, orderBy: { createdAt: 'asc' } });
  sseManager.broadcast(key, 'todos', todos);
}

async function pushReminders(classId: string): Promise<void> {
  const key = `reminders:${classId}`;
  if (sseManager.getClientCount(key) === 0) return;
  const reminders = await prisma.reminder.findMany({ where: { classId, archivedAt: null }, orderBy: { remindAt: 'asc' } });
  sseManager.broadcast(key, 'reminders', reminders);
}

async function pushReminderComments(reminderId: string): Promise<void> {
  const key = `reminderComments:${reminderId}`;
  if (sseManager.getClientCount(key) === 0) return;
  const comments = await prisma.comment.findMany({ where: { reminderId }, orderBy: { createdAt: 'asc' } });
  sseManager.broadcast(key, 'reminderComments', comments);
}

export function adminAppSync(req: Request, res: Response, next: NextFunction): void {
  if (!MUTATING.has(req.method)) { next(); return; }
  const path = (req.originalUrl || req.url).split('?')[0] ?? '';

  let push: (() => Promise<void>) | null = null;
  // A reminder or comment that is about to be deleted can no longer be asked
  // which class or reminder it belonged to, so that is looked up first.
  let lookup: Promise<unknown> = Promise.resolve();

  const todos = USER_TODOS.exec(path);
  const classReminders = CLASS_REMINDERS.exec(path);
  const reminder = REMINDER.exec(path);
  const comment = REMINDER_COMMENT.exec(path);

  if (todos) {
    const stableUid = decodeURIComponent(todos[1]!);
    push = () => pushTodos(stableUid);
  } else if (classReminders) {
    const classId = decodeURIComponent(classReminders[1]!);
    push = () => pushReminders(classId);
  } else if (reminder) {
    const id = decodeURIComponent(reminder[1]!);
    let classId: string | null = null;
    lookup = prisma.reminder.findUnique({ where: { id }, select: { classId: true } })
      .then((row) => { classId = row?.classId ?? null; });
    push = async () => { if (classId) await pushReminders(classId); };
  } else if (comment) {
    const id = decodeURIComponent(comment[1]!);
    let reminderId: string | null = null;
    lookup = prisma.comment.findUnique({ where: { id }, select: { reminderId: true } })
      .then((row) => { reminderId = row?.reminderId ?? null; });
    push = async () => { if (reminderId) await pushReminderComments(reminderId); };
  }

  if (!push) { next(); return; }

  const run = push;
  res.on('finish', () => {
    if (res.statusCode >= 400) return;
    // Best effort: a failed push must never surface as a failed admin request.
    void run().catch(() => undefined);
  });
  // The request waits for the lookup only; a failed lookup just means no push.
  void lookup.catch(() => undefined).then(() => next());
}
