import 'dotenv/config';
import fs from 'fs';
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import path from 'path';
import { spawnPrismaCli } from './utils/prismaCli';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { config } from './config';
import { globalLimiter } from './middleware/rateLimiter';
import { AppError } from './utils/errors';
import { appRouter } from './routes/index';
import { setupRouter } from './routes/setup';
import { requestLogger } from './middleware/requestLogger';
import { adminLive, adminAppSync } from './services/adminLive';
import { expireLapsedAdminSetups } from './services/adminLogin';
import { requestId } from './middleware/requestId';
import { prisma } from './db';
import { startPushPoller } from './services/pushPoller';
import { startArchiver } from './services/archiver';
import { startSchoolYearArchiver } from './services/schoolYearArchiver';
import { startBackupScheduler } from './services/dbBackup';
import { applyAdditiveSchema } from './services/schemaSync';
import { databaseIsEmpty, healLostDatabase, rememberDataPresent } from './services/dbHeal';
import { startOffsiteSync } from './services/offsite';
import { closeCache } from './services/cache';
import { migrateStableKeys } from './utils/dishKey';
import { reconcileDishRatings } from './services/dishRatings';
import { logger } from './utils/logger';
import { getLearnConfig } from './services/learnConfig';
import { ensureModelReady } from './services/learnAiOllama';
import { learningDayKey } from './services/learnAnalytics';
import { localDayAndHour } from './services/usageAnalytics';
import { keyUnkeyedVisits } from './services/visitorKey';
import { closeLearnCache } from './services/learnCache';
import { isSameOrigin, withWwwOriginAlias } from './utils/cors';
import { loadSessionRevocations, loadTokenRevocations } from './utils/revokedTokens';
import { cleanupSessions } from './services/sessions';
import { cleanupQrLogins } from './services/qrLogin';
import { mayRunExclusiveJob, ownsClusterWork } from './cluster/hooks';
import { CLUSTER_PATH } from './cluster/protocol';
import { createClusterRouter } from './cluster/router';
import { startClusterListener, stopClusterListener } from './cluster/listener';
import { RELAY_SCRIPT_PATH, handleRelayScript } from './cluster/relaySetup';
import { SETUP_PATH, createSetupRouter } from './cluster/provision';
import { startCluster, stopCluster } from './cluster';
import { migrateLegacyAdmins, migrateToSchools } from './services/multiSchool';
import { backfillAccountDays } from './services/accountDays';
import { activityCutoffDay } from './services/accountActivity';
import { BELL_MARK_RETENTION_DAYS, deleteExpiredBellMarks } from './services/bellMarks';

const app = express();

// ─── Proxy trust ─────────────────────────────────────────────────────────────
// Trust forwarded client-IP headers only when the operator explicitly configures
// the known reverse-proxy topology through TRUST_PROXY.
app.set('trust proxy', config.trustProxy);

// ─── Debug logging ───────────────────────────────────────────────────────────

if (config.debug) {
  app.use(morgan('dev'));
  app.use((req, _res, next) => {
    // Credentials, API keys, user-created content, and imports can all be
    // carried in request bodies. Keep debug tracing structural only.
    logger.debug('[request received]', { method: req.method, path: req.path });
    next();
  });
}

// ─── Admin static files — served BEFORE CORS so the browser's same-origin ────
// crossorigin requests are never blocked by CORS middleware. No hardcoded URLs.

const adminDist = path.join(__dirname, '..', 'admin', 'dist');
// The panel is mounted ahead of helmet() below and so would otherwise be the
// one response without any security headers. It must not be framed by another
// site (clickjacking of destructive admin actions), must not be MIME-sniffed,
// and must not hand its URL to other sites as a referrer. Same framing policy
// (same origin only) that helmet applies to every other route.
app.use('/admin', (_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use('/admin', express.static(adminDist, { index: false }));
app.use('/admin', (_req: Request, res: Response) => {
  res.sendFile(path.join(adminDist, 'index.html'), (err) => {
    // Without a built admin panel there is nothing to serve; that is a plain
    // "not found", not a server fault.
    if (err && !res.headersSent) res.status(404).json({ error: 'Admin panel is not built' });
  });
});

// ─── Security middleware ─────────────────────────────────────────────────────

app.use(helmet({ contentSecurityPolicy: false }));

// CORS origins — fully config-driven. The www/apex form of each configured
// HTTP(S) origin is included as the conventional equivalent browser host.
// This avoids an accidental outage when the public site redirects between
// `pokyh.com` and `www.pokyh.com`, without opening access to arbitrary origins.
const parsedCorsOrigins = config.corsOrigin.split(',').map((o) => o.trim()).filter(Boolean);
// A malformed CORS_ORIGIN (e.g. only commas/whitespace) silently degrades to
// zero origins from this source. That alone won't break CORS entirely — the
// other sources below still apply — but a real misconfigured production
// origin would then be rejected with nothing in the logs to explain why.
if (parsedCorsOrigins.length === 0 && config.corsOrigin.trim() !== '') {
  logger.warn(`CORS_ORIGIN is set but contains no usable origin after parsing: "${config.corsOrigin}"`);
}

const allowedOrigins = new Set([
  ...parsedCorsOrigins.flatMap(withWwwOriginAlias),
  ...config.learnAllowedOrigins,
  ...(config.isDev ? ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:3005', 'http://localhost:5173'] : []),
  `http://localhost:${config.port}`,
  `https://localhost:${config.port}`,
]);

// Same-origin requests (the admin panel calling the server it was loaded
// from, under whatever name — localhost, 127.0.0.1, a LAN address) always
// pass; the list above governs other origins only.
app.use(
  cors((req, callback) => {
    callback(null, {
      origin: (origin, done) => {
        if (!origin) return done(null, true);
        if (allowedOrigins.has(origin) || isSameOrigin(origin, req.headers.host)) return done(null, true);
        done(new Error(`CORS: origin ${origin} not allowed`));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      // X-Pokyh-Client: "pwa" when the website runs installed (its entry in the device list).
      allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Server-Key', 'Idempotency-Key', 'X-Pokyh-School', 'X-Pokyh-Client'],
      // The website calls this API directly: browsers may keep a preflight's
      // answer this long (seconds) instead of asking before every request.
      maxAge: 7200,
    });
  })
);

// ─── Node-to-node replication channel ────────────────────────────────────────
// Mounted ahead of the body parsers, request log and rate limiter: it carries
// encrypted binary frames between paired nodes and authenticates them itself.
// Served here only with CLUSTER_PUBLIC_PATH (nodes behind a reverse proxy);
// CLUSTER_PORT serves it on a listener of its own. Answers 404 for everything
// while the cluster layer is not running.
if (config.cluster.publicPath) app.use(CLUSTER_PATH, createClusterRouter('public'));
// The relay installer, only while an administrator has opened its window
// (relaySetup.ts); no secret in it, checked by SHA-256 on the relay server.
app.get(RELAY_SCRIPT_PATH, handleRelayScript);
// The one-line node installer's public address: 404 unless an administrator
// has just created an install command (provision.ts).
app.use(SETUP_PATH, createSetupRouter());

// ─── Body parsing ────────────────────────────────────────────────────────────

// Larger body limit for image upload routes; biggest for full-DB JSON import
app.use('/api/admin/import', express.json({ limit: config.bodyLimitImport }));
// Learn personal imports are separately scoped and never share the legacy
// database-import route, but they need the same configured size budget.
app.use('/learn/library/import', express.json({ limit: config.bodyLimitImport }));
// A vocabulary-list merge import can carry up to a course's full configured
// word cap worth of text/notes/tags, which can exceed the general admin
// body limit below.
app.use('/api/admin/learn/courses/:courseId/vocabulary/import', express.json({ limit: config.bodyLimitImport }));
app.use('/subject-images', express.json({ limit: config.bodyLimitUpload }));
app.use('/api/admin', express.json({ limit: config.bodyLimitUpload }));
app.use(express.json({ limit: config.bodyLimit }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// ─── Request identification, logging and rate limiting ───────────────────────
//
// Install correlation and finish-event logging before the limiter so 429s are
// traceable too. The logger only inspects request metadata at finish time; it
// never records bodies or credentials.
app.use(requestId);
app.use(requestLogger);
// Live updates: announce changes to open admin panels, and push an
// administrator's edits to the app streams. Both act after the response.
app.use(adminLive);
app.use('/api/admin', adminAppSync);
app.use(globalLimiter);

// ─── Health checks ───────────────────────────────────────────────────────────

// /health deliberately stays a process liveness check for existing callers.
// Compose and load balancers should use /readyz, which additionally proves the
// database connection is ready to serve durable Pokyh/Learn state.
let databaseReady = false;
let databaseStartupComplete = false;

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/readyz', async (_req, res) => {
  if (!databaseStartupComplete) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(503).json({ status: 'starting' });
    return;
  }
  try {
    // Static Prisma SQL with no interpolation. This endpoint never accepts
    // request-derived SQL, and it actively retries after a transient MySQL
    // outage instead of leaving the container permanently unhealthy.
    if (!databaseReady) await prisma.$connect();
    await prisma.$queryRaw(Prisma.sql`SELECT 1`);
    databaseReady = true;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ status: 'ready' });
  } catch {
    databaseReady = false;
    res.setHeader('Cache-Control', 'no-store');
    res.status(503).json({ status: 'unavailable' });
  }
});

// ─── Setup API (no API key required, locked by logic inside) ──────────────────

app.use('/api/setup', setupRouter);

// ─── Routes ──────────────────────────────────────────────────────────────────

app.use('/', appRouter);

// ─── 404 handler ─────────────────────────────────────────────────────────────

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Route not found' });
});

// ─── Global error handler ────────────────────────────────────────────────────

app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  if (config.debug && err instanceof Error) {
    logger.debug('[error]', { stack: err.stack, requestId: req.id });
  }

  // A stream (SSE, file download) that fails after its headers went out
  // cannot be turned into an error response any more. Writing one anyway
  // would raise a second error from inside this handler; closing the
  // connection is the only correct signal left.
  if (res.headersSent) {
    logger.warn('[server] request failed after the response had started', {
      message: err instanceof Error ? err.message.split('\n')[0] : String(err),
      requestId: req.id,
    });
    res.end();
    return;
  }

  // Operational errors (our AppError subclasses)
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    return;
  }

  // Zod validation errors
  if (err instanceof ZodError) {
    const message = err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
    res.status(422).json({ error: `Validation error: ${message}` });
    return;
  }

  // Prisma known request errors
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      res.status(409).json({ error: 'A record with this value already exists' });
      return;
    }
    if (err.code === 'P2025') {
      res.status(404).json({ error: 'Record not found' });
      return;
    }
    logger.error('[prisma] known error', { code: err.code, message: err.message, requestId: req.id });
    res.status(400).json({ error: 'Database error' });
    return;
  }

  // CORS errors
  if (err instanceof Error && err.message.startsWith('CORS:')) {
    res.status(403).json({ error: err.message });
    return;
  }

  // body-parser's request-too-large error previously fell through to the
  // generic 500 below — give it its own clean, non-leaking response instead.
  if (err && typeof err === 'object' && 'type' in err && (err as { type?: unknown }).type === 'entity.too.large') {
    res.status(413).json({ error: 'Request body is too large' });
    return;
  }

  // Unknown errors
  logger.error('[server] unhandled error', { message: err instanceof Error ? err.message : String(err), requestId: req.id });
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Start server ─────────────────────────────────────────────────────────────

const SESSION_CLEANUP_INTERVAL = config.sessionCleanupIntervalMs;

async function cleanupExpiredSessions() {
  // Replicated data: in a cluster one node cleaning up is enough.
  if (!ownsClusterWork('job:session-cleanup')) return;
  // Device sessions unused (or signed out) for SESSION_IDLE_DAYS, and the
  // login history older than LOGIN_HISTORY_DAYS (services/sessions.ts).
  const { sessions, logins } = await cleanupSessions();
  // QR sign-ins that ran out (services/qrLogin.ts).
  const qr = await cleanupQrLogins();
  if (sessions > 0 || logins > 0 || qr > 0) logger.info(`Session cleanup: ${sessions} device sessions, ${logins} login history entries and ${qr} QR sign-ins deleted`);
}

async function cleanupExpiredRequestLogs() {
  const cutoff = new Date(Date.now() - config.requestLogRetentionDays * 24 * 60 * 60 * 1000);
  const { count } = await prisma.requestLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
  // Their per-day summary (node-local as well) stays for the school year when
  // ACCOUNT_ACTIVITY_SCHOOL_YEAR is on, otherwise it goes with them.
  const cutoffDay = config.accountActivitySchoolYear
    ? await activityCutoffDay()
    : localDayAndHour(cutoff, config.usageAnalytics.timezone).dayKey;
  await prisma.requestAccountDay.deleteMany({ where: { dayKey: { lt: cutoffDay } } });
  if (count > 0) logger.info('Request log retention cleanup', {
    action: 'request_log_retention_cleanup',
    deletedCount: count,
    retentionDays: config.requestLogRetentionDays,
  });
}

async function cleanupExpiredLearnAnalytics() {
  if (!ownsClusterWork('job:learn-analytics-cleanup')) return;
  const learnCfg = await getLearnConfig();
  const cutoff = new Date(Date.now() - learnCfg.analyticsRetentionDays * 24 * 60 * 60 * 1000);
  // Activity rows contain a user-local calendar key. UTC gives a stable,
  // conservative cleanup boundary and cannot delete a newer local day.
  const cutoffDayKey = learningDayKey(cutoff, 'UTC');
  const { count } = await prisma.learnActivityDaily.deleteMany({
    where: { dayKey: { lt: cutoffDayKey } },
  });
  if (count > 0) logger.info('Learn analytics retention cleanup', {
    action: 'learn_analytics_retention_cleanup',
    deletedCount: count,
    retentionDays: learnCfg.analyticsRetentionDays,
  });
}

async function cleanupExpiredUsageSessions() {
  // Replicated data: in a cluster one node cleaning up is enough.
  if (!ownsClusterWork('job:usage-analytics-cleanup')) return;
  const { timezone, retentionDays } = config.usageAnalytics;
  const now = Date.now();
  // Linked to the account for the school year (ACCOUNT_ACTIVITY_SCHOOL_YEAR),
  // otherwise for USAGE_ANALYTICS_RETENTION_DAYS.
  const cutoffDayKey = config.accountActivitySchoolYear
    ? await activityCutoffDay()
    : localDayAndHour(new Date(now - retentionDays * 24 * 60 * 60 * 1000), timezone).dayKey;
  // Nothing is deleted: a visit only loses its account, after which it is one
  // of the anonymous counts the page is built from.
  // 0. Visits without a visitor key get one first, so they keep counting.
  const keyed = await keyUnkeyedVisits();
  // 1. Named only for the school year or USAGE_ANALYTICS_RETENTION_DAYS.
  const expired = await prisma.usageSession.updateMany({
    where: { stableUid: { not: null }, dayKey: { lt: cutoffDayKey } },
    data: { stableUid: null },
  });
  // 2. Named only with consent (rows from before it was asked, a race with a
  //    withdrawal on another node).
  const withoutConsent = await prisma.$executeRaw`
    UPDATE usage_sessions SET stable_uid = NULL
    WHERE stable_uid IS NOT NULL
      AND stable_uid NOT IN (SELECT stable_uid FROM privacy_consents WHERE usage_stats = 1)`;
  // 3. Finished anonymous visits keep only the hour, so their times cannot be
  //    matched against other records.
  const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
  const coarsened = await prisma.$executeRaw`
    UPDATE usage_sessions
    SET started_at = DATE_FORMAT(started_at, '%Y-%m-%d %H:00:00'),
        last_seen_at = DATE_FORMAT(last_seen_at, '%Y-%m-%d %H:00:00')
    WHERE stable_uid IS NULL AND last_seen_at < ${dayAgo}
      AND (MINUTE(started_at) <> 0 OR SECOND(started_at) <> 0 OR MINUTE(last_seen_at) <> 0 OR SECOND(last_seen_at) <> 0)`;
  // 4. Visitor-key salts of finished days go; their keys can then never be
  //    traced back. Yesterday's stays a day for visits past midnight.
  const yesterdayKey = localDayAndHour(dayAgo, timezone).dayKey;
  const salts = await prisma.usageDaySalt.deleteMany({ where: { dayKey: { lt: yesterdayKey } } });
  if (keyed > 0 || expired.count > 0 || withoutConsent > 0 || coarsened > 0 || salts.count > 0) logger.info('Usage analytics retention cleanup', {
    action: 'usage_analytics_retention_cleanup',
    keyed,
    anonymisedExpired: expired.count,
    anonymisedWithoutConsent: withoutConsent,
    coarsened,
    saltsDeleted: salts.count,
    retentionDays,
  });
}

// Frontend activity (page views, sign-ins, downloads) is technical personal
// data like the request logs and kept as long. Page views keep who and from
// where only with the account's usage-statistics consent. Node-local table:
// every node cleans its own rows.
async function cleanupFrontendActivity() {
  const cutoff = new Date(Date.now() - config.requestLogRetentionDays * 24 * 60 * 60 * 1000);
  const { count } = await prisma.frontendActivityLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
  const anonymised = await prisma.$executeRaw`
    UPDATE frontend_activity_logs
    SET stable_uid = NULL, username = NULL, ip = NULL, user_agent = NULL
    WHERE event = 'page_view'
      AND (stable_uid IS NOT NULL OR username IS NOT NULL OR ip IS NOT NULL OR user_agent IS NOT NULL)
      AND (stable_uid IS NULL OR stable_uid NOT IN (SELECT stable_uid FROM privacy_consents WHERE usage_stats = 1))`;
  if (count > 0 || anonymised > 0) logger.info('Frontend activity retention cleanup', {
    action: 'frontend_activity_cleanup',
    deletedCount: count,
    anonymisedCount: anonymised,
    retentionDays: config.requestLogRetentionDays,
  });
}

// The admin audit trail is kept AUDIT_RETENTION_DAYS (at least 180). One
// node is enough: the table is replicated.
async function cleanupAuditEvents() {
  if (!ownsClusterWork('job:audit-retention')) return;
  const cutoff = new Date(Date.now() - config.auditRetentionDays * 24 * 60 * 60 * 1000);
  const { count } = await prisma.adminAuditEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
  if (count > 0) logger.info('Admin audit retention cleanup', { action: 'audit_retention_cleanup', deletedCount: count, retentionDays: config.auditRetentionDays });
}

// Error reports of the web app and the apps: node-local, short-lived.
async function cleanupClientErrors() {
  const cutoff = new Date(Date.now() - config.clientErrors.retentionDays * 24 * 60 * 60 * 1000);
  const { count } = await prisma.clientErrorLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
  if (count > 0) logger.info('Client error retention cleanup', { action: 'client_error_cleanup', deletedCount: count, retentionDays: config.clientErrors.retentionDays });
}

// The bell's seen and cleared marks (services/bellMarks.ts): kept 30 days, as
// the privacy notice says. Replicated data: one node is enough.
async function cleanupBellMarks() {
  if (!ownsClusterWork('job:bell-marks-cleanup')) return;
  const count = await deleteExpiredBellMarks();
  if (count > 0) logger.info('Bell mark retention cleanup', { action: 'bell_mark_cleanup', deletedCount: count, retentionDays: BELL_MARK_RETENTION_DAYS });
}

// Website and app visitors (web_visits): the address, the place derived from
// it, an app visit's link to its usage visit and a consenting account's name
// are personal data and kept as long as the request logs. After that a row is
// an anonymous count — country, device, day, hour, page or app version — with
// its time cut to the hour. A name without (or after withdrawing) consent goes
// at once. Replicated data: one node is enough.
async function cleanupWebVisits() {
  if (!ownsClusterWork('job:web-visits-cleanup')) return;
  const cutoff = new Date(Date.now() - config.requestLogRetentionDays * 24 * 60 * 60 * 1000);
  const anonymised = await prisma.$executeRaw`
    UPDATE web_visits
    SET ip = NULL, region = NULL, city = NULL, stable_uid = NULL, account_key = NULL, session_id = NULL,
        created_at = DATE_FORMAT(created_at, '%Y-%m-%d %H:00:00')
    WHERE created_at < ${cutoff}
      AND (ip IS NOT NULL OR region IS NOT NULL OR city IS NOT NULL OR stable_uid IS NOT NULL OR account_key IS NOT NULL
           OR session_id IS NOT NULL OR MINUTE(created_at) <> 0 OR SECOND(created_at) <> 0)`;
  // Named only with consent: a withdrawal on another node, a race.
  const withoutConsent = await prisma.$executeRaw`
    UPDATE web_visits SET stable_uid = NULL
    WHERE stable_uid IS NOT NULL
      AND stable_uid NOT IN (SELECT stable_uid FROM privacy_consents WHERE usage_stats = 1)`;
  // Signed-in visits count by account (webVisitMeta.visitorSource). Rows keyed
  // by device instead — written before that rule, or by a node still on an
  // older version during a rolling update — get the account's day key while
  // their day's salt exists (today and yesterday); afterwards nothing can be
  // rekeyed, by design. Matches nothing once every row is in step.
  const rekeyed = await prisma.$executeRaw`
    UPDATE web_visits w
    JOIN usage_day_salts s ON s.day_key = w.day_key
    SET w.visitor_key = LEFT(SHA2(CONCAT(s.salt, ':web-account:', w.account_key), 256), 16)
    WHERE w.account_key IS NOT NULL
      AND w.visitor_key <> LEFT(SHA2(CONCAT(s.salt, ':web-account:', w.account_key), 256), 16)`;
  if (anonymised > 0 || withoutConsent > 0 || rekeyed > 0) logger.info('Web visit retention cleanup', {
    action: 'web_visit_retention_cleanup',
    anonymisedCount: anonymised,
    anonymisedWithoutConsent: withoutConsent,
    rekeyedByAccount: rekeyed,
    retentionDays: config.requestLogRetentionDays,
  });
}

let backgroundJobsStarted = false;

// Starts the periodic background jobs exactly once, after the DB is reachable.
function startBackgroundJobs() {
  if (backgroundJobsStarted) return;
  backgroundJobsStarted = true;

  // Session cleanup: deferred first run + interval.
  setTimeout(() => void cleanupExpiredSessions().catch(() => {}), 5000);
  setInterval(() => void cleanupExpiredSessions().catch(() => {}), SESSION_CLEANUP_INTERVAL);

  // Request/audit correlation is valuable for support and security, but these
  // records contain technical personal data. Remove expired rows on a bounded,
  // documented schedule rather than retaining them indefinitely.
  setTimeout(() => void cleanupExpiredRequestLogs().catch(() => {}), 10_000);
  setInterval(() => void cleanupExpiredRequestLogs().catch(() => {}), config.requestLogCleanupIntervalMs);

  // Daily aggregates deliberately have a bounded, administrator-configurable
  // retention policy. This job handles the privacy lifecycle independently of
  // the normal request-log cleanup cadence.
  setTimeout(() => void cleanupExpiredLearnAnalytics().catch(() => {}), 15_000);
  setInterval(() => void cleanupExpiredLearnAnalytics().catch(() => {}), 24 * 60 * 60 * 1000);

  // Per-visit usage rows behind the admin Analytics page have a finite,
  // documented retention as well (USAGE_ANALYTICS_RETENTION_DAYS).
  setTimeout(() => void cleanupExpiredUsageSessions().catch(() => {}), 20_000);
  setInterval(() => void cleanupExpiredUsageSessions().catch(() => {}), 24 * 60 * 60 * 1000);
  setTimeout(() => void cleanupFrontendActivity().catch(() => {}), 25_000);
  setInterval(() => void cleanupFrontendActivity().catch(() => {}), config.requestLogCleanupIntervalMs);
  setTimeout(() => void cleanupWebVisits().catch(() => {}), 30_000);
  setInterval(() => void cleanupWebVisits().catch(() => {}), config.requestLogCleanupIntervalMs);
  setTimeout(() => void cleanupAuditEvents().catch(() => {}), 35_000);
  setInterval(() => void cleanupAuditEvents().catch(() => {}), 24 * 60 * 60 * 1000);
  setTimeout(() => void cleanupClientErrors().catch(() => {}), 40_000);
  setInterval(() => void cleanupClientErrors().catch(() => {}), config.requestLogCleanupIntervalMs);
  setTimeout(() => void cleanupBellMarks().catch(() => {}), 45_000);
  setInterval(() => void cleanupBellMarks().catch(() => {}), 24 * 60 * 60 * 1000);

  // Once per installation: admin accounts from before permissions existed
  // become global admins (services/multiSchool.ts). On one node only; until
  // it ran, those accounts have no rights (denied, not granted, by default).
  // Retried until done — in a cluster the chosen node may be busy upgrading.
  let legacyAdminsDone = false;
  const migrateAdmins = () => {
    if (legacyAdminsDone || !mayRunExclusiveJob('admin-grants-migration')) return;
    void migrateLegacyAdmins()
      .then(() => { legacyAdminsDone = true; })
      .catch((err) => logger.warn(`admin grant migration failed (retrying): ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`));
  };
  migrateAdmins();
  // The Analytics page's per-day account summary, filled from the request
  // logs once on a node that has none yet (services/accountDays.ts).
  setTimeout(() => void backfillAccountDays().catch((err) => {
    logger.warn(`account day backfill failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }), 5_000);
  const adminMigrationTimer = setInterval(() => { if (legacyAdminsDone) clearInterval(adminMigrationTimer); else migrateAdmins(); }, 15_000);
  adminMigrationTimer.unref();

  // A WebUntis account made admin that did not sign in within its setup
  // window loses the grant and its one-time password. The node that made the
  // grant also has a timer for the exact moment; this covers restarts.
  const expireAdminSetups = () => {
    if (!ownsClusterWork('job:admin-setup-expiry')) return;
    void expireLapsedAdminSetups().catch(() => {});
  };
  setTimeout(expireAdminSetups, 8_000);
  setInterval(expireAdminSetups, 30_000);

  // Each job is started on its own: one that cannot start (for example a
  // rejected configuration value) must not keep the others from running.
  const startJob = (name: string, start: () => void) => {
    try {
      start();
    } catch (err) {
      logger.error(`Background job "${name}" could not be started: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // In a cluster there is no leader: notifications and polling are shared out
  // per item over the reachable nodes, and jobs whose effect must happen
  // exactly once (archiving, the school-year rollover) run on one node only
  // while every node is reachable. On a standalone server every check is true.

  // Archive expired todos/reminders (>24h) — server-only, admin-viewable.
  startJob('archiver', () => startArchiver(() => mayRunExclusiveJob('archiver')));

  // Push notification poller (no-op if VAPID keys not configured)
  startJob('push poller', () => startPushPoller(ownsClusterWork));

  // School year rollover: on August 1st, snapshot non-admin users/classes/todos/reminders
  startJob('school-year archiver', () => startSchoolYearArchiver(() => mayRunExclusiveJob('school-year-rollover')));

  // Scheduled full-database backups (mysqldump, gzip), retained for the
  // configured number of days and pruned automatically after each run.
  startJob('backup scheduler', () => startBackupScheduler());

  // Encrypted copies of the backups in an S3-compatible bucket, when set up.
  startJob('off-site backups', () => startOffsiteSync());

  // AI vocabulary trainer model provisioning ("check, else pull, then start"):
  // deliberately fire-and-forget, never awaited here. A multi-GB first-boot
  // model pull must never delay the HTTP server from listening or gate
  // /readyz — training requests check isModelReady() themselves and return a
  // friendly 503 until the pull completes.
  //
  // Never re-downloads an already-present model: ensureModelReady() checks
  // Ollama's /api/tags first and only calls /api/pull if the configured
  // model is missing from it. The pulled model is stored in the named
  // `ollama_data` Docker volume (docker-compose.yml), which persists across
  // container restarts/redeploys — so every subsequent boot (including a
  // Dokploy redeploy) finds the model already there and skips the pull
  // entirely. Live-verified: recreating both the `app` and `ollama`
  // containers with the model already pulled produced no re-pull, only the
  // "Database ready" log line. Also re-invoked (same no-op-if-present
  // behaviour) after an admin changes the model in the Pokyh AI admin page.
  void ensureModelReady();
}

// Create the database (if missing) and apply the schema via `prisma db push`.
// Idempotent and additive — safe to run on every boot. Returns true on success.
function pushSchema(): Promise<boolean> {
  return new Promise((resolve) => {
    // No --accept-data-loss: db push then refuses any destructive change
    // (safe — only additive schema updates are applied automatically).
    const child = spawnPrismaCli(['db', 'push', '--skip-generate'], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const onData = (b: Buffer) => { out += b.toString(); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, config.dbPushTimeoutMs);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const last = out.split('\n').filter(Boolean).slice(-2).join(' | ');
        logger.warn(`prisma db push failed (code ${code}): ${last}`);
      }
      resolve(code === 0);
    });
  });
}

// Bring the database up in the background with retry/backoff so the HTTP server
// is never blocked by a slow/unavailable/uninitialised database. Each round
// ensures the schema (creating the DB if needed) and then connects. The process
// stays alive across failures — reliable for first boot and rolling restarts.
async function connectDatabaseWithRetry() {
  let attempt = 0;
  // Whether the database was empty before the schema was applied: the
  // signal that its volume was lost (services/dbHeal.ts). Kept across
  // retries; unknown (null) while the database server cannot be reached.
  let emptyBefore: boolean | null = null;
  for (;;) {
    try {
      if (emptyBefore === null) emptyBefore = await databaseIsEmpty();
      if (config.dbAutoPush) {
        const ok = await pushSchema();
        if (!ok) {
          // `db push` refused — most often because the diff contains a
          // destructive step, which blocks the additive changes too. Apply the
          // additive part of the diff (new tables/columns) without dropping any
          // data, so features like the school-year archive keep working. This is
          // best-effort; `$connect` below is the real readiness gate, so a DB
          // that is simply not up yet still retries cleanly.
          try {
            await applyAdditiveSchema();
          } catch (err) {
            logger.warn(`Additive schema sync skipped: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
          }
        }
      }
      await prisma.$connect();
      // An empty database on a node that had data: rebuilt from the newest
      // backup, then brought to the current schema again (the dump's tables
      // are as old as the dump).
      if (emptyBefore === true && await healLostDatabase()) {
        if (!(config.dbAutoPush && await pushSchema())) {
          await applyAdditiveSchema().catch((err) => {
            logger.warn(`Additive schema sync after the rebuild failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
          });
        }
      }
      void rememberDataPresent();
      databaseReady = true;
      databaseStartupComplete = true;
      logger.info('Database ready (schema applied, connected)');
      // Idempotent — safe to run every boot. Populates dish.stableKey and
      // rewrites rating/comment dishId references so bewertungen survive
      // resets and shared-name Sommer/Winter dishes share ratings.
      try { await migrateStableKeys(); } catch (err) {
        logger.warn(`stableKey migration failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
      // Idempotent — merges votes orphaned by recreated accounts back onto the
      // current account and removes the duplicate votes that allowed.
      try { await reconcileDishRatings(); } catch (err) {
        logger.warn(`dish rating reconcile failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
      // Session revocations survive a restart through the database.
      try { await loadTokenRevocations(); await loadSessionRevocations(); } catch (err) {
        logger.warn(`token revocation load failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
      // Idempotent — the default school, and every school-specific row from
      // before schools existed assigned to it (services/multiSchool.ts).
      try { await migrateToSchools(); } catch (err) {
        logger.warn(`multi-school migration failed (non-fatal, retried next start): ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
      }
      // Blue/green (servers set up by the installer): a new container serves
      // HTTP at once, but takes over background work and the cluster only
      // once the updater has stopped the previous one and named this one.
      await waitForActivation();
      // Before the background jobs: they ask the cluster layer whether this
      // node is the one that should run them. Never throws.
      await startCluster();
      startBackgroundJobs();
      return;
    } catch (err) {
      databaseReady = false;
      attempt++;
      const delay = Math.min(
        config.dbConnectBaseDelayMs * 2 ** Math.min(attempt, 5),
        config.dbConnectMaxDelayMs,
      );
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`DB init attempt ${attempt} failed (${msg.split('\n')[0]}). Retrying in ${delay}ms…`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// Returns once this container is the active one (immediately where no
// activation file is configured, or none has been written yet).
async function waitForActivation(): Promise<void> {
  const { color, activationFile } = config.deploy;
  if (!color || !activationFile) return;
  let announced = false;
  for (;;) {
    let active: string | null = null;
    try {
      active = fs.readFileSync(activationFile, 'utf8').trim();
    } catch {
      active = null;
    }
    if (active === null || active === '' || active === color) {
      if (announced) logger.info('Activated by the updater; taking over background work and the cluster', { action: 'deploy_activated', color });
      return;
    }
    if (!announced) {
      announced = true;
      logger.info('Waiting to be activated by the updater (serving HTTP meanwhile)', { action: 'deploy_waiting', color, active });
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

let server: ReturnType<typeof app.listen> | null = null;

function start() {
  // Listen immediately — startup never waits on the database.
  // Bind to 0.0.0.0 so the server is reachable on every network interface
  // (LAN/containers), not just loopback.
  // The node-to-node channel's own port, when CLUSTER_PORT is set.
  startClusterListener();
  server = app.listen(config.port, '0.0.0.0', () => {
    logger.info(`Server running on port ${config.port} (${config.nodeEnv})`);
    logger.info(`API: http://localhost:${config.port}`);
    logger.info(`Admin: http://localhost:${config.port}/admin/`);

    if (!config.adminPasswordHash) {
      logger.info('No admin password set — open /admin/ to complete setup');
    }

    // Connect to the DB and start background jobs in the background (non-blocking).
    void connectDatabaseWithRetry();

  });
}

start();

// A rejected promise nobody handled is a bug worth knowing about, but not a
// reason to drop every connected client: log it and keep serving.
process.on('unhandledRejection', (reason) => {
  logger.error('[server] unhandled promise rejection', {
    message: reason instanceof Error ? reason.message.split('\n')[0] : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

// Kept well below the ten seconds a container runtime allows before it kills
// the process, so the orderly path below is the one that normally completes.
const SHUTDOWN_GRACE_MS = 4_000;
let shuttingDown = false;

// Stop accepting connections, let requests in flight finish, then release the
// cache and database. Long-lived streams (SSE) never finish by themselves, so
// after a grace period the remaining connections are closed.
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, shutting down...`);
  databaseReady = false;

  const forced = setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS + 3_000);
  forced.unref();

  const active = server;
  if (active) {
    await new Promise<void>((resolve) => {
      const closeAll = setTimeout(() => active.closeAllConnections(), SHUTDOWN_GRACE_MS);
      closeAll.unref();
      active.close(() => {
        clearTimeout(closeAll);
        resolve();
      });
      active.closeIdleConnections();
    });
  }

  await stopClusterListener().catch(() => {});
  await stopCluster().catch(() => {});
  await closeLearnCache().catch(() => {});
  await closeCache().catch(() => {});
  await prisma.$disconnect().catch(() => {});
  process.exit(0);
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
