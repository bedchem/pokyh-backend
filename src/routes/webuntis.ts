import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { prisma } from '../db';
import { config } from '../config';
import { logger } from '../utils/logger';
import { apiKeyMiddleware } from '../middleware/apiKey';
import { clientIp } from '../middleware/requestLogger';
import { completeWebUntisLogin, loginSchool } from './auth';
import {
  bearerToken,
  cookieHeader,
  firstWorkingGet,
  readPageConfig,
  readFetch,
  rpc,
  schoolYearId,
  sessionHeaders,
  untis,
  untisBase,
  untisClassicWrite,
  untisError,
  untisErrorCode,
  untisGetText,
  type UntisSession,
} from '../webuntis/client';
import {
  canReportAbsence,
  detectParent,
  extractAbsenceSubjectName,
  extractChildStudentId,
  extractImageUrl,
  fetchAbsenceCreateFlag,
  fetchAppData,
} from '../webuntis/appData';
import {
  accountClassForRole,
  findStudentClassIdInData,
  positiveId,
  resolveOwnStudentClassId,
  studentClassId,
  type WebUntisStudentClass,
} from '../webuntis/accountClass';
import { absenceWriteOutcome, conflictTexts, hmNumber, ymdNumber } from '../webuntis/absences';
import { fetchMessagePermissions, htmlToText, plainTextToHtml } from '../webuntis/messages';
import { defaultSchool, parseSchool, schoolBase, schoolCookieValue, schoolLoginName, searchSchools, type UntisSchool } from '../webuntis/schools';
import { openRenewal, readSession, requireUntisSession, sealRenewal, setRefreshCookie, setSessionCookie } from '../webuntis/session';

// WebUntis for the website. The website is a static page: it signs in here,
// and this router talks to the person's school with their own WebUntis
// session, which lives sealed in the browser's httpOnly cookies
// (webuntis/session.ts) — never on this server. Passwords pass through to
// WebUntis only: never logged, never stored; for the automatic renewal they go
// back into the browser, sealed.
//
// Reads (GET) are authenticated by the session cookie alone, so the website
// can show pictures and documents from here directly. Everything that writes
// also needs the API key header, which no browser sends to another site
// without asking first (CORS preflight against the allowed origins).

const router = Router();

function writesNeedApiKey(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  apiKeyMiddleware(req, res, next);
}

router.use(writesNeedApiKey);

// Answers depend on the person; no shared cache may keep them.
router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store');
  next();
});

const session = (req: Request): UntisSession => req.untis as UntisSession;
const sessionExpired = (res: Response) => res.status(401).json({ error: 'session_expired' });
const errorText = (e: unknown, fallback = 'Fehler') => (e instanceof Error ? e.message : fallback);

// Pictures and documents the website shows from this address (profile
// picture, attachments, excuse letter): its own site may embed them.
function embeddable(res: Response): void {
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

// ─── Rate limits ───────────────────────────────────────────────────────────────
// Whole schools share one public address, so the per-address budgets are
// generous; the per-account one is what stops guessing a password.

const loginByAddress = rateLimit({
  windowMs: 5 * 60_000,
  max: config.rateLimit.webLoginMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Versuche. Bitte warte 5 Minuten.', code: 'rate_limited' },
});

const loginByAccount = rateLimit({
  windowMs: 15 * 60_000,
  max: config.rateLimit.webLoginPerAccountMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Versuche. Bitte warte 15 Minuten.', code: 'rate_limited' },
  // A renewal without credentials names no account; it is limited by address only.
  skip: (req) => typeof req.body?.username !== 'string',
  keyGenerator: (req) => `web-login:${String(req.body?.username ?? '').trim().toLowerCase().slice(0, 100)}`,
});

const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Versuche. Bitte warte 15 Minuten.', code: 'rate_limited' },
});

const schoolSearchLimiter = rateLimit({
  windowMs: 60_000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.setHeader('Retry-After', '60');
    res.status(429).json({ reason: 'rate' });
  },
});

const passwordChangeLimiter = rateLimit({
  windowMs: 10 * 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `web-password:${req.untis?.sessionId ?? 'none'}`,
  message: { error: 'Zu viele Versuche. Bitte warte ein paar Minuten.', code: 'rate_limited' },
});

// ─── Sign-in ───────────────────────────────────────────────────────────────────

type Klasse = { id: number; name: string };

const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// The class element (type === "CLASS") of a REST timetable response
// (days[].gridEntries[].position1..7[].current): the class short name or null.
function classNameFromTimetable(json: unknown): string | null {
  const days = (json as { days?: unknown }).days;
  if (!Array.isArray(days)) return null;
  const POSITIONS = ['position1', 'position2', 'position3', 'position4', 'position5', 'position6', 'position7'];
  for (const day of days) {
    const entries = (day as { gridEntries?: unknown })?.gridEntries;
    if (!Array.isArray(entries)) continue;
    for (const ge of entries) {
      for (const key of POSITIONS) {
        const arr = (ge as Record<string, unknown>)?.[key];
        if (!Array.isArray(arr)) continue;
        for (const el of arr) {
          const cur = (el as { current?: { type?: string; shortName?: string; displayName?: string } })?.current;
          if (cur?.type === 'CLASS') {
            const name = cur.shortName ?? cur.displayName;
            if (typeof name === 'string' && name.trim()) return name.trim();
          }
        }
      }
    }
  }
  return null;
}

// A student's class id from their timetable. `getStudents` has no class for
// guardian logins, and at block-teaching schools whole weeks are free, so the
// current week and mid-month points across the school year are sampled; the
// first of them, in that order, whose lessons show the CLASS element wins.
// Best effort → 0.
async function klasseIdFromTimetable(base: string, headers: Record<string, string>, studentId: number, klassen: Klasse[]): Promise<number> {
  if (studentId <= 0 || klassen.length === 0) return 0;
  const now = new Date();
  // The school year is archived on August 1, so August already samples the
  // coming September instead of reassigning last year's class.
  const startYear = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  const samples: Date[] = [new Date()];
  for (const m of [9, 10, 11, 12]) samples.push(new Date(startYear, m - 1, 15));
  for (const m of [1, 2, 3, 4, 5, 6]) samples.push(new Date(startYear + 1, m - 1, 15));

  const classOf = async (day: Date): Promise<number> => {
    const start = isoDay(day);
    const end = isoDay(new Date(day.getFullYear(), day.getMonth(), day.getDate() + 5));
    const url = `${base}/api/rest/view/v1/timetable/entries?start=${start}&end=${end}&format=1&resourceType=STUDENT&resources=${studentId}&periodTypes=&timetableType=MY_TIMETABLE&layout=START_TIME`;
    try {
      const r = await readFetch(url, { headers, signal: AbortSignal.timeout(8_000) });
      if (!r.ok) return 0;
      const text = await r.text();
      if (text.startsWith('<')) return 0;
      const name = classNameFromTimetable(JSON.parse(text));
      return name ? positiveId(klassen.find((k) => k.name?.toLowerCase() === name.toLowerCase())?.id) : 0;
    } catch {
      return 0;
    }
  };

  // The current week alone first; the weeks across the year then all at once.
  const current = await classOf(samples[0]);
  if (current > 0) return current;
  for (const pending of samples.slice(1).map(classOf)) {
    const id = await pending;
    if (id > 0) return id;
  }
  return 0;
}

interface ResolvedAccount {
  studentId: number;
  klasseId: number;
  klasseName: string;
  isParent: boolean;
  imageUrl?: string;
}

interface FreshSignIn {
  base: string;
  school: UntisSchool;
  sessionId: string;
  cookie: string;
  username: string;
  /** What `authenticate` answered. */
  studentId: number;
  klasseId: number;
  personType?: number;
  /** The bearer token being minted for the session ('' when it failed). */
  bearer: Promise<string>;
}

// Whom a new sign-in acts for: for a student login the person itself; guardian
// and other logins need the app-data to find the child. With the class and the
// profile picture.
async function resolveAccount(signIn: FreshSignIn): Promise<ResolvedAccount> {
  const { base, school, sessionId, cookie, username, studentId, klasseId, personType } = signIn;
  const rpcUrl = `${base}/jsonrpc.do?school=${encodeURIComponent(school.loginName)}`;

  // Classes, the accessible students and the app-data, in parallel (the
  // app-data as soon as the bearer token is there). The app-data is read here
  // where the WebUntis session is freshest (also the most reliable moment for
  // the profile-picture URL); capped at 5 seconds so a slow answer never
  // stalls the sign-in.
  const [bearer, klassen, students, appData] = await Promise.all([
    signIn.bearer,
    readFetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ id: 'pokyh-klassen', method: 'getKlassen', params: {}, jsonrpc: '2.0' }),
      signal: AbortSignal.timeout(10_000),
    })
      .then((r) => r.json() as Promise<{ result?: unknown }>)
      .then((kj) => (Array.isArray(kj.result) ? (kj.result as Klasse[]) : []))
      .catch(() => [] as Klasse[]),
    readFetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ id: 'pokyh-students', method: 'getStudents', params: {}, jsonrpc: '2.0' }),
      signal: AbortSignal.timeout(10_000),
    })
      .then((r) => r.json() as Promise<{ result?: unknown }>)
      .then((sj) => (Array.isArray(sj.result) ? (sj.result as WebUntisStudentClass[]) : []))
      .catch(() => [] as WebUntisStudentClass[]),
    signIn.bearer.then((bearerToken) => Promise.race([
      fetchAppData({ sessionId, school, bearerToken, studentId, klasseId, klasseName: '', username }),
      new Promise<{ ok: false; status: number }>((resolve) => setTimeout(() => resolve({ ok: false, status: 0 }), 5_000)),
    ])),
  ]);

  let klasseName = klassen.find((k) => positiveId(k.id) === klasseId)?.name ?? '';
  let resolvedStudentId = studentId;
  let resolvedKlasseId = resolveOwnStudentClassId(klasseId, studentId, students);
  let isParent = false;
  const isStudentSelf = students.some((student) => positiveId(student.id) === studentId);
  const appJson = appData.ok ? appData.json : null;

  // Parent detection must not depend on getStudents: some WebUntis answers
  // contain an id collision that makes a guardian look like the student.
  if (appJson) isParent = detectParent(appJson);

  if (isParent) {
    const childId = appJson ? extractChildStudentId(appJson, studentId) : null;
    const child = students.find((entry) => positiveId(entry.id) === childId)
      ?? students.find((entry) => positiveId(entry.id) !== studentId)
      ?? students[0];
    if (childId) resolvedStudentId = childId;
    else if (child) resolvedStudentId = positiveId(child.id);
    const childKlasseId = studentClassId(child);
    if (childKlasseId > 0) resolvedKlasseId = childKlasseId;
  } else if (!isStudentSelf && students.length) {
    const accessible = students[0];
    resolvedStudentId = positiveId(accessible.id);
    const accessibleKlasseId = studentClassId(accessible);
    if (accessibleKlasseId > 0) resolvedKlasseId = accessibleKlasseId;
  }

  if (resolvedKlasseId <= 0 && appJson) {
    const fromAppData = findStudentClassIdInData(appJson, resolvedStudentId);
    if (fromAppData > 0) resolvedKlasseId = fromAppData;
  }

  // Guardians (and students whose `authenticate` returned klasseId 0): the
  // class comes from the (child's) timetable.
  if (resolvedKlasseId <= 0 && resolvedStudentId > 0) {
    const headers: Record<string, string> = { Cookie: cookie, Accept: 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) };
    const derived = await klasseIdFromTimetable(base, headers, resolvedStudentId, klassen);
    if (derived > 0) resolvedKlasseId = derived;
  }

  klasseName = klassen.find((k) => positiveId(k.id) === resolvedKlasseId)?.name ?? klasseName;

  // Diagnostic without personal data: how the class was resolved.
  logger.info('[webuntis login] resolved', {
    school: school.loginName, personType, isStudentSelf, studentsLen: students.length, isParent,
    hasStudent: resolvedStudentId > 0, hasClass: resolvedKlasseId > 0,
  });

  return {
    studentId: resolvedStudentId,
    klasseId: resolvedKlasseId,
    klasseName,
    isParent,
    // '' when the app-data shows no picture: the avatar then needs no lookup.
    imageUrl: appJson ? (extractImageUrl(appJson, isParent) ?? '') : undefined,
  };
}

interface LoginBody {
  username?: unknown;
  password?: unknown;
  renewal?: unknown;
  school?: unknown;
}

router.post('/login', loginByAddress, loginByAccount, async (req: Request, res: Response) => {
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as LoginBody;

  // The website renewing an expired session by itself, not the person signing
  // in; it is left out of the account's sign-ins. It sends no credentials:
  // they come from the renewal cookie of the session being renewed, so a
  // sign-in whose cookies were deleted stays signed out.
  const renewal = body.renewal === true;
  const saved = renewal && body.password === undefined ? openRenewal(req) : null;
  if (renewal && body.password === undefined && !saved) {
    res.status(401).json({ error: 'session_expired', code: 'session_expired' });
    return;
  }
  const rawUsername = saved?.username ?? (typeof body.username === 'string' ? body.username : undefined);
  const password = saved?.password ?? (typeof body.password === 'string' ? body.password : undefined);
  // Lower case for everything stored; WebUntis itself is case-insensitive.
  const username = rawUsername?.trim().toLowerCase() ?? '';

  if (!username || !password?.trim()) {
    res.status(400).json({ error: 'Benutzername und Passwort erforderlich.', code: 'missing' });
    return;
  }
  if (username.length > 100 || password.length > 200) {
    res.status(400).json({ error: 'Eingabe zu lang.', code: 'invalid' });
    return;
  }

  // The school picked on the sign-in page; only WebUntis hosts are accepted.
  // A request without one (older clients) signs in at the default school.
  if (!saved && body.school !== undefined && body.school !== null && !parseSchool(body.school)) {
    res.status(400).json({ error: 'Diese Schule ist nicht verfügbar.', code: 'school_invalid' });
    return;
  }
  const school: UntisSchool = saved?.school ?? parseSchool(body.school) ?? defaultSchool();
  const BASE = schoolBase(school);
  const SCHOOL = encodeURIComponent(school.loginName);

  try {
    // 1. WebUntis JSON-RPC authentication
    const rpcRes = await fetch(`${BASE}/jsonrpc.do?school=${SCHOOL}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'pokyh-web', method: 'authenticate', params: { user: username, password, client: 'pokyh' }, jsonrpc: '2.0' }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!rpcRes.ok) {
      const statusMsg = rpcRes.status >= 500
        ? 'WebUntis ist gerade nicht erreichbar. Bitte versuche es später erneut.'
        : 'Die Verbindung zu WebUntis ist fehlgeschlagen.';
      res.status(502).json({ error: statusMsg, code: 'unavailable' });
      return;
    }

    const sessionId = (rpcRes.headers.get('set-cookie') ?? '').match(/JSESSIONID=([^;]+)/)?.[1] ?? '';
    const rpcJson = (await rpcRes.json().catch(() => null)) as {
      result?: { personId?: unknown; klasseId?: unknown; personType?: number };
      error?: { code?: number };
    } | null;
    if (!rpcJson) {
      res.status(502).json({ error: 'WebUntis hat unerwartet geantwortet.', code: 'unavailable' });
      return;
    }
    if (rpcJson.error || !rpcJson.result) {
      // -8504: wrong user name or password. Anything else: WebUntis refused
      // the sign-in (account locked, school closed for API access, …).
      const bad = rpcJson.error?.code === -8504;
      res.status(401).json(bad
        ? { error: 'Benutzername oder Passwort ist falsch.', code: 'bad_credentials' }
        : { error: 'WebUntis hat die Anmeldung abgelehnt.', code: 'refused' });
      return;
    }

    const { personId: rawStudentId, klasseId: rawKlasseId, personType } = rpcJson.result;
    // The school's POKYH record, looked up while WebUntis answers (awaited,
    // and a failure reported, with the POKYH session below).
    const schoolIdRequest = loginSchool(req, { school: school.loginName.toLowerCase(), schoolName: school.name, schoolServer: school.server });
    schoolIdRequest.catch(() => {});
    const cookie = `JSESSIONID=${sessionId}; schoolname="${schoolCookieValue(school)}"`;
    const bearerRequest = readFetch(`${BASE}/api/token/new`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(10_000) })
      .then((r) => r.text())
      .then((tok) => ((tok.match(/\./g) ?? []).length === 2 ? tok.trim() : ''))
      .catch(() => '');

    // 2. Whom the sign-in acts for. A renewal keeps what was worked out for
    // the session it renews (same account and school, at most 4 hours old:
    // openRenewal), so WebUntis only has to sign in again; a new sign-in
    // looks it all up.
    const previous = saved ? readSession(req) : null;
    const account: ResolvedAccount = previous && previous.studentId > 0 && previous.klasseId > 0
      ? {
        studentId: previous.studentId,
        klasseId: previous.klasseId,
        klasseName: previous.klasseName ?? '',
        isParent: previous.isParent === true,
        imageUrl: previous.imageUrl,
      }
      : await resolveAccount({
        base: BASE, school, sessionId, cookie, username,
        studentId: positiveId(rawStudentId), klasseId: positiveId(rawKlasseId), personType, bearer: bearerRequest,
      });
    // The sealed WebUntis session keeps a child's class (its endpoints need
    // it); the guardian's account itself has and stores no class.
    const { klasseId: accountKlasseId, klasseName: accountKlasseName } = accountClassForRole(account.isParent, account.klasseId, account.klasseName);

    // 3. The POKYH session, alongside the bearer token. Without it the WebUntis
    // data still works; pokyhSynced tells the website whether the POKYH layer
    // was renewed too (it must not re-run its POKYH sign-in against a stale
    // token otherwise).
    const pokyhSession = (async () => {
      try {
        // Guardians are never assigned to their child's class; completeWebUntisLogin
        // repeats this normalisation as the authoritative safeguard.
        const schoolId = await schoolIdRequest;
        return await completeWebUntisLogin({
          username, klasseId: accountKlasseId, klasseName: accountKlasseName, role: account.isParent ? 'parent' : 'student', schoolId,
        });
      } catch (err) {
        logger.error('[webuntis login] POKYH session not created', { message: errorText(err, 'unknown').split('\n')[0] });
        return null;
      }
    })();
    const [bearer, pokyh] = await Promise.all([bearerRequest, pokyhSession]);

    const loginAt = Date.now();
    const sessionData: UntisSession = {
      sessionId, school, bearerToken: bearer, studentId: account.studentId, klasseId: account.klasseId, klasseName: account.klasseName,
      username, personType, isParent: account.isParent, imageUrl: account.imageUrl, loginAt,
    };
    // What the website shows; no token, no password.
    const user = {
      username, studentId: account.studentId, klasseId: accountKlasseId, klasseName: accountKlasseName, personType, isParent: account.isParent,
      loginAt, isUntisUser: true, school: { loginName: school.loginName, name: school.name ?? school.loginName },
    };

    setSessionCookie(res, sessionData);
    sealRenewal(res, { username, password, school });
    if (pokyh) {
      setRefreshCookie(res, pokyh.refreshToken);
      if (!renewal) res.locals.signedIn = { stableUid: pokyh.user.stableUid, username: pokyh.user.username };
    }
    res.json({
      ok: true,
      pokyhSynced: pokyh !== null,
      username,
      studentId: account.studentId,
      klasseId: accountKlasseId,
      klasseName: accountKlasseName,
      user,
      ...(pokyh ? { token: pokyh.token } : {}),
    });
  } catch (e) {
    logger.error('[webuntis login] failed', { message: errorText(e, 'unknown').split('\n')[0] });
    res.status(502).json({ error: 'WebUntis ist gerade nicht erreichbar. Bitte versuche es später erneut.', code: 'unavailable' });
  }
});

// "Passwort vergessen", WebUntis' own reset request (PasswordResetRequestActions):
// POST /passwordReset/resetPassword.do { username, email }. WebUntis e-mails a
// reset link to the address stored for the account; Pokyh never sees a password.
// It needs an anonymous WebUntis session: the login page sets the session
// cookie and embeds the CSRF token and tenant id that go with it.

const RESET_MESSAGES: Record<string, { status: number; error: string }> = {
  INVALID_USER_DATA: { status: 400, error: 'Benutzername und E-Mail-Adresse passen zu keinem Konto.' },
  SEND_EMAIL_FAILURE: { status: 502, error: 'WebUntis konnte die E-Mail gerade nicht senden.' },
  PW_RESET_NOT_ALLOWED: { status: 403, error: 'Das Zurücksetzen des Passworts ist an deiner Schule nicht freigegeben. Wende dich an das Sekretariat.' },
  INTERNAL_ERROR: { status: 502, error: 'WebUntis hat einen internen Fehler gemeldet.' },
};

router.post('/password-reset', passwordResetLimiter, async (req: Request, res: Response) => {
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as { username?: unknown; email?: unknown; school?: unknown };
  const username = String(body.username ?? '').trim();
  const email = String(body.email ?? '').trim();
  const school = parseSchool(body.school);
  if (!username || !email) {
    res.status(400).json({ error: 'Bitte Benutzername und E-Mail-Adresse eingeben.', code: 'missing' });
    return;
  }
  if (username.length > 100 || email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: 'Bitte eine gültige E-Mail-Adresse eingeben.', code: 'invalid_email' });
    return;
  }

  try {
    const base = schoolBase(school);
    const page = await fetch(`${base}/?school=${encodeURIComponent(schoolLoginName(school))}`, {
      headers: { Accept: 'text/html' },
      signal: AbortSignal.timeout(12_000),
    });
    const sessionId = (page.headers.get('set-cookie') ?? '').match(/JSESSIONID=([^;]+)/)?.[1];
    const pageConfig = readPageConfig(await page.text());
    if (!sessionId || !pageConfig.csrf) {
      res.status(502).json({ error: 'WebUntis ist gerade nicht erreichbar.', code: 'unavailable' });
      return;
    }

    const r = await fetch(`${base}/passwordReset/resetPassword.do`, {
      method: 'POST',
      headers: {
        Cookie: `JSESSIONID=${sessionId}; schoolname="${schoolCookieValue(school)}"`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-CSRF-TOKEN': pageConfig.csrf,
        ...(pageConfig.tenant ? { 'Tenant-Id': pageConfig.tenant } : {}),
      },
      body: JSON.stringify({ username, email }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await r.text();
    let json: { errors?: { code?: string }[] } | null = null;
    try { json = text ? JSON.parse(text) : {}; } catch { json = null; }

    const code = json?.errors?.[0]?.code;
    if (r.ok && json && !code) {
      res.json({ ok: true });
      return;
    }
    const mapped = code ? RESET_MESSAGES[code] : undefined;
    logger.warn('[webuntis password-reset] WebUntis rejected the request', { status: r.status, code: code ?? '' });
    res.status(mapped?.status ?? 502).json({ error: mapped?.error ?? 'Das Zurücksetzen konnte nicht gestartet werden.', code: code ?? 'reset_failed' });
  } catch {
    res.status(502).json({ error: 'WebUntis ist gerade nicht erreichbar.', code: 'unavailable' });
  }
});

// School search for the sign-in page: any school on WebUntis, by name, town or
// postcode. Public, limited per address, no personal data in the answers.
// Errors are reasons, not texts: the page says them in the reader's language.
router.get('/schools', schoolSearchLimiter, async (req: Request, res: Response) => {
  const q = String(req.query['q'] ?? '').replace(/[\p{C}]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (q.length < 3 || q.length > 80) {
    res.status(400).json({ reason: 'short' });
    return;
  }
  const result = await searchSchools(q);
  if (!result.ok) {
    res.status(result.reason === 'too_many' ? 422 : 502).json({ reason: result.reason });
    return;
  }
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600, stale-while-revalidate=3600');
  res.json({ schools: result.schools });
});

// ─── Everything below acts with the person's WebUntis session ────────────────

router.use(requireUntisSession);

// A WebUntis JSON answer passed on as it came: an object or a list is not
// parsed and serialised again on the way (time and memory for a large
// timetable); anything else is checked as before.
function sendJsonText(res: Response, text: string): void {
  if (/^\s*[[{]/.test(text)) res.type('application/json').send(text);
  else res.json(JSON.parse(text));
}

// The REST answer of one GET as JSON, or the usual session/availability errors.
async function relayGet(req: Request, res: Response, path: string, failure: string, opts: { strict?: boolean } = {}): Promise<void> {
  try {
    const r = await untisGetText(session(req), path);
    // `strict`: 403 means the session too (the routes that always treated it so).
    if (r.text.trimStart().startsWith('<') || r.status === 401 || (opts.strict !== false && r.status === 403)) {
      sessionExpired(res);
      return;
    }
    if (!r.ok) {
      res.status(502).json({ error: failure });
      return;
    }
    sendJsonText(res, r.text);
  } catch (e) {
    res.status(500).json({ error: errorText(e) });
  }
}

/**
 * A file from WebUntis passed on as it arrives, never held whole in memory.
 * `headers` sets the answer's headers once the first bytes are there; false,
 * with nothing sent, when the file is empty.
 */
async function streamFile(file: globalThis.Response, res: Response, headers: () => void): Promise<boolean> {
  const reader = file.body?.getReader();
  if (!reader) return false;
  let first = await reader.read();
  while (!first.done && first.value.byteLength === 0) first = await reader.read();
  if (first.done) {
    await reader.cancel().catch(() => {});
    return false;
  }
  const firstChunk = first.value;
  headers();
  // The length only of a body fetch did not decompress on the way.
  const length = file.headers.get('content-length');
  if (length && /^\d+$/.test(length) && !file.headers.get('content-encoding')) res.setHeader('Content-Length', length);
  async function* chunks() {
    try {
      yield firstChunk;
      for (;;) {
        const next = await reader!.read();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      // Stops the download from WebUntis when the browser went away.
      await reader!.cancel().catch(() => {});
    }
  }
  try {
    await pipeline(Readable.from(chunks()), res);
  } catch {
    // Broken off on either side after the answer started: only the
    // connection can still say so.
    res.destroy();
  }
  return true;
}

const YMD = /^\d{8}$/;

function dateRange(req: Request, res: Response): { startDate: string; endDate: string } | null {
  const startDate = String(req.query['startDate'] ?? '');
  const endDate = String(req.query['endDate'] ?? '');
  if (startDate && !YMD.test(startDate)) {
    res.status(400).json({ error: 'Ungültiges Startdatum.' });
    return null;
  }
  if (endDate && !YMD.test(endDate)) {
    res.status(400).json({ error: 'Ungültiges Enddatum.' });
    return null;
  }
  return { startDate, endDate };
}

router.get('/timetable', async (req: Request, res: Response) => {
  const date = String(req.query['date'] ?? '');
  if (!date) {
    res.status(400).json({ error: 'Datum fehlt.' });
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: 'Ungültiges Datumsformat.' });
    return;
  }
  // Saturday of that week (start + 5 days), in local date arithmetic.
  const [y, m, d] = date.split('-').map(Number);
  const end = isoDay(new Date(y, m - 1, d + 5));
  const s = session(req);
  await relayGet(req, res, `/api/rest/view/v1/timetable/entries?start=${date}&end=${end}&format=1&resourceType=STUDENT&resources=${s.studentId}&periodTypes=&timetableType=MY_TIMETABLE&layout=START_TIME`, 'Der Stundenplan konnte gerade nicht geladen werden.');
});

router.get('/lesson-detail', async (req: Request, res: Response) => {
  const date = String(req.query['date'] ?? '');
  const startTime = String(req.query['startTime'] ?? '');
  const endTime = String(req.query['endTime'] ?? '');
  if (!/^\d{8}$/.test(date) || !/^\d{1,4}$/.test(startTime) || !/^\d{1,4}$/.test(endTime)) {
    res.status(400).json({ error: 'Parameter fehlen.' });
    return;
  }
  const iso = (time: string) => {
    const t = time.padStart(4, '0');
    return encodeURIComponent(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:00`);
  };
  const s = session(req);
  await relayGet(req, res, `/api/rest/view/v2/calendar-entry/detail?elementId=${s.studentId}&elementType=5&startDateTime=${iso(startTime)}&endDateTime=${iso(endTime)}&homeworkOption=DUE`, 'Die Details konnten gerade nicht geladen werden.', { strict: false });
});

router.get('/homework', async (req: Request, res: Response) => {
  const range = dateRange(req, res);
  if (!range) return;
  try {
    const r = await untisGetText(session(req), `/api/homeworks/lessons?startDate=${range.startDate}&endDate=${range.endDate}`);
    if (r.text.startsWith('<')) {
      sessionExpired(res);
      return;
    }
    sendJsonText(res, r.text);
  } catch (e) {
    res.status(500).json({ error: errorText(e) });
  }
});

router.get('/exams', async (req: Request, res: Response) => {
  const range = dateRange(req, res);
  if (!range) return;
  await relayGet(req, res, `/api/exams?studentId=${session(req).studentId}&klasseId=-1&startDate=${range.startDate}&endDate=${range.endDate}`, 'Die Prüfungen konnten gerade nicht geladen werden.');
});

const schoolYearOf = (now = new Date()) => (now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1);

router.get('/classregevents', async (req: Request, res: Response) => {
  const yearParam = Number.parseInt(String(req.query['year'] ?? ''), 10);
  const year = Number.isInteger(yearParam) && yearParam > 1900 && yearParam < 3000 ? yearParam : schoolYearOf();
  await relayGet(req, res, `/api/classreg/classregevents?startDate=${year}0908&endDate=${year + 1}0612&studentId=${session(req).studentId}`, 'Das Klassenbuch konnte gerade nicht geladen werden.');
});

router.get('/classservices', async (req: Request, res: Response) => {
  const year = schoolYearOf();
  await relayGet(req, res, `/api/classreg/classservices?startDate=${year}0901&endDate=${year + 1}0630`, 'Die Klassendienste konnten gerade nicht geladen werden.');
});

// ── Grades ──────────────────────────────────────────────────────────────────

type SchoolYear = { id: number; startDate: number; endDate: number };

// -1: the session is gone; null: no school year found.
async function gradesSchoolYearId(s: UntisSession, targetYear?: number): Promise<number | null | -1> {
  // The current one is the id REST requests already send (client.ts); an
  // expired session shows in the school-year list below.
  if (targetYear == null) {
    const current = await schoolYearId(s);
    if (current) return current;
  }
  const years = await rpc<SchoolYear[]>(s, 'getSchoolyears');
  if (!years.ok) return years.expired ? -1 : null;
  if (!Array.isArray(years.result)) return null;
  if (targetYear != null) return years.result.find((y) => Math.floor(y.startDate / 10_000) === targetYear)?.id ?? null;
  const now = Number(new Date().toISOString().replace(/-/g, '').slice(0, 8));
  const current = years.result.find((y) => y.startDate <= now && y.endDate >= now);
  if (current?.id) return current.id;
  return years.result.length ? [...years.result].sort((a, b) => b.startDate - a.startDate)[0].id : null;
}

router.get('/grades', async (req: Request, res: Response) => {
  const s = session(req);
  const yearParam = Number.parseInt(String(req.query['year'] ?? ''), 10);
  const targetYear = Number.isInteger(yearParam) ? yearParam : undefined;
  try {
    const schoolyearId = await gradesSchoolYearId(s, targetYear);
    if (schoolyearId === -1) {
      sessionExpired(res);
      return;
    }
    if (!schoolyearId) {
      res.status(500).json({ error: 'Schuljahr nicht gefunden. Bitte neu anmelden.' });
      return;
    }

    const list = await untisGetText(s, `/api/classreg/grade/grading/list?studentId=${s.studentId}&schoolyearId=${schoolyearId}`, 20_000);
    if (list.text.startsWith('<') || list.status === 401 || list.status === 403) {
      sessionExpired(res);
      return;
    }
    if (!list.ok) {
      res.status(502).json({ error: 'Die Noten konnten gerade nicht geladen werden.' });
      return;
    }
    const listData = JSON.parse(list.text) as { data?: { lessons?: unknown; lesson?: unknown } };
    const lessons = (listData?.data?.lessons ?? listData?.data?.lesson ?? []) as Array<Record<string, unknown>>;
    if (!Array.isArray(lessons) || lessons.length === 0) {
      res.json({ subjects: [] });
      return;
    }

    // Grades per lesson, in parallel.
    const results = await Promise.allSettled(lessons.map(async (lesson) => {
      const lessonId = lesson.id as number;
      const subjectName = lesson.subjects?.toString() ?? lesson.subject?.toString() ?? '';
      const teacherName = lesson.teachers?.toString() ?? lesson.teacher?.toString() ?? '';
      const r = await untisGetText(s, `/api/classreg/grade/grading/lesson?studentId=${s.studentId}&lessonId=${lessonId}`);
      if (r.text.startsWith('<') || !r.ok) return null;
      const data = JSON.parse(r.text) as { data?: { grades?: Array<Record<string, unknown>> } };
      const grades = (data?.data?.grades ?? [])
        .map((g) => {
          const mark = (g.mark ?? {}) as Record<string, unknown>;
          const examType = (g.examType ?? {}) as Record<string, unknown>;
          return {
            id: g.id,
            text: g.text ?? '',
            date: g.date,
            markName: mark.name ?? '',
            markValue: mark.markValue ?? 0,
            markDisplayValue: (mark.markDisplayValue as number) ?? (mark.markValue as number) ?? 0,
            examType: examType.longname ?? examType.name ?? g.examType ?? '',
          };
        })
        .filter((g) => (g.markValue as number) > 0);
      return { lessonId, subjectName, teacherName, grades };
    }));
    res.json({ subjects: results.map((r) => (r.status === 'fulfilled' ? r.value : null)).filter(Boolean) });
  } catch (e) {
    res.status(500).json({ error: errorText(e, 'Unbekannter Fehler') });
  }
});

// ── Absences ────────────────────────────────────────────────────────────────

const PAGE_SIZE = 100;

router.get('/absences', async (req: Request, res: Response) => {
  const range = dateRange(req, res);
  if (!range) return;
  const s = session(req);
  const baseUrl = `${config.webuntis.paths.absences}?studentId=${s.studentId}&startDate=${range.startDate}&endDate=${range.endDate}&excuseStatusId=-1&limit=${PAGE_SIZE}&pageSize=${PAGE_SIZE}`;
  try {
    const all: unknown[] = [];
    let totalCount: number | null = null;
    // Safety cap: 50 pages × 100 = 5000 absences.
    for (let page = 0; page < 50; page++) {
      const r = await untisGetText(s, page === 0 ? baseUrl : `${baseUrl}&page=${page}`);
      // Session errors count on the first page; later failures end the paging.
      if (r.text.trimStart().startsWith('<') || r.status === 401 || r.status === 403) {
        if (page === 0) {
          sessionExpired(res);
          return;
        }
        break;
      }
      if (!r.ok) {
        if (page === 0) {
          res.status(502).json({ error: 'Die Abwesenheiten konnten gerade nicht geladen werden.' });
          return;
        }
        break;
      }
      const parsed = JSON.parse(r.text) as Record<string, unknown>;
      const inner = (parsed?.data as Record<string, unknown>) ?? parsed;
      const items = (inner?.absences as unknown[]) ?? [];
      if (totalCount === null) {
        totalCount = (inner?.count as number) ?? (inner?.totalCount as number) ?? (inner?.totalElements as number) ?? null;
      }
      if (items.length === 0) break;
      // WebUntis repeating the first page (no paging support): stop.
      const firstId = (items[0] as Record<string, unknown>)?.id;
      if (page > 0 && all.some((a) => (a as Record<string, unknown>).id === firstId)) break;
      all.push(...items);
      if (items.length < PAGE_SIZE || (totalCount !== null && all.length >= totalCount)) break;
    }
    res.json({ data: { absences: all, count: all.length } });
  } catch (e) {
    res.status(500).json({ error: errorText(e) });
  }
});

// The absence reasons arrive inside the absences envelope (`data.absenceReasons`);
// one day is asked for, which is cheap. An override path is tried first.
function parseReasons(json: unknown): { id: number; name: string }[] {
  const root = (json ?? {}) as Record<string, unknown>;
  const data = root.data as Record<string, unknown> | undefined;
  const arr: unknown[] =
    (root.absenceReasons as unknown[]) ??
    (root.reasons as unknown[]) ??
    (data?.absenceReasons as unknown[]) ??
    (data?.reasons as unknown[]) ??
    (Array.isArray(data) ? data : null) ??
    (Array.isArray(json) ? (json as unknown[]) : null) ??
    [];
  return arr
    .map((item) => {
      const r = item as Record<string, unknown>;
      const id = r.id ?? r.reasonId ?? r.absenceReasonId ?? r.value;
      const name = r.name ?? r.longName ?? r.displayName ?? r.label ?? r.text ?? r.shortName ?? '';
      return { id: Number(id), name: String(name).trim() };
    })
    .filter((r) => Number.isFinite(r.id) && r.name && r.name !== '---');
}

router.get('/absence-reasons', async (req: Request, res: Response) => {
  const s = session(req);
  const d = isoDay(new Date()).replace(/-/g, '');
  const candidates = [
    config.webuntis.paths.absenceReasons || undefined,
    `${config.webuntis.paths.absences}?studentId=${s.studentId}&startDate=${d}&endDate=${d}&excuseStatusId=-1`,
  ];
  try {
    const result = await firstWorkingGet(s, candidates, (json) => parseReasons(json).length > 0);
    if (!result.ok) {
      if (result.reason === 'expired') sessionExpired(res);
      else res.status(502).json({ error: 'Abwesenheitsgründe konnten gerade nicht geladen werden.' });
      return;
    }
    res.json({ reasons: parseReasons(result.json) });
  } catch (e) {
    res.status(500).json({ error: errorText(e) });
  }
});

// Reasons and defaults for "Abwesenheit melden" (GET /api/classreg/absences/meta,
// what the official report dialog loads first).
router.get('/absences/meta', async (req: Request, res: Response) => {
  try {
    const r = await untis(session(req), '/api/classreg/absences/meta', { rest: false, timeoutMs: 12_000 });
    if (r.expired) {
      sessionExpired(res);
      return;
    }
    if (!r.ok) {
      res.status(502).json({ error: 'Abwesenheitsgründe konnten nicht geladen werden.' });
      return;
    }
    const root = (r.json ?? {}) as Record<string, unknown>;
    const d = ((root.data as Record<string, unknown>) ?? root) as Record<string, unknown>;
    const list = (d.absenceReasons ?? d.reasons ?? []) as Array<Record<string, unknown>>;
    const reasons = (Array.isArray(list) ? list : [])
      .map((x) => ({ id: Number(x.id), name: String(x.name ?? x.longName ?? x.displayName ?? '').trim() }))
      .filter((x) => Number.isFinite(x.id) && x.name && x.name !== '---');
    const def = d.defaultAbsenceReason as { id?: unknown } | undefined;
    res.json({
      reasons,
      defaultReasonId: def?.id != null ? Number(def.id) : null,
      defaultDate: typeof d.defaultDate === 'number' ? d.defaultDate : null,
      defaultStartTime: typeof d.defaultStartTime === 'number' ? d.defaultStartTime : null,
      defaultEndTime: typeof d.defaultEndTime === 'number' ? d.defaultEndTime : null,
    });
  } catch {
    res.status(502).json({ error: 'Abwesenheitsgründe konnten nicht geladen werden.' });
  }
});

// "Abwesenheit melden", as the official client does it (createStudentAbsence):
// POST /api/classreg/absences/students/self with the session's CSRF token. The
// absence is saved only when WebUntis reports no conflicts. The student id
// always comes from the session, never from the request.
router.post('/absences/create', async (req: Request, res: Response) => {
  const s = session(req);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const startDate = ymdNumber(body.startDate);
  const endDate = ymdNumber(body.endDate);
  const startTime = hmNumber(body.startTime);
  const endTime = hmNumber(body.endTime);
  if (startDate == null || endDate == null) {
    res.status(400).json({ error: 'Ungültiges Datum.', code: 'invalid_date' });
    return;
  }
  if (startTime == null || endTime == null) {
    res.status(400).json({ error: 'Ungültige Uhrzeit.', code: 'invalid_time' });
    return;
  }
  if (endDate * 10_000 + endTime <= startDate * 10_000 + startTime) {
    res.status(400).json({ error: 'Das Ende muss nach dem Beginn liegen.', code: 'end_before_start' });
    return;
  }
  const reasonRaw = String(body.reasonId ?? '-1');
  if (!/^-?\d{1,9}$/.test(reasonRaw)) {
    res.status(400).json({ error: 'Ungültiger Grund.', code: 'invalid_reason' });
    return;
  }
  const text = String(body.text ?? '').slice(0, 1000);

  // WebUntis' own age-aware flag (showCreateAbsence) decides who may report.
  if (!(await canReportAbsence(s))) {
    res.status(403).json({ error: 'Abwesenheiten melden ist für dein Konto in WebUntis nicht freigegeben.', code: 'not_allowed' });
    return;
  }

  try {
    const r = await untisClassicWrite(s, '/api/classreg/absences/students/self', {
      method: 'POST',
      json: { studentId: s.studentId, startDate, startTime, endDate, endTime, text, reasonId: Number(reasonRaw) },
    });
    if (r.expired) {
      sessionExpired(res);
      return;
    }
    const outcome = absenceWriteOutcome(r);
    if (outcome.ok) {
      res.json({ ok: true });
      return;
    }
    if (outcome.conflicts.length) {
      res.status(409).json({ error: 'Für diesen Zeitraum gibt es bereits eine Abwesenheit.', code: 'conflict', conflicts: conflictTexts(outcome.conflicts) });
      return;
    }
    logger.warn('[webuntis absences/create] WebUntis rejected the request', { status: r.status, code: outcome.code ?? '' });
    res.status(502).json({ error: outcome.error ?? 'Die Abwesenheit konnte nicht gemeldet werden.', code: outcome.code ?? 'create_failed' });
  } catch {
    res.status(502).json({ error: 'Die Abwesenheit konnte nicht gemeldet werden.', code: 'create_failed' });
  }
});

// "Löschen" on the student absence list (deleteStudentAbsence):
// DELETE /api/classreg/absences/students { absenceIds }. WebUntis decides
// which absences the account may delete.
router.post('/absences/delete', async (req: Request, res: Response) => {
  const raw = (req.body ?? {}) as { absenceIds?: unknown };
  const ids = (Array.isArray(raw.absenceIds) ? raw.absenceIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 50);
  if (ids.length === 0) {
    res.status(400).json({ error: 'Keine Abwesenheit ausgewählt.', code: 'no_absence' });
    return;
  }
  try {
    const r = await untisClassicWrite(session(req), '/api/classreg/absences/students', { method: 'DELETE', json: { absenceIds: ids } });
    if (r.expired) {
      sessionExpired(res);
      return;
    }
    const errors = (r.json as { errors?: unknown[] } | null)?.errors;
    if (r.ok && !(Array.isArray(errors) && errors.length)) {
      res.json({ ok: true });
      return;
    }
    logger.warn('[webuntis absences/delete] WebUntis rejected the request', { status: r.status });
    res.status(502).json({ error: untisError(r.json) ?? 'Die Abwesenheit konnte nicht gelöscht werden.', code: 'delete_failed' });
  } catch {
    res.status(502).json({ error: 'Die Abwesenheit konnte nicht gelöscht werden.', code: 'delete_failed' });
  }
});

// A reason and a note for existing absences, what "entschuldigen" is for a
// student in WebUntis (the excuse status itself is set by the school), as the
// official edit dialog does it: read the absence (only when canEdit), then
// POST /api/classreg/absences/students/edit keeping its own dates and times.
interface UntisAbsence {
  id?: number;
  startDate?: number;
  startTime?: number;
  endDate?: number;
  endTime?: number;
  canEdit?: boolean;
}

router.post('/absences/excuse', async (req: Request, res: Response) => {
  const s = session(req);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const ids = (Array.isArray(body.absenceIds) ? body.absenceIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 20);
  if (ids.length === 0) {
    res.status(400).json({ error: 'Keine Abwesenheit ausgewählt.', code: 'no_absence' });
    return;
  }
  const reasonRaw = String(body.reasonId ?? '-1');
  if (!/^-?\d{1,9}$/.test(reasonRaw)) {
    res.status(400).json({ error: 'Ungültiger Grund.', code: 'invalid_reason' });
    return;
  }
  const reasonId = Number(reasonRaw);
  const text = String(body.text ?? '').slice(0, 1000);

  const results: { id: number; ok: boolean; code?: string; error?: string; conflicts?: string[] }[] = [];
  for (const id of ids) {
    try {
      const current = await untis(s, `/api/classreg/absences/student?absenceId=${id}`, { rest: false, timeoutMs: 12_000 });
      if (current.expired) {
        sessionExpired(res);
        return;
      }
      const absence = (current.json as { data?: { absence?: UntisAbsence } } | null)?.data?.absence ?? null;
      if (!current.ok || !absence) {
        results.push({ id, ok: false, code: 'not_found' });
        continue;
      }
      if (!absence.canEdit) {
        results.push({ id, ok: false, code: 'not_editable' });
        continue;
      }
      const r = await untisClassicWrite(s, '/api/classreg/absences/students/edit', {
        method: 'POST',
        json: { absenceId: id, startDate: absence.startDate, startTime: absence.startTime, endDate: absence.endDate, endTime: absence.endTime, text, reasonId },
      });
      if (r.expired) {
        sessionExpired(res);
        return;
      }
      const outcome = absenceWriteOutcome(r);
      if (outcome.ok) results.push({ id, ok: true });
      else {
        if (!outcome.conflicts.length) logger.warn('[webuntis absences/excuse] WebUntis rejected the edit', { status: r.status, code: outcome.code ?? '' });
        results.push({
          id,
          ok: false,
          code: outcome.conflicts.length ? 'conflict' : (outcome.code ?? 'edit_failed'),
          error: outcome.error,
          conflicts: outcome.conflicts.length ? conflictTexts(outcome.conflicts) : undefined,
        });
      }
    } catch {
      results.push({ id, ok: false, code: 'edit_failed' });
    }
  }

  const saved = results.filter((r) => r.ok).length;
  if (saved === results.length) {
    res.json({ ok: true, results });
    return;
  }
  const first = results.find((r) => !r.ok);
  const message =
    first?.code === 'not_editable' ? 'WebUntis erlaubt dir bei dieser Abwesenheit keine Änderung.'
    : first?.code === 'not_found' ? 'Die Abwesenheit wurde in WebUntis nicht gefunden.'
    : first?.code === 'conflict' ? 'WebUntis meldet eine Überschneidung mit einer anderen Abwesenheit.'
    : first?.error ?? 'Die Abwesenheit konnte nicht gespeichert werden.';
  res.status(saved > 0 ? 207 : 422).json({ ok: false, saved, results, error: message, code: first?.code });
});

// "Entschuldigungsschreiben drucken": the excuse letter WebUntis generates as a
// PDF, requested like the official absence list does (handleOpenExcuseReport).
// A report WebUntis is still generating answers 202 and is simply asked for
// again. Read-only: generating the letter changes nothing in WebUntis.
router.get('/absences/excuse-letter', async (req: Request, res: Response) => {
  const s = session(req);
  const start = ymdNumber(req.query['start']);
  const end = ymdNumber(req.query['end']);
  const group = req.query['group'] === '2' ? '2' : '1'; // 1 = per lesson, 2 = per day
  const ids = String(req.query['ids'] ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 100);
  if (start == null || end == null) {
    res.status(400).json({ error: 'Ungültiger Zeitraum.' });
    return;
  }
  const status = String(req.query['status'] ?? '');
  const params = new URLSearchParams({
    name: 'Excuse',
    format: 'pdf',
    rpt_sd: String(start),
    rpt_ed: String(end),
    excuseStatusId: /^-?\d{1,6}$/.test(status) ? status : '1',
    withLateness: 'true',
    withAbsences: 'true',
    excuseGroup: group,
  });
  for (const id of ids) params.append('id', String(id));

  try {
    const job = await untis(s, `/reports.do?${params.toString()}`, { rest: false, timeoutMs: 20_000 });
    if (job.expired) {
      sessionExpired(res);
      return;
    }
    const data = (job.json as { data?: { finished?: boolean; messageId?: unknown; reportParams?: unknown } } | null)?.data;
    if (!job.ok || !data) {
      res.status(502).json({ error: 'Das Entschuldigungsschreiben konnte nicht erstellt werden.' });
      return;
    }
    if (!data.finished) {
      res.status(202).json({ pending: true, error: 'WebUntis erstellt das Schreiben noch. Versuch es gleich noch einmal.' });
      return;
    }
    const file = await readFetch(`${untisBase(s)}/reports.do?msgId=${encodeURIComponent(String(data.messageId ?? ''))}&${String(data.reportParams ?? '')}`, {
      headers: { Cookie: cookieHeader(s) },
      signal: AbortSignal.timeout(30_000),
    });
    const type = file.headers.get('content-type') ?? '';
    if (!file.ok || type.includes('text/html') || type.includes('application/json')) {
      res.status(502).json({ error: 'Das Entschuldigungsschreiben konnte nicht geladen werden.' });
      return;
    }
    const sent = await streamFile(file, res, () => {
      embeddable(res);
      res.setHeader('Content-Type', type || 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="Entschuldigung-${start}.pdf"`);
    });
    if (!sent) res.status(502).json({ error: 'Das Entschuldigungsschreiben konnte nicht geladen werden.' });
  } catch {
    if (!res.headersSent) res.status(502).json({ error: 'Das Entschuldigungsschreiben konnte nicht erstellt werden.' });
  }
});

// ── Permissions and profile ─────────────────────────────────────────────────

// The account's capabilities for the write features: above all whether it may
// self-report and excuse absences (WebUntis' age-aware gate).
router.get('/permissions', async (req: Request, res: Response) => {
  const s = session(req);
  try {
    const [flag, data] = await Promise.all([fetchAbsenceCreateFlag(s), fetchAppData(s)]);
    if (!data.ok && data.expired) {
      sessionExpired(res);
      return;
    }
    // As on the WebUntis page: only its own flag opens reporting.
    const canReport = config.webuntis.forceAbsenceReport || flag === true;
    const personName = data.ok ? (extractAbsenceSubjectName(data.json) ?? s.personName ?? null) : (s.personName ?? null);
    res.json({ canReportAbsence: canReport, personName });
  } catch (e) {
    res.status(500).json({ error: errorText(e) });
  }
});

// The account's WebUntis picture: it lives behind the WebUntis session, so the
// browser can't load it from WebUntis directly. Without a picture the answer
// is 204, so the image fails quietly and the website shows initials.
router.get('/profile-image', async (req: Request, res: Response) => {
  const s = session(req);
  const noPicture = () => {
    embeddable(res);
    res.setHeader('Cache-Control', 'private, max-age=600');
    res.status(204).end();
  };
  // The URL captured at sign-in ('' when the account has none); a live lookup
  // for sessions from before that.
  let imageUrl = s.imageUrl;
  if (imageUrl === undefined) {
    const appData = await fetchAppData(s);
    imageUrl = appData.ok ? extractImageUrl(appData.json, s.isParent) : undefined;
  }
  if (!imageUrl) {
    noPicture();
    return;
  }

  // Only the WebUntis domain family is ever fetched: profile pictures come
  // from a CDN host under the school server's registrable domain.
  const base = untisBase(s);
  let target: string;
  try {
    const url = new URL(/^https?:\/\//.test(imageUrl) ? imageUrl : new URL(imageUrl.startsWith('/') ? imageUrl : `/${imageUrl}`, base).toString());
    const rootDomain = new URL(base).host.split('.').slice(-2).join('.');
    if (url.protocol !== 'https:' || !(url.host === rootDomain || url.host.endsWith(`.${rootDomain}`))) {
      res.status(400).json({ error: 'Ungültige Bildquelle.' });
      return;
    }
    target = url.toString();
  } catch {
    res.status(400).json({ error: 'Ungültige Bildquelle.' });
    return;
  }

  try {
    const r = await readFetch(target, { headers: await sessionHeaders(s), signal: AbortSignal.timeout(15_000) });
    const ct = r.headers.get('content-type') ?? '';
    if (!r.ok || ct.includes('text/html') || ct.includes('application/json')) {
      noPicture();
      return;
    }
    const sent = await streamFile(r, res, () => {
      embeddable(res);
      res.setHeader('Content-Type', ct || 'image/jpeg');
      res.setHeader('Cache-Control', 'private, max-age=3600');
    });
    if (!sent) noPicture();
  } catch {
    if (!res.headersSent) res.status(502).json({ error: 'Profilbild nicht ladbar.' });
  }
});

// Changing the WebUntis password, as the official profile page does it:
// POST /api/profile/access/password with the session's CSRF token and
// Tenant-Id. WebUntis checks the old password and its rules itself. The new
// password only goes back into the browser's sealed renewal cookie.
router.post('/password', passwordChangeLimiter, async (req: Request, res: Response) => {
  const s = session(req);
  const body = (req.body ?? {}) as { oldPassword?: unknown; newPassword?: unknown };
  const oldPassword = typeof body.oldPassword === 'string' ? body.oldPassword : '';
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
  if (!oldPassword || !newPassword) {
    res.status(400).json({ error: 'Bitte beide Passwörter eingeben.', code: 'missing' });
    return;
  }
  if (oldPassword.length > 200 || newPassword.length > 200) {
    res.status(400).json({ error: 'Eingabe zu lang.', code: 'too_long' });
    return;
  }
  if (oldPassword === newPassword) {
    res.status(400).json({ error: 'Das neue Passwort muss sich vom alten unterscheiden.', code: 'same_password' });
    return;
  }
  try {
    const r = await untisClassicWrite(s, '/api/profile/access/password', { method: 'POST', json: { oldPassword, newPassword }, timeoutMs: 15_000 });
    if (r.expired) {
      res.status(401).json({ error: 'session_expired', code: 'session_expired' });
      return;
    }
    const errors = (r.json as { errors?: unknown[] } | null)?.errors;
    if (r.ok && !(Array.isArray(errors) && errors.length)) {
      // The automatic renewal signs in with the new password from now on.
      sealRenewal(res, { username: s.username, password: newPassword, school: s.school ?? defaultSchool() });
      res.json({ ok: true });
      return;
    }
    logger.warn('[webuntis password] WebUntis rejected the change', { status: r.status, code: untisErrorCode(r.json) ?? '' });
    res.status(r.status === 400 || r.status === 422 ? 400 : 502).json({
      error: untisError(r.json) ?? 'Das Passwort konnte nicht geändert werden.',
      code: untisErrorCode(r.json) ?? 'change_failed',
    });
  } catch {
    res.status(502).json({ error: 'Das Passwort konnte nicht geändert werden.', code: 'change_failed' });
  }
});

// ── Messages ────────────────────────────────────────────────────────────────

const FOLDER_PATHS: Record<string, string> = {
  inbox: config.webuntis.paths.messageList,
  sent: config.webuntis.paths.messageSent,
  drafts: config.webuntis.paths.messageDrafts,
};

const ID = /^\d{1,12}$/;
const idParam = (req: Request): string | null => {
  const id = req.query['id'];
  return typeof id === 'string' && ID.test(id) ? id : null;
};

// Message folders (MessageCenter 2021); each answers a differently named
// array (incomingMessages / sentMessages / draftMessages) the website normalises.
router.get('/messages', async (req: Request, res: Response) => {
  const rawId = req.query['id'];
  const messageId = idParam(req);
  if (rawId !== undefined && !messageId) {
    res.status(400).json({ error: 'Ungültige Nachrichten-ID.' });
    return;
  }
  const folder = typeof req.query['folder'] === 'string' ? req.query['folder'] : 'inbox';
  const path = messageId
    ? folder === 'sent' ? `/api/rest/view/v1/messages/sent/${messageId}` : `/api/rest/view/v1/messages/${messageId}`
    : `${FOLDER_PATHS[folder] ?? FOLDER_PATHS.inbox}?pageSize=100&start=0`;
  const attachmentsOnly = messageId !== null && req.query['attachments'] === '1';
  try {
    const r = await untis(session(req), path, { textOnly: !attachmentsOnly });
    if (r.expired || r.status === 403) {
      sessionExpired(res);
      return;
    }
    if (!r.ok) {
      res.status(502).json({ error: 'Die Nachrichten konnten gerade nicht geladen werden.' });
      return;
    }
    // Attachment lists ride along in the message detail.
    if (attachmentsOnly) {
      const j = (r.json ?? {}) as Record<string, unknown>;
      const d = (j.data as Record<string, unknown>) ?? j;
      res.json({ attachments: d.storageAttachments ?? d.attachments ?? [] });
      return;
    }
    // A list or a message as WebUntis sent it; anything else as before (null).
    if (/^\s*[[{]/.test(r.text)) sendJsonText(res, r.text);
    else res.json(null);
  } catch {
    res.status(502).json({ error: 'Die Nachrichten konnten gerade nicht geladen werden.' });
  }
});

// POST ?id= marks a message read. WebUntis has no "mark read" call; the
// official client marks a message read by opening it, so this does the same.
router.post('/messages', async (req: Request, res: Response) => {
  const messageId = idParam(req);
  if (!messageId) {
    res.status(400).json({ error: 'Ungültige Nachrichten-ID.' });
    return;
  }
  try {
    const r = await untis(session(req), `/api/rest/view/v1/messages/${messageId}`, { textOnly: true });
    if (r.expired) {
      sessionExpired(res);
      return;
    }
    res.json({ ok: r.ok });
  } catch {
    res.status(502).json({ ok: false });
  }
});

// The recipients the official client loads for the TEACHER option: groups of
// persons for CLASS_TEACHERS / TEACHERS / OTHERS. Works for students and guardians.
interface Recipient {
  id: number;
  type: string;
  name: string;
  role?: string;
  initials: string;
  category: 'classTeacher' | 'other';
}

function initialsOf(name: string): string {
  const parts = name.replace(/[(),]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function parseRecipients(json: unknown): Recipient[] {
  type PersonGroup = { type?: string; persons?: { displayName?: string; userId?: number; id?: number; tags?: string[] }[] };
  const groups: PersonGroup[] = Array.isArray(json) ? (json as PersonGroup[]) : [];
  const byId = new Map<number, Recipient>();
  for (const g of groups) {
    const type = String(g?.type ?? '').toUpperCase();
    for (const p of Array.isArray(g?.persons) ? g.persons : []) {
      const id = Number(p?.userId ?? p?.id);
      const name = String(p?.displayName ?? '').trim();
      if (!Number.isFinite(id) || !name) continue;
      // One entry per person: a class teacher also appears under TEACHERS.
      const existing = byId.get(id);
      if (existing) {
        if (type === 'CLASS_TEACHERS') existing.category = 'classTeacher';
        continue;
      }
      const tags = Array.isArray(p?.tags) ? p.tags.filter(Boolean) : [];
      byId.set(id, {
        id,
        type: type || 'TEACHERS',
        name,
        role: tags.length ? tags.join(', ') : undefined,
        initials: initialsOf(name),
        category: type === 'CLASS_TEACHERS' ? 'classTeacher' : 'other',
      });
    }
  }
  return [...byId.values()];
}

router.get('/messages/recipients', async (req: Request, res: Response) => {
  const s = session(req);
  try {
    const [r, perms] = await Promise.all([
      untis(s, config.webuntis.paths.messageRecipients, { timeoutMs: 12_000 }),
      fetchMessagePermissions(s),
    ]);
    if (r.expired) {
      sessionExpired(res);
      return;
    }
    if (!r.ok) {
      res.status(502).json({ error: 'Empfänger konnten nicht geladen werden.' });
      return;
    }
    // With the TEACHER option WebUntis takes exactly one recipient per message.
    const option = perms.recipientOptions[0] ?? 'TEACHER';
    res.json({
      recipients: parseRecipients(r.json),
      recipientOption: option,
      single: option === 'TEACHER',
      maxFileCount: perms.maxFileCount,
      maxFileSize: perms.maxFileSize,
    });
  } catch {
    res.status(502).json({ error: 'Empfänger konnten nicht geladen werden.' });
  }
});

// A draft: GET ?id= loads it, DELETE ?id= deletes it (as the official client).
function parseDraft(json: unknown) {
  type DraftPerson = { id?: unknown; userId?: unknown; type?: unknown; displayName?: unknown; name?: unknown };
  const root = (json as Record<string, unknown>) ?? {};
  const d = (root.data as Record<string, unknown>) ?? root;
  const rawContent = String(d.content ?? d.contentHtml ?? d.body ?? '');
  const content = /<[a-z][\s\S]*>/i.test(rawContent) ? htmlToText(rawContent) : rawContent;
  const rawR = (d.recipientPersons ?? d.recipients ?? []) as DraftPerson[];
  const recipients = (Array.isArray(rawR) ? rawR : [])
    .map((r) => ({ id: Number(r.id ?? r.userId), type: String(r.type ?? 'TEACHER').toUpperCase(), name: String(r.displayName ?? r.name ?? '') }))
    .filter((r) => Number.isFinite(r.id) && r.id > 0);
  // Files already uploaded to this draft; WebUntis keeps them on a PUT edit.
  const rawA = (d.storageAttachments ?? d.attachments ?? []) as { id?: unknown; name?: unknown }[];
  const attachments = (Array.isArray(rawA) ? rawA : [])
    .map((a) => ({ id: String(a.id ?? ''), name: String(a.name ?? '') }))
    .filter((a) => a.id && a.name);
  return { id: Number(d.id) || undefined, subject: String(d.subject ?? ''), content, recipients, attachments };
}

router.get('/messages/draft', async (req: Request, res: Response) => {
  const id = idParam(req);
  if (!id) {
    res.status(400).json({ error: 'Ungültige Entwurf-ID.' });
    return;
  }
  try {
    const r = await untis(session(req), `/api/rest/view/v1/messages/drafts/${id}`, { timeoutMs: 12_000 });
    if (r.expired) {
      sessionExpired(res);
      return;
    }
    if (!r.ok) {
      res.status(404).json({ error: 'Entwurf nicht gefunden.' });
      return;
    }
    res.json(parseDraft(r.json));
  } catch {
    res.status(502).json({ error: 'Entwurf konnte nicht geladen werden.' });
  }
});

router.delete('/messages/draft', async (req: Request, res: Response) => {
  const id = idParam(req);
  if (!id) {
    res.status(400).json({ error: 'Ungültige Entwurf-ID.' });
    return;
  }
  try {
    const r = await untis(session(req), `/api/rest/view/v1/messages/${id}`, { method: 'DELETE', timeoutMs: 12_000 });
    if (r.expired) {
      sessionExpired(res);
      return;
    }
    if (r.ok) res.json({ ok: true });
    else res.status(502).json({ error: 'Entwurf konnte nicht gelöscht werden.' });
  } catch {
    res.status(502).json({ error: 'Entwurf konnte nicht gelöscht werden.' });
  }
});

// Multipart bodies (messages with attachments) are read here, bounded: the
// API's JSON body limit does not apply to them, this one does.
const MAX_FORM_BYTES = 40 * 1024 * 1024;

class FormTooLarge extends Error {}

async function readForm(req: Request): Promise<FormData> {
  const type = String(req.headers['content-type'] ?? '');
  if (!type.toLowerCase().startsWith('multipart/form-data')) throw new Error('not multipart');
  if (Number(req.headers['content-length'] ?? 0) > MAX_FORM_BYTES) throw new FormTooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buf.length;
    if (size > MAX_FORM_BYTES) throw new FormTooLarge();
    chunks.push(buf);
  }
  return new globalThis.Response(Buffer.concat(chunks), { headers: { 'content-type': type } }).formData();
}

// An uploaded file of a multipart body (fetch's own File type).
type Upload = Exclude<ReturnType<FormData['get']>, string | null>;

function formFiles(form: FormData): Upload[] {
  return form.getAll('attachments').filter((f): f is Upload => typeof f !== 'string' && f.size > 0);
}

function multipart(request: unknown, files: Upload[]): FormData {
  const fd = new FormData();
  fd.append('request', new Blob([JSON.stringify(request)], { type: 'application/json' }));
  for (const f of files) fd.append('attachments', f, f.name);
  return fd;
}

// MessageCenter writes, exactly as the official web client makes them
// (multipart: a JSON part "request" plus repeatable "attachments"):
//   TEACHER / STAFF / CUSTOM option → POST /api/rest/view/v2/messages/users
//   any other option                → POST /api/rest/view/v2/messages
//   new draft                       → POST /api/rest/view/v2/messages/drafts
//   edited draft                    → PUT  /api/rest/view/v2/messages/drafts/{id}
// Drafts carry no recipients in WebUntis; they are chosen when sending. Each
// write is sent once to one endpoint and never retried against a guessed path.

const USER_OPTIONS = new Set(['TEACHER', 'STAFF', 'CUSTOM']);

const SEND_MESSAGES: Record<string, string> = {
  invalid_request: 'Ungültige Anfrage.',
  no_recipient: 'Kein Empfänger ausgewählt.',
  one_recipient: 'Bitte genau eine Lehrkraft als Empfänger auswählen.',
  no_subject: 'Betreff fehlt.',
  no_content: 'Nachrichtentext fehlt.',
  empty_draft: 'Entwurf ist leer.',
  too_many_files: 'Zu viele Anhänge.',
  file_too_large: 'Eine Datei ist zu groß.',
  send_failed: 'Die Nachricht konnte nicht gesendet werden.',
  draft_failed: 'Der Entwurf konnte nicht gespeichert werden.',
  session_expired: 'session_expired',
};

function sendFail(res: Response, code: string, status: number, extra: Record<string, unknown> = {}): void {
  res.status(status).json({ error: SEND_MESSAGES[code] ?? code, code, ...extra });
}

router.post('/messages/send', async (req: Request, res: Response) => {
  const s = session(req);
  const isDraft = req.query['draft'] === '1';

  let subject = '';
  let content = '';
  let recipientIds: number[] = [];
  let files: Upload[] = [];
  let draftId: number | null = null;
  try {
    const form = await readForm(req);
    let rawRecipients: unknown = [];
    try { rawRecipients = JSON.parse(String(form.get('recipients') ?? '[]')); } catch { rawRecipients = []; }
    recipientIds = [...new Set((Array.isArray(rawRecipients) ? rawRecipients : [])
      .map((r) => Number((r as { id?: unknown })?.id ?? r))
      .filter((id) => Number.isInteger(id) && id > 0))];
    // The draft being edited arrives as a form field or, from older callers, as `?id=`.
    const draftRaw = String(form.get('draftId') ?? req.query['id'] ?? '');
    draftId = ID.test(draftRaw) ? Number(draftRaw) : null;
    subject = String(form.get('subject') ?? '').trim().slice(0, 255);
    content = String(form.get('content') ?? '').slice(0, 10_000);
    files = formFiles(form);
  } catch (e) {
    sendFail(res, e instanceof FormTooLarge ? 'file_too_large' : 'invalid_request', e instanceof FormTooLarge ? 413 : 400);
    return;
  }

  if (!isDraft) {
    if (recipientIds.length === 0) return sendFail(res, 'no_recipient', 400);
    if (!subject) return sendFail(res, 'no_subject', 400);
    if (!content.trim()) return sendFail(res, 'no_content', 400);
  } else if (!subject && !content.trim() && files.length === 0) {
    return sendFail(res, 'empty_draft', 400);
  }

  try {
    const perms = await fetchMessagePermissions(s);
    if (perms.expired) return sendFail(res, 'session_expired', 401);
    if (files.length > perms.maxFileCount) return sendFail(res, 'too_many_files', 400, { limit: perms.maxFileCount });
    const tooBig = files.find((f) => f.size > perms.maxFileSize);
    if (tooBig) return sendFail(res, 'file_too_large', 400, { name: tooBig.name, limit: perms.maxFileSize });

    const option = perms.recipientOptions[0] ?? 'TEACHER';
    // With the TEACHER option the official client sends to exactly one person.
    if (!isDraft && option === 'TEACHER' && recipientIds.length !== 1) return sendFail(res, 'one_recipient', 400);
    const html = plainTextToHtml(content);

    let path: string;
    let method: 'POST' | 'PUT' = 'POST';
    let request: Record<string, unknown>;
    if (isDraft) {
      request = { subject, content: html, recipientOption: option, copyToStudent: false, requestConfirmation: false, forbidReply: false, oneDriveAttachments: [] };
      if (draftId) {
        path = `/api/rest/view/v2/messages/drafts/${draftId}`;
        method = 'PUT';
        request.attachmentIdsToDelete = [];
      } else {
        path = '/api/rest/view/v2/messages/drafts';
      }
    } else if (USER_OPTIONS.has(option)) {
      path = '/api/rest/view/v2/messages/users';
      request = {
        subject, content: html, requestConfirmation: false, recipientUserIds: recipientIds, forbidReply: false, oneDriveAttachments: [],
        ...(draftId ? { draftMessageId: draftId } : {}),
      };
    } else {
      path = '/api/rest/view/v2/messages';
      request = {
        subject, content: html, recipientOption: option, recipientPersonIds: recipientIds, recipientGroupIds: [], copyToStudent: false,
        requestConfirmation: false, forbidReply: false, oneDriveAttachments: [],
        ...(draftId ? { draftMessageId: draftId } : {}),
      };
    }

    const r = await untis(s, path, { method, form: multipart(request, files), timeoutMs: 30_000 });
    if (r.expired) return sendFail(res, 'session_expired', 401);
    if (r.ok) {
      res.json({ ok: true, data: r.json });
      return;
    }
    logger.warn('[webuntis messages/send] WebUntis rejected the request', { status: r.status });
    const code = isDraft ? 'draft_failed' : 'send_failed';
    res.status(502).json({ error: untisError(r.json) ?? SEND_MESSAGES[code], code, status: r.status });
  } catch (e) {
    logger.warn('[webuntis messages/send] failed', { message: errorText(e, 'unknown').split('\n')[0] });
    sendFail(res, isDraft ? 'draft_failed' : 'send_failed', 502);
  }
});

// Replying, as the official client does it:
//   GET  /api/rest/view/v1/messages/{id}/reply-form → prefilled subject and the recipient
//   POST /api/rest/view/v2/messages/{id}/reply      (multipart: "request" JSON + "attachments")
router.get('/messages/reply', async (req: Request, res: Response) => {
  const id = idParam(req);
  if (!id) {
    res.status(400).json({ error: 'Ungültige Nachrichten-ID.' });
    return;
  }
  try {
    const r = await untis(session(req), `/api/rest/view/v1/messages/${id}/reply-form?contentAsHtml=false`, { timeoutMs: 12_000 });
    if (r.expired) {
      sessionExpired(res);
      return;
    }
    if (!r.ok) {
      // WebUntis answers 4xx when the sender forbade replies or the message type has none.
      res.status(409).json({ error: untisError(r.json) ?? 'Auf diese Nachricht kann nicht geantwortet werden.', code: 'reply_unavailable' });
      return;
    }
    const form = (r.json ?? {}) as { subject?: unknown; recipient?: { displayName?: unknown; userId?: unknown; id?: unknown } };
    res.json({
      subject: String(form.subject ?? ''),
      recipient: form.recipient ? { name: String(form.recipient.displayName ?? ''), id: Number(form.recipient.userId ?? form.recipient.id) || null } : null,
    });
  } catch {
    res.status(502).json({ error: 'Antwort konnte nicht vorbereitet werden.', code: 'reply_unavailable' });
  }
});

router.post('/messages/reply', async (req: Request, res: Response) => {
  const s = session(req);
  const id = idParam(req);
  if (!id) {
    res.status(400).json({ error: 'Ungültige Nachrichten-ID.', code: 'invalid_request' });
    return;
  }
  let subject = '';
  let content = '';
  let files: Upload[] = [];
  try {
    const form = await readForm(req);
    subject = String(form.get('subject') ?? '').trim().slice(0, 255);
    content = String(form.get('content') ?? '').slice(0, 10_000);
    files = formFiles(form);
  } catch (e) {
    if (e instanceof FormTooLarge) res.status(413).json({ error: 'Eine Datei ist zu groß.', code: 'file_too_large' });
    else res.status(400).json({ error: 'Ungültige Anfrage.', code: 'invalid_request' });
    return;
  }
  if (!subject) {
    res.status(400).json({ error: 'Betreff fehlt.', code: 'no_subject' });
    return;
  }
  if (!content.trim()) {
    res.status(400).json({ error: 'Nachrichtentext fehlt.', code: 'no_content' });
    return;
  }
  try {
    const perms = await fetchMessagePermissions(s);
    if (perms.expired) {
      res.status(401).json({ error: 'session_expired', code: 'session_expired' });
      return;
    }
    if (files.length > perms.maxFileCount) {
      res.status(400).json({ error: 'Zu viele Anhänge.', code: 'too_many_files' });
      return;
    }
    if (files.some((f) => f.size > perms.maxFileSize)) {
      res.status(400).json({ error: 'Eine Datei ist zu groß.', code: 'file_too_large' });
      return;
    }
    const r = await untis(s, `/api/rest/view/v2/messages/${id}/reply`, {
      method: 'POST',
      form: multipart({ subject, content: plainTextToHtml(content), oneDriveAttachments: [] }, files),
      timeoutMs: 30_000,
    });
    if (r.expired) {
      res.status(401).json({ error: 'session_expired', code: 'session_expired' });
      return;
    }
    if (r.ok) {
      res.json({ ok: true });
      return;
    }
    logger.warn('[webuntis messages/reply] WebUntis rejected the request', { status: r.status });
    res.status(502).json({ error: untisError(r.json) ?? 'Die Antwort konnte nicht gesendet werden.', code: 'send_failed' });
  } catch {
    res.status(502).json({ error: 'Die Antwort konnte nicht gesendet werden.', code: 'send_failed' });
  }
});

// Attachment download, the way the official client does it:
//   1. storage attachments: GET /v1/messages/{storageId}/attachmentstorageurl
//      → { downloadUrl, additionalHeaders[] }, then the signed URL with those
//      headers (minus `host`) plus its X-Amz-Date;
//   2. blob attachments:    GET /v1/messages/{attachmentId}/attachment
router.get('/attachment', async (req: Request, res: Response) => {
  const s = session(req);
  const messageId = String(req.query['messageId'] ?? '');
  const storageId = String(req.query['storageId'] ?? '');
  const attachmentIdRaw = String(req.query['attachmentId'] ?? '');
  const name = String(req.query['name'] ?? 'Anhang').slice(0, 200);
  if (!ID.test(messageId)) {
    res.status(400).json({ error: 'Ungültige Nachrichten-ID.' });
    return;
  }
  if (storageId && !/^[\w\-.:@/+=]{1,256}$/.test(storageId)) {
    res.status(400).json({ error: 'Ungültige Storage-ID.' });
    return;
  }
  const attachmentId = ID.test(attachmentIdRaw) && attachmentIdRaw !== '0' ? attachmentIdRaw : '';

  // Downloads are kept like the website kept them: the event, the file name,
  // address and browser; no account.
  prisma.frontendActivityLog.create({
    data: {
      event: 'download', page: '/webuntis/attachment', detail: name.slice(0, 500), stableUid: null, username: null,
      ip: clientIp(req), userAgent: String(req.headers['user-agent'] ?? '').slice(0, 500) || null, schoolId: null,
    },
  }).catch(() => {});

  const isFile = (r: globalThis.Response) => {
    const ct = r.headers.get('content-type') ?? '';
    return !ct.includes('text/html') && !ct.includes('application/json');
  };
  const send = (r: globalThis.Response): Promise<boolean> => {
    const contentType = r.headers.get('content-type') ?? 'application/octet-stream';
    const safeName = name.replace(/[^\w.\-_ ]/g, '_').replace(/\.\./g, '_').trim() || 'Anhang';
    const inline = contentType.startsWith('image/') || contentType === 'application/pdf';
    return streamFile(r, res, () => {
      embeddable(res);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(safeName)}"`);
      res.setHeader('Cache-Control', 'private, max-age=300');
    });
  };

  if (storageId) {
    try {
      const info = await untis(s, `/api/rest/view/v1/messages/${encodeURIComponent(storageId)}/attachmentstorageurl`, { timeoutMs: 10_000 });
      if (info.expired) {
        sessionExpired(res);
        return;
      }
      const data = (info.json ?? {}) as { downloadUrl?: string; additionalHeaders?: Array<{ key?: string; name?: string; value?: string }> };
      if (info.ok && data.downloadUrl) {
        const url = new URL(data.downloadUrl);
        if (url.protocol !== 'https:') throw new Error('insecure download url');
        const headers: Record<string, string> = {};
        for (const h of data.additionalHeaders ?? []) {
          const k = h.key ?? h.name;
          if (k && h.value && k.toLowerCase() !== 'host') headers[k] = h.value;
        }
        const amzDate = url.searchParams.get('X-Amz-Date');
        if (amzDate) headers['X-Amz-Date'] = amzDate;
        const file = await readFetch(url, { headers, signal: AbortSignal.timeout(30_000) });
        if (file.ok && isFile(file) && (await send(file))) return;
      }
    } catch {
      /* the blob route below */
    }
  }

  if (attachmentId) {
    try {
      const token = await bearerToken(s);
      const file = await readFetch(`${untisBase(s)}/api/rest/view/v1/messages/${attachmentId}/attachment`, {
        headers: { Cookie: cookieHeader(s), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(30_000),
      });
      if (file.status === 401) {
        sessionExpired(res);
        return;
      }
      if (file.ok && isFile(file) && (await send(file))) return;
    } catch {
      /* fall through */
    }
  }

  res.status(404).json({ error: 'Anhang konnte nicht heruntergeladen werden.' });
});

export { router as webuntisRouter };
