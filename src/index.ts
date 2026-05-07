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
import { startTunnel, stopTunnel, isTunnelConfigured } from './tunnel';

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
const allowedOrigins = new Set([
  ...config.corsOrigin.split(',').map((o) => o.trim()).filter(Boolean),
  ...(config.tunnelHostname ? [`https://${config.tunnelHostname}`] : []),
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

async function start() {
  try {
    await prisma.$connect();
    console.log('[db] Connected to MySQL');

    app.listen(config.port, () => {
      console.log(`[server] Running on port ${config.port} (${config.nodeEnv})`);
      console.log(`[server] API: http://localhost:${config.port}`);
      console.log(`[server] Admin: http://localhost:${config.port}/admin/`);
      console.log(`[server] CORS origins: ${[...allowedOrigins].join(', ') || '(from CORS_ORIGIN env)'} + self`);

      if (!config.adminPasswordHash) {
        console.log('[server] ⚠  No admin password set — open /admin/ to complete setup');
      }

      // Auto-start Cloudflare tunnel if configured
      if (isTunnelConfigured()) {
        startTunnel(config.tunnelName);
      } else {
        console.log('[tunnel] Not configured — open /admin/ to set up Cloudflare tunnel');
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('P1001') || msg.includes('ECONNREFUSED')) {
      console.error('[db] Cannot connect to database.');
      console.error('[db] Check that MySQL is running and DATABASE_URL in .env is correct.');
      console.error('[db] Current DATABASE_URL:', process.env['DATABASE_URL']?.replace(/:\/\/[^@]+@/, '://<credentials>@'));
    } else {
      console.error('[server] Failed to start:', err);
    }
    process.exit(1);
  }
}

start();

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[server] SIGTERM received, shutting down...');
  stopTunnel();
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[server] SIGINT received, shutting down...');
  stopTunnel();
  await prisma.$disconnect();
  process.exit(0);
});
