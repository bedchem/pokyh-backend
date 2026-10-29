import 'dotenv/config';
import os from 'os';
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

function strEnv(key: string, fallback: string): string {
  const raw = process.env[key];
  return raw === undefined || raw.trim() === '' ? fallback : unwrapEnvironmentValue(raw);
}

function boolEnv(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  return unwrapEnvironmentValue(raw).toLocaleLowerCase('en-US') === 'true';
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
  // Optional: the only admin panel origins passkeys may be made and used
  // under (e.g. "https://api.pokyh.com"). Empty = the panel's own https origin.
  adminPasskeyOrigins: (process.env.ADMIN_PASSKEY_ORIGINS ?? '')
    .split(',').map((origin) => origin.trim().replace(/\/+$/, '')).filter(Boolean),
  // The shared read cache (services/cache.ts): answers that are read often
  // and change rarely. Redis is a copy only; MySQL stays authoritative and
  // the API works the same without it (entries then live in process memory).
  cache: {
    enabled: boolEnv('CACHE_ENABLED', true),
    redisUrl: strEnv('REDIS_URL', ''),
    keyPrefix: strEnv('REDIS_KEY_PREFIX', 'pokyh:cache'),
    // Entries kept in process memory while Redis is unavailable (0 = none).
    memoryEntries: boundedIntEnv('CACHE_MEMORY_ENTRIES', 2_000, 0, 100_000),
  },
  // WebUntis for the website (routes/webuntis.ts): the website is a static
  // page and signs in here; the WebUntis session lives sealed in httpOnly
  // cookies on the API's own address, never on the server.
  webuntis: {
    // Seals the session and renewal cookies (AES-256-GCM). Empty: derived
    // from JWT_SECRET, which every node of a cluster shares anyway.
    sessionSecret: strEnv('WEBUNTIS_SESSION_SECRET', ''),
    // Secure cookies (HTTPS only). Off only for a plain-http development setup.
    cookieSecure: boolEnv('WEBUNTIS_COOKIE_SECURE', isProd),
    // How long a WebUntis sign-in lasts on the website (cookies and session).
    sessionMaxAgeMs: 4 * 60 * 60 * 1000,
    // The public WebUntis school search behind the sign-in page.
    schoolSearchUrl: strEnv('WEBUNTIS_SCHOOL_SEARCH_URL', 'https://mobile.webuntis.com/ms/schoolquery2'),
    // The website's sign-in QR code as a link (e.g. https://api.pokyh.com/l/): a phone's own
    // camera then opens the POKYH app with it (services/qrLogin.ts). Empty: the plain text the
    // apps' scanners read ("POKYH-LOGIN:…") — keep it empty until every app in use reads links
    // (Android from 2.1.0; the iOS app needs the same change first).
    qrLinkBase: strEnv('QR_LINK_BASE', ''),
    // The Android apps that may open those links (/.well-known/assetlinks.json) and the SHA-256
    // of the key they are signed with.
    androidApps: ['dev.plattnericus.project', 'dev.plattnericus.project.debug'],
    androidCertSha256: strEnv(
      'ANDROID_CERT_SHA256',
      '53:3D:92:58:41:E7:AF:90:61:F8:73:4B:3F:C8:43:59:88:E7:D5:54:A7:45:F1:44:03:AB:99:10:92:DA:2B:13',
    ),
    // Optional: only these schools (WebUntis login names) may sign in.
    schoolAllowlist: strEnv('WEBUNTIS_SCHOOL_ALLOWLIST', '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
    // Internal WebUntis paths differ between instances; each can be overridden.
    paths: {
      absences: strEnv('WEBUNTIS_API_PATH_ABSENCES', '/api/classreg/absences/students'),
      absenceReasons: strEnv('WEBUNTIS_API_PATH_ABSENCE_REASONS', ''),
      appData: strEnv('WEBUNTIS_API_PATH_APPDATA', ''),
      messageList: strEnv('WEBUNTIS_API_PATH_MSG_LIST', '/api/rest/view/v1/messages'),
      messageSent: strEnv('WEBUNTIS_API_PATH_MSG_SENT', '/api/rest/view/v1/messages/sent'),
      messageDrafts: strEnv('WEBUNTIS_API_PATH_MSG_DRAFTS', '/api/rest/view/v1/messages/drafts'),
      messageRecipients: strEnv('WEBUNTIS_API_PATH_MSG_RECIPIENTS', '/api/rest/view/v1/messages/recipients/static/persons'),
    },
    // Instance-specific guardian markers, in addition to the built-in ones.
    parentRoles: strEnv('WEBUNTIS_PARENT_ROLE', '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    // Development only: offer absence reporting regardless of WebUntis' flag.
    forceAbsenceReport: boolEnv('WEBUNTIS_FORCE_ABSENCE_REPORT', false),
  },
  webuntisSchool: process.env.WEBUNTIS_SCHOOL ?? '',
  // ── Schools ────────────────────────────────────────────────────────────────
  // The school created for WEBUNTIS_SCHOOL on first start (every account and
  // menu that existed before schools were introduced belongs to it). Only the
  // initial display name — WEBUNTIS_SCHOOL when unset — edited in the panel
  // afterwards.
  defaultSchoolName: strEnv('DEFAULT_SCHOOL_NAME', ''),
  // Any school on WebUntis can use Pokyh: it is added the first time one of
  // its accounts signs in through the trusted login (X-Server-Key). Off: only
  // schools that already exist can sign in.
  schoolsAutoCreate: boolEnv('SCHOOLS_AUTO_CREATE', true),
  // A safety net on how many schools may be added that way.
  schoolsMax: boundedIntEnv('SCHOOLS_MAX', 1000, 1, 100_000),
  // The panel's search (/api/admin/search): requests per admin and minute,
  // results per kind, and per kind when only one kind is searched.
  adminSearchPerMinute: boundedIntEnv('ADMIN_SEARCH_PER_MINUTE', 120, 10, 2000),
  adminSearchLimit: boundedIntEnv('ADMIN_SEARCH_LIMIT', 6, 1, 20),
  adminSearchDetailLimit: boundedIntEnv('ADMIN_SEARCH_DETAIL_LIMIT', 30, 5, 100),
  // The WebUntis servers a school's login may name (host suffixes, comma
  // separated); any other host is not stored.
  webuntisHostSuffixes: strEnv('WEBUNTIS_HOST_SUFFIXES', 'webuntis.com')
    .split(',')
    .map((suffix) => suffix.trim().toLowerCase().replace(/^\.+/, ''))
    .filter(Boolean),
  // The admin audit trail (admin_audit_events). The Garante's measures on
  // system administrators ask for at least six months of access records.
  auditRetentionDays: boundedIntEnv('AUDIT_RETENTION_DAYS', 365, 180, 3650),
  // Error reports of the web app and the apps (POST /client-errors).
  clientErrors: {
    enabled: (process.env['CLIENT_ERRORS_ENABLED'] ?? 'true') !== 'false',
    retentionDays: boundedIntEnv('CLIENT_ERROR_RETENTION_DAYS', 30, 1, 180),
    // Per address and minute; a broken page loops, a person does not.
    perMinute: boundedIntEnv('CLIENT_ERRORS_PER_MINUTE', 20, 1, 600),
    // The same error at most this often a minute, however often it is sent.
    perErrorPerMinute: boundedIntEnv('CLIENT_ERRORS_PER_ERROR_PER_MINUTE', 20, 1, 600),
  },
  isDev: nodeEnv === 'development',
  isProd,

  // ── Auth / tokens (all env-overridable) ────────────────────────────────────
  jwtExpiresIn: strEnv('JWT_EXPIRES_IN', '1h'),
  adminJwtExpiresIn: strEnv('ADMIN_JWT_EXPIRES_IN', '7d'),
  // Every admin panel account needs the authenticator app (2FA); only the
  // server can switch that off. A passkey is optional unless required per
  // account in the panel; accounts without their own setting (and server
  // owners) follow ADMIN_REQUIRE_PASSKEY (security/adminSecondFactorPolicy.ts).
  adminRequireSecondFactor: boolEnv('ADMIN_REQUIRE_SECOND_FACTOR', true),
  adminRequirePasskey: boolEnv('ADMIN_REQUIRE_PASSKEY', false),
  refreshTokenExpiresInHours: intEnv('REFRESH_TOKEN_EXPIRES_HOURS', 1),
  // Device sessions (services/sessions.ts): an account's device stays in its
  // device list until it signs out, is signed out, or goes unused this long;
  // a device signed out from elsewhere stays known as such for the same time,
  // so its automatic sign-in is refused. At most this many devices per account.
  sessionIdleDays: boundedIntEnv('SESSION_IDLE_DAYS', 60, 1, 400),
  sessionsPerAccountMax: boundedIntEnv('SESSIONS_PER_ACCOUNT_MAX', 20, 1, 200),
  // The account's own login history (login_events).
  loginHistoryDays: boundedIntEnv('LOGIN_HISTORY_DAYS', 90, 7, 730),
  bcryptRounds: intEnv('BCRYPT_ROUNDS', 12),

  adminUsername: process.env.ADMIN_USERNAME ?? '',
  adminUsernames: (process.env.ADMIN_USERNAMES ?? process.env.ADMIN_USERNAME ?? '')
    .split(',').map((u) => u.trim()).filter(Boolean),
  adminPasswordHash: process.env.ADMIN_PASSWORD_HASH ?? '',
  debug: process.env.DEBUG === 'true',
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? '',
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY ?? '',
  vapidEmail: process.env.VAPID_EMAIL ?? 'contact@pokyh.com',
  // APNs token auth (iOS app). Off unless key id, team id, key and topic are all set.
  // APNS_KEY is the .p8 text (literal \n allowed), or APNS_KEY_PATH points at the file.
  apnsKeyId: process.env.APNS_KEY_ID ?? '',
  apnsTeamId: process.env.APNS_TEAM_ID ?? '',
  apnsKey: (process.env.APNS_KEY ?? '').replace(/\\n/g, '\n'),
  apnsKeyPath: process.env.APNS_KEY_PATH ?? '',
  // The iOS app's bundle id.
  apnsTopic: process.env.APNS_TOPIC ?? '',
  // Apple's gateways; overridable for tests or a proxy.
  apnsHostSandbox: strEnv('APNS_HOST_SANDBOX', 'https://api.sandbox.push.apple.com'),
  apnsHostProduction: strEnv('APNS_HOST_PRODUCTION', 'https://api.push.apple.com'),
  apnsTimeoutMs: boundedIntEnv('APNS_TIMEOUT_MS', 10 * 1000, 1000, 60 * 1000),
  // Apple refuses provider tokens older than an hour and throttles renewals
  // more often than every 20 minutes, hence the bounds.
  apnsTokenTtlMs: boundedIntEnv('APNS_TOKEN_TTL_MS', 50 * 60 * 1000, 20 * 60 * 1000, 59 * 60 * 1000),
  webuntisBase: process.env.WEBUNTIS_BASE ?? 'https://lbs-brixen.webuntis.com/WebUntis',

  // ── Rate limiting (per-limiter, env-overridable) ───────────────────────────
  rateLimit: {
    globalMax: intEnv('RATE_LIMIT_GLOBAL_MAX', 500),
    globalWindowMs: intEnv('RATE_LIMIT_GLOBAL_WINDOW_MS', 60 * 1000),
    authMax: intEnv('RATE_LIMIT_AUTH_MAX', 10),
    authWindowMs: intEnv('RATE_LIMIT_AUTH_WINDOW_MS', 15 * 60 * 1000),
    // Website WebUntis sign-ins (POST /webuntis/login): per address and five
    // minutes (a school signs in through one address), and per account and
    // fifteen minutes (what stops guessing a password).
    webLoginMax: intEnv('RATE_LIMIT_WEB_LOGIN_MAX', 60),
    webLoginPerAccountMax: intEnv('RATE_LIMIT_WEB_LOGIN_PER_ACCOUNT_MAX', 10),
    // Messages one website account may send to teachers (new, replies, excuses) per window.
    webMessageMax: intEnv('RATE_LIMIT_WEB_MESSAGE_MAX', 30),
    webMessageWindowMs: intEnv('RATE_LIMIT_WEB_MESSAGE_WINDOW_MS', 15 * 60 * 1000),
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
    // New live streams per account (website tabs and the app together).
    sseMax: intEnv('RATE_LIMIT_SSE_MAX', 30),
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

  // ── Usage analytics (admin Analytics page) ────────────────────────────────
  // Visits (device kind, foreground time, screen count — no IP or user agent)
  // are pseudonymous, so their retention is finite as well.
  usageAnalytics: {
    // Visits are counted per calendar day and hour in this IANA timezone.
    timezone: strEnv('ANALYTICS_TIMEZONE', 'Europe/Rome'),
    // How long a visit stays linked to its (consenting) account; afterwards it
    // is anonymous and only feeds the aggregate figures.
    retentionDays: boundedIntEnv('USAGE_ANALYTICS_RETENTION_DAYS', 90, 30, 365),
  },

  // ── An account's own activity (its profile, GET /users/me/activity) ───────
  // With this on (the default), an account's active days, device kinds and
  // sign-ins per day (request_account_days: no address, no path) and — only
  // with its consent — the link of its visits to it (usage_sessions) are kept
  // for the running school year instead of the request logs' 30 days and
  // USAGE_ANALYTICS_RETENTION_DAYS. At the rollover (1 August) the year is
  // archived per account (archived_activity) and the rows go. Off: the
  // previous periods apply.
  accountActivitySchoolYear: (process.env['ACCOUNT_ACTIVITY_SCHOOL_YEAR'] ?? 'true') !== 'false',

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
  // Hours between two backups: 24 (default) is one a day at BACKUP_SCHEDULE_HOUR,
  // fewer hours back up more often (e.g. 1 = every hour, at most an hour of
  // changes can be lost when only the backups are left).
  backupIntervalHours: boundedIntEnv('BACKUP_INTERVAL_HOURS', 24, 1, 24 * 7),
  // What the server does when it starts with an empty database although this
  // node has backups (or knew data before): the database volume was lost.
  //   local    restore the newest local backup (default)
  //   offsite  as local; a server with neither local backups nor any trace of
  //            earlier data also restores the newest off-site copy (a server
  //            rebuilt after losing its disk)
  //   off      never restore by itself
  dbAutoRestore: ((): 'off' | 'local' | 'offsite' => {
    const mode = strEnv('DB_AUTO_RESTORE', 'local').toLowerCase();
    return mode === 'off' || mode === 'offsite' ? mode : 'local';
  })(),
  // Encrypted copies of every backup in an S3-compatible bucket
  // (services/offsite.ts). Off until bucket, credentials and key are set.
  offsite: {
    endpoint: strEnv('BACKUP_S3_ENDPOINT', ''),
    region: strEnv('BACKUP_S3_REGION', 'us-east-1'),
    bucket: strEnv('BACKUP_S3_BUCKET', ''),
    accessKeyId: strEnv('BACKUP_S3_ACCESS_KEY_ID', ''),
    secretAccessKey: strEnv('BACKUP_S3_SECRET_ACCESS_KEY', ''),
    // Path-style addresses (endpoint/bucket/key) work with every provider;
    // false: virtual-host style (bucket.endpoint/key).
    forcePathStyle: boolEnv('BACKUP_S3_FORCE_PATH_STYLE', true),
    prefix: strEnv('BACKUP_S3_PREFIX', 'pokyh'),
    // Encrypts every copy before it leaves the server. Keep it somewhere else
    // as well: without it no copy can be restored.
    encryptionKey: strEnv('BACKUP_ENCRYPTION_KEY', ''),
    retentionDays: boundedIntEnv('BACKUP_OFFSITE_RETENTION_DAYS', 30, 1, 3650),
    syncIntervalMinutes: boundedIntEnv('BACKUP_OFFSITE_SYNC_MINUTES', 10, 1, 24 * 60),
    maxFileBytes: boundedIntEnv('BACKUP_OFFSITE_MAX_FILE_MB', 2048, 1, 16_384) * 1024 * 1024,
  },

  // ── School year rollover ──────────────────────────────────────────────────
  // On Aug 1 the live non-admin users/classes/todos/reminders are archived into
  // the school_years snapshot tables and the live tables are reset for the new year.
  schoolYearRolloverAuto: (process.env['SCHOOL_YEAR_ROLLOVER_AUTO'] ?? 'true') !== 'false',
  schoolYearRolloverCheckIntervalMs: intEnv('SCHOOL_YEAR_ROLLOVER_CHECK_INTERVAL_MS', 60 * 60 * 1000),
  // Month (1-12) and day on which the rollover fires. Defaults to August 1st.
  schoolYearRolloverMonth: intEnv('SCHOOL_YEAR_ROLLOVER_MONTH', 8),
  schoolYearRolloverDay:   intEnv('SCHOOL_YEAR_ROLLOVER_DAY',   1),

  // ── Cluster (multi-node replication) ───────────────────────────────────────
  // Dormant until an administrator pairs the first peer: no triggers, no
  // background traffic and no extra writes on a standalone node. Every value
  // here is optional. See README.md → "Cluster".
  cluster: {
    enabled: boolEnv('CLUSTER_ENABLED', true),
    nodeName: strEnv('CLUSTER_NODE_NAME', os.hostname()).slice(0, 120),
    // Source of the key that wraps stored link keys. When unset it is derived
    // from JWT_SECRET, so nothing new has to be provisioned for a first setup.
    secret: strEnv('CLUSTER_SECRET', ''),
    // The address other nodes reach this one at (https://node1.example.org,
    // http://10.0.0.5:4100). Prefills the invite and join forms; optional.
    advertiseUrl: strEnv('CLUSTER_ADVERTISE_URL', ''),

    // Where the node-to-node channel is served. Both can be on at once:
    //   CLUSTER_PUBLIC_PATH  /cluster/v1 on the ordinary API port, for nodes
    //                        that reach each other through a reverse proxy;
    //   CLUSTER_PORT         a separate listener that serves nothing but the
    //                        channel (0 = off), bound to CLUSTER_BIND_ADDRESS.
    // CLUSTER_ALLOWLIST (IPs and CIDR ranges, comma separated) restricts both
    // to the listed addresses; behind a proxy the address is the one
    // TRUST_PROXY lets through. Every frame is end-to-end encrypted either way.
    publicPath: boolEnv('CLUSTER_PUBLIC_PATH', true),
    port: boundedIntEnv('CLUSTER_PORT', 0, 0, 65_535),
    bindAddress: strEnv('CLUSTER_BIND_ADDRESS', '0.0.0.0'),
    allowlist: (process.env['CLUSTER_ALLOWLIST'] ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
    // A node joining through one member is introduced to all the others, so
    // every node ends up linked directly with every other.
    autoMesh: boolEnv('CLUSTER_AUTO_MESH', true),

    // The mutually authenticated channel (mtls.ts): a TLS 1.3 listener of its
    // own (0 = off) where every node proves itself with its own certificate
    // and peers accept only the certificates they pinned. Required for the
    // one-line node installer. CLUSTER_MTLS_URL is how the other nodes reach
    // it (https://node1.example.org:4100); when empty it is derived from the
    // host of CLUSTER_ADVERTISE_URL (or PUBLIC_BASE_URL) and the port.
    mtlsPort: boundedIntEnv('CLUSTER_MTLS_PORT', 0, 0, 65_535),
    mtlsBindAddress: strEnv('CLUSTER_MTLS_BIND_ADDRESS', '0.0.0.0'),
    mtlsUrl: strEnv('CLUSTER_MTLS_URL', '').replace(/\/$/, ''),
    // Further ways to reach the channel, in order of preference, comma
    // separated: https://host:port, optionally ?sni=name (a VPN address, a
    // proxy port, a proxy on 443 routing by name). More can be added in the
    // admin panel; see src/cluster/endpoints.ts.
    mtlsEndpoints: strEnv('CLUSTER_MTLS_ENDPOINTS', ''),
    // Pokyh relays this node registers at (keys from the relay's setup, comma
    // separated). Relays added in the admin panel apply to every node.
    relayKeys: (process.env['CLUSTER_RELAY_KEYS'] ?? '').split(',').map((key) => key.trim()).filter(Boolean),
    // The name this node is registered under at relays (default: from its name).
    relayLabel: strEnv('CLUSTER_RELAY_LABEL', '').toLowerCase(),
    // Connections kept parked at each relay, ready for incoming connections.
    relayPoolSize: boundedIntEnv('CLUSTER_RELAY_POOL_SIZE', 4, 1, 32),
    // A forwarder in front of the channel (the installer's stack:
    // deploy/node/edge.mjs) names the original client in a PROXY protocol
    // line; it is believed only from these addresses (IPs or CIDR ranges).
    mtlsProxyProtocol: boolEnv('CLUSTER_MTLS_PROXY_PROTOCOL', false),
    mtlsProxyFrom: strEnv('CLUSTER_MTLS_PROXY_FROM', '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.0/8,::1/128,fc00::/7')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),

    // Updates without downtime (updates.ts). The newest commit of BRANCH in
    // REPO (a git repository reachable over https) is rolled out node by
    // node; empty REPO: versions only travel between nodes. Every value can
    // also be changed in the admin panel for the whole cluster.
    update: {
      repo: strEnv('CLUSTER_UPDATE_REPO', ''),
      branch: strEnv('CLUSTER_UPDATE_BRANCH', 'main'),
      auto: boolEnv('CLUSTER_UPDATE_AUTO', true),
      // Only commits whose checks on GitHub passed are rolled out. Off by
      // default: the repository runs no checks of its own; turn it on where
      // the update branch has some.
      requireCi: boolEnv('CLUSTER_UPDATE_REQUIRE_CI', false),
      pollMinutes: boundedIntEnv('CLUSTER_UPDATE_POLL_MINUTES', 2, 1, 24 * 60),
      // A node that stays unreachable this long is passed over in a rollout.
      skipOfflineMinutes: boundedIntEnv('CLUSTER_UPDATE_SKIP_OFFLINE_MINUTES', 10, 1, 24 * 60),
      // How long a new version may take to become healthy before the node
      // stays on the previous one.
      healthTimeoutSeconds: boundedIntEnv('CLUSTER_UPDATE_HEALTH_TIMEOUT_SECONDS', 300, 30, 3600),
      // Optional, this node only: a GitHub token (read-only) for more API
      // requests when checking CI; public repositories work without one.
      githubToken: strEnv('CLUSTER_UPDATE_GITHUB_TOKEN', ''),
    },
    // Ways through this node's own web proxy on the API's address, comma
    // separated (https://api.example.org/cluster-node/a): no certificate
    // pinning there, so used by the others only when every pinned way fails.
    pathEndpoints: strEnv('CLUSTER_PATH_ENDPOINTS', ''),
    // After the channel to a peer failed, how long calls take another way
    // before the channel is tried again.
    channelRetrySeconds: boundedIntEnv('CLUSTER_CHANNEL_RETRY_SECONDS', 60, 5, 3600),
    // The port a relay listens on locally when nothing else says so (the
    // relay installer's --port default), for the proxy configuration shown.
    relayDefaultPort: boundedIntEnv('CLUSTER_RELAY_DEFAULT_PORT', 4100, 1, 65_535),
    // How long a one-line install command can be started after it was made.
    installTtlMinutes: boundedIntEnv('CLUSTER_INSTALL_TTL_MINUTES', 30, 5, 24 * 60),
    // Set by the installer on the node it sets up: where that node finds its
    // one-time join instructions and reports its progress back.
    bootstrapDir: strEnv('CLUSTER_BOOTSTRAP_DIR', ''),

    heartbeatIntervalMs: boundedIntEnv('CLUSTER_HEARTBEAT_INTERVAL_MS', 5_000, 500, 60_000),
    requestTimeoutMs: boundedIntEnv('CLUSTER_REQUEST_TIMEOUT_MS', 4_000, 500, 60_000),
    syncTimeoutMs: boundedIntEnv('CLUSTER_SYNC_TIMEOUT_MS', 60_000, 5_000, 600_000),
    suspectAfterFailures: boundedIntEnv('CLUSTER_SUSPECT_AFTER_FAILURES', 2, 1, 20),
    offlineAfterFailures: boundedIntEnv('CLUSTER_OFFLINE_AFTER_FAILURES', 4, 2, 100),
    // How often the change feed is looked at. Only reads, on an index.
    syncIntervalMs: boundedIntEnv('CLUSTER_SYNC_INTERVAL_MS', 250, 100, 60_000),
    // Adaptive batching: a change goes out once nothing new arrived for
    // BATCH_IDLE_MS; under steady load changes are collected for at most
    // BATCH_MAX_DELAY_MS (or until a batch is full) and sent as one
    // compressed package.
    batchIdleMs: boundedIntEnv('CLUSTER_BATCH_IDLE_MS', 500, 0, 10_000),
    batchMaxDelayMs: boundedIntEnv('CLUSTER_BATCH_MAX_DELAY_MS', 2_000, 0, 60_000),
    batchSize: boundedIntEnv('CLUSTER_BATCH_SIZE', 500, 10, 2_000),
    maxMessageBytes: boundedIntEnv('CLUSTER_MAX_MESSAGE_BYTES', 16 * 1024 * 1024, 1024 * 1024, 64 * 1024 * 1024),
    // Longest a writing transaction may stay open between recording a change
    // and committing it (the longest in this code base, the school-year
    // rollover, may take 180 s). The change feed re-reads this span, so a late
    // commit is never skipped; the data check covers anything beyond it.
    commitHorizonMs: boundedIntEnv('CLUSTER_COMMIT_HORIZON_MS', 300_000, 5_000, 3_600_000),
    // The nodes compare checksums of their complete data this often and
    // repair whatever differs.
    verifyIntervalMinutes: boundedIntEnv('CLUSTER_VERIFY_INTERVAL_MINUTES', 15, 1, 24 * 60),
    // An invite code is valid this long, once.
    pairingTtlMinutes: boundedIntEnv('CLUSTER_PAIRING_TTL_MINUTES', 15, 1, 24 * 60),
    pairingMaxFailures: boundedIntEnv('CLUSTER_PAIRING_MAX_FAILURES', 5, 1, 100),
    // LWW conflict resolution compares clocks; a larger measured difference is
    // reported as a warning in the cluster status.
    maxClockSkewMs: boundedIntEnv('CLUSTER_MAX_CLOCK_SKEW_MS', 10_000, 100, 3_600_000),
    tombstoneRetentionDays: boundedIntEnv('CLUSTER_TOMBSTONE_RETENTION_DAYS', 30, 1, 3_650),
    deferredMaxAgeHours: boundedIntEnv('CLUSTER_DEFERRED_MAX_AGE_HOURS', 72, 1, 24 * 90),
    // Additional tables kept node-local, on top of the built-in exclusions.
    excludeTables: (process.env['CLUSTER_EXCLUDE_TABLES'] ?? '')
      .split(',')
      .map((table) => table.trim().toLocaleLowerCase('en-US'))
      .filter((table) => /^[a-z0-9_]+$/.test(table)),
  },

  // ── Blue/green on servers set up by the installer (deploy/node) ───────────
  // This container's colour, the file the updater writes the active colour
  // into, and the directory it shares with the updater. Empty elsewhere.
  deploy: {
    color: strEnv('POKYH_COLOR', ''),
    activationFile: strEnv('POKYH_ACTIVATION_FILE', ''),
    updateDir: strEnv('POKYH_UPDATE_DIR', ''),
  },

  // ── Misc tunables (no hardcoded values) ────────────────────────────────────
  sseHeartbeatMs: intEnv('SSE_HEARTBEAT_MS', 30 * 1000),
  // The menu source (a mensa.json) for the dish import; no built-in default.
  mensaImportUrl: strEnv('MENSA_IMPORT_URL', ''),
  // Absolute base for self-hosted asset URLs (e.g. uploaded dish images). When
  // empty, a relative path is stored instead. No hardcoded domain.
  publicBaseUrl: (process.env['PUBLIC_BASE_URL'] ?? '').replace(/\/$/, ''),
};
