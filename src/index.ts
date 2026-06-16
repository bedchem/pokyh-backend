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
import { prisma } from './db';
import { startTunnel, stopTunnel, isTunnelConfigured, getHostnameFromCloudflaredConfig } from './tunnel';
import { startPushPoller } from './services/pushPoller';
import { startArchiver } from './services/archiver';
import { logger } from './utils/logger';

const app = express();

// ─── Debug logging ───────────────────────────────────────────────────────────

if (config.debug) {
  app.use(morgan('dev'));
  app.use((req, _res, next) => {
    console.log(`[req] ${req.method} ${req.url} body=${JSON.stringify(req.body)}`);
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
const allowedOrigins = new Set([
  ...config.corsOrigin.split(',').map((o) => o.trim()).filter(Boolean),
  ...(effectiveTunnelHostname ? [`https://${effectiveTunnelHostname}`] : []),
  ...(config.isDev ? ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:5173'] : []),
  `http://localhost:${config.port}`,
  `https://localhost:${config.port}`,
]);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.has(origin)) return callback(null, true);
      // Allow any origin on our own port — covers LAN IPs, hostnames, etc.
      // The admin panel JS is served by us, so same-host:port requests are always ours.
      try {
        const u = new URL(origin);
        if (u.port === String(config.port)) return callback(null, true);
      } catch {}
      callback(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Server-Key'],
  })
);

// ─── Body parsing ────────────────────────────────────────────────────────────

// Larger body limit for image upload routes; biggest for full-DB JSON import
app.use('/api/admin/import', express.json({ limit: config.bodyLimitImport }));
app.use('/subject-images', express.json({ limit: config.bodyLimitUpload }));
app.use('/api/admin', express.json({ limit: config.bodyLimitUpload }));
app.use(express.json({ limit: config.bodyLimit }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// ─── Rate limiting ───────────────────────────────────────────────────────────

app.use(globalLimiter);

// ─── Request logger (after body parse, before routes) ────────────────────────

app.use(requestLogger);

// ─── Health check ────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (config.debug && err instanceof Error) {
    console.error('[error]', err.stack);
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
    console.error('[prisma] known error:', err.code, err.message);
    res.status(400).json({ error: 'Database error' });
    return;
  }

  // CORS errors
  if (err instanceof Error && err.message.startsWith('CORS:')) {
    res.status(403).json({ error: err.message });
    return;
  }

  // Unknown errors
  console.error('[server] unhandled error:', err);
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

let backgroundJobsStarted = false;

// Starts the periodic background jobs exactly once, after the DB is reachable.
function startBackgroundJobs() {
  if (backgroundJobsStarted) return;
  backgroundJobsStarted = true;

  // Session cleanup: deferred first run + interval.
  setTimeout(() => void cleanupExpiredSessions().catch(() => {}), 5000);
  setInterval(() => void cleanupExpiredSessions().catch(() => {}), SESSION_CLEANUP_INTERVAL);

  // Archive expired todos/reminders (>24h) — server-only, admin-viewable.
  startArchiver();

  // Push notification poller (no-op if VAPID keys not configured)
  startPushPoller();
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
        if (!ok) throw new Error('schema push not ready');
      }
      await prisma.$connect();
      logger.info('Database ready (schema applied, connected)');
      startBackgroundJobs();
      return;
    } catch (err) {
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
  app.listen(config.port, () => {
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
  stopTunnel();
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down...');
  stopTunnel();
  await prisma.$disconnect();
  process.exit(0);
});
