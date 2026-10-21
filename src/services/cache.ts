import { createHash } from 'crypto';
import { createClient, type RedisClientType } from 'redis';
import { Prisma } from '@prisma/client';
import { config } from '../config';
import { logger } from '../utils/logger';

// ─── Shared read cache ─────────────────────────────────────────────────────────
//
// What the API answers often and changes rarely (the menu, popups, schools,
// subject images, an account's to-dos, classes and reminders, the public
// WebUntis school search) is kept in Redis. MySQL stays the only source of
// truth: an entry is a copy of an answer, never state of its own.
//
// Freshness does not depend on remembering every write. Each entry is stored
// under the versions of the tables it was built from, and every write to one
// of those tables raises the table's version — writes through Prisma anywhere
// in this process (routes, the admin panel, background jobs, scripts run in
// it), raw SQL writes (the tables are read from the statement, or every entry
// is dropped when that is not possible), changes applied from another node of
// a cluster and database restores. An entry under an old version is never
// read again and expires by itself. A short TTL on top bounds what a write
// outside this process (a manual SQL session) can leave behind.
//
// Without Redis (not configured, unreachable) the entries are kept in this
// process's memory instead; with the cache switched off every read goes to
// MySQL. A cache fault never fails a request.

type Entry = { value: unknown; expiresAt: number };

const ALL = '*';
const RETRY_AFTER_FAILURE_MS = 30_000;

let client: RedisClientType | null = null;
let connectionAttempt: Promise<RedisClientType | null> | null = null;
let nextConnectionAttemptAt = 0;
let invalidConfigurationLogged = false;
// Set when a version could not be raised; the next connection raises the
// version of everything before it serves a single entry.
let staleAfterReconnect = false;

// Fallback store while Redis is not available (bounded, oldest out first).
const memory = new Map<string, Entry>();
const memoryVersions = new Map<string, number>();

function validRedisUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'redis:' || url.protocol === 'rediss:') && Boolean(url.hostname) && !url.hash;
  } catch {
    return false;
  }
}

async function redis(): Promise<RedisClientType | null> {
  const url = config.cache.redisUrl;
  if (!url || !validRedisUrl(url)) {
    if (url && !invalidConfigurationLogged) {
      invalidConfigurationLogged = true;
      logger.warn('Redis cache disabled because REDIS_URL is invalid', { action: 'cache_config_invalid' });
    }
    return null;
  }
  if (client?.isOpen) return client;
  if (connectionAttempt) return connectionAttempt;
  if (Date.now() < nextConnectionAttemptAt) return null;

  connectionAttempt = (async () => {
    const next = createClient({ url, socket: { connectTimeout: 1_000, reconnectStrategy: false } });
    next.on('error', () => {
      // The provider's error text can name hosts or credentials; never logged.
      if (client === next) client = null;
      nextConnectionAttemptAt = Date.now() + RETRY_AFTER_FAILURE_MS;
      logger.warn('Redis cache unavailable; using process memory', { action: 'cache_unavailable' });
    });
    try {
      await next.connect();
      if (staleAfterReconnect) {
        await next.incr(versionKey(ALL));
        staleAfterReconnect = false;
      }
      client = next;
      nextConnectionAttemptAt = 0;
      // Entries written to memory meanwhile may be older than writes Redis
      // never saw; they are not carried over.
      memory.clear();
      logger.info('Redis cache connected', { action: 'cache_connected' });
      return client;
    } catch {
      try { await next.close(); } catch { /* nothing to close */ }
      nextConnectionAttemptAt = Date.now() + RETRY_AFTER_FAILURE_MS;
      logger.warn('Redis cache connection failed; using process memory', { action: 'cache_connect_failed' });
      return null;
    } finally {
      connectionAttempt = null;
    }
  })();
  return connectionAttempt;
}

const versionKey = (table: string) => `${config.cache.keyPrefix}:v:${table}`;

// Names can carry account ids; the keyspace only ever sees a digest.
function entryKey(name: string, versions: string): string {
  const digest = createHash('sha256').update(name).digest('hex').slice(0, 40);
  return `${config.cache.keyPrefix}:e:${digest}:${versions}`;
}

async function currentVersions(tables: readonly string[]): Promise<string> {
  const names = [ALL, ...new Set(tables)];
  const r = await redis();
  if (r) {
    const values = await r.mGet(names.map(versionKey));
    return values.map((v) => v ?? '0').join('.');
  }
  return names.map((t) => String(memoryVersions.get(t) ?? 0)).join('.');
}

function rememberInMemory(key: string, value: unknown, ttlSeconds: number): void {
  if (config.cache.memoryEntries <= 0) return;
  while (memory.size >= config.cache.memoryEntries) {
    const oldest = memory.keys().next().value;
    if (oldest === undefined) break;
    memory.delete(oldest);
  }
  memory.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

async function read(key: string): Promise<{ hit: boolean; value?: unknown }> {
  const r = await redis();
  if (r) {
    const raw = await r.get(key);
    return raw === null ? { hit: false } : { hit: true, value: JSON.parse(raw) };
  }
  const entry = memory.get(key);
  if (!entry) return { hit: false };
  if (entry.expiresAt < Date.now()) {
    memory.delete(key);
    return { hit: false };
  }
  return { hit: true, value: entry.value };
}

async function write(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  const r = await redis();
  // undefined is not JSON; such an answer is simply not kept.
  if (value === undefined) return;
  if (r) {
    await r.set(key, JSON.stringify(value), { EX: Math.max(1, Math.floor(ttlSeconds)) });
    return;
  }
  // Memory holds a JSON copy too, so a caller can never change a cached answer.
  rememberInMemory(key, JSON.parse(JSON.stringify(value)), ttlSeconds);
}

/**
 * The answer `load` gives, from the cache while none of `tables` (Prisma model
 * names, e.g. 'Dish') has changed since it was kept and it is younger than
 * `ttlSeconds`. Meant for whole JSON answers: what comes back from the cache
 * has been through JSON (dates are strings), exactly as a client receives it.
 */
export async function cached<T>(name: string, tables: readonly string[], ttlSeconds: number, load: () => Promise<T>): Promise<T> {
  if (!config.cache.enabled) return load();
  let key: string | null = null;
  try {
    key = entryKey(name, await currentVersions(tables));
    const found = await read(key);
    if (found.hit) return found.value as T;
  } catch {
    key = null;
  }
  const value = await load();
  if (key) write(key, value, ttlSeconds).catch(() => { /* a later read loads again */ });
  return value;
}

/** A value kept under a plain key with a TTL, for answers that come from outside MySQL. */
export async function cachedFor<T>(name: string, ttlSeconds: number, load: () => Promise<T>, keep: (value: T) => boolean = () => true): Promise<T> {
  if (!config.cache.enabled) return load();
  const key = entryKey(`plain:${name}`, '0');
  try {
    const found = await read(key);
    if (found.hit) return found.value as T;
  } catch { /* load below */ }
  const value = await load();
  if (keep(value)) write(key, value, ttlSeconds).catch(() => { /* a later read loads again */ });
  return value;
}

/**
 * Every entry built from one of these tables (model names) is out of date
 * from now on. Resolves once Redis has the new versions, so a read right
 * after a write never meets the old answer; never rejects.
 */
export async function invalidateTables(tables: Iterable<string>): Promise<void> {
  const names = [...new Set(tables)].filter(Boolean);
  if (names.length === 0) return;
  for (const t of names) memoryVersions.set(t, (memoryVersions.get(t) ?? 0) + 1);
  try {
    const r = await redis();
    if (r) await Promise.all(names.map((t) => r.incr(versionKey(t))));
  } catch {
    // Redis failed mid-write and may keep entries this write made stale:
    // drop the connection; the next one starts by raising every version.
    staleAfterReconnect = true;
    client = null;
  }
}

/** Drops every entry (a restore, a write whose tables are unknown). */
export function invalidateAllCaches(): Promise<void> {
  memory.clear();
  return invalidateTables([ALL]);
}

// ─── Table names → model names ────────────────────────────────────────────────
// Raw SQL and the cluster's change applier name tables (`dish_ratings`); cache
// entries name models (`DishRating`). Built from Prisma's own schema data.

let tableToModel: Map<string, string> | null = null;
// Per model: relation field name → the related model.
let relationsOf: Map<string, Map<string, string>> | null = null;

function modelOfTable(table: string): string | null {
  if (!tableToModel) {
    tableToModel = new Map();
    for (const model of Prisma.dmmf.datamodel.models) {
      tableToModel.set((model.dbName ?? model.name).toLowerCase(), model.name);
    }
  }
  return tableToModel.get(table.toLowerCase()) ?? null;
}

function relations(model: string): Map<string, string> {
  if (!relationsOf) {
    relationsOf = new Map();
    for (const m of Prisma.dmmf.datamodel.models) {
      const fields = new Map<string, string>();
      for (const f of m.fields) if (f.kind === 'object') fields.set(f.name, f.type);
      relationsOf.set(m.name, fields);
    }
  }
  return relationsOf.get(model) ?? new Map();
}

const WRITE_ACTIONS = new Set(['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']);

/**
 * The models a Prisma write changes: its own, the related models a nested
 * write in its data names, and for a deletion every related model (rows that
 * go with it by cascade). Empty for reads.
 */
export function modelsTouchedBy(model: string, action: string, args: unknown): string[] {
  if (!WRITE_ACTIONS.has(action)) return [];
  const touched = new Set([model]);
  const rel = relations(model);
  if (action === 'delete' || action === 'deleteMany') {
    for (const related of rel.values()) touched.add(related);
    return [...touched];
  }
  const a = (args ?? {}) as Record<string, unknown>;
  for (const part of [a.data, a.create, a.update]) {
    if (!part || typeof part !== 'object') continue;
    for (const key of Object.keys(part as object)) {
      const related = rel.get(key);
      if (related) touched.add(related);
    }
  }
  return [...touched];
}

const WRITTEN_TABLE = /\b(INSERT\s+(?:IGNORE\s+)?INTO|REPLACE\s+INTO|UPDATE(?:\s+IGNORE)?|DELETE\s+(?:\w+\s+)?FROM|TRUNCATE(?:\s+TABLE)?)\s+`?([A-Za-z0-9_]+)`?/gi;

/**
 * The models a raw SQL statement writes, or null when that cannot be told
 * (the caller then drops every entry). Reads (SELECT, SET …) write nothing.
 */
export function modelsWrittenBy(sql: string): string[] | null {
  const matches = [...sql.matchAll(WRITTEN_TABLE)];
  if (matches.length === 0) {
    return /^\s*(SELECT|SET|SHOW|DESCRIBE|EXPLAIN|WITH)\b/i.test(sql) ? [] : null;
  }
  const models: string[] = [];
  for (const [, verb, table] of matches) {
    const model = modelOfTable(table);
    // A table outside the schema (cluster bookkeeping) holds nothing cached.
    if (!model) continue;
    const removes = /^(DELETE|TRUNCATE)/i.test(verb);
    models.push(...(removes ? modelsTouchedBy(model, 'delete', null) : [model]));
  }
  return models;
}

/**
 * The SQL text of a raw Prisma call's arguments: `$executeRawUnsafe(sql, …)`
 * passes the string, `$executeRaw\`…\`` the template strings or a Prisma.Sql.
 */
export function sqlOfRawArgs(args: unknown): string | null {
  const first = Array.isArray(args) ? args[0] : args;
  if (typeof first === 'string') return first;
  if (Array.isArray(first)) return first.join('?');
  if (first && typeof first === 'object') {
    const o = first as { sql?: unknown; strings?: unknown };
    if (typeof o.sql === 'string') return o.sql;
    if (Array.isArray(o.strings)) return o.strings.join('?');
  }
  return null;
}

/** Invalidation for a raw statement: its tables, or everything when unknown. */
export function invalidateForSql(sql: string): Promise<void> {
  const models = modelsWrittenBy(sql);
  return models === null ? invalidateAllCaches() : invalidateTables(models);
}

/** Invalidation for tables named by their SQL name (the cluster applier). */
export function invalidateSqlTables(tables: Iterable<string>): Promise<void> {
  const models: string[] = [];
  for (const table of tables) {
    const model = modelOfTable(table);
    // Deleting a row may take related rows with it (cascade).
    if (model) models.push(...modelsTouchedBy(model, 'delete', null));
  }
  return invalidateTables(models);
}

export async function closeCache(): Promise<void> {
  if (!client?.isOpen) return;
  try { await client.close(); } catch { /* shutting down anyway */ }
}
