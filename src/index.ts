import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import path from 'path';
import { spawn } from 'child_process';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { config } from './config';
import { globalLimiter } from './middleware/rateLimiter';
import { AppError } from './utils/errors';
import { appRouter } from './routes/index';
import { setupRouter } from './routes/setup';
import { requestLogger } from './middleware/requestLogger';
import { requestId } from './middleware/requestId';
import { prisma } from './db';
import { startTunnel, stopTunnel, isTunnelConfigured, getHostnameFromCloudflaredConfig } from './tunnel';
import { startPushPoller } from './services/pushPoller';
import { startArchiver } from './services/archiver';
import { startSchoolYearArchiver } from './services/schoolYearArchiver';
import { applyAdditiveSchema } from './services/schemaSync';
import { migrateStableKeys } from './utils/dishKey';
import { logger } from './utils/logger';
import { getLearnConfig } from './services/learnConfig';
import { learningDayKey } from './services/learnAnalytics';
import { closeLearnCache } from './services/learnCache';

const app = express();

// ─── Proxy trust ─────────────────────────────────────────────────────────────
// Behind the Cloudflare tunnel the real client IP arrives via X-Forwarded-For.
// Declaring the trusted proxy lets express-rate-limit identify clients correctly
// (and stops it from throwing ERR_ERL_UNEXPECTED_X_FORWARDED_FOR). Config-driven
// via TRUST_PROXY; defaults to 'loopback' for the in-container cloudflared proxy.
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
app.use('/admin', express.static(adminDist, { index: false }));
app.use('/admin', (_req: Request, res: Response) => {
  res.sendFile(path.join(adminDist, 'index.html'));
});

// ─── Security middleware ─────────────────────────────────────────────────────

app.use(helmet({ contentSecurityPolicy: false }));

// CORS origins — fully config-driven, zero hardcoded values
// Always include the server's own origin (admin panel makes same-origin fetch requests
// that browsers tag with Origin when custom headers like Authorization are present)
const effectiveTunnelHostname = config.tunnelHostname || getHostnameFromCloudflaredConfig() || '';

// When the tunnel is on a subdomain (e.g. api.pokyh.com), the frontend typically
// lives on the parent domain (pokyh.com). Auto-derive it so operators don't have
// to set CORS_ORIGIN manually in the common API-subdomain + frontend-on-root setup.
function parentDomainOrigin(hostname: string): string | null {
  const parts = hostname.split('.');
  return parts.length > 2 ? `https://${parts.slice(1).join('.')}` : null;
}

const parsedCorsOrigins = config.corsOrigin.split(',').map((o) => o.trim()).filter(Boolean);
// A malformed CORS_ORIGIN (e.g. only commas/whitespace) silently degrades to
// zero origins from this source. That alone won't break CORS entirely — the
// other sources below still apply — but a real misconfigured production
// origin would then be rejected with nothing in the logs to explain why.
if (parsedCorsOrigins.length === 0 && config.corsOrigin.trim() !== '') {
  logger.warn(`CORS_ORIGIN is set but contains no usable origin after parsing: "${config.corsOrigin}"`);
}

const allowedOrigins = new Set([
  ...parsedCorsOrigins,
  ...config.learnAllowedOrigins,
  ...(effectiveTunnelHostname ? [`https://${effectiveTunnelHostname}`] : []),
  // Also allow the parent domain of the tunnel (e.g. pokyh.com when tunnel is api.pokyh.com)
  ...(effectiveTunnelHostname ? [parentDomainOrigin(effectiveTunnelHostname)].filter(Boolean) as string[] : []),
  ...(config.isDev ? ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:3005', 'http://localhost:5173'] : []),
  `http://localhost:${config.port}`,
  `https://localhost:${config.port}`,
]);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.has(origin)) return callback(null, true);
      callback(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Server-Key', 'Idempotency-Key'],
  })
);

// ─── Body parsing ────────────────────────────────────────────────────────────

// Larger body limit for image upload routes; biggest for full-DB JSON import
app.use('/api/admin/import', express.json({ limit: config.bodyLimitImport }));
// Learn personal imports are separately scoped and never share the legacy
// database-import route, but they need the same configured size budget.
app.use('/learn/library/import', express.json({ limit: config.bodyLimitImport }));
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

  // Operational errors (our AppError subclasses)
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.message });
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

  // Unknown errors
  logger.error('[server] unhandled error', { message: err instanceof Error ? err.message : String(err), requestId: req.id });
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Start server ─────────────────────────────────────────────────────────────

const SESSION_CLEANUP_INTERVAL = config.sessionCleanupIntervalMs;

async function cleanupExpiredSessions() {
  const cutoff = new Date(Date.now() - 12 * 60 * 60 * 1000);
  const { count } = await prisma.refreshToken.deleteMany({
    where: {
      AND: [
        { OR: [{ revokedAt: { not: null } }, { expiresAt: { lt: new Date() } }] },
        { createdAt: { lt: cutoff } },
      ],
    },
  });
  if (count > 0) logger.info(`Session cleanup: ${count} expired tokens deleted`);
}

async function cleanupExpiredRequestLogs() {
  const cutoff = new Date(Date.now() - config.requestLogRetentionDays * 24 * 60 * 60 * 1000);
  const { count } = await prisma.requestLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
  if (count > 0) logger.info('Request log retention cleanup', {
    action: 'request_log_retention_cleanup',
    deletedCount: count,
    retentionDays: config.requestLogRetentionDays,
  });
}

async function cleanupExpiredLearnAnalytics() {
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

  // Archive expired todos/reminders (>24h) — server-only, admin-viewable.
  startArchiver();

  // Push notification poller (no-op if VAPID keys not configured)
  startPushPoller();

  // School year rollover: on August 1st, snapshot non-admin users/classes/todos/reminders
  startSchoolYearArchiver();
}

// Create the database (if missing) and apply the schema via `prisma db push`.
// Idempotent and additive — safe to run on every boot. Returns true on success.
function pushSchema(): Promise<boolean> {
  return new Promise((resolve) => {
    // No --accept-data-loss: db push then refuses any destructive change
    // (safe — only additive schema updates are applied automatically).
    const child = spawn('npx', ['prisma', 'db', 'push', '--skip-generate'], {
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
  for (;;) {
    try {
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
      databaseReady = true;
      databaseStartupComplete = true;
      logger.info('Database ready (schema applied, connected)');
      // Idempotent — safe to run every boot. Populates dish.stableKey and
      // rewrites rating/comment dishId references so bewertungen survive
      // resets and shared-name Sommer/Winter dishes share ratings.
      try { await migrateStableKeys(); } catch (err) {
        logger.warn(`stableKey migration failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
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

function start() {
  // Listen immediately — startup never waits on the database.
  // Bind to 0.0.0.0 so the server is reachable on every network interface
  // (LAN/containers), not just loopback.
  app.listen(config.port, '0.0.0.0', () => {
    logger.info(`Server running on port ${config.port} (${config.nodeEnv})`);
    logger.info(`API: http://localhost:${config.port}`);
    logger.info(`Admin: http://localhost:${config.port}/admin/`);

    if (!config.adminPasswordHash) {
      logger.info('No admin password set — open /admin/ to complete setup');
    }

    // Connect to the DB and start background jobs in the background (non-blocking).
    void connectDatabaseWithRetry();

    // Auto-start Cloudflare tunnel if configured
    if (isTunnelConfigured()) {
      startTunnel(config.tunnelName);
    } else {
      logger.info('Tunnel not configured — open /admin/ to set up Cloudflare tunnel');
    }
  });
}

start();

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down...');
  databaseReady = false;
  stopTunnel();
  await closeLearnCache();
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down...');
  databaseReady = false;
  stopTunnel();
  await prisma.$disconnect();
  process.exit(0);
});
