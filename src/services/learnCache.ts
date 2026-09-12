import { createHash } from 'crypto';
import { createClient, type RedisClientType } from 'redis';
import { config } from '../config';
import { logger } from '../utils/logger';

// Redis is strictly an optional cache. It never stores credentials, answer
// keys, raw quiz input, permissions, or mutable source-of-truth state.
let client: RedisClientType | null = null;
let connectionAttempt: Promise<RedisClientType | null> | null = null;
let nextConnectionAttemptAt = 0;
let invalidConfigurationLogged = false;
const RETRY_AFTER_FAILURE_MS = 30_000;

function validRedisUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'redis:' || url.protocol === 'rediss:')
      && Boolean(url.hostname)
      && !url.hash;
  } catch {
    return false;
  }
}

async function getClient(): Promise<RedisClientType | null> {
  if (!config.learnCache.redisUrl || !validRedisUrl(config.learnCache.redisUrl)) {
    if (config.learnCache.redisUrl && !invalidConfigurationLogged) {
      invalidConfigurationLogged = true;
      logger.warn('Learn cache disabled because LEARN_REDIS_URL is invalid', { action: 'learn_cache_config_invalid' });
    }
    return null;
  }
  if (client?.isOpen) return client;
  if (connectionAttempt) return connectionAttempt;
  if (Date.now() < nextConnectionAttemptAt) return null;

  connectionAttempt = (async () => {
    const next = createClient({
      url: config.learnCache.redisUrl,
      socket: { connectTimeout: 1_000, reconnectStrategy: false },
    });
    next.on('error', () => {
      // Do not log the provider error text: it can include operator topology or
      // credentials. A cache fault is non-fatal and only degrades to MySQL.
      if (client === next) client = null;
      nextConnectionAttemptAt = Date.now() + RETRY_AFTER_FAILURE_MS;
      logger.warn('Learn Redis cache unavailable', { action: 'learn_cache_unavailable' });
    });
    try {
      await next.connect();
      client = next;
      nextConnectionAttemptAt = 0;
      logger.info('Learn Redis cache connected', { action: 'learn_cache_connected' });
      return client;
    } catch {
      try {
        await next.close();
      } catch {
        // No cache path must ever break an API request.
      }
      nextConnectionAttemptAt = Date.now() + RETRY_AFTER_FAILURE_MS;
      logger.warn('Learn Redis cache connection failed; using MySQL', { action: 'learn_cache_connect_failed' });
      return null;
    } finally {
      connectionAttempt = null;
    }
  })();

  return connectionAttempt;
}

function keyFor(namespace: string, parts: string[]): string {
  // Do not expose a stable user ID in Redis keyspace names, command traces or
  // monitoring output. The deterministic hash still supports exact eviction.
  const digest = createHash('sha256').update(parts.join('\u0000')).digest('hex');
  return `${config.learnCache.keyPrefix}:${namespace}:${digest}`;
}

export function analyticsCacheKey(stableUid: string, range: string, courseId?: string): string {
  return keyFor('analytics', [stableUid, range, courseId ?? 'all']);
}

export async function getCachedJson<T>(key: string): Promise<T | null> {
  try {
    const redis = await getClient();
    if (!redis) return null;
    const raw = await redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function setCachedJson(key: string, value: unknown): Promise<void> {
  try {
    const redis = await getClient();
    if (!redis) return;
    await redis.set(key, JSON.stringify(value), { EX: config.learnCache.analyticsTtlSeconds });
  } catch {
    // A cache write failure is intentionally not observable to the learner.
  }
}

export async function invalidateAnalyticsCache(stableUid: string, courseId?: string): Promise<void> {
  try {
    const redis = await getClient();
    if (!redis) return;
    const keys = ['7d', '28d', '90d'].flatMap((range) => [
      analyticsCacheKey(stableUid, range),
      ...(courseId ? [analyticsCacheKey(stableUid, range, courseId)] : []),
    ]);
    await redis.del(keys);
  } catch {
    // The next request can safely receive a short-lived stale aggregate.
  }
}

export async function closeLearnCache(): Promise<void> {
  if (!client?.isOpen) return;
  try {
    await client.close();
  } catch {
    // Process shutdown should not be held by an optional cache.
  }
}
