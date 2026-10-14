// Which settings a node installed with the one-line installer takes over from
// the node that invites it. Pure, tested on its own (tests/clusterInstall).
//
// Only settings that must be equal on every node for clients to move freely
// between them (token secrets, keys, admin login, push keys) and policy that
// should not differ by node (Learn, rate limits, school year, cluster tuning)
// are shared, as is the cluster's public address. Everything that identifies
// or protects one node — database credentials, CLUSTER_SECRET, its own
// addresses, ports, proxy trust, paths — is never shared; the installer
// generates or derives those on the new node.
// The list names what is shared, rather than what is not, so a setting added
// later stays on its node until someone decides otherwise.

const SHARED_KEYS = new Set([
  'JWT_SECRET',
  'REFRESH_TOKEN_SECRET',
  'API_KEY',
  'SERVER_KEY',
  'CORS_ORIGIN',
  // Absolute links stored in replicated data (uploaded images) are built
  // from it, so they must be the same on every node.
  'PUBLIC_BASE_URL',
  'ADMIN_USERNAME',
  'ADMIN_USERNAMES',
  'ADMIN_PASSWORD_HASH',
  'JWT_EXPIRES_IN',
  'ADMIN_JWT_EXPIRES_IN',
  'REFRESH_TOKEN_EXPIRES_HOURS',
  'BCRYPT_ROUNDS',
  'DEBUG',
  'BODY_LIMIT',
  'BODY_LIMIT_UPLOAD',
  'BODY_LIMIT_IMPORT',
  'PUSH_POLL_INTERVAL_MS',
  'PUSH_DUE_CHECK_INTERVAL_MS',
  'SESSION_CLEANUP_INTERVAL_MS',
  'REQUEST_LOG_RETENTION_DAYS',
  'REQUEST_LOG_CLEANUP_INTERVAL_MS',
  'LOG_FILE_RETENTION_DAYS',
  'ARCHIVE_AFTER_HOURS',
  'ARCHIVE_CHECK_INTERVAL_MS',
  'CACHE_TTL_MS',
  'SSE_HEARTBEAT_MS',
  'MENSA_IMPORT_URL',
  'OLLAMA_KEEP_ALIVE',
  'OLLAMA_NUM_PARALLEL',
  'OLLAMA_MAX_LOADED_MODELS',
  // Cluster behaviour that every node should apply alike.
  'CLUSTER_AUTO_MESH',
  'CLUSTER_HEARTBEAT_INTERVAL_MS',
  'CLUSTER_REQUEST_TIMEOUT_MS',
  'CLUSTER_SUSPECT_AFTER_FAILURES',
  'CLUSTER_OFFLINE_AFTER_FAILURES',
  'CLUSTER_SYNC_INTERVAL_MS',
  'CLUSTER_SYNC_TIMEOUT_MS',
  'CLUSTER_BATCH_IDLE_MS',
  'CLUSTER_BATCH_MAX_DELAY_MS',
  'CLUSTER_BATCH_SIZE',
  'CLUSTER_MAX_MESSAGE_BYTES',
  'CLUSTER_COMMIT_HORIZON_MS',
  'CLUSTER_VERIFY_INTERVAL_MINUTES',
  'CLUSTER_PAIRING_TTL_MINUTES',
  'CLUSTER_PAIRING_MAX_FAILURES',
  'CLUSTER_MAX_CLOCK_SKEW_MS',
  'CLUSTER_TOMBSTONE_RETENTION_DAYS',
  'CLUSTER_DEFERRED_MAX_AGE_HOURS',
  'CLUSTER_EXCLUDE_TABLES',
  'CLUSTER_INSTALL_TTL_MINUTES',
  'CLUSTER_REPLICATE_LEARN',
  'CLUSTER_CHANNEL_RETRY_SECONDS',
  'CLUSTER_UPDATE_REPO',
  'CLUSTER_UPDATE_BRANCH',
  'CLUSTER_UPDATE_AUTO',
  'CLUSTER_UPDATE_REQUIRE_CI',
  'CLUSTER_UPDATE_POLL_MINUTES',
  'CLUSTER_UPDATE_SKIP_OFFLINE_MINUTES',
  'CLUSTER_UPDATE_HEALTH_TIMEOUT_SECONDS',
]);

const SHARED_PREFIXES = ['LEARN_', 'RATE_LIMIT_', 'VAPID_', 'WEBUNTIS_', 'SCHOOL_YEAR_ROLLOVER_', 'BACKUP_'];

// Inside a shared prefix, but tied to the node's own containers or disk.
const NODE_LOCAL_KEYS = new Set([
  'LEARN_REDIS_URL',
  'LEARN_AI_OLLAMA_BASE_URL',
  'BACKUP_DIR',
]);

export const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_VALUE_LENGTH = 8192;

export function isSharedKey(key: string): boolean {
  if (!ENV_KEY_PATTERN.test(key) || NODE_LOCAL_KEYS.has(key)) return false;
  return SHARED_KEYS.has(key) || SHARED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

// A value that can be written as one line of an env file without changing
// its meaning or smuggling in another setting.
export function isSafeEnvValue(value: string): boolean {
  return value.length <= MAX_VALUE_LENGTH && !/[\r\n\0]/.test(value);
}

export interface SharedEnvironment {
  values: Record<string, string>;
  // Shared settings left out because their value cannot be written safely.
  skipped: string[];
}

export function sharedEnvironment(env: Record<string, string | undefined>): SharedEnvironment {
  const values: Record<string, string> = {};
  const skipped: string[] = [];
  for (const key of Object.keys(env).sort()) {
    const value = env[key];
    if (value === undefined || value === '' || !isSharedKey(key)) continue;
    if (!isSafeEnvValue(value)) { skipped.push(key); continue; }
    values[key] = value;
  }
  return { values, skipped };
}
