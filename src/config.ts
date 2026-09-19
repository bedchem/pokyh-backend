import 'dotenv/config';
import path from 'path';

// Docker Compose environment files keep wrapping quotes as literal characters.
// Deployment UIs commonly serialise every value that way, while `.env` parsers
// remove them. Normalise one matching outer pair once, before any setting is
// read, so both delivery mechanisms behave identically. It intentionally does
// not modify unmatched quotes inside a value.
function unwrapEnvironmentValue(value: string): string {
  const trimmed = value.trim();
  const hasMatchingQuotes = trimmed.length >= 2
    && (trimmed.startsWith('"') || trimmed.startsWith("'"))
    && trimmed.at(0) === trimmed.at(-1);
  return hasMatchingQuotes ? trimmed.slice(1, -1).trim() : trimmed;
}

for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined) process.env[key] = unwrapEnvironmentValue(value);
}

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
  const n = parseInt(unwrapEnvironmentValue(raw), 10);
  return Number.isFinite(n) ? n : fallback;
}

function boundedIntEnv(key: string, fallback: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, intEnv(key, fallback)));
}

function floatEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseFloat(unwrapEnvironmentValue(raw));
  return Number.isFinite(n) ? n : fallback;
}

function boundedFloatEnv(key: string, fallback: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, floatEnv(key, fallback)));
}

function strEnv(key: string, fallback: string): string {
  const raw = process.env[key];
  return raw === undefined || raw.trim() === '' ? fallback : unwrapEnvironmentValue(raw);
}

function boolEnv(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  return unwrapEnvironmentValue(raw).toLocaleLowerCase('en-US') === 'true';
}

export function isSecurePublicUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname);
  } catch {
    return false;
  }
}

// Resolve the express `trust proxy` value from TRUST_PROXY. Some deployment
// UIs persist string values with their wrapping quotes (for example,
// `"loopback"`). Strip one matching wrapping pair before validating so that a
// value intended for Express cannot crash the API at startup. Direct
// deployments must not trust forwarded headers by default.
export function parseTrustProxy(raw: string | undefined): boolean | number | string {
  const val = unwrapEnvironmentValue(raw ?? '');
  if (val === '') return false;
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

const nodeEnv = process.env.NODE_ENV ?? 'development';
const isProd = nodeEnv === 'production';
const learnLegalGateEnabled = boolEnv('LEARN_LEGAL_GATE_ENABLED', isProd);
const learnWebUntisAuthorizationReference = strEnv('LEARN_WEBUNTIS_AUTHORIZATION_REFERENCE', '');
const learnPrivacyNoticeUrl = strEnv('LEARN_PRIVACY_NOTICE_URL', '');
const learnPrivacyNoticeVersion = strEnv('LEARN_PRIVACY_NOTICE_VERSION', '');
const learnLegalGateReady = !learnLegalGateEnabled || Boolean(
  learnWebUntisAuthorizationReference
  && learnPrivacyNoticeVersion
  && (isProd ? isSecurePublicUrl(learnPrivacyNoticeUrl) : Boolean(learnPrivacyNoticeUrl)),
);

// Review scheduling is a product policy rather than a browser implementation.
// Defaults are intentionally conservative and all values can be set from the
// deployment configuration (or narrowed in the Learn admin configuration).
const learnReviewMinimumEase = boundedFloatEnv('LEARN_REVIEW_MINIMUM_EASE', 1.3, 1, 5);
const learnReviewMaximumEase = Math.max(
  learnReviewMinimumEase,
  boundedFloatEnv('LEARN_REVIEW_MAXIMUM_EASE', 3, 1, 5),
);

export const config = {
  nodeEnv,
  port: intEnv('PORT', 4000),
  // Express `trust proxy` setting. Keep it false for a directly exposed server;
  // configure a precise trusted proxy setting only when an operator places one
  // in front of the API. This keeps client-supplied X-Forwarded-For untrusted.
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
  // Browser-origin access to the Learn route is deliberately narrower than
  // the general API CORS policy. Server-to-server BFF calls carry no Origin
  // header and remain authenticated by the API key plus user bearer token.
  learnAllowedOrigins: (process.env.LEARN_ALLOWED_ORIGINS ?? '')
    .split(',').map((origin) => origin.trim()).filter(Boolean),
  // Optional editorial lookup only. The provider never grades a quiz or writes
  // an answer by itself; it offers a server-side suggestion for an editor to
  // review. Keeping it disabled by default prevents unannounced content export.
  learnDictionary: {
    enabled: (process.env['LEARN_DICTIONARY_ENABLED'] ?? 'false') === 'true',
    provider: strEnv('LEARN_DICTIONARY_PROVIDER', 'mymemory').toLocaleLowerCase('en-US'),
    baseUrl: strEnv('LEARN_DICTIONARY_BASE_URL', 'https://api.mymemory.translated.net').replace(/\/$/, ''),
    contactEmail: strEnv('LEARN_DICTIONARY_CONTACT_EMAIL', ''),
    allowedPairs: (process.env['LEARN_DICTIONARY_ALLOWED_PAIRS'] ?? 'it:de,en:de,de:it,de:en')
      .split(',')
      .map((pair) => pair.trim().toLocaleLowerCase('en-US'))
      .filter((pair) => /^[a-z]{2,3}:[a-z]{2,3}$/.test(pair)),
    timeoutMs: intEnv('LEARN_DICTIONARY_TIMEOUT_MS', 4_000),
    cacheTtlMs: intEnv('LEARN_DICTIONARY_CACHE_TTL_MS', 60 * 60 * 1000),
    maxCacheEntries: intEnv('LEARN_DICTIONARY_MAX_CACHE_ENTRIES', 500),
  },
  // Free Dictionary is a separate lexical-validation capability. Its public
  // documentation exposes English headwords, so it is never presented as a
  // German or Italian dictionary. A local/manual outcome keeps authoring
  // available when it is disabled or unavailable.
  learnDictionaryValidation: {
    enabled: (process.env['LEARN_DICTIONARY_VALIDATION_ENABLED'] ?? 'false') === 'true',
    provider: strEnv('LEARN_DICTIONARY_VALIDATION_PROVIDER', 'dictionaryapi').toLocaleLowerCase('en-US'),
    baseUrl: strEnv('LEARN_DICTIONARY_VALIDATION_BASE_URL', 'https://api.dictionaryapi.dev/api/v2').replace(/\/$/, ''),
    timeoutMs: intEnv('LEARN_DICTIONARY_VALIDATION_TIMEOUT_MS', 4_000),
    cacheTtlMs: intEnv('LEARN_DICTIONARY_VALIDATION_CACHE_TTL_MS', 24 * 60 * 60 * 1000),
    maxCacheEntries: intEnv('LEARN_DICTIONARY_VALIDATION_MAX_CACHE_ENTRIES', 1_000),
  },
  // This is an egress policy, not editor content. It remains environment-only
  // so an admin setting cannot turn a dictionary lookup into an arbitrary
  // internal-network request.
  learnDictionaryAllowedHosts: (process.env['LEARN_DICTIONARY_ALLOWED_HOSTS'] ?? 'api.dictionaryapi.dev,api.mymemory.translated.net')
    .split(',')
    .map((host) => host.trim().toLocaleLowerCase('en-US'))
    .filter((host) => /^[a-z0-9.-]+$/.test(host)),
  // Self-hosted, CPU-only Ollama vocabulary trainer ("Pokyh AI"). Disabled by default and
  // pilot-gated (see LearnAiAccessGrant) even when enabled — this flag is a
  // second, independent switch, not the access control itself.
  learnAi: {
    enabled: (process.env['LEARN_AI_ENABLED'] ?? 'false') === 'true',
    modelName: strEnv('LEARN_AI_MODEL', 'gemma4:e4b'),
    // Kept deliberately small: RAM for a CPU-quantized model grows sharply
    // with context length (see docs/architecture.md).
    contextTokens: boundedIntEnv('LEARN_AI_CONTEXT_TOKENS', 4_096, 512, 32_768),
    numPredictFast: boundedIntEnv('LEARN_AI_NUM_PREDICT_FAST', 512, 32, 4_096),
    rateLimitMessagesPerHour: boundedIntEnv('LEARN_AI_RATE_LIMIT_MESSAGES_PER_HOUR', 30, 1, 1_000),
    // The vocabulary trainer accepts a class-sized number of requests while
    // keeping a hard server-side cap in front of the local Ollama runtime.
    maxConcurrentTrainingGenerations: boundedIntEnv('LEARN_AI_MAX_CONCURRENT_TRAINING_GENERATIONS', 10, 1, 32),
    ollamaBaseUrl: strEnv('LEARN_AI_OLLAMA_BASE_URL', 'http://ollama:11434').replace(/\/$/, ''),
    // 60s was measured too short for a real CPU-only cold start (loading a
    // ~9.6GB model into memory before the first inference on an idle/just-
    // restarted Ollama instance measured ~150s on modest hardware) — a
    // subsequent call within OLLAMA_KEEP_ALIVE is far faster since the model
    // stays resident, but the timeout must cover the worst case.
    ollamaTimeoutMs: intEnv('LEARN_AI_OLLAMA_TIMEOUT_MS', 180_000),
  },
  // Egress policy, not editor content — stays environment-only so an admin
  // setting can never repoint the assistant at an arbitrary external host.
  // Defaults to the internal Docker service name only.
  learnAiAllowedHosts: (process.env['LEARN_AI_ALLOWED_HOSTS'] ?? 'ollama')
    .split(',')
    .map((host) => host.trim().toLocaleLowerCase('en-US'))
    .filter((host) => /^[a-z0-9.-]+$/.test(host)),
  learnImport: {
    maxCourses: intEnv('LEARN_IMPORT_MAX_COURSES', 20),
    maxSectionsPerCourse: intEnv('LEARN_IMPORT_MAX_SECTIONS_PER_COURSE', 100),
    maxVocabularyPerCourse: intEnv('LEARN_IMPORT_MAX_VOCABULARY_PER_COURSE', 1_000),
  },
  // The backend, not a device, derives every next review. A wrong answer can
  // be returned immediately (or after an operator-selected recovery delay),
  // while repeated success increases the interval within safe bounds.
  learnReview: {
    initialIntervalDays: boundedIntEnv('LEARN_REVIEW_INITIAL_INTERVAL_DAYS', 1, 1, 30),
    maxIntervalDays: boundedIntEnv('LEARN_REVIEW_MAX_INTERVAL_DAYS', 120, 1, 3_650),
    minimumEase: learnReviewMinimumEase,
    maximumEase: learnReviewMaximumEase,
    correctEaseStep: boundedFloatEnv('LEARN_REVIEW_CORRECT_EASE_STEP', 0.05, 0, 1),
    incorrectEasePenalty: boundedFloatEnv('LEARN_REVIEW_INCORRECT_EASE_PENALTY', 0.2, 0, 1),
    wrongDelayMinutes: boundedIntEnv('LEARN_REVIEW_WRONG_DELAY_MINUTES', 0, 0, 24 * 60),
    // Daily aggregates are pseudonymous learning analytics. Retention is
    // deliberately bounded and configurable instead of being indefinite.
    analyticsRetentionDays: boundedIntEnv('LEARN_ANALYTICS_RETENTION_DAYS', 365, 30, 3_650),
  },
  // Redis is an optional performance layer. MySQL remains authoritative for
  // identity, permissions, progress, answers and scheduling; a cache outage
  // must only cause a refetch, never a lost learning action.
  learnCache: {
    redisUrl: strEnv('LEARN_REDIS_URL', ''),
    keyPrefix: strEnv('LEARN_REDIS_KEY_PREFIX', 'pokyh:learn'),
    analyticsTtlSeconds: boundedIntEnv('LEARN_ANALYTICS_CACHE_TTL_SECONDS', 60, 1, 900),
  },
  // A school/controller must authorise this independent integration before a
  // production Learn login can process WebUntis credentials. This check does
  // not claim to create a legal basis; it prevents accidental activation when
  // the operator has not configured the documented approval and notice.
  learnLegal: {
    gateEnabled: learnLegalGateEnabled,
    ready: learnLegalGateReady,
    webUntisAuthorizationReference: learnWebUntisAuthorizationReference,
    privacyNoticeUrl: learnPrivacyNoticeUrl,
    privacyNoticeVersion: learnPrivacyNoticeVersion,
  },
  webuntisSchool: process.env.WEBUNTIS_SCHOOL ?? '',
  isDev: nodeEnv === 'development',
  isProd,

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
    // Token refresh is authenticated by an unguessable refresh token (not a
    // brute-forceable password), so it gets a far more generous per-IP budget.
    // Whole schools share one public IP via NAT, so a strict auth limit here
    // would 429 hundreds of legitimate users at once.
    refreshMax: intEnv('RATE_LIMIT_REFRESH_MAX', 600),
    refreshWindowMs: intEnv('RATE_LIMIT_REFRESH_WINDOW_MS', 15 * 60 * 1000),
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
  // Request logs contain technical personal data (for example IP address and
  // user agent), so retention is deliberately finite and operator-configured.
  requestLogRetentionDays: boundedIntEnv('REQUEST_LOG_RETENTION_DAYS', 30, 1, 365),
  requestLogCleanupIntervalMs: boundedIntEnv('REQUEST_LOG_CLEANUP_INTERVAL_MS', 24 * 60 * 60 * 1000, 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000),

  // ── Archiving of expired todos/reminders ───────────────────────────────────
  archiveAfterHours: intEnv('ARCHIVE_AFTER_HOURS', 24),
  archiveCheckIntervalMs: intEnv('ARCHIVE_CHECK_INTERVAL_MS', 60 * 60 * 1000),

  // ── In-memory cache TTL (ms) ───────────────────────────────────────────────
  cacheTtlMs: intEnv('CACHE_TTL_MS', 5 * 60 * 1000),

  // ── Scheduled database backups (env defaults — admin-overridable at runtime
  // via BackupConfig, see src/services/dbBackup.ts) ──────────────────────────
  backupDir: strEnv('BACKUP_DIR', path.join(process.cwd(), 'backups')),
  backupEnabled: (process.env['BACKUP_ENABLED'] ?? 'true') !== 'false',
  // UTC hour (0-23) the daily backup targets.
  backupScheduleHour: boundedIntEnv('BACKUP_SCHEDULE_HOUR', 3, 0, 23),
  backupRetentionDays: boundedIntEnv('BACKUP_RETENTION_DAYS', 7, 1, 365),
  backupCheckIntervalMs: intEnv('BACKUP_CHECK_INTERVAL_MS', 60 * 60 * 1000),

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
