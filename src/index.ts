import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { config } from './config';
import { globalLimiter } from './middleware/rateLimiter';
import { AppError } from './utils/errors';
import { appRouter } from './routes/index';
import { prisma } from './db';

const app = express();

// ─── Security middleware ─────────────────────────────────────────────────────

app.use(helmet());

const allowedOrigins = [
  config.corsOrigin,
  'https://pokyh.com',
  ...(config.isDev ? ['http://localhost:3000', 'http://localhost:3001'] : []),
];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (server-to-server, curl, etc.)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Server-Key'],
  })
);

// ─── Body parsing ────────────────────────────────────────────────────────────

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// ─── Rate limiting ───────────────────────────────────────────────────────────

app.use(globalLimiter);

// ─── Health check (before API key middleware) ────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Routes ──────────────────────────────────────────────────────────────────

app.use('/', appRouter);

// ─── 404 handler ─────────────────────────────────────────────────────────────

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Route not found' });
});

// ─── Global error handler ────────────────────────────────────────────────────

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
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
      console.log(`[server] CORS origins: ${allowedOrigins.join(', ')}`);
    });
  } catch (err) {
    console.error('[server] Failed to start:', err);
    process.exit(1);
  }
}

start();

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[server] SIGTERM received, shutting down...');
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[server] SIGINT received, shutting down...');
  await prisma.$disconnect();
  process.exit(0);
});
