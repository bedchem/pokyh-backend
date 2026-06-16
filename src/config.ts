import 'dotenv/config';

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return val;
}

// Parse an integer env var with a fallback. Ignores empty/invalid values so a
// blank line in .env never silently turns into NaN.
function intEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function strEnv(key: string, fallback: string): string {
  const raw = process.env[key];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

// Resolve the express `trust proxy` value from TRUST_PROXY. Accepts a boolean
// ('true'/'false'), a numeric hop count, or a named value ('loopback', etc.).
// Defaults to 'loopback' which trusts only the in-container cloudflared proxy.
function parseTrustProxy(raw: string | undefined): boolean | number | string {
  const val = (raw ?? '').trim();
  if (val === '') return 'loopback';
  if (val.toLowerCase() === 'true') return true;
  if (val.toLowerCase() === 'false') return false;
  const n = parseInt(val, 10);
  if (String(n) === val && Number.isFinite(n)) return n;
  return val;
}

// Build a MySQL connection string from discrete DB_* env vars. Lets the database
// be configured field-by-field (host/port/user/password/name) instead of one URL.
// User & password are URL-encoded so special characters (e.g. "!") are safe.
function buildDatabaseUrl(): string | undefined {
  const host = process.env['DB_HOST'];
  const name = process.env['DB_NAME'];
  if (!host || !name) return undefined;
  const port = process.env['DB_PORT'] ?? '3306';
  const user = encodeURIComponent(process.env['DB_USER'] ?? 'root');
  const pass = process.env['DB_PASSWORD'] ?? '';
  const auth = pass ? `${user}:${encodeURIComponent(pass)}` : user;
  // Connection pool sizing for higher concurrency (built-URL path only — when a
  // full DATABASE_URL is given the operator controls its params themselves).
  const limit = process.env['DB_CONNECTION_LIMIT'];
  const query = limit && limit.trim() !== '' ? `?connection_limit=${parseInt(limit, 10) || 10}` : '';
  return `mysql://${auth}@${host}:${port}/${name}${query}`;
}

// DATABASE_URL wins if set (Prisma CLI also reads it directly); otherwise fall
// back to the discrete DB_* fields. Whichever we resolve is written back to the
// environment so the Prisma client (created later) picks it up.
const resolvedDatabaseUrl = process.env['DATABASE_URL'] || buildDatabaseUrl();
if (resolvedDatabaseUrl) process.env['DATABASE_URL'] = resolvedDatabaseUrl;

const jwtSecret = requireEnv('JWT_SECRET');
if (jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters long');
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: intEnv('PORT', 4000),
  // Express `trust proxy` setting. Behind the Cloudflare tunnel (cloudflared
  // runs in-container and proxies to localhost) the client IP arrives via the
  // X-Forwarded-For header — express-rate-limit refuses to run unless we declare
  // how many proxies to trust. Default 'loopback' trusts only the in-container
  // proxy (secure: external clients can't spoof XFF). Override with TRUST_PROXY:
  // 'true'/'false', a hop count ('1'), or any valid express trust-proxy value.
  trustProxy: parseTrustProxy(process.env['TRUST_PROXY']),
  databaseUrl: requireEnv('DATABASE_URL'),
  db: {
    host: process.env['DB_HOST'] ?? '',
    port: intEnv('DB_PORT', 3306),
    user: process.env['DB_USER'] ?? '',
    name: process.env['DB_NAME'] ?? '',
  },
  jwtSecret,
  refreshTokenSecret: requireEnv('REFRESH_TOKEN_SECRET'),
  apiKey: requireEnv('API_KEY'),
  serverKey: requireEnv('SERVER_KEY'),
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:3000',
  webuntisSchool: process.env.WEBUNTIS_SCHOOL ?? '',
  isDev: (process.env.NODE_ENV ?? 'development') === 'development',
  isProd: process.env.NODE_ENV === 'production',

  // ── Auth / tokens (all env-overridable) ────────────────────────────────────
  jwtExpiresIn: strEnv('JWT_EXPIRES_IN', '1h'),
  adminJwtExpiresIn: strEnv('ADMIN_JWT_EXPIRES_IN', '7d'),
  refreshTokenExpiresInHours: intEnv('REFRESH_TOKEN_EXPIRES_HOURS', 1),
  bcryptRounds: intEnv('BCRYPT_ROUNDS', 12),

  adminUsername: process.env.ADMIN_USERNAME ?? '',
  adminUsernames: (process.env.ADMIN_USERNAMES ?? process.env.ADMIN_USERNAME ?? '')
    .split(',').map((u) => u.trim()).filter(Boolean),
  adminPasswordHash: process.env.ADMIN_PASSWORD_HASH ?? '',
  debug: process.env.DEBUG === 'true',
  tunnelName: process.env.TUNNEL_NAME ?? '',
  tunnelHostname: process.env.TUNNEL_HOSTNAME ?? '',
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? '',
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY ?? '',
  vapidEmail: process.env.VAPID_EMAIL ?? 'contact@pokyh.com',
  webuntisBase: process.env.WEBUNTIS_BASE ?? 'https://lbs-brixen.webuntis.com/WebUntis',

  // ── Rate limiting (per-limiter, env-overridable) ───────────────────────────
  rateLimit: {
    globalMax: intEnv('RATE_LIMIT_GLOBAL_MAX', 500),
    globalWindowMs: intEnv('RATE_LIMIT_GLOBAL_WINDOW_MS', 60 * 1000),
    authMax: intEnv('RATE_LIMIT_AUTH_MAX', 10),
    authWindowMs: intEnv('RATE_LIMIT_AUTH_WINDOW_MS', 15 * 60 * 1000),
    writeMax: intEnv('RATE_LIMIT_WRITE_MAX', 60),
    writeWindowMs: intEnv('RATE_LIMIT_WRITE_WINDOW_MS', 60 * 1000),
    readMax: intEnv('RATE_LIMIT_READ_MAX', 300),
    readWindowMs: intEnv('RATE_LIMIT_READ_WINDOW_MS', 60 * 1000),
    sseMax: intEnv('RATE_LIMIT_SSE_MAX', 10),
    sseWindowMs: intEnv('RATE_LIMIT_SSE_WINDOW_MS', 60 * 1000),
    adminLoginMax: intEnv('RATE_LIMIT_ADMIN_LOGIN_MAX', 10),
    adminLoginWindowMs: intEnv('RATE_LIMIT_ADMIN_LOGIN_WINDOW_MS', 15 * 60 * 1000),
  },

  // ── Request body size limits ───────────────────────────────────────────────
  bodyLimit: strEnv('BODY_LIMIT', '10kb'),
  bodyLimitUpload: strEnv('BODY_LIMIT_UPLOAD', '4mb'),
  bodyLimitImport: strEnv('BODY_LIMIT_IMPORT', '100mb'),

  // ── Database bootstrap / connection resilience ────────────────────────────
  // On startup, create the database (if missing) and apply the schema via
  // `prisma db push` before connecting. All knobs are env-configurable.
  dbAutoPush: (process.env['DB_AUTO_PUSH'] ?? 'true') !== 'false',
  dbPushTimeoutMs: intEnv('DB_PUSH_TIMEOUT_MS', 120 * 1000),
  dbConnectBaseDelayMs: intEnv('DB_CONNECT_BASE_DELAY_MS', 2 * 1000),
  dbConnectMaxDelayMs: intEnv('DB_CONNECT_MAX_DELAY_MS', 30 * 1000),

  // ── Background job intervals ───────────────────────────────────────────────
  pushPollIntervalMs: intEnv('PUSH_POLL_INTERVAL_MS', 5 * 60 * 1000),
  pushDueCheckIntervalMs: intEnv('PUSH_DUE_CHECK_INTERVAL_MS', 60 * 1000),
  sessionCleanupIntervalMs: intEnv('SESSION_CLEANUP_INTERVAL_MS', 60 * 60 * 1000),

  // ── Archiving of expired todos/reminders ───────────────────────────────────
  archiveAfterHours: intEnv('ARCHIVE_AFTER_HOURS', 24),
  archiveCheckIntervalMs: intEnv('ARCHIVE_CHECK_INTERVAL_MS', 60 * 60 * 1000),

  // ── In-memory cache TTL (ms) ───────────────────────────────────────────────
  cacheTtlMs: intEnv('CACHE_TTL_MS', 5 * 60 * 1000),

  // ── School year rollover ──────────────────────────────────────────────────
  // On Aug 1 the live non-admin users/classes/todos/reminders are archived into
  // the school_years snapshot tables and the live tables are reset for the new year.
  schoolYearRolloverAuto: (process.env['SCHOOL_YEAR_ROLLOVER_AUTO'] ?? 'true') !== 'false',
  schoolYearRolloverCheckIntervalMs: intEnv('SCHOOL_YEAR_ROLLOVER_CHECK_INTERVAL_MS', 60 * 60 * 1000),
  // Month (1-12) and day on which the rollover fires. Defaults to August 1st.
  schoolYearRolloverMonth: intEnv('SCHOOL_YEAR_ROLLOVER_MONTH', 8),
  schoolYearRolloverDay:   intEnv('SCHOOL_YEAR_ROLLOVER_DAY',   1),

  // ── Misc tunables (no hardcoded values) ────────────────────────────────────
  sseHeartbeatMs: intEnv('SSE_HEARTBEAT_MS', 30 * 1000),
  mensaImportUrl: strEnv('MENSA_IMPORT_URL', 'https://mensa.plattnericus.dev/mensa.json'),
  // Absolute base for self-hosted asset URLs (e.g. uploaded dish images). When
  // empty, a relative path is stored instead. No hardcoded domain.
  publicBaseUrl: (process.env['PUBLIC_BASE_URL'] ?? '').replace(/\/$/, ''),
};
