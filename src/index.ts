import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import path from 'path';
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

// Larger body limit for image upload routes
app.use('/subject-images', express.json({ limit: '4mb' }));
app.use('/api/admin', express.json({ limit: '4mb' }));
app.use(express.json({ limit: '10kb' }));
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

const SESSION_CLEANUP_INTERVAL = 60 * 60 * 1000;

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

async function start() {
  try {
    await prisma.$connect();
    logger.info('Connected to MySQL');

    app.listen(config.port, () => {
      logger.info(`Server running on port ${config.port} (${config.nodeEnv})`);
      logger.info(`API: http://localhost:${config.port}`);
      logger.info(`Admin: http://localhost:${config.port}/admin/`);

      if (!config.adminPasswordHash) {
        logger.info('No admin password set — open /admin/ to complete setup');
      }

      // Session cleanup: run immediately + every hour
      void cleanupExpiredSessions();
      setInterval(() => void cleanupExpiredSessions(), SESSION_CLEANUP_INTERVAL);

      // Push notification poller (no-op if VAPID keys not configured)
      startPushPoller();

      // Auto-start Cloudflare tunnel if configured
      if (isTunnelConfigured()) {
        startTunnel(config.tunnelName);
      } else {
        logger.info('Tunnel not configured — open /admin/ to set up Cloudflare tunnel');
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('P1001') || msg.includes('ECONNREFUSED')) {
      logger.error('Cannot connect to database. Check that MySQL is running and DATABASE_URL in .env is correct.');
    } else {
      logger.error('Failed to start server', { error: err instanceof Error ? err.message : String(err) });
    }
    process.exit(1);
  }
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
