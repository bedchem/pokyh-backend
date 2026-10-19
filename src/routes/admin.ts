import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { rateLimit } from 'express-rate-limit';
import https from 'https';
import http from 'http';
import dns from 'dns';
import net from 'net';
import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import { createHash, randomBytes } from 'crypto';
import { config } from '../config';
import { prisma } from '../db';
import { inScope, requireAdmin, requirePermission, schoolWhere, scopeSchool, allowDuringSecondFactorSetup } from '../middleware/requireAdmin';
import { generateClassCode, generateClassId } from '../utils/uid';
import { revokeUserTokens } from '../utils/revokedTokens';
import { logger } from '../utils/logger';
import { invalidateDishesCache } from '../utils/cache';
import { publishDishRatings } from '../services/dishRatings';
import { publishDishComments } from '../services/dishComments';
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
import { intQueryParam } from '../utils/duration';
import { endpointOf } from '../utils/endpoint';
import { clientIp } from '../middleware/requestLogger';
import { sseManager } from '../services/sse';
import { ADMIN_LIVE_KEY } from '../services/adminLive';
import { localDayAndHour, startOfLocalDay } from '../services/usageAnalytics';
import { activeToday } from './adminAnalytics';
import {
  beginPasswordSetup,
  checkAdminPassword,
  expireLapsedAdminSetups,
  findAdminAccount,
  finishPasswordSetup,
  grantAdminWithOneTimePassword,
  issueAdminToken,
  pendingAdminFields,
  scheduleSetupExpiry,
  viewOneTimePassword,
} from '../services/adminLogin';
import { adminCanSignIn, grantNeedsOneTimePassword, mayViewOneTimePassword, validOneTimePassword } from '../security/adminLogin';
import { clearSecondFactors, issueSecondFactorTicket, secondFactorMethods } from '../services/adminSecondFactor';
import { adminSecuritySummaries, clearAdminSecurity, lastAppSignIns, loginStepsFor, recordAdminLogin, secondFactorSetupNeeded } from '../services/adminSecurity';
import { SIGN_IN_PATHS } from '../services/accountActivity';
import { hasClassIdentity, parseAccountRole } from '../utils/accountClass';
import { audit } from '../services/audit';
import { assertMayAppointAdmin, assertMayRemoveAdmin, checkGrantRequest, clearGrants, grantsOf, isOwner, parseGrantRequest, setGrant } from '../services/adminAccess';
import { DEFAULT_MENU_ID, defaultSchoolId, forgetUserSchool, listSchools, menuOfSchool, schoolById, schoolsOfMenu } from '../services/schools';
import { GLOBAL_SCOPE, can } from '../security/permissions';
import { likeText } from '../utils/like';

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

// Try to pull the intrinsic week number out of the source id of the menu
// source, formatted as "w1_mo", "w2_tu", … "w6_su".
// Falls back to 0 (unknown) when the id doesn't match the pattern.
function weekOrdinalFromSourceId(sourceId: string | null | undefined): number {
  if (!sourceId) return 0;
  const m = /^w(\d+)[_-]/i.exec(sourceId);
  if (!m) return 0;
  const n = parseInt(m[1]!, 10);
  return Number.isFinite(n) && n > 0 && n < 1000 ? n : 0;
}

// Fetches an operator-supplied JSON source. Bounded in time and size and
// limited to plain web URLs, so a slow, endless or mistyped source can only
// fail the one admin request that asked for it.
const FETCH_TIMEOUT_MS = 10_000;
const FETCH_MAX_BYTES = 5 * 1024 * 1024;

class BlockedAddressError extends Error {}

// Loopback, private, link-local (cloud metadata), carrier-grade NAT and
// multicast ranges: what a server can reach but the internet cannot.
function isInternalAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = address.toLowerCase();
  if (v6.startsWith('::ffff:')) return isInternalAddress(v6.slice(7));
  return v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe8') || v6.startsWith('fe9')
    || v6.startsWith('fea') || v6.startsWith('feb') || v6.startsWith('ff');
}

const BLOCKED = 'Diese Adresse zeigt ins interne Netz und ist für den Import nicht erlaubt';

// Resolves like the default lookup, but refuses a name that leads to an
// internal address. Used for the connection itself, so a name that changes
// its answer between a check and the request (DNS rebinding) is caught too.
const publicLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) {
      callback(err, '', 0);
      return;
    }
    const list = addresses as unknown as dns.LookupAddress[];
    if (list.length === 0 || list.some((a) => isInternalAddress(a.address))) {
      callback(new BlockedAddressError(BLOCKED), '', 0);
      return;
    }
    if (options.all) (callback as unknown as (e: null, all: dns.LookupAddress[]) => void)(null, list);
    else callback(null, list[0]!.address, list[0]!.family);
  });
};

// Whoever may change the Mensa of every school, or the operator's own
// MENSA_IMPORT_URL, may fetch from anywhere — as before schools existed. A
// school's Mensa manager only from the public internet: the server must not
// become their way into the internal network (SSRF).
function importMayReachInternal(req: Request, url: string): boolean {
  return can(req.adminAccess!, 'mensa.manage', null) || (config.mensaImportUrl !== '' && url === config.mensaImportUrl);
}

function fetchUrl(url: string, { publicOnly = false }: { publicOnly?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error('invalid URL'));
      return;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      reject(new Error('unsupported URL scheme'));
      return;
    }
    const literal = parsed.hostname.replace(/^\[|\]$/g, '');
    if (publicOnly && (parsed.hostname === 'localhost' || (net.isIP(literal) && isInternalAddress(literal)))) {
      reject(new BlockedAddressError(BLOCKED));
      return;
    }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(parsed, { headers: { 'User-Agent': 'pokyh-backend/1.0' }, ...(publicOnly ? { lookup: publicLookup } : {}) }, (res) => {
      const status = res.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        res.resume();
        reject(new Error(`unexpected HTTP status ${status}`));
        return;
      }
      const chunks: Buffer[] = [];
      let received = 0;
      res.on('data', (c: Buffer) => {
        received += c.length;
        if (received > FETCH_MAX_BYTES) {
          req.destroy(new Error('response too large'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(FETCH_TIMEOUT_MS, () => { req.destroy(new Error('fetch timeout')); });
  });
}

const router = Router();

// ` AND <column> = <school>` for raw SQL of a school-scoped request, nothing
// for the global view.
function schoolSql(req: Request, column = 'school_id'): Prisma.Sql {
  const schoolId = scopeSchool(req);
  return schoolId ? Prisma.sql` AND ${Prisma.raw(column)} = ${schoolId}` : Prisma.empty;
}

// The apps' traffic: the admin panel's own requests are not app activity.
// Every row has a scope (rows from before it existed are filled with "core"
// once, services/multiSchool.ts), so a plain comparison suffices and stays
// readable from the (created_at, scope, …) index.
const APP_TRAFFIC = Prisma.sql` AND scope <> 'admin'`;
const APP_TRAFFIC_WHERE = { scope: { not: 'admin' } };

// A user the request may see: in its school, or any in the global view.
// Null for an unknown id and for another school's account alike, so the
// answer never tells which ids exist elsewhere.
async function userInScope(req: Request, stableUid: string) {
  const user = await prisma.user.findUnique({ where: { stableUid } });
  return user && inScope(req, user.schoolId) ? user : null;
}

async function classInScope(req: Request, id: string) {
  const cls = await prisma.class.findUnique({ where: { id } });
  return cls && inScope(req, cls.schoolId) ? cls : null;
}

async function reminderInScope(req: Request, id: string) {
  const reminder = await prisma.reminder.findUnique({ where: { id }, include: { class: { select: { schoolId: true } } } });
  return reminder && inScope(req, reminder.class.schoolId) ? reminder : null;
}

// ─── Menus ──────────────────────────────────────────────────────────────────
// A school's view works on the menu assigned to that school; the global view
// names one (?menuId= / body menuId), the default menu otherwise. Changing a
// menu changes it for every school that shows it, so that needs the Mensa
// right in each of them.

async function menuFor(req: Request, requested: unknown): Promise<string | null> {
  const schoolId = scopeSchool(req);
  const asked = typeof requested === 'string' && requested.trim() ? requested.trim().toLowerCase() : null;
  if (schoolId) {
    const own = await menuOfSchool(schoolId);
    return own && (!asked || asked === own) ? own : null;
  }
  const menu = await prisma.mensaMenu.findUnique({ where: { id: asked ?? DEFAULT_MENU_ID }, select: { id: true } });
  return menu?.id ?? null;
}

async function assertMayEditMenu(req: Request, menuId: string): Promise<void> {
  const schools = await schoolsOfMenu(menuId);
  const access = req.adminAccess!;
  const ok = schools.length === 0 ? can(access, 'mensa.manage', null) : schools.every((id) => can(access, 'mensa.manage', id));
  if (!ok) throw new ForbiddenError('Dieser Mensaplan wird auch von Schulen genutzt, für die du keine Mensa-Rechte hast');
}

async function editableMenu(req: Request, requested: unknown): Promise<string> {
  const menuId = await menuFor(req, requested);
  if (!menuId) throw new NotFoundError(scopeSchool(req) ? 'Dieser Schule ist kein Mensaplan zugewiesen' : 'Mensaplan nicht gefunden');
  await assertMayEditMenu(req, menuId);
  return menuId;
}

async function editableDish(req: Request, id: string) {
  const dish = await prisma.dish.findUnique({ where: { id } });
  if (!dish || !dish.menuId) throw new NotFoundError('Dish not found');
  const schoolId = scopeSchool(req);
  if (schoolId && (await menuOfSchool(schoolId)) !== dish.menuId) throw new NotFoundError('Dish not found');
  await assertMayEditMenu(req, dish.menuId);
  return dish;
}

// The school a new record of a global-view request goes to: the one named
// in the body (it must exist), else the default school.
async function targetSchoolFor(req: Request, requested: unknown): Promise<string> {
  const scoped = scopeSchool(req);
  if (scoped) return scoped;
  if (typeof requested === 'string' && requested.trim() !== '') {
    const school = await schoolById(requested.trim().toLowerCase());
    if (!school) throw new ValidationError('Unbekannte Schule');
    return school.id;
  }
  return defaultSchoolId();
}

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
  const { username, password } = req.body as { username?: unknown; password?: unknown };

  if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
    res.status(400).json({ error: 'Username and password required' });
    return;
  }

  // Admins defined in env OR with an Admin DB record. The failure reason only
  // goes to the log; the caller always sees the same "Invalid credentials".
  const loginIp = clientIp(req);
  const lookup = await findAdminAccount(username);
  if (!lookup.ok) {
    const message = lookup.reason === 'no-account'
      ? 'Admin login failed: unknown user'
      : 'Admin login failed: account is not an admin';
    logger.warn(message, { action: 'admin_login_failed', reason: lookup.reason, username, ip: loginIp });
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }
  const { account } = lookup;

  const check = await checkAdminPassword(account, password);
  if (check === 'no-password') {
    if (account.isEnvAdmin) {
      res.status(500).json({ error: 'Admin password not configured — run npm run make-admin to set one' });
      return;
    }
    logger.warn('Admin login failed: account has no password — set one under Nutzer → Passwort setzen', {
      action: 'admin_login_failed', reason: 'no-password', username: account.username, ip: loginIp,
    });
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }
  if (check === 'wrong') {
    logger.warn('Admin login failed: wrong password', { action: 'admin_login_failed', reason: 'wrong-password', username: account.username, ip: loginIp });
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  // The one-time password of a WebUntis account made admin opens nothing but
  // the step that replaces it.
  if (account.adminRecord?.mustChangePassword) {
    logger.info('Admin login: one-time password ok, new password required', { action: 'admin_login_password_ok', reason: 'one-time-password', username: account.username, ip: loginIp });
    res.json({ passwordChangeRequired: true, ticket: await beginPasswordSetup(account) });
    return;
  }

  await answerPasswordAccepted(req, res, account.username, 'password');
});

// After a correct password: the second factor if one is set up, else the session.
async function answerPasswordAccepted(req: Request, res: Response, username: string, method: string): Promise<void> {
  const loginIp = clientIp(req);
  // The authenticator app, a passkey, or (where a passkey is required) only
  // the passkey; a recovery code is always offered where the app is set up.
  const methods = await loginStepsFor(username);
  const factors = await secondFactorMethods(username);
  if (methods.totp || methods.passkey) {
    logger.info('Admin login: password ok, second factor required', { action: 'admin_login_password_ok', username, ip: loginIp });
    res.json({ secondFactorRequired: true, ticket: issueSecondFactorTicket(username), methods: { ...methods, recovery: factors.totp } });
    return;
  }

  const token = issueAdminToken(username);
  // Required but not set up yet: this session can only set up a second factor
  // (requireAdmin); the panel shows that step right away.
  const secondFactorSetupRequired = await secondFactorSetupNeeded(username);
  logger.info('Admin login successful', { action: 'admin_login', method, username, ip: loginIp, userAgent: req.headers['user-agent'], secondFactorSetupRequired });
  // The access record of system administrators (Garante, 27 Nov 2008).
  audit(req, 'admin.login', { type: 'admin', id: username }, { method, ...(secondFactorSetupRequired ? { secondFactorSetupRequired } : {}) }, null, username);
  await recordAdminLogin(username, method);
  res.json(secondFactorSetupRequired ? { token, secondFactorSetupRequired } : { token });
}

// ─── POST /api/admin/auth/password-setup ──────────────────────────────────────
// Second step after a one-time password: the new admin's own password.

router.post('/auth/password-setup', loginLimiter, async (req: Request, res: Response): Promise<void> => {
  const { ticket, newPassword } = z.object({
    ticket: z.string().min(1).max(2000),
    newPassword: z.string().min(8, 'Das Passwort braucht mindestens 8 Zeichen').max(200),
  }).parse(req.body);
  const username = await finishPasswordSetup(ticket, newPassword);
  logger.info('Admin security: one-time password replaced', { action: 'admin_password_setup', username, ip: clientIp(req) });
  await answerPasswordAccepted(req, res, username, 'one-time-password');
});

// ─── GET /api/admin/stats ─────────────────────────────────────────────────────

router.get('/stats', requireAdmin, requirePermission('dashboard.view'), async (req: Request, res: Response): Promise<void> => {
  const inSchool = schoolWhere(req);
  const schoolId = scopeSchool(req);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  // The week starts on Monday, as in Austria and Germany.
  const startOfWeek = new Date();
  startOfWeek.setDate(startOfWeek.getDate() - ((startOfWeek.getDay() + 6) % 7));
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
    prisma.user.count({ where: inSchool }),
    // A school's admins: everyone with rights in it (global admins aside).
    schoolId
      ? prisma.adminGrant.count({ where: { scope: schoolId } })
      : prisma.admin.count(),
    prisma.class.count({ where: inSchool }),
    prisma.todo.count({ where: schoolId ? { user: { schoolId } } : {} }),
    prisma.reminder.count({ where: schoolId ? { class: { schoolId } } : {} }),
    prisma.refreshToken.count({ where: { revokedAt: null, expiresAt: { gt: new Date() }, ...(schoolId ? { user: { schoolId } } : {}) } }),
    prisma.requestLog.count({ where: { createdAt: { gte: startOfToday }, ...APP_TRAFFIC_WHERE, ...inSchool } }),
    prisma.user.count({ where: { createdAt: { gte: startOfToday }, ...inSchool } }),
    prisma.user.count({ where: { createdAt: { gte: startOfWeek }, ...inSchool } }),
  ]);

  type DayRow = { date: string | Date; count: bigint };
  type StatRow = { errors: bigint; avgMs: number | null };

  const [rawRows, todayStats] = await Promise.all([
    prisma.$queryRaw<DayRow[]>`
      SELECT DATE(created_at) as date, COUNT(*) as count
      FROM users
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 14 DAY)${schoolSql(req)}
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `,
    prisma.$queryRaw<StatRow[]>`
      SELECT
        SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END) AS errors,
        ROUND(AVG(duration)) AS avgMs
      FROM request_logs
      WHERE created_at >= ${startOfToday}${APP_TRAFFIC}${schoolSql(req)}
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

router.post('/users', requireAdmin, requirePermission('users.create'), async (req: Request, res: Response): Promise<void> => {
  const { username, password, webuntisKlasseId, webuntisKlasseName, role, isAdmin, adminPassword, schoolId: requestedSchool, grant: rawGrant } = req.body as {
    username?: string;
    password?: string;
    webuntisKlasseId?: number;
    webuntisKlasseName?: string;
    role?: string;
    isAdmin?: unknown;
    // The one-time password of a new admin without an own password (a WebUntis account).
    adminPassword?: unknown;
    // Global view only: the school the account belongs to (default school otherwise).
    schoolId?: unknown;
    // For a new admin: what they may do, in which scope.
    grant?: unknown;
  };

  // Only the known account roles are accepted; default to "student".
  const accountRole = parseAccountRole(role);
  const withClass = hasClassIdentity(accountRole);
  const makeAdmin = isAdmin === true;

  if (!username || username.trim().length < 1) {
    res.status(400).json({ error: 'Username is required' });
    return;
  }

  if (password !== undefined && password !== '' && password.length < 8) {
    res.status(400).json({ error: 'Passwort muss mindestens 8 Zeichen lang sein' });
    return;
  }

  // Without a password the account is a WebUntis account: as an admin it
  // starts with a one-time password, like "Admin vergeben".
  const oneTimeAdmin = makeAdmin && !password;
  if (oneTimeAdmin && !validOneTimePassword(adminPassword)) {
    res.status(400).json({ error: 'Einmal-Passwort fürs Admin-Panel muss 8 bis 100 Zeichen lang sein' });
    return;
  }
  const grantingAdmin = req.adminUser!.username;
  if (typeof username !== 'string' || username.trim().length > 100) {
    res.status(400).json({ error: 'Username is required' });
    return;
  }
  const schoolId = await targetSchoolFor(req, requestedSchool);
  const grant = makeAdmin ? parseGrantRequest(rawGrant) : null;
  // Refuse before anything is created: making an admin and every right in
  // the grant must be the creating admin's own.
  if (makeAdmin) {
    assertMayAppointAdmin(req, schoolId);
    if (grant) await checkGrantRequest(req, grant, schoolId);
  }

  const existing = await prisma.user.findUnique({ where: { username: username.trim().toLowerCase() } });
  if (existing) {
    res.status(409).json({ error: `User "${username}" already exists` });
    return;
  }

  const passwordHash = password ? await bcrypt.hash(password, config.bcryptRounds) : undefined;
  const stableUid = uuidv4();
  const createUser = prisma.user.create({
    data: {
      id: uuidv4(),
      stableUid,
      username: username.trim().toLowerCase(),
      webuntisKlasseId: withClass ? webuntisKlasseId ?? 0 : 0,
      webuntisKlasseName: withClass ? webuntisKlasseName?.trim() || '' : '',
      isUntisUser: !passwordHash,
      role: accountRole,
      schoolId,
      ...(passwordHash ? { passwordHash } : {}),
    },
  });
  // The account and its admin rights are made together or not at all.
  const adminData = makeAdmin
    ? (oneTimeAdmin ? await pendingAdminFields(adminPassword as string, grantingAdmin) : { canCreateClass: true })
    : null;
  const [user] = adminData
    ? await prisma.$transaction([createUser, prisma.admin.create({ data: { stableUid, ...adminData } })])
    : [await createUser];
  const setupExpiresAt = adminData && 'setupExpiresAt' in adminData ? adminData.setupExpiresAt : null;
  if (setupExpiresAt) scheduleSetupExpiry(setupExpiresAt);

  audit(req, 'user.create', { type: 'user', id: stableUid }, { role: accountRole, admin: makeAdmin, local: Boolean(passwordHash) }, schoolId);
  if (makeAdmin) {
    logger.info('Admin action: grant admin', { action: 'grant_admin', adminUsername: grantingAdmin, targetUid: stableUid, oneTimePassword: oneTimeAdmin });
    audit(req, 'admin.appoint', { type: 'admin', id: user.username }, { oneTimePassword: oneTimeAdmin }, schoolId);
    if (grant) await setGrant(req, user.username, grant.scope, grant.permissions, grant.preset);
  }

  res.status(201).json({
    stableUid: user.stableUid,
    username: user.username,
    webuntisKlasseId: user.webuntisKlasseId,
    webuntisKlasseName: user.webuntisKlasseName,
    isAdmin: makeAdmin,
    adminSetupExpiresAt: setupExpiresAt?.toISOString() ?? null,
    canViewOneTimePassword: setupExpiresAt !== null,
    serverTime: new Date().toISOString(),
    needsOneTimePassword: grantNeedsOneTimePassword({ isUntisUser: user.isUntisUser, hasPassword: Boolean(user.passwordHash) }),
    role: user.role,
    schoolId: user.schoolId,
    todoCount: 0,
    classId: null,
    classCode: null,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  });
});

// ─── PATCH /api/admin/users/:stableUid/role ───────────────────────────────────
// Switch an account between "student", "parent" and "none" (no role, e.g. an
// admin who is not in a class). Parents and role-less accounts have no class
// identity and no ClassMember row at all. Admin rights are independent of
// the role: granting or revoking admin never changes it.

router.patch('/users/:stableUid/role', requireAdmin, requirePermission('users.update'), async (req: Request, res: Response): Promise<void> => {
  const stableUid = String(req.params['stableUid'] ?? '');
  const { role } = req.body as { role?: unknown };

  if (role !== 'student' && role !== 'parent' && role !== 'none') {
    res.status(400).json({ error: 'role must be "student", "parent" or "none"' });
    return;
  }

  const user = await userInScope(req, stableUid);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  if (!hasClassIdentity(role)) {
    const memberships = await prisma.classMember.findMany({
      where: { stableUid },
      select: { classId: true },
    });
    const classIds = [...new Set(memberships.map((membership) => membership.classId))];
    await prisma.$transaction([
      prisma.user.update({
        where: { stableUid },
        data: { role, webuntisKlasseId: 0, webuntisKlasseName: '' },
      }),
      prisma.classMember.deleteMany({ where: { stableUid } }),
    ]);
    if (classIds.length > 0) {
      await prisma.class.deleteMany({
        where: { id: { in: classIds }, members: { none: {} } },
      });
    }
  } else {
    await prisma.user.update({ where: { stableUid }, data: { role } });
  }

  const adminUsername = adminUsernameFromReq(req.headers['authorization']);
  logger.info('Admin action: set user role', { action: 'set_user_role', adminUsername, stableUid, role });
  audit(req, 'user.role', { type: 'user', id: stableUid }, { from: user.role, to: role }, user.schoolId);

  res.json({ stableUid, role });
});

// ─── PATCH /api/admin/users/:stableUid/password ───────────────────────────────

router.patch('/users/:stableUid/password', requireAdmin, requirePermission('users.update'), async (req: Request, res: Response): Promise<void> => {
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

  const user = await userInScope(req, stableUid);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  // An admin's account password can open the panel: setting it is taking
  // the account over, so it needs every right that admin holds.
  const targetIsAdmin = isOwner(user.username) || (await prisma.admin.findUnique({ where: { stableUid }, select: { stableUid: true } })) !== null;
  if (targetIsAdmin) await assertMayRemoveAdmin(req, user.username, user.schoolId);

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
  audit(req, 'user.password', { type: 'user', id: stableUid }, { admin: targetIsAdmin }, user.schoolId);

  res.status(204).end();
});

// ─── GET /api/admin/users ─────────────────────────────────────────────────────

router.get('/users', requireAdmin, requirePermission('users.view'), async (req: Request, res: Response): Promise<void> => {
  const search = typeof req.query['search'] === 'string' ? req.query['search'].trim().slice(0, 100) : '';
  // One filter for the kind of account: 'student', 'parent', 'none' (no role
  // and no admin), 'admin' (has panel access). Anything else: all accounts.
  // Every filter runs in the database before paging, so totals and pages
  // always describe the filtered set (the panel used to filter admins on the
  // loaded page only, which spread two admins over several pages).
  const roleRaw = typeof req.query['role'] === 'string' ? req.query['role'] : undefined;
  const kind = roleRaw === 'student' || roleRaw === 'parent' || roleRaw === 'none' || roleRaw === 'admin' ? roleRaw : undefined;
  const page = intQueryParam(req.query['page'], 1, 1, 1_000_000);
  const limit = intQueryParam(req.query['limit'], 20, 1, 100);
  // Global view: optionally one school's accounts.
  const filterSchoolRaw = typeof req.query['schoolId'] === 'string' ? req.query['schoolId'].trim().toLowerCase() : '';
  const filterSchool = scopeSchool(req) ?? (filterSchoolRaw ? (await schoolById(filterSchoolRaw))?.id ?? '__none__' : null);

  // A lapsed grant must not show up as admin when the panel's countdown ends.
  await expireLapsedAdminSetups();

  const adminRows = await prisma.admin.findMany({
    select: { stableUid: true, mustChangePassword: true, setupExpiresAt: true, oneTimePasswordEnc: true, grantedBy: true },
  });
  const adminUids = adminRows.map((a) => a.stableUid);
  const where: Prisma.UserWhereInput = {
    ...(search ? { username: { contains: likeText(search) } } : {}),
    ...(filterSchool ? { schoolId: filterSchool } : {}),
    ...(kind === 'admin'
      ? { OR: [{ stableUid: { in: adminUids } }, { username: { in: config.adminUsernames.map((n) => n.toLowerCase()) } }] }
      : kind === 'none'
        // "Without a role" means no role at all: an admin set to "none" still
        // has the admin role and is not listed there.
        ? { role: 'none', ...(adminUids.length > 0 ? { stableUid: { notIn: adminUids } } : {}) }
        : kind ? { role: kind } : {}),
  };

  const total = await prisma.user.count({ where });
  // A page past the end (the filter shrank the set) shows the last page.
  const lastPage = Math.max(1, Math.ceil(total / limit));
  const effectivePage = Math.min(page, lastPage);
  const users = await prisma.user.findMany({
    where,
    skip: (effectivePage - 1) * limit,
    take: limit,
    // The id breaks ties, so no account appears on two pages or on none.
    orderBy: [{ createdAt: 'desc' }, { stableUid: 'asc' }],
    include: {
      _count: { select: { todos: true } },
      classMembers: {
        include: { class: { select: { id: true, code: true } } },
        take: 1,
        orderBy: { joinedAt: 'desc' },
      },
    },
  });

  const adminByUid = new Map(adminRows.map((a) => [a.stableUid, a]));
  const names = users.filter((u) => adminByUid.has(u.stableUid)).map((u) => u.username);
  const grantRows = names.length > 0
    ? await prisma.adminGrant.findMany({ where: { username: { in: names } }, select: { username: true, scope: true, preset: true } })
    : [];
  const grantsByName = new Map<string, Array<{ scope: string; preset: string }>>();
  for (const g of grantRows) grantsByName.set(g.username, [...(grantsByName.get(g.username) ?? []), { scope: g.scope, preset: g.preset }]);
  const schools = new Map((await listSchools()).map((sc) => [sc.id, sc]));
  const viewer = req.adminUser!.username;
  const now = new Date();
  // Last app sign-in of every listed account; for admins also the panel's
  // login security (second factor required / set up, last panel login).
  const [signIns, panelSecurity] = await Promise.all([
    lastAppSignIns(users.map((u) => u.stableUid), SIGN_IN_PATHS),
    adminSecuritySummaries(users.filter((u) => adminByUid.has(u.stableUid) || isOwner(u.username)).map((u) => u.username)),
  ]);

  const result = users.map((u) => {
    const withClass = hasClassIdentity(u.role);
    const membership = withClass ? u.classMembers[0] : undefined;
    const admin = adminByUid.get(u.stableUid);
    const school = u.schoolId ? schools.get(u.schoolId) : undefined;
    const grants = grantsByName.get(u.username) ?? [];
    return {
      stableUid: u.stableUid,
      username: u.username,
      webuntisKlasseId: withClass ? u.webuntisKlasseId : 0,
      webuntisKlasseName: withClass ? u.webuntisKlasseName : '',
      classId: membership?.classId ?? null,
      classCode: membership?.class?.code ?? null,
      isAdmin: admin !== undefined || isOwner(u.username),
      // "owner" (ADMIN_USERNAMES), "global" (a global grant), "school" (school
      // grants only), "none" (panel access without any right yet), or null.
      adminKind: isOwner(u.username) ? 'owner' : admin ? (grants.some((g) => g.scope === GLOBAL_SCOPE) ? 'global' : grants.length > 0 ? 'school' : 'none') : null,
      adminGrants: grants.map((g) => ({ scope: g.scope, preset: g.preset, schoolName: g.scope === GLOBAL_SCOPE ? null : schools.get(g.scope)?.name ?? null })),
      // Set while a WebUntis account made admin has not signed in yet; the
      // grant lapses at this moment.
      adminSetupExpiresAt: admin?.mustChangePassword ? admin.setupExpiresAt?.toISOString() ?? null : null,
      // Only for the admin who granted it, while it is pending.
      canViewOneTimePassword: admin ? mayViewOneTimePassword(admin, viewer, now) : false,
      // "Admin vergeben" asks for a one-time password for this account.
      needsOneTimePassword: grantNeedsOneTimePassword({ isUntisUser: u.isUntisUser, hasPassword: Boolean(u.passwordHash) }),
      role: u.role,
      isUntisUser: u.isUntisUser,
      schoolId: u.schoolId,
      schoolName: school?.name ?? null,
      todoCount: u._count.todos,
      lastSignInAt: signIns.get(u.stableUid) ?? null,
      adminSecurity: panelSecurity.get(u.username) ?? null,
      createdAt: u.createdAt.toISOString(),
      updatedAt: u.updatedAt.toISOString(),
    };
  });

  // The panel's countdowns run against the server clock.
  res.json({ users: result, total, page: effectivePage, limit, pages: lastPage, serverTime: new Date().toISOString() });
});

// ─── GET /api/admin/users/:stableUid ─────────────────────────────────────────

router.get('/users/:stableUid', requireAdmin, requirePermission('users.view'), async (req: Request, res: Response): Promise<void> => {
  const stableUid = String(req.params['stableUid']);

  await expireLapsedAdminSetups();
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

  if (!user || !inScope(req, user.schoolId)) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const withClass = hasClassIdentity(user.role);
  const needsOneTimePassword = grantNeedsOneTimePassword({ isUntisUser: user.isUntisUser, hasPassword: Boolean(user.passwordHash) });
  const school = user.schoolId ? await schoolById(user.schoolId) : null;
  const grants = isAdmin ? await grantsOf(user.username) : [];
  res.json({
    stableUid: user.stableUid,
    username: user.username,
    webuntisKlasseId: withClass ? user.webuntisKlasseId : 0,
    webuntisKlasseName: withClass ? user.webuntisKlasseName : '',
    isAdmin: !!isAdmin,
    // Whether the account can sign in to the panel with its own password.
    hasPassword: Boolean(user.passwordHash || isAdmin?.passwordHash),
    needsOneTimePassword,
    adminSetupExpiresAt: isAdmin?.mustChangePassword ? isAdmin.setupExpiresAt?.toISOString() ?? null : null,
    canViewOneTimePassword: isAdmin ? mayViewOneTimePassword(isAdmin, req.adminUser!.username, new Date()) : false,
    // An admin that cannot sign in at all (a WebUntis admin made before
    // one-time passwords) gets one through "Admin vergeben" again.
    adminCanSignIn: isAdmin
      ? adminCanSignIn({ adminHash: isAdmin.passwordHash, mustChangePassword: isAdmin.mustChangePassword, needsOneTimePassword })
      : false,
    serverTime: new Date().toISOString(),
    role: user.role,
    isUntisUser: user.isUntisUser,
    schoolId: user.schoolId,
    schoolName: school?.name ?? null,
    isOwner: isOwner(user.username),
    lastSignInAt: (await lastAppSignIns([user.stableUid], SIGN_IN_PATHS)).get(user.stableUid) ?? null,
    adminSecurity: isAdmin || isOwner(user.username) ? (await adminSecuritySummaries([user.username])).get(user.username) ?? null : null,
    adminGrants: grants,
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
    classes: (withClass ? user.classMembers : []).map((m) => ({
      classId: m.classId,
      className: m.class.name,
      classCode: m.class.code,
      joinedAt: m.joinedAt.toISOString(),
    })),
  });
});

// ─── DELETE /api/admin/users/:stableUid ──────────────────────────────────────

router.delete('/users/:stableUid', requireAdmin, requirePermission('users.delete'), async (req: Request, res: Response): Promise<void> => {
  const stableUid = String(req.params['stableUid']);
  const adminUsername = req.adminUser!.username;
  const target = await userInScope(req, stableUid);
  if (!target) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  // Deleting an admin's account ends their admin standing: that needs every
  // right they hold, like revoking it.
  const targetIsAdmin = isOwner(target.username) || (await prisma.admin.findUnique({ where: { stableUid }, select: { stableUid: true } })) !== null;
  if (targetIsAdmin) await assertMayRemoveAdmin(req, target.username, target.schoolId);
  revokeUserTokens(stableUid);
  const deleted = await prisma.user.delete({ where: { stableUid } }).catch(() => null);
  if (deleted) {
    await clearStaleSecondFactors(deleted.username);
    await clearGrants(deleted.username);
    forgetUserSchool(stableUid);
  }
  logger.info('Admin action: delete user', { action: 'delete_user', adminUsername, targetUid: stableUid });
  audit(req, 'user.delete', { type: 'user', id: stableUid }, { admin: targetIsAdmin }, target.schoolId);
  res.status(204).send();
});

// ─── PATCH /api/admin/users/:stableUid/todos/:todoId ─────────────────────────

router.patch('/users/:stableUid/todos/:todoId', requireAdmin, requirePermission('todos.manage'), async (req: Request, res: Response): Promise<void> => {
  const stableUid = String(req.params['stableUid']);
  const todoId = String(req.params['todoId']);
  if (!(await userInScope(req, stableUid))) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  const { title, details, done, dueAt } = req.body as {
    title?: string;
    details?: string;
    done?: boolean;
    dueAt?: string | null;
  };

  const data: Record<string, unknown> = {};
  // Bounded by the column widths (todos.title VARCHAR(500), details VARCHAR(5000)).
  if (title !== undefined) data['title'] = String(title).slice(0, 500);
  if (details !== undefined) data['details'] = String(details).slice(0, 5000);
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

router.delete('/users/:stableUid/todos/:todoId', requireAdmin, requirePermission('todos.manage'), async (req: Request, res: Response): Promise<void> => {
  const stableUid = String(req.params['stableUid']);
  const todoId = String(req.params['todoId']);
  if (!(await userInScope(req, stableUid))) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  await prisma.todo.deleteMany({ where: { id: todoId, stableUid } });
  res.status(204).send();
});

// ─── POST /api/admin/users/:stableUid/todos ───────────────────────────────────

router.post('/users/:stableUid/todos', requireAdmin, requirePermission('todos.manage'), async (req: Request, res: Response): Promise<void> => {
  const stableUid = String(req.params['stableUid']);
  const { title, details, dueAt } = req.body as { title?: string; details?: string; dueAt?: string | null };

  if (!title || String(title).trim().length < 1) {
    res.status(400).json({ error: 'Title is required' });
    return;
  }

  const user = await userInScope(req, stableUid);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const todo = await prisma.todo.create({
    data: {
      stableUid,
      title: String(title).trim().slice(0, 500),
      details: details ? String(details).slice(0, 5000) : '',
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

router.delete('/users/:stableUid/classes/:classId', requireAdmin, requirePermission('classes.manage'), async (req: Request, res: Response): Promise<void> => {
  const stableUid = String(req.params['stableUid']);
  const classId = String(req.params['classId']);
  if (!(await userInScope(req, stableUid))) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  await prisma.classMember.deleteMany({ where: { stableUid, classId } });
  res.status(204).send();
});

// ─── POST /api/admin/users/:stableUid/grant-admin ────────────────────────────

router.post('/users/:stableUid/grant-admin', requireAdmin, requirePermission('users.view'), async (req: Request, res: Response): Promise<void> => {
  const stableUid = String(req.params['stableUid']);
  const adminUsername = req.adminUser!.username;
  const answer = (adminSetupExpiresAt: Date | null) => res.json({
    ok: true,
    adminSetupExpiresAt: adminSetupExpiresAt?.toISOString() ?? null,
    canViewOneTimePassword: adminSetupExpiresAt !== null,
    serverTime: new Date().toISOString(),
  });

  const user = await userInScope(req, stableUid);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  // Appointing an admin, and every right of the grant that comes with it,
  // must be the appointing admin's own; checked before anything changes.
  assertMayAppointAdmin(req, user.schoolId);
  const grant = parseGrantRequest((req.body ?? {} as Record<string, unknown>)['grant']);
  if (grant) await checkGrantRequest(req, grant, user.schoolId);
  const giveGrant = async () => { if (grant) await setGrant(req, user.username, grant.scope, grant.permissions, grant.preset); };

  const needsOneTimePassword = grantNeedsOneTimePassword({ isUntisUser: user.isUntisUser, hasPassword: Boolean(user.passwordHash) });
  if (!needsOneTimePassword) {
    await prisma.admin.upsert({
      where: { stableUid },
      create: { stableUid, canCreateClass: true },
      update: { canCreateClass: true },
    });
    logger.info('Admin action: grant admin', { action: 'grant_admin', adminUsername, targetUid: stableUid });
    audit(req, 'admin.appoint', { type: 'admin', id: user.username }, {}, user.schoolId);
    await giveGrant();
    answer(null);
    return;
  }

  // A WebUntis account has no password the panel could check: it starts with
  // a one-time password from the granting admin and must replace it at its
  // first login within ADMIN_SETUP_WINDOW_MS, or the grant lapses. An admin
  // that already signs in with its own password stays as it is; a pending
  // grant is replaced by this one (new password, new deadline).
  const existing = await prisma.admin.findUnique({ where: { stableUid } });
  if (existing && adminCanSignIn({ adminHash: existing.passwordHash, mustChangePassword: existing.mustChangePassword, needsOneTimePassword })) {
    await giveGrant();
    answer(null);
    return;
  }
  // No body at all is a grant without a password, not a server error.
  const { password } = (req.body ?? {}) as { password?: unknown };
  if (!validOneTimePassword(password)) {
    res.status(422).json({
      error: 'Für einen WebUntis-Account braucht „Admin vergeben“ ein Einmal-Passwort (8 bis 100 Zeichen)',
      code: 'one-time-password-required',
    });
    return;
  }
  const setupExpiresAt = await grantAdminWithOneTimePassword(stableUid, password, adminUsername);
  logger.info('Admin action: grant admin', { action: 'grant_admin', adminUsername, targetUid: stableUid, oneTimePassword: true });
  audit(req, 'admin.appoint', { type: 'admin', id: user.username }, { oneTimePassword: true }, user.schoolId);
  await giveGrant();
  answer(setupExpiresAt);
});

// ─── GET /api/admin/users/:stableUid/one-time-password ───────────────────────
// The pending grant's one-time password again — only for the admin who
// granted it, only until the new admin has their own password or the grant
// lapses. Never any other password.

router.get('/users/:stableUid/one-time-password', requireAdmin, requirePermission('users.view'), async (req: Request, res: Response): Promise<void> => {
  const stableUid = String(req.params['stableUid']);
  const viewer = req.adminUser!.username;
  if (!(await userInScope(req, stableUid))) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  await expireLapsedAdminSetups();
  const found = await viewOneTimePassword(stableUid, viewer);
  res.setHeader('Cache-Control', 'no-store');
  if (!found) {
    res.status(404).json({ error: 'Kein Einmal-Passwort mehr verfügbar — schon angemeldet, abgelaufen oder entzogen' });
    return;
  }
  logger.info('Admin action: one-time password shown again', { action: 'admin_one_time_password_viewed', adminUsername: viewer, targetUid: stableUid });
  res.json({ password: found.password, adminSetupExpiresAt: found.setupExpiresAt.toISOString(), serverTime: new Date().toISOString() });
});

// ─── DELETE /api/admin/users/:stableUid/revoke-admin ─────────────────────────

router.delete('/users/:stableUid/revoke-admin', requireAdmin, requirePermission('users.view'), async (req: Request, res: Response): Promise<void> => {
  const stableUid = String(req.params['stableUid']);
  const adminUsername = req.adminUser!.username;
  const target = await userInScope(req, stableUid);
  if (!target) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  await assertMayRemoveAdmin(req, target.username, target.schoolId);

  await prisma.admin.deleteMany({ where: { stableUid } });
  await clearGrants(target.username);
  await clearStaleSecondFactors(target.username);

  logger.info('Admin action: revoke admin', { action: 'revoke_admin', adminUsername, targetUid: stableUid });
  audit(req, 'admin.revoke', { type: 'admin', id: target.username }, {}, target.schoolId);
  res.status(204).send();
});

// Passkeys, the authenticator app and the login security settings of someone
// who is no longer an admin must not come back to life when the name is later
// made admin again. An env-configured admin keeps them: their access did not end.
async function clearStaleSecondFactors(username: string): Promise<void> {
  const still = await findAdminAccount(username);
  if (!still.ok) {
    await clearSecondFactors(username);
    await clearAdminSecurity(username);
  }
}

// ─── GET /api/admin/classes ───────────────────────────────────────────────────

router.get('/classes', requireAdmin, requirePermission('classes.view'), async (req: Request, res: Response): Promise<void> => {
  const classes = await prisma.class.findMany({
    where: schoolWhere(req),
    orderBy: { createdAt: 'desc' },
    include: {
      // Legacy parent rows remain filtered defensively while normal login and
      // role changes remove them permanently.
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
    schoolId: c.schoolId,
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

router.get('/sessions', requireAdmin, requirePermission('sessions.view'), async (req: Request, res: Response): Promise<void> => {
  const schoolId = scopeSchool(req);
  const tokens = await prisma.refreshToken.findMany({
    where: schoolId ? { user: { schoolId } } : {},
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
router.delete('/sessions', requireAdmin, requirePermission('sessions.revoke'), async (req: Request, res: Response): Promise<void> => {
  const adminUsername = req.adminUser!.username;
  // A school's admin signs out that school's accounts only.
  const schoolId = scopeSchool(req);
  const ofSchool = schoolId ? { user: { schoolId } } : {};

  const active = await prisma.refreshToken.findMany({
    where: { revokedAt: null, ...ofSchool },
    select: { stableUid: true },
  });

  await prisma.refreshToken.deleteMany({ where: ofSchool });

  const seen = new Set<string>();
  for (const t of active) {
    if (!seen.has(t.stableUid)) {
      seen.add(t.stableUid);
      revokeUserTokens(t.stableUid);
    }
  }

  logger.info('Admin action: delete all sessions', { action: 'delete_all_sessions', adminUsername, affectedUsers: seen.size });
  audit(req, 'sessions.revoke_all', { type: 'sessions', id: schoolId ?? 'all' }, { affectedUsers: seen.size });
  res.status(204).send();
});

// ─── DELETE /api/admin/sessions/inactive ── delete only revoked/expired sessions
router.delete('/sessions/inactive', requireAdmin, requirePermission('sessions.revoke'), async (req: Request, res: Response): Promise<void> => {
  const schoolId = scopeSchool(req);
  await prisma.refreshToken.deleteMany({
    where: {
      OR: [
        { revokedAt: { not: null } },
        { expiresAt: { lt: new Date() } },
      ],
      ...(schoolId ? { user: { schoolId } } : {}),
    },
  });

  res.status(204).send();
});

// ─── DELETE /api/admin/sessions/:id ──────────────────────────────────────────

router.delete('/sessions/:id', requireAdmin, requirePermission('sessions.revoke'), async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params['id']);

  const token = await prisma.refreshToken.findUnique({ where: { id }, select: { stableUid: true, user: { select: { schoolId: true } } } });
  if (!token || !inScope(req, token.user.schoolId)) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  await prisma.refreshToken.updateMany({
    where: { id, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  // Force-expire any active access JWTs for this user immediately
  revokeUserTokens(token.stableUid);
  audit(req, 'sessions.revoke', { type: 'user', id: token.stableUid }, {}, token.user.schoolId);

  res.status(204).send();
});

// ─── GET /api/admin/logs ──────────────────────────────────────────────────────
// General request logs with optional filters

router.get('/logs', requireAdmin, requirePermission('requests.view'), async (req: Request, res: Response): Promise<void> => {
  const page = intQueryParam(req.query['page'], 1, 1, 1_000_000);
  const limit = intQueryParam(req.query['limit'], 50, 1, 200);
  const skip = (page - 1) * limit;
  const method = req.query['method'] ? String(req.query['method']).toUpperCase() : undefined;
  const statusRaw = req.query['status'] ? Number.parseInt(String(req.query['status']), 10) : NaN;
  const status = Number.isFinite(statusRaw) ? statusRaw : undefined;
  const pathFilter = req.query['path'] ? String(req.query['path']) : undefined;
  const username = req.query['username'] ? String(req.query['username']) : undefined;
  const scopeRaw = String(req.query['scope'] ?? '');
  // The admin panel's own requests only for who monitors the system, and
  // never in a school's view.
  const seesAdminTraffic = scopeSchool(req) === null && can(req.adminAccess!, 'system.monitoring.view', null);
  const scope = scopeRaw === 'learn' || scopeRaw === 'core' || (scopeRaw === 'admin' && seesAdminTraffic) ? scopeRaw : undefined;
  const from = req.query['from'] ? new Date(String(req.query['from'])) : undefined;
  // A day (YYYY-MM-DD, to its end) or an exact time (the panel's local days).
  const toRaw = req.query['to'] ? String(req.query['to']) : '';
  const to = toRaw ? new Date(toRaw.includes('T') ? toRaw : `${toRaw}T23:59:59.999Z`) : undefined;

  const where: Prisma.RequestLogWhereInput = { ...schoolWhere(req), ...(scope || seesAdminTraffic ? {} : APP_TRAFFIC_WHERE) };
  if (method) where['method'] = method;
  if (status) where['status'] = { gte: status, lt: status + 100 };
  if (pathFilter) where['path'] = { contains: likeText(pathFilter) };
  if (username) where['username'] = { contains: likeText(username) };
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

  res.json({ logs: logs.map((log) => networkDetailsFor(req, log)), total, page, limit });
});

// Addresses and user agents are for the system's operators (security,
// abuse); a school's view gets path, status, time and account only.
function networkDetailsFor<T extends { ip: string | null; userAgent: string | null }>(req: Request, log: T): T {
  if (scopeSchool(req) === null && can(req.adminAccess!, 'system.logs.view', null)) return log;
  return { ...log, ip: null, userAgent: null };
}

// ─── GET /api/admin/logs/users/:stableUid ────────────────────────────────────
// Per-user request log

router.get('/logs/users/:stableUid', requireAdmin, requirePermission('requests.view'), async (req: Request, res: Response): Promise<void> => {
  const stableUid = String(req.params['stableUid']);
  const page = intQueryParam(req.query['page'], 1, 1, 1_000_000);
  const limit = intQueryParam(req.query['limit'], 50, 1, 200);
  const skip = (page - 1) * limit;

  const user = await userInScope(req, stableUid);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  const [logs, total] = await Promise.all([
    prisma.requestLog.findMany({
      where: { stableUid },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.requestLog.count({ where: { stableUid } }),
  ]);

  res.json({ logs: logs.map((log) => networkDetailsFor(req, log)), total, page, limit, user: { username: user.username } });
});

// ─── POST /api/admin/classes ──────────────────────────────────────────────────

router.post('/classes', requireAdmin, requirePermission('classes.manage'), async (req: Request, res: Response): Promise<void> => {
  const { name, code, webuntisKlasseId, schoolId: requestedSchool } = req.body as {
    name?: string;
    code?: string;
    webuntisKlasseId?: number;
    schoolId?: unknown;
  };

  if (!name || typeof name !== 'string' || name.trim().length < 1) {
    res.status(400).json({ error: 'Class name is required' });
    return;
  }

  const classCode = (typeof code === 'string' && code.trim() ? code.trim().toUpperCase() : generateClassCode()).slice(0, 6);
  const schoolId = await targetSchoolFor(req, requestedSchool);

  const newClass = await prisma.class.create({
    data: {
      id: generateClassId(),
      name: name.trim().slice(0, 100),
      code: classCode,
      webuntisKlasseId: typeof webuntisKlasseId === 'number' && Number.isInteger(webuntisKlasseId) ? webuntisKlasseId : 0,
      createdBy: 'admin',
      createdByName: req.adminUser!.username,
      schoolId,
    },
    include: {
      members: { select: { stableUid: true, username: true, joinedAt: true } },
    },
  });

  audit(req, 'class.create', { type: 'class', id: newClass.id }, { name: newClass.name }, schoolId);
  res.status(201).json({
    id: newClass.id,
    name: newClass.name,
    code: newClass.code,
    schoolId: newClass.schoolId,
    webuntisKlasseId: newClass.webuntisKlasseId,
    createdBy: newClass.createdBy,
    createdByName: newClass.createdByName,
    createdAt: newClass.createdAt.toISOString(),
    memberCount: 0,
    members: [],
  });
});

// ─── DELETE /api/admin/classes/:id ───────────────────────────────────────────

router.delete('/classes/:id', requireAdmin, requirePermission('classes.manage'), async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params['id']);
  const cls = await classInScope(req, id);
  if (!cls) {
    res.status(404).json({ error: 'Class not found' });
    return;
  }
  await prisma.class.delete({ where: { id } }).catch(() => null);
  audit(req, 'class.delete', { type: 'class', id }, { name: cls.name }, cls.schoolId);
  res.status(204).send();
});

// ─── GET /api/admin/classes/:id/reminders ────────────────────────────────────

router.get('/classes/:id/reminders', requireAdmin, requirePermission('classes.view'), async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params['id']);
  if (!(await classInScope(req, id))) {
    res.status(404).json({ error: 'Class not found' });
    return;
  }
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

router.post('/classes/:id/reminders', requireAdmin, requirePermission('classes.manage'), async (req: Request, res: Response): Promise<void> => {
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

  const cls = await classInScope(req, id);
  if (!cls) {
    res.status(404).json({ error: 'Class not found' });
    return;
  }

  const reminder = await prisma.reminder.create({
    data: {
      classId: id,
      title: String(title).trim().slice(0, 500),
      body: body ? String(body).slice(0, 5000) : '',
      remindAt: new Date(remindAt),
      createdBy: 'admin',
      createdByName: req.adminUser!.username,
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

router.patch('/reminders/:id', requireAdmin, requirePermission('classes.manage'), async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params['id']);
  const { title, body, remindAt } = req.body as { title?: string; body?: string; remindAt?: string };
  if (!(await reminderInScope(req, id))) {
    res.status(404).json({ error: 'Reminder not found' });
    return;
  }

  const data: Record<string, unknown> = {};
  if (title !== undefined) data['title'] = String(title).trim().slice(0, 500);
  if (body !== undefined) data['body'] = String(body).slice(0, 5000);
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

router.delete('/reminders/:id', requireAdmin, requirePermission('classes.manage'), async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params['id']);
  const reminder = await reminderInScope(req, id);
  if (!reminder) {
    res.status(404).json({ error: 'Reminder not found' });
    return;
  }
  await prisma.reminder.delete({ where: { id } }).catch(() => null);
  audit(req, 'reminder.delete', { type: 'reminder', id }, {}, reminder.class.schoolId);
  res.status(204).send();
});

// ─── POST /api/admin/classes/:id/members ─────────────────────────────────────

router.post('/classes/:id/members', requireAdmin, requirePermission('classes.manage'), async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params['id']);
  const { username } = req.body as { username?: string };
  if (!username?.trim()) {
    res.status(400).json({ error: 'username required' });
    return;
  }
  const cls = await classInScope(req, id);
  if (!cls) {
    res.status(404).json({ error: 'Class not found' });
    return;
  }
  const user = await prisma.user.findUnique({ where: { username: username.trim().toLowerCase() } });
  // Only an account of the class's own school can join it.
  if (!user || (user.schoolId ?? defaultSchoolId()) !== (cls.schoolId ?? defaultSchoolId())) {
    res.status(404).json({ error: `User "${username.trim()}" not found` });
    return;
  }
  if (!hasClassIdentity(user.role)) {
    res.status(409).json({
      error: user.role === 'parent'
        ? 'Eltern-Accounts werden keiner Klasse zugeteilt'
        : 'Konten ohne Rolle werden keiner Klasse zugeteilt',
    });
    return;
  }
  await prisma.classMember.upsert({
    where: { classId_stableUid: { classId: id, stableUid: user.stableUid } },
    create: { classId: id, stableUid: user.stableUid, username: user.username, role: 'student' },
    update: { username: user.username, role: 'student' },
  });
  res.json({ stableUid: user.stableUid, username: user.username, joinedAt: new Date().toISOString() });
});

// ─── GET /api/admin/stats/requests-chart ─────────────────────────────────────
// Requests per hour for the last 24 hours

router.get('/stats/requests-chart', requireAdmin, requirePermission('dashboard.view'), async (req: Request, res: Response): Promise<void> => {
  type HourRow = { hour: string; count: bigint; errors: bigint };

  // The apps' requests only: the panel's own polling is not activity.
  const rows = await prisma.$queryRaw<HourRow[]>`
    SELECT
      DATE_FORMAT(created_at, '%Y-%m-%d %H:00') AS hour,
      COUNT(*) AS count,
      SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors
    FROM request_logs
    WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)${APP_TRAFFIC}${schoolSql(req)}
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

// ─── GET /api/admin/live ─────────────────────────────────────────────────────
// A server-sent stream that says only *that* something changed and in which
// area of the panel — never the data itself. The panel answers by refetching
// through its normal, authorised endpoints (see services/adminLive.ts).

// Allowed while a second factor is still to be set up: it only names areas that
// changed, and the set-up screen learns from it when the requirement is lifted.
router.get('/live', allowDuringSecondFactorSetup, requireAdmin, (_req: Request, res: Response): void => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  res.flushHeaders();
  sseManager.addClient(ADMIN_LIVE_KEY, res);
  res.write('event: ready\ndata: {}\n\n');
});

// ─── GET /api/admin/stats/top-endpoints ──────────────────────────────────────

router.get('/stats/top-endpoints', requireAdmin, requirePermission('dashboard.view'), async (req: Request, res: Response): Promise<void> => {
  type EndpointRow = { path: string; count: bigint; totalMs: unknown };

  // Raw paths first (ids included), then grouped by route in code: a route
  // such as /dish-ratings/:id would otherwise split into hundreds of rows.
  const rows = await prisma.$queryRaw<EndpointRow[]>`
    SELECT path, COUNT(*) AS count, SUM(duration) AS totalMs
    FROM request_logs
    WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)${APP_TRAFFIC}${schoolSql(req)}
    GROUP BY path
    ORDER BY count DESC
    LIMIT 500
  `;
  const grouped = new Map<string, { path: string; count: number; totalMs: number }>();
  for (const row of rows) {
    const path = endpointOf(row.path);
    const entry = grouped.get(path) ?? { path, count: 0, totalMs: 0 };
    entry.count += Number(row.count);
    entry.totalMs += Number(row.totalMs ?? 0);
    grouped.set(path, entry);
  }

  res.json([...grouped.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)
    .map((e) => ({ path: e.path, count: e.count, avgMs: e.count > 0 ? Math.round(e.totalMs / e.count) : 0 })));
});

// ─── GET /api/admin/classes/:id/todos ────────────────────────────────────────

router.get('/classes/:id/todos', requireAdmin, requirePermission('todos.view'), async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params['id']);
  if (!(await classInScope(req, id))) {
    res.status(404).json({ error: 'Class not found' });
    return;
  }

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

router.get('/dishes', requireAdmin, requirePermission('mensa.view'), async (req: Request, res: Response): Promise<void> => {
  const planParam = req.query['plan'];
  const menuId = await menuFor(req, req.query['menuId']);
  if (!menuId) {
    res.json([]);
    return;
  }
  const dishes = await prisma.dish.findMany({
    where: { menuId, ...(planParam === 'summer' || planParam === 'winter' ? { plan: planParam } : {}) },
    orderBy: [{ date: 'asc' }, { sortOrder: 'asc' }, { nameDe: 'asc' }],
  });
  res.json(dishes.map(dishRow));
});

// ─── POST /api/admin/dishes ───────────────────────────────────────────────────

router.post('/dishes', requireAdmin, requirePermission('mensa.manage'), async (req: Request, res: Response): Promise<void> => {
  const b = req.body as Record<string, unknown>;
  if (!b['nameDe'] || String(b['nameDe']).trim().length < 1) {
    res.status(400).json({ error: 'nameDe is required' });
    return;
  }
  if (!b['date']) {
    res.status(400).json({ error: 'date is required' });
    return;
  }
  const menuId = await editableMenu(req, b['menuId']);

  const dish = await prisma.dish.create({
    data: {
      menuId,
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

router.patch('/dishes/:id', requireAdmin, requirePermission('mensa.manage'), async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params['id']);
  const b = req.body as Record<string, unknown>;
  await editableDish(req, id);

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

router.delete('/dishes/:id', requireAdmin, requirePermission('mensa.manage'), async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params['id']);
  const dish = await editableDish(req, id);
  await prisma.dish.delete({ where: { id } }).catch(() => null);
  await prisma.dishImage.deleteMany({ where: { dishId: id } });
  invalidateDishesCache();
  audit(req, 'mensa.dish.delete', { type: 'dish', id }, { name: dish.nameDe, menuId: dish.menuId });
  res.status(204).send();
});

// ─── POST /api/admin/dishes/import-url ───────────────────────────────────────
// Fetches the external mensa.json URL and bulk-upserts all dishes

router.post('/dishes/import-url', requireAdmin, requirePermission('mensa.manage'), async (req: Request, res: Response): Promise<void> => {
  const url = String(req.body?.url || config.mensaImportUrl);
  const plan = parsePlan(req.body?.plan);
  if (!url) {
    res.status(400).json({ error: 'Enter the address of the menu (mensa.json) or set MENSA_IMPORT_URL' });
    return;
  }
  const menuId = await editableMenu(req, req.body?.menuId);

  let raw: string;
  try {
    raw = await fetchUrl(url, { publicOnly: !importMayReachInternal(req, url) });
  } catch (err) {
    res.status(502).json({ error: err instanceof BlockedAddressError ? err.message : 'Failed to fetch external URL' });
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
      menuId,
      sourceId,
      stableKey: slugifyDishName(name.de.trim()),
      weekOrdinal: weekOrdinalFromSourceId(sourceId) || dateToOrdinalFallback.get(dateRaw) || 0,
    };

    // Match by (menu, plan, sourceId) so the same source JSON can populate
    // BOTH plans — and several menus — independently. Fall back to plain id
    // for legacy rows that were imported before sourceId existed.
    let existing = sourceId
      ? await prisma.dish.findFirst({ where: { menuId, plan, sourceId } })
      : null;
    if (!existing && sourceId) {
      const legacy = await prisma.dish.findUnique({ where: { id: sourceId } });
      if (legacy && legacy.plan === plan && legacy.menuId === menuId) existing = legacy;
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
  audit(req, 'mensa.import', { type: 'menu', id: menuId }, { plan, imported, updated });
  res.json({ imported, updated, total: imported + updated, plan });
});

// ─── POST /api/admin/dishes/reset ────────────────────────────────────────────
// Wipes every dish for the given plan and re-imports fresh from the source URL.
// Handy when local edits have drifted too far from the canonical mensa.json.

router.post('/dishes/reset', requireAdmin, requirePermission('mensa.manage'), async (req: Request, res: Response): Promise<void> => {
  const plan = parsePlan(req.body?.plan);
  const url = String(req.body?.url || config.mensaImportUrl);
  if (!url) {
    res.status(400).json({ error: 'Enter the address of the menu (mensa.json) or set MENSA_IMPORT_URL' });
    return;
  }
  const menuId = await editableMenu(req, req.body?.menuId);

  let raw: string;
  try {
    raw = await fetchUrl(url, { publicOnly: !importMayReachInternal(req, url) });
  } catch (err) {
    res.status(502).json({ error: err instanceof BlockedAddressError ? err.message : 'Failed to fetch external URL' });
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
    const deleted = await tx.dish.deleteMany({ where: { menuId, plan } });
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
          menuId,
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
  audit(req, 'mensa.reset', { type: 'menu', id: menuId }, { plan, ...result });
  res.json({ ...result, plan });
});

// ─── POST /api/admin/dishes/cascade-shift ────────────────────────────────────
// Shifts date of every dish in `plan` with date >= fromWeek by offsetDays.
// Used to cascade a manual week-date change to all following weeks.

router.post('/dishes/cascade-shift', requireAdmin, requirePermission('mensa.manage'), async (req: Request, res: Response): Promise<void> => {
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
  const menuId = await editableMenu(req, req.body?.menuId);

  // Prisma updateMany can't express DATE_ADD, so we shift with one raw UPDATE
  // for atomicity and constant round-trips regardless of row count.
  const shifted = await prisma.$executeRaw`UPDATE dishes SET date = DATE_ADD(date, INTERVAL ${offsetDays} DAY) WHERE menu_id = ${menuId} AND plan = ${plan} AND date >= ${fromDate}`;

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

router.post('/dishes/anchor-week', requireAdmin, requirePermission('mensa.manage'), async (req: Request, res: Response): Promise<void> => {
  const plan = parsePlan(req.body?.plan);
  const chosenRaw = req.body?.chosenWeek ? String(req.body.chosenWeek) : '';
  const targetRaw = req.body?.targetMonday ? String(req.body.targetMonday) : '';
  const alignOther = req.body?.alignOtherPlan !== false; // default true

  if (!/^\d{4}-\d{2}-\d{2}$/.test(chosenRaw) || !/^\d{4}-\d{2}-\d{2}$/.test(targetRaw)) {
    res.status(400).json({ error: 'chosenWeek and targetMonday must be YYYY-MM-DD' });
    return;
  }

  const menuId = await editableMenu(req, req.body?.menuId);
  const result = await prisma.$transaction(async (tx) => {
    const normalized = await normalizePlanAroundAnchor(tx, menuId, plan, chosenRaw, targetRaw);
    const rotated = await rotatePastWeeks(menuId, plan, tx);

    let otherAligned = 0;
    let otherAnchorDate: string | null = null;
    let otherRotated = 0;
    if (alignOther) {
      const lastMon = await lastFutureMondayIso(tx, menuId, plan);
      const otherFirst = await firstMondayIso(tx, menuId, otherPlan(plan));
      if (lastMon && otherFirst) {
        // First Monday after this plan's end, then snap into the other plan's
        // season (in case this plan ends deep inside its own season).
        const rawStart = isoAddDays(lastMon, 7);
        const snapped = snapForwardToSeason(new Date(rawStart + 'T00:00:00Z'), otherPlan(plan));
        otherAnchorDate = snapped.toISOString().split('T')[0]!;
        otherAligned = await normalizePlanAroundAnchor(tx, menuId, otherPlan(plan), otherFirst, otherAnchorDate);
        otherRotated = await rotatePastWeeks(menuId, otherPlan(plan), tx);
      }
    }

    return { normalized, rotated, otherAligned, otherAnchorDate, otherRotated };
  });

  invalidateDishesCache();
  res.json(result);
});

// ─── POST /api/admin/dishes/auto-rotate ──────────────────────────────────────
// Delegates to the shared rotate helper. Cheap to call repeatedly.

router.post('/dishes/auto-rotate', requireAdmin, requirePermission('mensa.manage'), async (req: Request, res: Response): Promise<void> => {
  const plan = parsePlan(req.body?.plan);
  const menuId = await editableMenu(req, req.body?.menuId);
  const rotated = await rotatePastWeeks(menuId, plan);
  if (rotated > 0) invalidateDishesCache();
  res.json({ rotated });
});

// ─── GET /api/admin/dish-ratings ─────────────────────────────────────────────

router.get('/dish-ratings', requireAdmin, requirePermission('comments.view'), async (req: Request, res: Response): Promise<void> => {
  const menuId = await menuFor(req, req.query['menuId']);
  if (!menuId) {
    res.json([]);
    return;
  }
  // A school's view: the votes of its own accounts only (names and stars are
  // personal data of another school's pupils otherwise).
  const [allDishes, rows] = await Promise.all([
    prisma.dish.findMany({ where: { menuId }, orderBy: { nameDe: 'asc' } }),
    prisma.dishRating.findMany({ where: { menuId, ...schoolWhere(req) }, orderBy: [{ dishId: 'asc' }, { createdAt: 'asc' }] }),
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

router.patch('/dish-ratings/:dishId/:stableUid', requireAdmin, requirePermission('comments.moderate'), async (req: Request, res: Response): Promise<void> => {
  const dishId = String(req.params['dishId']);
  const stableUid = String(req.params['stableUid']);
  const { stars } = req.body as { stars?: number };

  if (!stars || typeof stars !== 'number' || !Number.isInteger(stars) || stars < 1 || stars > 5) {
    res.status(400).json({ error: 'stars must be an integer 1-5' });
    return;
  }
  const rating = await prisma.dishRating.findUnique({ where: { dishId_stableUid: { dishId, stableUid } } });
  if (!rating || !inScope(req, rating.schoolId)) {
    res.status(404).json({ error: 'Rating not found' });
    return;
  }

  await prisma.dishRating.update({
    where: { dishId_stableUid: { dishId, stableUid } },
    data: { stars },
  });
  await publishDishRatings(rating.menuId, dishId);
  audit(req, 'rating.update', { type: 'rating', id: `${dishId}/${stableUid}` }, { from: rating.stars, to: stars }, rating.schoolId);

  res.status(204).send();
});

// ─── DELETE /api/admin/dish-ratings/:dishId/:stableUid ───────────────────────

router.delete('/dish-ratings/:dishId/:stableUid', requireAdmin, requirePermission('comments.moderate'), async (req: Request, res: Response): Promise<void> => {
  const dishId = String(req.params['dishId']);
  const stableUid = String(req.params['stableUid']);
  const rating = await prisma.dishRating.findUnique({ where: { dishId_stableUid: { dishId, stableUid } } });
  if (!rating || !inScope(req, rating.schoolId)) {
    res.status(404).json({ error: 'Rating not found' });
    return;
  }

  await prisma.dishRating.delete({
    where: { dishId_stableUid: { dishId, stableUid } },
  }).catch(() => null);
  await publishDishRatings(rating.menuId, dishId);
  audit(req, 'rating.delete', { type: 'rating', id: `${dishId}/${stableUid}` }, { stars: rating.stars }, rating.schoolId);

  res.status(204).send();
});

// ─── GET /api/admin/comments ─────────────────────────────────────────────────
// Returns all reminder comments + dish comments, newest first, paginated

router.get('/comments', requireAdmin, requirePermission('comments.view'), async (req: Request, res: Response): Promise<void> => {
  const page = intQueryParam(req.query['page'], 1, 1, 1_000_000);
  const limit = intQueryParam(req.query['limit'], 50, 1, 100);
  const skip = (page - 1) * limit;
  const type = String(req.query['type'] ?? 'all');
  const search = String(req.query['search'] ?? '').trim().toLowerCase().slice(0, 100);
  const sortBy = (['createdAt', 'username', 'body'] as const).includes(req.query['sortBy'] as 'createdAt')
    ? (req.query['sortBy'] as 'createdAt' | 'username' | 'body')
    : 'createdAt';
  const sortOrder = req.query['sortOrder'] === 'asc' ? 'asc' : 'desc';
  const schoolId = scopeSchool(req);

  const where: Record<string, unknown> = search
    ? { OR: [{ body: { contains: likeText(search) } }, { username: { contains: likeText(search) } }] }
    : {};
  // Reminder comments belong to a class's school, dish comments to their
  // author's.
  const reminderWhere = { ...where, ...(schoolId ? { reminder: { class: { schoolId } } } : {}) };
  const dishWhere = { ...where, ...(schoolId ? { schoolId } : {}) };

  const orderBy = [{ [sortBy]: sortOrder }, { id: 'asc' as const }];
  // "all" merges both lists: each side needs at most skip+limit rows.
  const window = type === 'all' ? { skip: 0, take: skip + limit } : { skip, take: limit };

  const [reminderComments, dishComments, totalReminder, totalDish] = await Promise.all([
    type === 'dish' ? Promise.resolve([]) : prisma.comment.findMany({
      where: reminderWhere,
      orderBy,
      ...window,
      include: { reminder: { select: { id: true, title: true, classId: true } } },
    }),
    type === 'reminder' ? Promise.resolve([]) : prisma.dishComment.findMany({
      where: dishWhere,
      orderBy,
      ...window,
    }),
    type === 'dish' ? Promise.resolve(0) : prisma.comment.count({ where: reminderWhere }),
    type === 'reminder' ? Promise.resolve(0) : prisma.dishComment.count({ where: dishWhere }),
  ]);

  const names = await dishNames(dishComments.map((c) => ({ menuId: c.menuId, dishId: c.dishId })));

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
      contextTitle: names.get(`${c.menuId ?? ''}|${c.dishId}`)?.name ?? c.dishId,
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

// The name and picture of dishes by menu and stable key — from any plan and
// day the dish appears on. A dish that no longer exists has none: the panel
// shows it as deleted, its comments stay reachable.
async function dishNames(refs: Array<{ menuId: string | null; dishId: string }>): Promise<Map<string, { name: string; imageUrl: string }>> {
  const keys = [...new Set(refs.map((r) => r.dishId))];
  const out = new Map<string, { name: string; imageUrl: string }>();
  if (keys.length === 0) return out;
  const dishes = await prisma.dish.findMany({
    where: { stableKey: { in: keys } },
    select: { menuId: true, stableKey: true, nameDe: true, imageUrl: true },
    orderBy: { date: 'asc' },
  });
  for (const d of dishes) {
    const id = `${d.menuId ?? ''}|${d.stableKey}`;
    const known = out.get(id);
    if (!known || (!known.imageUrl && d.imageUrl)) out.set(id, { name: d.nameDe, imageUrl: d.imageUrl });
  }
  return out;
}

// ─── GET /api/admin/comments/dishes ──────────────────────────────────────────
// The Kommentare page's main view: one row per dish of a menu with its
// comment count, latest comment and rating — grouped by the dish's stable
// key (what comments and votes reference), never by display name. A school's
// view counts its own accounts' comments and votes only.

router.get('/comments/dishes', requireAdmin, requirePermission('comments.view'), async (req: Request, res: Response): Promise<void> => {
  const menuId = await menuFor(req, req.query['menuId']);
  const page = intQueryParam(req.query['page'], 1, 1, 1_000_000);
  const limit = intQueryParam(req.query['limit'], 30, 1, 100);
  const search = String(req.query['search'] ?? '').trim().slice(0, 100);
  const sortRaw = String(req.query['sort'] ?? 'latest');
  const sort = sortRaw === 'comments' || sortRaw === 'rating' || sortRaw === 'name' ? sortRaw : 'latest';
  if (!menuId) {
    res.json({ dishes: [], total: 0, page: 1, limit, menuId: null });
    return;
  }
  // Dish keys whose name matches the search, so a dish is found by its name
  // as well as by what was written about it.
  let nameKeys: string[] = [];
  if (search) {
    const named = await prisma.dish.findMany({
      where: { menuId, OR: [{ nameDe: { contains: likeText(search) } }, { nameIt: { contains: likeText(search) } }, { nameEn: { contains: likeText(search) } }] },
      select: { stableKey: true },
      distinct: ['stableKey'],
      take: 500,
    });
    nameKeys = named.map((d) => d.stableKey);
  }
  const like = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const searchSql = search
    ? Prisma.sql` AND (c.body LIKE ${like} OR c.username LIKE ${like}${nameKeys.length > 0 ? Prisma.sql` OR c.dish_id IN (${Prisma.join(nameKeys)})` : Prisma.empty})`
    : Prisma.empty;

  type GroupRow = { dishId: string; comments: bigint; latest: Date };
  const groups = await prisma.$queryRaw<GroupRow[]>`
    SELECT c.dish_id AS dishId, COUNT(*) AS comments, MAX(c.created_at) AS latest
    FROM dish_comments c
    WHERE c.menu_id = ${menuId}${schoolSql(req, 'c.school_id')}${searchSql}
    GROUP BY c.dish_id`;

  type RatingRow = { dishId: string; n: bigint; avgStars: unknown };
  const keys = groups.map((g) => g.dishId);
  const ratings = keys.length > 0
    ? await prisma.$queryRaw<RatingRow[]>`
        SELECT dish_id AS dishId, COUNT(*) AS n, AVG(stars) AS avgStars FROM dish_ratings
        WHERE menu_id = ${menuId} AND dish_id IN (${Prisma.join(keys)})${schoolSql(req)}
        GROUP BY dish_id`
    : [];
  const ratingOf = new Map(ratings.map((r) => [r.dishId, { count: Number(r.n), avg: Math.round(Number(r.avgStars ?? 0) * 10) / 10 }]));
  const names = await dishNames(keys.map((dishId) => ({ menuId, dishId })));

  const rows = groups.map((g) => {
    const known = names.get(`${menuId}|${g.dishId}`);
    const rating = ratingOf.get(g.dishId);
    return {
      dishId: g.dishId,
      name: known?.name ?? null,
      imageUrl: known?.imageUrl ?? '',
      deleted: !known,
      comments: Number(g.comments),
      latestAt: new Date(g.latest).toISOString(),
      ratingCount: rating?.count ?? 0,
      avgStars: rating && rating.count > 0 ? rating.avg : null,
    };
  });
  rows.sort((a, b) => {
    if (sort === 'comments') return b.comments - a.comments || b.latestAt.localeCompare(a.latestAt);
    if (sort === 'rating') return (b.avgStars ?? -1) - (a.avgStars ?? -1) || b.comments - a.comments;
    if (sort === 'name') return (a.name ?? a.dishId).localeCompare(b.name ?? b.dishId, 'de');
    return b.latestAt.localeCompare(a.latestAt);
  });
  const total = rows.length;
  const pageRows = rows.slice((page - 1) * limit, page * limit);
  res.json({ dishes: pageRows, total, page, limit, menuId, totalComments: rows.reduce((sum, r) => sum + r.comments, 0) });
});

// ─── GET /api/admin/comments/dishes/:dishId ──────────────────────────────────
// One dish's comments, each with its author's rating of that dish.

router.get('/comments/dishes/:dishId', requireAdmin, requirePermission('comments.view'), async (req: Request, res: Response): Promise<void> => {
  const dishId = String(req.params['dishId']).slice(0, 200);
  const menuId = await menuFor(req, req.query['menuId']);
  const page = intQueryParam(req.query['page'], 1, 1, 1_000_000);
  const limit = intQueryParam(req.query['limit'], 50, 1, 200);
  const sortRaw = String(req.query['sort'] ?? 'newest');
  if (!menuId) {
    res.status(404).json({ error: 'Mensaplan nicht gefunden' });
    return;
  }
  const where: Prisma.DishCommentWhereInput = { menuId, dishId, ...schoolWhere(req) };
  const [all, ratings, names] = await Promise.all([
    prisma.dishComment.findMany({ where, orderBy: [{ createdAt: sortRaw === 'oldest' ? 'asc' : 'desc' }, { id: 'asc' }] }),
    prisma.dishRating.findMany({ where: { menuId, dishId, ...schoolWhere(req) }, select: { stableUid: true, stars: true } }),
    dishNames([{ menuId, dishId }]),
  ]);
  const starsOf = new Map(ratings.map((r) => [r.stableUid, r.stars]));
  const comments = all.map((c) => ({
    id: c.id,
    stableUid: c.stableUid,
    username: c.username,
    body: c.body,
    stars: starsOf.get(c.stableUid) ?? null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    edited: c.updatedAt.getTime() - c.createdAt.getTime() > 1000,
  }));
  if (sortRaw === 'rating-low') comments.sort((a, b) => (a.stars ?? 6) - (b.stars ?? 6));
  if (sortRaw === 'rating-high') comments.sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0));
  const known = names.get(`${menuId}|${dishId}`);
  res.json({
    dish: { dishId, name: known?.name ?? null, imageUrl: known?.imageUrl ?? '', deleted: !known },
    comments: comments.slice((page - 1) * limit, page * limit),
    total: comments.length,
    page,
    limit,
  });
});

// ─── GET /api/admin/comments/reminders ───────────────────────────────────────
// Reminder comments grouped by their reminder, newest activity first.

router.get('/comments/reminders', requireAdmin, requirePermission('comments.view'), async (req: Request, res: Response): Promise<void> => {
  const page = intQueryParam(req.query['page'], 1, 1, 1_000_000);
  const limit = intQueryParam(req.query['limit'], 30, 1, 100);
  const search = String(req.query['search'] ?? '').trim().slice(0, 100);
  const schoolId = scopeSchool(req);
  const groups = await prisma.comment.groupBy({
    by: ['reminderId'],
    where: {
      ...(schoolId ? { reminder: { class: { schoolId } } } : {}),
      ...(search ? { OR: [{ body: { contains: likeText(search) } }, { username: { contains: likeText(search) } }, { reminder: { title: { contains: likeText(search) } } }] } : {}),
    },
    _count: { _all: true },
    _max: { createdAt: true },
  });
  groups.sort((a, b) => (b._max.createdAt?.getTime() ?? 0) - (a._max.createdAt?.getTime() ?? 0));
  const pageGroups = groups.slice((page - 1) * limit, page * limit);
  const reminders = await prisma.reminder.findMany({
    where: { id: { in: pageGroups.map((g) => g.reminderId) } },
    select: { id: true, title: true, classId: true, remindAt: true, class: { select: { name: true } } },
  });
  const byId = new Map(reminders.map((r) => [r.id, r]));
  res.json({
    reminders: pageGroups.map((g) => {
      const r = byId.get(g.reminderId);
      return {
        reminderId: g.reminderId,
        title: r?.title ?? null,
        className: r?.class.name ?? null,
        remindAt: r?.remindAt.toISOString() ?? null,
        comments: g._count._all,
        latestAt: g._max.createdAt?.toISOString() ?? null,
      };
    }),
    total: groups.length,
    page,
    limit,
  });
});

router.get('/comments/reminders/:reminderId', requireAdmin, requirePermission('comments.view'), async (req: Request, res: Response): Promise<void> => {
  const reminder = await reminderInScope(req, String(req.params['reminderId']));
  if (!reminder) {
    res.status(404).json({ error: 'Reminder not found' });
    return;
  }
  const comments = await prisma.comment.findMany({ where: { reminderId: reminder.id }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] });
  res.json({
    reminder: { reminderId: reminder.id, title: reminder.title, classId: reminder.classId },
    comments: comments.map((c) => ({
      id: c.id,
      stableUid: c.stableUid,
      username: c.username,
      body: c.body,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    })),
  });
});

// ─── DELETE /api/admin/comments/reminder/:id ─────────────────────────────────

router.delete('/comments/reminder/:id', requireAdmin, requirePermission('comments.moderate'), async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params['id']);
  const comment = await prisma.comment.findUnique({ where: { id }, include: { reminder: { select: { class: { select: { schoolId: true } } } } } });
  if (!comment || !inScope(req, comment.reminder.class.schoolId)) {
    res.status(404).json({ error: 'Comment not found' });
    return;
  }
  await prisma.comment.delete({ where: { id } }).catch(() => null);
  audit(req, 'comment.delete', { type: 'reminder_comment', id }, { reminderId: comment.reminderId }, comment.reminder.class.schoolId);
  res.status(204).send();
});

// ─── DELETE /api/admin/comments/dish/:id ─────────────────────────────────────

router.delete('/comments/dish/:id', requireAdmin, requirePermission('comments.moderate'), async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params['id']);
  const comment = await prisma.dishComment.findUnique({ where: { id } });
  if (!comment || !inScope(req, comment.schoolId)) {
    res.status(404).json({ error: 'Comment not found' });
    return;
  }
  const deleted = await prisma.dishComment.delete({ where: { id } }).catch(() => null);
  if (deleted) {
    await publishDishComments(deleted.menuId, deleted.dishId);
    audit(req, 'comment.delete', { type: 'dish_comment', id }, { dishId: deleted.dishId }, deleted.schoolId);
  }
  res.status(204).send();
});

// ─── GET /api/admin/file-logs ─────────────────────────────────────────────────

router.get('/file-logs', requireAdmin, requirePermission('system.logs.view'), async (_req: Request, res: Response): Promise<void> => {
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

router.get('/file-logs/:date', requireAdmin, requirePermission('system.logs.view'), async (req: Request, res: Response): Promise<void> => {
  const dateParam = String(req.params['date']);
  // Path traversal protection
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    res.status(400).json({ error: 'Invalid date format' });
    return;
  }

  const filename = `app-${dateParam}.log`;
  const filePath = path.join(process.cwd(), 'logs', filename);

  const page = intQueryParam(req.query['page'], 1, 1, 1_000_000);
  const limit = intQueryParam(req.query['limit'], 100, 1, 500);

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
router.get('/subject-images/:subject/preview', requireAdmin, requirePermission('subjectimages.manage'), async (req: Request, res: Response): Promise<void> => {
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
router.get('/subject-images', requireAdmin, requirePermission('subjectimages.manage'), async (_req: Request, res: Response): Promise<void> => {
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

router.put('/subject-images/:subject', requireAdmin, requirePermission('subjectimages.manage'), async (req: Request, res: Response): Promise<void> => {
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
router.delete('/subject-images/:subject', requireAdmin, requirePermission('subjectimages.manage'), async (req: Request, res: Response): Promise<void> => {
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
router.put('/dishes/:id/image', requireAdmin, requirePermission('mensa.manage'), async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params['id']);
  await editableDish(req, id);

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
router.delete('/dishes/:id/image', requireAdmin, requirePermission('mensa.manage'), async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params['id']);
  await editableDish(req, id);
  await prisma.dishImage.delete({ where: { dishId: id } }).catch(() => null);
  await prisma.dish.update({ where: { id }, data: { imageUrl: '' } }).catch(() => null);
  invalidateDishesCache();
  res.status(204).send();
});

// ─── GET /api/admin/activity-logs ────────────────────────────────────────────
// Frontend activity logs (page views, downloads, logins, etc.)

router.get('/activity-logs', requireAdmin, requirePermission('logs.frontend.view'), async (req: Request, res: Response): Promise<void> => {
  const page  = intQueryParam(req.query['page'], 1, 1, 1_000_000);
  const limit = intQueryParam(req.query['limit'], 50, 1, 200);
  const skip  = (page - 1) * limit;
  const event    = req.query['event']    ? String(req.query['event'])    : undefined;
  const username = req.query['username'] ? String(req.query['username']) : undefined;
  const from = req.query['from'] ? new Date(String(req.query['from']))                        : undefined;
  const to   = req.query['to']   ? new Date(String(req.query['to']) + 'T23:59:59.999Z')       : undefined;

  const where: Record<string, unknown> = { ...schoolWhere(req) };
  if (event)    where['event']    = event;
  if (username) where['username'] = { contains: likeText(username) };
  if (from || to) {
    where['createdAt'] = {
      ...(from && !isNaN(from.getTime()) ? { gte: from } : {}),
      ...(to   && !isNaN(to.getTime())   ? { lte: to   } : {}),
    };
  }

  const [logs, total] = await Promise.all([
    prisma.frontendActivityLog.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip, take: limit }),
    prisma.frontendActivityLog.count({ where }),
  ]);

  res.json({ logs: logs.map((log) => networkDetailsFor(req, log)), total, page, limit });
});

// ─── GET /api/admin/activity-logs/stats ──────────────────────────────────────

router.get('/activity-logs/stats', requireAdmin, requirePermission('dashboard.view'), async (req: Request, res: Response): Promise<void> => {
  const inSchool = schoolSql(req);
  const schoolId = scopeSchool(req);
  // "Today" is the local day the Analytics page counts in, not the server's.
  const tz = config.usageAnalytics.timezone;
  const startOfToday = startOfLocalDay(localDayAndHour(new Date(), tz).dayKey, tz);

  type EventRow = { event: string; count: bigint };
  type PageRow  = { page: string; count: bigint };

  const [totalToday, uniqueUsersToday, eventBreakdown, topPages, activeUsersToday, eventsToday, topPagesToday] = await Promise.all([
    prisma.frontendActivityLog.count({ where: { createdAt: { gte: startOfToday }, ...schoolWhere(req) } }),
    prisma.$queryRaw<{ cnt: bigint }[]>`
      SELECT COUNT(DISTINCT username) AS cnt FROM frontend_activity_logs
      WHERE created_at >= ${startOfToday} AND username IS NOT NULL${inSchool}
    `,
    prisma.$queryRaw<EventRow[]>`
      SELECT event, COUNT(*) AS count FROM frontend_activity_logs
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)${inSchool}
      GROUP BY event ORDER BY count DESC
    `,
    prisma.$queryRaw<PageRow[]>`
      SELECT page, COUNT(*) AS count FROM frontend_activity_logs
      WHERE page IS NOT NULL AND created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)${inSchool}
      GROUP BY page ORDER BY count DESC LIMIT 10
    `,
    // The dashboard's "today" figures: active users as Analytics counts them,
    // and events and pages of today only.
    activeToday(new Date(), schoolId).catch(() => 0),
    prisma.$queryRaw<EventRow[]>`
      SELECT event, COUNT(*) AS count FROM frontend_activity_logs
      WHERE created_at >= ${startOfToday}${inSchool}
      GROUP BY event ORDER BY count DESC
    `,
    prisma.$queryRaw<PageRow[]>`
      SELECT page, COUNT(*) AS count FROM frontend_activity_logs
      WHERE page IS NOT NULL AND created_at >= ${startOfToday}${inSchool}
      GROUP BY page ORDER BY count DESC LIMIT 10
    `,
  ]);

  res.json({
    totalToday,
    uniqueUsersToday: Number(uniqueUsersToday[0]?.cnt ?? 0),
    eventBreakdown: eventBreakdown.map((r: EventRow) => ({ event: r.event, count: Number(r.count) })),
    topPages: topPages.map((r: PageRow) => ({ page: r.page, count: Number(r.count) })),
    activeUsersToday,
    eventsToday: eventsToday.map((r: EventRow) => ({ event: r.event, count: Number(r.count) })),
    topPagesToday: topPagesToday.map((r: PageRow) => ({ page: r.page, count: Number(r.count) })),
  });
});

// GET /api/admin/audit-log — recent admin actions from file logs (last 3 days)
router.get('/audit-log', requireAdmin, requirePermission('system.logs.view'), async (req: Request, res: Response): Promise<void> => {
  const limit = intQueryParam(req.query['limit'], 100, 1, 200);
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

router.get('/todos', requireAdmin, requirePermission('todos.view'), async (req: Request, res: Response): Promise<void> => {
  const page    = intQueryParam(req.query['page'], 1, 1, 1_000_000);
  const limit   = intQueryParam(req.query['limit'], 50, 1, 200);
  const skip    = (page - 1) * limit;
  const search  = String(req.query['search'] ?? '').trim();
  const status  = String(req.query['status'] ?? 'all');
  const uid     = String(req.query['stableUid'] ?? '').trim();

  const schoolId = scopeSchool(req);
  const where: Record<string, unknown> = schoolId ? { user: { schoolId } } : {};
  if (search) where['title'] = { contains: likeText(search) };
  if (uid) where['stableUid'] = uid;
  if (status === 'active')        { where['done'] = false; where['archivedAt'] = null; }
  else if (status === 'done')     { where['done'] = true;  where['archivedAt'] = null; }
  else if (status === 'archived') { where['archivedAt'] = { not: null }; }
  // 'all' → no filter

  const [todos, total] = await Promise.all([
    prisma.todo.findMany({ where: where as never, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip, take: limit }),
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

router.get('/reminders', requireAdmin, requirePermission('todos.view'), async (req: Request, res: Response): Promise<void> => {
  const page    = intQueryParam(req.query['page'], 1, 1, 1_000_000);
  const limit   = intQueryParam(req.query['limit'], 50, 1, 200);
  const skip    = (page - 1) * limit;
  const search  = String(req.query['search'] ?? '').trim();
  const status  = String(req.query['status'] ?? 'all');
  const classId = String(req.query['classId'] ?? '').trim();

  const schoolId = scopeSchool(req);
  const where: Record<string, unknown> = schoolId ? { class: { schoolId } } : {};
  if (search) where['title'] = { contains: likeText(search) };
  if (classId) where['classId'] = classId;
  if (status === 'active')        { where['archivedAt'] = null; }
  else if (status === 'archived') { where['archivedAt'] = { not: null }; }

  const [reminders, total] = await Promise.all([
    prisma.reminder.findMany({ where: where as never, orderBy: [{ remindAt: 'desc' }, { id: 'asc' }], skip, take: limit }),
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

router.get('/archive/todos', requireAdmin, requirePermission('todos.view'), async (req: Request, res: Response): Promise<void> => {
  const page = intQueryParam(req.query['page'], 1, 1, 1_000_000);
  const limit = intQueryParam(req.query['limit'], 50, 1, 200);
  const skip = (page - 1) * limit;

  const schoolId = scopeSchool(req);
  const archived = { archivedAt: { not: null }, ...(schoolId ? { user: { schoolId } } : {}) };
  const [todos, total] = await Promise.all([
    prisma.todo.findMany({
      where: archived,
      orderBy: [{ archivedAt: 'desc' }, { id: 'asc' }],
      skip,
      take: limit,
    }),
    prisma.todo.count({ where: archived }),
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

router.get('/archive/reminders', requireAdmin, requirePermission('todos.view'), async (req: Request, res: Response): Promise<void> => {
  const page = intQueryParam(req.query['page'], 1, 1, 1_000_000);
  const limit = intQueryParam(req.query['limit'], 50, 1, 200);
  const skip = (page - 1) * limit;

  const schoolId = scopeSchool(req);
  const archived = { archivedAt: { not: null }, ...(schoolId ? { class: { schoolId } } : {}) };
  const [reminders, total] = await Promise.all([
    prisma.reminder.findMany({
      where: archived,
      orderBy: [{ archivedAt: 'desc' }, { id: 'asc' }],
      skip,
      take: limit,
    }),
    prisma.reminder.count({ where: archived }),
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

router.get('/export', requireAdmin, requirePermission('backups.manage'), async (req: Request, res: Response): Promise<void> => {
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

router.post('/import', requireAdmin, requirePermission('backups.manage'), async (req2: Request, res: Response): Promise<void> => {
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

router.get('/school-years', requireAdmin, requirePermission('schoolyears.manage'), async (_req: Request, res: Response): Promise<void> => {
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

router.get('/school-years/:id/users', requireAdmin, requirePermission('schoolyears.manage'), async (req: Request, res: Response): Promise<void> => {
  const id      = String(req.params['id']);
  const page    = intQueryParam(req.query['page'], 1, 1, 1_000_000);
  const limit   = intQueryParam(req.query['limit'], 50, 1, 200);
  const skip    = (page - 1) * limit;
  const search  = String(req.query['search'] ?? '').trim();
  const role    = String(req.query['role']   ?? '').trim();

  const where: Record<string, unknown> = { schoolYearId: id };
  if (search) where['username'] = { contains: likeText(search) };
  if (role === 'student' || role === 'parent' || role === 'none') where['role'] = role;

  const [users, total] = await Promise.all([
    prisma.archivedUser.findMany({ where: where as never, orderBy: { username: 'asc' }, skip, take: limit }),
    prisma.archivedUser.count({ where: where as never }),
  ]);
  // Each account's year in figures (archived_activity), when it was active.
  const activity = await prisma.archivedActivity.findMany({
    where: { schoolYearId: id, stableUid: { in: users.map((u) => u.stableUid) } },
    select: { stableUid: true, activeDays: true, logins: true, activeSeconds: true },
  });
  const activityByUid = new Map(activity.map((a) => [a.stableUid, a]));
  res.json({
    users: users.map((u) => {
      const a = activityByUid.get(u.stableUid);
      return { ...u, activity: a ? { activeDays: a.activeDays, logins: a.logins, activeSeconds: a.activeSeconds } : null };
    }),
    total, page, limit,
  });
});

// ─── GET /api/admin/school-years/:id/classes ──────────────────────────────────

router.get('/school-years/:id/classes', requireAdmin, requirePermission('schoolyears.manage'), async (req: Request, res: Response): Promise<void> => {
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

router.get('/school-years/:id/todos', requireAdmin, requirePermission('schoolyears.manage'), async (req: Request, res: Response): Promise<void> => {
  const id      = String(req.params['id']);
  const page    = intQueryParam(req.query['page'], 1, 1, 1_000_000);
  const limit   = intQueryParam(req.query['limit'], 50, 1, 200);
  const skip    = (page - 1) * limit;
  const search  = String(req.query['search'] ?? '').trim();
  const status  = String(req.query['status'] ?? 'all');

  const where: Record<string, unknown> = { schoolYearId: id };
  if (search) where['title'] = { contains: likeText(search) };
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

router.get('/school-years/:id/reminders', requireAdmin, requirePermission('schoolyears.manage'), async (req: Request, res: Response): Promise<void> => {
  const id      = String(req.params['id']);
  const page    = intQueryParam(req.query['page'], 1, 1, 1_000_000);
  const limit   = intQueryParam(req.query['limit'], 50, 1, 200);
  const skip    = (page - 1) * limit;
  const search  = String(req.query['search'] ?? '').trim();
  const status  = String(req.query['status'] ?? 'all');

  const where: Record<string, unknown> = { schoolYearId: id };
  if (search) where['title'] = { contains: likeText(search) };
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

router.post('/school-years/rollover', requireAdmin, requirePermission('schoolyears.manage'), async (req: Request, res: Response): Promise<void> => {
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

router.post('/school-years/:id/rollback', requireAdmin, requirePermission('schoolyears.manage'), async (req: Request, res: Response): Promise<void> => {
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

router.get('/api-keys', requireAdmin, requirePermission('apikeys.manage'), async (_req: Request, res: Response): Promise<void> => {
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

router.post('/api-keys', requireAdmin, requirePermission('apikeys.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
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

router.patch('/api-keys/:id/revoke', requireAdmin, requirePermission('apikeys.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
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

router.get('/learn-config', requireAdmin, requirePermission('learn.manage'), async (_req: Request, res: Response): Promise<void> => {
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

router.patch('/learn-config', requireAdmin, requirePermission('learn.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
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

// ─── Learn AI vocabulary trainer ("Pokyh AI") administration ───────────────────
// Same DB-backed-with-env-fallback pattern as /learn-config above, kept as a
// sibling singleton (LearnAiConfig) rather than merged into LearnConfig's
// already-large row. Access is separate from this config: it always
// additionally requires a LearnAiAccessGrant (personal) or
// LearnAiTeamAccessGrant (team) — this config's `enabled` flag is only the
// platform-wide kill-switch, never a substitute for a grant.

router.get('/learn-ai/config', requireAdmin, requirePermission('learn.manage'), async (_req: Request, res: Response): Promise<void> => {
  const cfg = await getLearnAiConfig();
  res.json(cfg);
});

const learnAiConfigSchema = z.object({
  enabled: z.boolean().optional(),
  modelName: z.string().trim().min(1).max(120).optional(),
  contextTokens: z.number().int().min(512).max(32_768).optional(),
  numPredictFast: z.number().int().min(32).max(4_096).optional(),
  rateLimitMessagesPerHour: z.number().int().min(1).max(1_000).optional(),
  maxConcurrentTrainingGenerations: z.number().int().min(1).max(32).optional(),
  ollamaBaseUrl: z.string().trim().min(1).max(300).optional(),
  ollamaTimeoutMs: z.number().int().positive().optional(),
});

router.patch('/learn-ai/config', requireAdmin, requirePermission('learn.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
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

router.get('/learn-ai/grants', requireAdmin, requirePermission('learn.manage'), async (_req: Request, res: Response): Promise<void> => {
  const grants = await listAiAccessGrants();
  res.json({ grants });
});

const learnAiGrantSchema = z.object({
  username: z.string().trim().min(1).max(100),
  note: z.string().trim().max(500).optional(),
});

router.post('/learn-ai/grants', requireAdmin, requirePermission('learn.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
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

router.delete('/learn-ai/grants/:stableUid', requireAdmin, requirePermission('learn.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const stableUid = String(req.params['stableUid']);
  const adminUsername = adminUsernameFromReq(req.headers['authorization']);
  await revokeAiAccess(stableUid, adminUsername);
  logger.info('Admin action: Learn AI access revoked', { action: 'learn_ai_access_revoked', adminUsername, targetStableUid: stableUid });
  res.json({ ok: true });
});

router.get('/learn-ai/team-grants', requireAdmin, requirePermission('learn.manage'), async (_req: Request, res: Response): Promise<void> => {
  const grants = await listAiTeamAccessGrants();
  res.json({ grants });
});

const learnAiTeamGrantSchema = z.object({
  teamId: z.string().trim().min(1),
  note: z.string().trim().max(500).optional(),
});

router.post('/learn-ai/team-grants', requireAdmin, requirePermission('learn.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
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

router.delete('/learn-ai/team-grants/:teamId', requireAdmin, requirePermission('learn.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
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

router.get('/learn/courses', requireAdmin, requirePermission('learn.manage'), async (req: Request, res: Response): Promise<void> => {
  const query = adminLearnCourseListQuerySchema.parse(req.query);
  const where = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.visibility ? { visibility: query.visibility } : {}),
    ...(query.teamId ? { teamId: query.teamId } : {}),
    ...(query.q ? {
      OR: [
        { title: { contains: likeText(query.q) } },
        { slug: { contains: likeText(query.q) } },
        { subject: { contains: likeText(query.q) } },
        { language: { contains: likeText(query.q) } },
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

router.get('/learn/courses/:courseId/access', requireAdmin, requirePermission('learn.manage'), async (req: Request, res: Response): Promise<void> => {
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

router.patch('/learn/courses/:courseId/lifecycle', requireAdmin, requirePermission('learn.manage'), async (req: Request, res: Response): Promise<void> => {
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

router.post('/learn/courses/:courseId/access', requireAdmin, requirePermission('learn.manage'), async (req: Request, res: Response): Promise<void> => {
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

router.delete('/learn/courses/:courseId/access/:stableUid', requireAdmin, requirePermission('learn.manage'), async (req: Request, res: Response): Promise<void> => {
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

router.get('/learn/courses/:courseId/vocabulary', requireAdmin, requirePermission('learn.manage'), async (req: Request, res: Response): Promise<void> => {
  const courseId = z.string().uuid().parse(req.params['courseId']);
  const query = adminLearnVocabularyQuerySchema.parse(req.query);
  const course = await prisma.learnCourse.findUnique({ where: { id: courseId }, select: adminLearnCourseMetadataSelect });
  if (!course) throw new NotFoundError('Learn course not found');

  const where = {
    courseId,
    ...(query.q ? {
      OR: [
        { sourceText: { contains: likeText(query.q) } },
        { targetText: { contains: likeText(query.q) } },
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

router.get('/learn/courses/:courseId/vocabulary/export', requireAdmin, requirePermission('learn.manage'), async (req: Request, res: Response): Promise<void> => {
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

router.post('/learn/courses/:courseId/vocabulary/import', requireAdmin, requirePermission('learn.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
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

router.delete('/learn/courses/:courseId', requireAdmin, requirePermission('learn.manage'), async (req: Request, res: Response): Promise<void> => {
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

router.get('/learn/teams', requireAdmin, requirePermission('learn.manage'), async (_req: Request, res: Response): Promise<void> => {
  const teams = await prisma.learnTeam.findMany({
    orderBy: { updatedAt: 'desc' },
    include: learnTeamAdminInclude,
  });
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ teams: teams.map(learnTeamAdminRow) });
});

router.post('/learn/teams', requireAdmin, requirePermission('learn.manage'), async (req: Request, res: Response): Promise<void> => {
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
router.post('/learn/teams/:teamId/seed-vocab-courses', requireAdmin, requirePermission('learn.manage'), async (req: Request, res: Response): Promise<void> => {
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

router.patch('/learn/teams/:teamId', requireAdmin, requirePermission('learn.manage'), async (req: Request, res: Response): Promise<void> => {
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

router.post('/learn/teams/:teamId/members', requireAdmin, requirePermission('learn.manage'), async (req: Request, res: Response): Promise<void> => {
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

router.delete('/learn/teams/:teamId/members/:stableUid', requireAdmin, requirePermission('learn.manage'), async (req: Request, res: Response): Promise<void> => {
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
router.post('/learn/teams/:teamId/owner', requireAdmin, requirePermission('learn.manage'), async (req: Request, res: Response): Promise<void> => {
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

router.delete('/learn/teams/:teamId', requireAdmin, requirePermission('learn.manage'), async (req: Request, res: Response): Promise<void> => {
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

router.get('/backups', requireAdmin, requirePermission('backups.manage'), async (_req: Request, res: Response): Promise<void> => {
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

router.patch('/backups/config', requireAdmin, requirePermission('backups.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
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

router.post('/backups/run', requireAdmin, requirePermission('backups.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const adminUsername = adminUsernameFromReq(req.headers['authorization']);
  try {
    const result = await runBackup('manual');
    logger.info('Admin action: manual backup created', { action: 'backup_manual_run', adminUsername, filename: result.filename, sizeBytes: result.sizeBytes });
    res.status(201).json(result);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Backup failed' });
  }
});

router.get('/backups/:filename/download', requireAdmin, requirePermission('backups.manage'), async (req: Request, res: Response): Promise<void> => {
  const filename = String(req.params['filename']);
  const filePath = resolveBackupPath(filename);
  if (!filePath) throw new ValidationError('Invalid backup filename');
  const adminUsername = adminUsernameFromReq(req.headers['authorization']);
  logger.info('Admin action: backup downloaded', { action: 'backup_downloaded', adminUsername, filename });
  res.download(filePath, filename, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Backup not found' });
  });
});

router.delete('/backups/:filename', requireAdmin, requirePermission('backups.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
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
router.post('/backups/:filename/restore', requireAdmin, requirePermission('backups.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
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

router.post('/backups/prune', requireAdmin, requirePermission('backups.manage'), writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const adminUsername = adminUsernameFromReq(req.headers['authorization']);
  const pruned = await pruneOldBackups();
  logger.info('Admin action: backup retention pruned manually', { action: 'backup_pruned_manual', adminUsername, pruned });
  res.json({ pruned });
});

export { router as adminRouter };
