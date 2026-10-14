import { randomInt } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../db';
import { config } from '../config';
import { logger } from '../utils/logger';
import type { TableInfo, UniqueIndex } from './catalog';
import { decodeRow, isNewer, type RowVersion, type WireValue } from './codec';
import { queueEffect, flushEffects } from './effects';
import type { ItemResult, WireItem, WireTableBatch } from './protocol';
import { nowMicros, recordEvent, state, type PeerRuntime } from './runtime';
import {
  APPLY_FLAG,
  FEED_SEQ,
  STATE_TABLE,
  computePkHash,
  deleteSql,
  insertSql,
  pkWhere,
  q,
  selectByPkSql,
  updateSql,
} from './sqlgen';

// Applies changes received from a peer to the local database.
//
// Changes are applied on a dedicated database connection. That connection
// carries a session flag which keeps the capture triggers silent, so an
// applied change is not mistaken for a local one; the version record is
// written explicitly here, in the same transaction as the row itself, and its
// new place in the change feed passes the change on to the other peers.
//
// A received package is first applied as a whole, in one transaction: one
// commit — one flush to disk — for hundreds of rows instead of one per row.
// That transaction never waits for a lock: it takes every row lock up front
// with NOWAIT, so it cannot end up in a lock cycle with a request that edits
// several rows at once. Should anything in the package need more than a plain
// write (a missing parent, a unique value held by another row, a lock in use),
// it is rolled back untouched and the package goes through the careful path:
// one short transaction per row, which takes its locks in the same order as
// any local write to that row does and holds none while waiting for another.
//
// Rules, in order:
//   1. Last writer wins. A change is applied only if its (version, origin) is
//      greater than what this node already holds for that row.
//   2. A change whose parent row has not arrived yet is set aside and retried;
//      nothing is ever written that would violate a foreign key.
//   3. A change that collides with another row on a unique value is set aside
//      too. Usually the other row's own change is already on its way (a
//      deleted-and-recreated record, a reordered list); once both are here
//      they are applied together. Only when the sender has nothing further to
//      deliver is the collision treated as a real duplicate and resolved by a
//      fixed rule that every node evaluates identically.

type Tx = Prisma.TransactionClient;

let applyClient: PrismaClient | null = null;

function getApplyClient(): PrismaClient {
  if (!applyClient) {
    // Exactly one connection: the session flag below is then guaranteed to be
    // set on the connection that executes the transaction.
    const url = new URL(config.databaseUrl);
    url.searchParams.set('connection_limit', '1');
    // Every failure here is expected and handled (a package falls back to
    // the careful path, a row is set aside); none needs a log line of its own.
    applyClient = new PrismaClient({ datasources: { db: { url: url.toString() } }, log: [] });
  }
  return applyClient;
}

export async function closeApplier(): Promise<void> {
  if (!applyClient) return;
  const client = applyClient;
  applyClient = null;
  await client.$disconnect().catch(() => {});
}

// `lockWaitSeconds` bounds how long a statement may wait for a lock (the
// package path waits for none; see above).
function applyTx<T>(fn: (tx: Tx) => Promise<T>, lockWaitSeconds = 50): Promise<T> {
  return getApplyClient().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET ${APPLY_FLAG} = 1`);
    await tx.$executeRawUnsafe(`SET SESSION innodb_lock_wait_timeout = ${Math.max(1, Math.floor(lockWaitSeconds))}`);
    return fn(tx);
  }, { isolationLevel: 'ReadCommitted', maxWait: 15_000, timeout: 60_000 });
}

function mysqlErrorCode(err: unknown): number | null {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.meta && typeof err.meta === 'object') {
    const code = Number((err.meta as { code?: unknown }).code);
    return Number.isFinite(code) ? code : null;
  }
  return null;
}

function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n').pop()!.slice(0, 300);
}

// ─── Work items ──────────────────────────────────────────────────────────────

interface WorkItem {
  table: TableInfo;
  hash: string;
  key: string[];
  version: bigint;
  origin: string;
  deleted: boolean;
  // Bind values in table column order; null for a deletion.
  values: unknown[] | null;
  fromPeer: string;
  wire: { cols: string[]; item: WireItem };
  // Set when the item was loaded from the deferred table.
  deferred: { attempts: number; firstSeenAt: number } | null;
  // Position in the incoming push, when it came from one.
  slot: number | null;
}

type Outcome =
  | { kind: 'applied' }
  | { kind: 'stale' }
  | { kind: 'conflict'; index: UniqueIndex; otherKey: string[] }
  | { kind: 'defer'; reason: 'fk' | 'race' | 'error'; detail: string }
  | { kind: 'reject'; detail: string };

const itemKey = (table: string, hash: string): string => `${table}|${hash}`;

function valueOf(item: WorkItem, column: string): unknown {
  const index = item.table.columns.findIndex((candidate) => candidate.name === column);
  return index >= 0 && item.values ? item.values[index] : undefined;
}

function buildWorkItem(
  table: TableInfo,
  cols: string[],
  wire: WireItem,
  fromPeer: string,
): WorkItem | string {
  if (wire.k.length !== table.pk.length) return 'key does not match the table';
  if (computePkHash(wire.k) !== wire.h) return 'key hash mismatch';
  let values: unknown[] | null = null;
  if (wire.d === 0) {
    if (!wire.r) return 'row is missing';
    // The sender's column list must be exactly ours; anything else means the
    // two nodes run different schemas.
    if (cols.length !== table.columns.length || cols.some((name, index) => table.columns[index]!.name !== name)) {
      return 'column list differs';
    }
    try {
      values = decodeRow(table.codec, wire.r as WireValue[]);
    } catch (err) {
      return `row could not be decoded (${firstLine(err)})`;
    }
  }
  return {
    table,
    hash: wire.h,
    key: wire.k,
    version: BigInt(wire.v),
    origin: wire.o,
    deleted: wire.d === 1,
    values,
    fromPeer,
    wire: { cols, item: wire },
    deferred: null,
    slot: null,
  };
}

// ─── Registry and queue writes ───────────────────────────────────────────────

async function readVersion(db: Tx | typeof prisma, table: string, hash: string): Promise<RowVersion | null> {
  const rows = await db.$queryRawUnsafe<Array<{ version: bigint; origin: string }>>(
    `SELECT \`version\`, \`origin\` FROM ${q(STATE_TABLE)} WHERE \`table_name\` = ? AND \`pk_hash\` = ?`,
    table, hash,
  );
  return rows[0] ? { version: BigInt(rows[0].version), origin: rows[0].origin } : null;
}

// Stores a row's version and moves it to the end of the change feed, which
// passes the change on to every other peer: a node that is not linked with
// the origin still receives it, and peers that already hold it decline the
// offer. `via` is the peer it came from (null for a change made here), so it
// is not offered straight back.
async function writeVersion(tx: Tx, table: string, hash: string, key: string[], version: bigint, origin: string, deleted: boolean, via: string | null): Promise<void> {
  await tx.$executeRawUnsafe(
    `INSERT INTO ${q(STATE_TABLE)} (\`table_name\`, \`pk_hash\`, \`pk\`, \`version\`, \`origin\`, \`via\`, \`deleted\`, \`changed_at\`, \`seq\`) `
    + `VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3), ${FEED_SEQ}) `
    + 'ON DUPLICATE KEY UPDATE `version` = VALUES(`version`), `origin` = VALUES(`origin`), `via` = VALUES(`via`), '
    + '`deleted` = VALUES(`deleted`), `pk` = VALUES(`pk`), `changed_at` = VALUES(`changed_at`), `seq` = VALUES(`seq`)',
    table, hash, JSON.stringify(key), version, origin, via, deleted ? 1 : 0,
  );
}

// ─── Unique-value collisions ─────────────────────────────────────────────────

function keySelect(table: TableInfo): string {
  return table.pk.map((column) => `CAST(${q(column)} AS CHAR CHARACTER SET utf8mb4) AS ${q(column)}`).join(', ');
}

// Finds a different local row that already holds one of the unique values the
// incoming row needs.
async function findCollision(db: Tx | typeof prisma, item: WorkItem): Promise<{ index: UniqueIndex; otherKey: string[] } | null> {
  if (!item.values) return null;
  const table = item.table;
  for (const index of table.uniques) {
    const values = index.columns.map((column) => valueOf(item, column));
    // NULL never collides in a unique index.
    if (values.some((value) => value === null || value === undefined)) continue;
    const rows = await db.$queryRawUnsafe<Array<Record<string, string>>>(
      `SELECT ${keySelect(table)} FROM ${q(table.name)} `
      + `WHERE ${index.columns.map((column) => `${q(column)} = ?`).join(' AND ')} AND NOT (${pkWhere(table)}) LIMIT 1`,
      ...values, ...item.key,
    );
    if (rows[0]) return { index, otherKey: table.pk.map((column) => String(rows[0]![column])) };
  }
  return null;
}

// ─── Applying one change ─────────────────────────────────────────────────────

class Abort extends Error {
  constructor(public readonly outcome: Outcome) {
    super('apply aborted');
  }
}

function classifyWriteError(err: unknown): Outcome {
  const code = mysqlErrorCode(err);
  switch (code) {
    case 1452: // parent row is not here (yet)
    case 1216:
      return { kind: 'defer', reason: 'fk', detail: firstLine(err) };
    case 1062: // a concurrent local write took the key or unique value first
    case 1213: // deadlock
    case 1205: // lock wait timeout
      return { kind: 'defer', reason: 'race', detail: firstLine(err) };
    case 1406: // data too long
    case 1264: // out of range
    case 1265: // truncated
    case 1366: // incorrect value
    case 1292: // incorrect date/time
    case 1054: // unknown column
    case 1146: // unknown table
      return { kind: 'reject', detail: firstLine(err) };
    default:
      return { kind: 'defer', reason: 'error', detail: firstLine(err) };
  }
}

interface Effect {
  table: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

function rowObject(item: WorkItem): Record<string, unknown> | null {
  if (!item.values) return null;
  const row: Record<string, unknown> = {};
  item.table.columns.forEach((column, index) => { row[column.name] = item.values![index]; });
  return row;
}

async function writeRow(tx: Tx, item: WorkItem, exists: boolean): Promise<void> {
  const table = item.table;
  if (!item.values) {
    if (exists) await tx.$executeRawUnsafe(deleteSql(table), ...item.key);
    return;
  }
  if (!exists) {
    await tx.$executeRawUnsafe(insertSql(table), ...item.values);
    return;
  }
  const sql = updateSql(table);
  if (!sql) return;
  const keys = new Set(table.pk);
  const assignments = item.values.filter((_, index) => !keys.has(table.columns[index]!.name));
  await tx.$executeRawUnsafe(sql, ...assignments, ...item.key);
}

interface AttemptResult {
  outcome: Outcome;
  effect: Effect | null;
}

// The steps for one change inside an open transaction. Throws `Abort` when the
// write itself fails, so the caller's transaction is rolled back.
async function attemptWithin(tx: Tx, item: WorkItem): Promise<AttemptResult> {
  // Locking the row first means no local write can change it — or its
  // version — between the comparison below and our own write.
  const existing = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(selectByPkSql(item.table, true), ...item.key);
  const local = await readVersion(tx, item.table.name, item.hash);
  if (!isNewer({ version: item.version, origin: item.origin }, local)) return { outcome: { kind: 'stale' }, effect: null };

  if (!item.deleted) {
    const collision = await findCollision(tx, item);
    if (collision) return { outcome: { kind: 'conflict', index: collision.index, otherKey: collision.otherKey }, effect: null };
  }
  try {
    await writeRow(tx, item, existing.length > 0);
  } catch (err) {
    throw new Abort(classifyWriteError(err));
  }
  await writeVersion(tx, item.table.name, item.hash, item.key, item.version, item.origin, item.deleted, item.fromPeer);
  return {
    outcome: { kind: 'applied' },
    effect: { table: item.table.name, before: existing[0] ?? null, after: rowObject(item) },
  };
}

async function attempt(item: WorkItem): Promise<AttemptResult> {
  try {
    return await applyTx((tx) => attemptWithin(tx, item));
  } catch (err) {
    if (err instanceof Abort) return { outcome: err.outcome, effect: null };
    return { outcome: classifyWriteError(err), effect: null };
  }
}

// ─── Applying a whole package at once ────────────────────────────────────────

const LOCK_NOWAIT = 3572;

class Fallback extends Error {
  constructor() {
    super('package needs the careful path');
    this.name = 'Fallback';
  }
}

// Applies every item in one transaction, or nothing. Returns null when the
// package has to go through the careful path instead (see the top of the
// file); the transaction is then rolled back without a trace.
async function applyPackage(items: WorkItem[]): Promise<{ results: Map<WorkItem, ItemResult>; effects: Effect[] } | null> {
  const results = new Map<WorkItem, ItemResult>();
  const effects: Effect[] = [];
  try {
    await applyTx(async (tx) => {
      // Every row lock is taken first, without waiting: once they are all
      // held, nothing below can be blocked by a local writer on these rows.
      const existing = new Map<WorkItem, Record<string, unknown> | null>();
      for (const item of items) {
        try {
          const rows = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(`${selectByPkSql(item.table, true)} NOWAIT`, ...item.key);
          existing.set(item, rows[0] ?? null);
        } catch (err) {
          if (mysqlErrorCode(err) === LOCK_NOWAIT) throw new Fallback();
          throw err;
        }
      }
      for (const item of items) {
        const local = await readVersion(tx, item.table.name, item.hash);
        if (!isNewer({ version: item.version, origin: item.origin }, local)) {
          results.set(item, 's');
          continue;
        }
        if (!item.deleted && await findCollision(tx, item)) throw new Fallback();
        try {
          await writeRow(tx, item, existing.get(item) !== null);
        } catch {
          // A missing parent, a unique value taken meanwhile, a lock: the
          // careful path knows how to handle each of these.
          throw new Fallback();
        }
        await writeVersion(tx, item.table.name, item.hash, item.key, item.version, item.origin, item.deleted, item.fromPeer);
        results.set(item, 'a');
        effects.push({ table: item.table.name, before: existing.get(item) ?? null, after: rowObject(item) });
      }
    }, 1);
  } catch (err) {
    if (err instanceof Fallback) return null;
    const code = mysqlErrorCode(err);
    // Lock waits, deadlocks and the like: try again row by row.
    if (code !== null) return null;
    throw err;
  }
  return { results, effects };
}

// ─── Applying a set of mutually colliding changes together ───────────────────
// When list positions are swapped (A takes B's place and B takes A's), neither
// row can be written first without breaking the unique constraint. The rows
// are therefore moved out of the way inside one transaction — the colliding
// column is set to a throw-away value — and then all receive their final
// values. Either the whole set is applied or none of it.

function parkingValue(table: TableInfo, column: string): unknown | undefined {
  const kind = table.codec.find((candidate) => candidate.name === column)?.kind;
  if (kind === 'number') return -(100_000_000 + randomInt(1_900_000_000));
  if (kind === 'bigint') return BigInt(-(100_000_000 + randomInt(1_900_000_000)));
  if (kind === 'string') {
    const max = table.maxLength.get(column) ?? 0;
    if (max < 6) return undefined;
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let out = '~';
    while (out.length < Math.min(max, 24)) out += alphabet[randomInt(alphabet.length)];
    return out;
  }
  return undefined;
}

function parkingColumn(table: TableInfo, index: UniqueIndex): string | null {
  const keys = new Set(table.pk);
  for (const column of index.columns) {
    if (keys.has(column) || table.fkColumns.has(column)) continue;
    if (parkingValue(table, column) !== undefined) return column;
  }
  return null;
}

async function applyGroup(group: WorkItem[]): Promise<{ applied: boolean; effects: Effect[] }> {
  const effects: Effect[] = [];
  try {
    const applied = await applyTx<boolean>(async (tx) => {
      const existing = new Map<string, Record<string, unknown> | null>();
      for (const item of group) {
        const rows = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(selectByPkSql(item.table, true), ...item.key);
        const local = await readVersion(tx, item.table.name, item.hash);
        // The set only makes sense as a whole. If one member is no longer
        // current, each member is re-evaluated on its own next time.
        if (!isNewer({ version: item.version, origin: item.origin }, local)) return false;
        existing.set(item.hash, rows[0] ?? null);
      }
      for (const item of group) {
        if (!existing.get(item.hash)) continue;
        for (const index of item.table.uniques) {
          const column = parkingColumn(item.table, index);
          if (!column) return false;
          await tx.$executeRawUnsafe(
            `UPDATE ${q(item.table.name)} SET ${q(column)} = ? WHERE ${pkWhere(item.table)}`,
            parkingValue(item.table, column), ...item.key,
          );
        }
      }
      for (const item of group) {
        await writeRow(tx, item, existing.get(item.hash) !== null);
        await writeVersion(tx, item.table.name, item.hash, item.key, item.version, item.origin, item.deleted, item.fromPeer);
        effects.push({ table: item.table.name, before: existing.get(item.hash) ?? null, after: rowObject(item) });
      }
      return true;
    });
    return { applied, effects: applied ? effects : [] };
  } catch {
    return { applied: false, effects: [] };
  }
}

// ─── Resolving a real duplicate ──────────────────────────────────────────────
// Two nodes each created a different row with the same unique value before
// they could learn of the other's. Every node must reach the same verdict
// without talking to anyone, so the rule only looks at properties of the two
// rows themselves.

// Not every collision is the same entity created twice. Two different list
// entries that claim the same position, or two different courses that chose
// the same address, are both legitimate: one of them only needs another
// value. For these indexes the losing row is adjusted instead of removed.
interface Repair {
  index: string[];
  column: string;
  // 'position': move to the end of the list given by `scope`.
  // 'suffix':   append a short suffix derived from the row's own key, which
  //             every node computes identically.
  kind: 'position' | 'suffix';
  scope: string[];
}

const REPAIRS: Record<string, Repair[]> = {
  learn_course_sections: [{ index: ['course_id', 'sort_order'], column: 'sort_order', kind: 'position', scope: ['course_id'] }],
  learn_courses: [{ index: ['slug'], column: 'slug', kind: 'suffix', scope: [] }],
};

function sameColumns(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');
}

// True when the incoming row wins against the local row it collides with.
// The earlier-created row wins — it is the one more likely to have other
// data attached — and the key hash settles a tie or a missing timestamp.
async function incomingWins(item: WorkItem, otherKey: string[], otherHash: string): Promise<boolean> {
  const column = item.table.createdAtColumn;
  if (column) {
    const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT ${q(column)} FROM ${q(item.table.name)} WHERE ${pkWhere(item.table)}`, ...otherKey,
    );
    const localCreated = rows[0]?.[column];
    const incomingCreated = valueOf(item, column);
    if (localCreated instanceof Date && incomingCreated instanceof Date && localCreated.getTime() !== incomingCreated.getTime()) {
      return incomingCreated.getTime() < localCreated.getTime();
    }
  }
  return item.hash < otherHash;
}

async function resolveDuplicate(item: WorkItem, index: UniqueIndex, otherKey: string[]): Promise<{ applied: boolean; effects: Effect[] }> {
  const table = item.table;
  const otherHash = computePkHash(otherKey);
  const repair = (REPAIRS[table.name] ?? []).find((candidate) => sameColumns(candidate.index, index.columns));
  const effects: Effect[] = [];

  try {
    if (repair) {
      // The row with the larger key hash is the one that gets adjusted. The
      // adjustment is recorded as a new change of that row, so it reaches
      // every node.
      const adjustIncoming = item.hash > otherHash;
      const position = table.columns.findIndex((column) => column.name === repair.column);
      const applied = await applyTx<boolean>(async (tx) => {
        const existing = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(selectByPkSql(table, true), ...item.key);
        const local = await readVersion(tx, table.name, item.hash);
        if (!isNewer({ version: item.version, origin: item.origin }, local)) return false;

        let replacement: unknown;
        if (repair.kind === 'position') {
          const rows = await tx.$queryRawUnsafe<Array<{ next: bigint | number | null }>>(
            `SELECT COALESCE(MAX(${q(repair.column)}), -1) + 1 AS next FROM ${q(table.name)} `
            + `WHERE ${repair.scope.map((column) => `${q(column)} = ?`).join(' AND ')}`,
            ...repair.scope.map((column) => valueOf(item, column)),
          );
          replacement = Number(rows[0]?.next ?? 0);
        } else {
          const max = table.maxLength.get(repair.column) ?? 191;
          const suffix = `-${(adjustIncoming ? item.hash : otherHash).slice(0, 6)}`;
          replacement = `${String(valueOf(item, repair.column)).slice(0, max - suffix.length)}${suffix}`;
        }

        if (adjustIncoming) {
          item.values![position] = replacement;
          await writeRow(tx, item, existing.length > 0);
          const adjusted = item.version + 1n > nowMicros() ? item.version + 1n : nowMicros();
          await writeVersion(tx, table.name, item.hash, item.key, adjusted, state.nodeId, false, null);
        } else {
          const otherVersion = await readVersion(tx, table.name, otherHash);
          await tx.$executeRawUnsafe(
            `UPDATE ${q(table.name)} SET ${q(repair.column)} = ? WHERE ${pkWhere(table)}`, replacement, ...otherKey,
          );
          const base = (otherVersion?.version ?? 0n) + 1n;
          await writeVersion(tx, table.name, otherHash, otherKey, base > nowMicros() ? base : nowMicros(), state.nodeId, false, null);
          await writeRow(tx, item, existing.length > 0);
          await writeVersion(tx, table.name, item.hash, item.key, item.version, item.origin, false, item.fromPeer);
        }
        effects.push({ table: table.name, before: existing[0] ?? null, after: rowObject(item) });
        return true;
      });
      if (applied) {
        recordEvent('warn', `Colliding ${table.name} rows on (${index.columns.join(', ')}) resolved by adjusting one of them`);
      }
      return { applied, effects: applied ? effects : [] };
    }

    const wins = await incomingWins(item, otherKey, otherHash);
    const applied = await applyTx<boolean>(async (tx) => {
      const existing = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(selectByPkSql(table, true), ...item.key);
      const local = await readVersion(tx, table.name, item.hash);
      if (!isNewer({ version: item.version, origin: item.origin }, local)) return false;

      if (!wins) {
        // The incoming row loses: it is recorded as deleted with a version
        // just above its own, and that record is sent to every peer —
        // including the sender, which removes its copy.
        if (existing.length > 0) await tx.$executeRawUnsafe(deleteSql(table), ...item.key);
        await writeVersion(tx, table.name, item.hash, item.key, item.version + 1n, state.nodeId, true, null);
        effects.push({ table: table.name, before: existing[0] ?? null, after: null });
        return true;
      }

      // The local row loses: remove it (with everything that depends on it),
      // record that for the peers, then store the incoming row.
      const other = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(selectByPkSql(table, true), ...otherKey);
      const otherVersion = await readVersion(tx, table.name, otherHash);
      if (other.length > 0) await tx.$executeRawUnsafe(deleteSql(table), ...otherKey);
      await writeVersion(tx, table.name, otherHash, otherKey, (otherVersion?.version ?? 0n) + 1n, state.nodeId, true, null);
      effects.push({ table: table.name, before: other[0] ?? null, after: null });

      await writeRow(tx, item, existing.length > 0);
      await writeVersion(tx, table.name, item.hash, item.key, item.version, item.origin, false, item.fromPeer);
      effects.push({ table: table.name, before: existing[0] ?? null, after: rowObject(item) });
      return true;
    });
    if (applied) {
      const message = `Duplicate ${table.name} rows on (${index.columns.join(', ')}) resolved — ${wins ? 'received' : 'local'} row kept`;
      recordEvent('warn', message);
      logger.warn('Cluster duplicate resolved', {
        action: 'cluster_duplicate_resolved',
        table: table.name,
        index: index.columns.join(','),
        kept: wins ? 'received' : 'local',
      });
    }
    return { applied, effects: applied ? effects : [] };
  } catch (err) {
    logger.warn('Cluster duplicate could not be resolved', {
      action: 'cluster_duplicate_unresolved',
      table: table.name,
      message: firstLine(err),
    });
    return { applied: false, effects: [] };
  }
}

// ─── Deferred changes ────────────────────────────────────────────────────────

async function saveDeferred(item: WorkItem, reason: string, detail: string): Promise<void> {
  const existing = await prisma.clusterDeferred.findUnique({
    where: { tableName_pkHash: { tableName: item.table.name, pkHash: item.hash } },
    select: { version: true, origin: true },
  });
  // Only the newest pending change of a row is worth keeping.
  if (existing && !isNewer({ version: item.version, origin: item.origin }, { version: existing.version, origin: existing.origin })
    && !(existing.version === item.version && existing.origin === item.origin)) {
    return;
  }
  const data = {
    fromPeer: item.fromPeer,
    version: item.version,
    origin: item.origin,
    payload: JSON.stringify(item.wire),
    reason,
    detail: detail.slice(0, 500),
    lastTriedAt: new Date(),
  };
  await prisma.clusterDeferred.upsert({
    where: { tableName_pkHash: { tableName: item.table.name, pkHash: item.hash } },
    create: { tableName: item.table.name, pkHash: item.hash, ...data, attempts: 1 },
    update: { ...data, attempts: { increment: 1 } },
  });
}

async function clearDeferred(item: WorkItem): Promise<void> {
  await prisma.clusterDeferred.deleteMany({
    where: { tableName: item.table.name, pkHash: item.hash, version: { lte: item.version } },
  });
}

// True once the peer that sent a set-aside change has confirmed, after we
// first saw the change, that it has nothing further queued for us. Whatever
// the change was waiting for — its parent row, or the other row's own change
// that would have freed a unique value — would have arrived by then, because
// a node only ever forwards a row after it could store that row itself.
function senderHasNothingMore(item: WorkItem): boolean {
  if (!item.deferred || item.deferred.attempts < 2) return false;
  const maxAgeMs = config.cluster.deferredMaxAgeHours * 60 * 60 * 1000;
  if (Date.now() - item.deferred.firstSeenAt > maxAgeMs) return true;
  for (const peer of state.peers.values()) {
    if (peer.nodeId === item.fromPeer) return peer.drainedAt !== null && peer.drainedAt > item.deferred.firstSeenAt;
  }
  // The sending peer has since been removed.
  return true;
}

// ─── Processing a set of changes ─────────────────────────────────────────────

async function processItems(items: WorkItem[]): Promise<Map<WorkItem, ItemResult>> {
  // Nothing set aside and nothing loaded from there: no clean-up needed below.
  const anySetAside = items.some((item) => item.deferred !== null) || (await prisma.clusterDeferred.count()) > 0;

  // Deletions first (children before parents), then rows (parents before
  // children): a freed unique value or a new parent is then already in place
  // when the row that needs it follows.
  const ordered = [...items].sort((a, b) => {
    if (a.deleted !== b.deleted) return a.deleted ? -1 : 1;
    return a.deleted ? b.table.rank - a.table.rank : a.table.rank - b.table.rank;
  });

  // The usual case: the whole package in one transaction.
  if (ordered.length > 0 && !ordered.some((item) => item.deferred !== null)) {
    const done = await applyPackage(ordered);
    if (done) {
      if (anySetAside) {
        for (const [item, result] of done.results) {
          if (result === 'a' || result === 's') await clearDeferred(item);
        }
      }
      for (const effect of done.effects) queueEffect(effect.table, effect.before, effect.after);
      flushEffects();
      return done.results;
    }
  }

  const results = new Map<WorkItem, ItemResult>();
  const effects: Effect[] = [];

  const colliding: Array<{ item: WorkItem; index: UniqueIndex; otherKey: string[] }> = [];
  const waiting: Array<{ item: WorkItem; reason: string; detail: string }> = [];

  for (const item of ordered) {
    const { outcome, effect } = await attempt(item);
    switch (outcome.kind) {
      case 'applied':
        results.set(item, 'a');
        if (effect) effects.push(effect);
        break;
      case 'stale':
        results.set(item, 's');
        break;
      case 'conflict':
        colliding.push({ item, index: outcome.index, otherKey: outcome.otherKey });
        break;
      case 'defer':
        waiting.push({ item, reason: outcome.reason, detail: outcome.detail });
        break;
      case 'reject':
        results.set(item, 'r');
        logger.warn('Cluster change rejected', { action: 'cluster_change_rejected', table: item.table.name, message: outcome.detail });
        break;
    }
  }

  // A row that waited for its parent may have been unblocked by a later row
  // of the same set.
  for (const entry of [...waiting]) {
    if (entry.reason !== 'fk' && entry.reason !== 'race') continue;
    const { outcome, effect } = await attempt(entry.item);
    if (outcome.kind === 'applied' || outcome.kind === 'stale') {
      results.set(entry.item, outcome.kind === 'applied' ? 'a' : 's');
      if (effect) effects.push(effect);
      waiting.splice(waiting.indexOf(entry), 1);
    } else if (outcome.kind === 'conflict') {
      colliding.push({ item: entry.item, index: outcome.index, otherKey: outcome.otherKey });
      waiting.splice(waiting.indexOf(entry), 1);
    }
  }

  if (colliding.length > 0) {
    const pending = new Map<string, WorkItem>();
    for (const entry of colliding) pending.set(itemKey(entry.item.table.name, entry.item.hash), entry.item);
    const handled = new Set<WorkItem>();

    for (const entry of colliding) {
      if (handled.has(entry.item)) continue;

      // An earlier step of this pass may have removed the collision already.
      const retry = await attempt(entry.item);
      if (retry.outcome.kind === 'applied' || retry.outcome.kind === 'stale') {
        handled.add(entry.item);
        results.set(entry.item, retry.outcome.kind === 'applied' ? 'a' : 's');
        if (retry.effect) effects.push(retry.effect);
        continue;
      }
      if (retry.outcome.kind !== 'conflict') {
        handled.add(entry.item);
        if (retry.outcome.kind === 'reject') results.set(entry.item, 'r');
        else waiting.push({ item: entry.item, reason: retry.outcome.reason, detail: retry.outcome.detail });
        continue;
      }

      // Collect the rows that collide only with each other.
      const group: WorkItem[] = [entry.item];
      let closed = true;
      let blocker: { index: UniqueIndex; otherKey: string[] } = { index: retry.outcome.index, otherKey: retry.outcome.otherKey };
      for (let cursor = 0; cursor < group.length && closed; cursor++) {
        const member = group[cursor]!;
        for (const index of member.table.uniques) {
          const values = index.columns.map((column) => valueOf(member, column));
          if (values.some((value) => value === null || value === undefined)) continue;
          const rows = await prisma.$queryRawUnsafe<Array<Record<string, string>>>(
            `SELECT ${keySelect(member.table)} FROM ${q(member.table.name)} `
            + `WHERE ${index.columns.map((column) => `${q(column)} = ?`).join(' AND ')} AND NOT (${pkWhere(member.table)}) LIMIT 1`,
            ...values, ...member.key,
          );
          if (!rows[0]) continue;
          const otherKey = member.table.pk.map((column) => String(rows[0]![column]));
          const otherHash = computePkHash(otherKey);
          if (group.some((candidate) => candidate.table === member.table && candidate.hash === otherHash)) continue;
          const partner = pending.get(itemKey(member.table.name, otherHash));
          if (partner && !handled.has(partner) && !partner.deleted) {
            group.push(partner);
          } else {
            closed = false;
            blocker = { index, otherKey };
            break;
          }
        }
      }

      if (closed && group.length > 1) {
        const outcome = await applyGroup(group);
        if (outcome.applied) {
          for (const member of group) {
            handled.add(member);
            results.set(member, 'a');
          }
          effects.push(...outcome.effects);
          continue;
        }
      }

      handled.add(entry.item);
      if (senderHasNothingMore(entry.item)) {
        const outcome = await resolveDuplicate(entry.item, blocker.index, blocker.otherKey);
        if (outcome.applied) {
          results.set(entry.item, 'a');
          effects.push(...outcome.effects);
          continue;
        }
      }
      waiting.push({
        item: entry.item,
        reason: 'unique',
        detail: `collides on (${blocker.index.columns.join(', ')})`,
      });
    }
  }

  for (const entry of waiting) {
    if (entry.reason === 'fk' && senderHasNothingMore(entry.item)) {
      // The row it depends on no longer exists anywhere the change could
      // have come from: it belongs to something deleted in the meantime.
      results.set(entry.item, 's');
      logger.info('Cluster change for a deleted parent dropped', {
        action: 'cluster_orphan_dropped',
        table: entry.item.table.name,
      });
      continue;
    }
    results.set(entry.item, 'd');
    await saveDeferred(entry.item, entry.reason, entry.detail);
  }
  if (anySetAside) {
    for (const [item, result] of results) {
      if (result === 'a' || result === 's') await clearDeferred(item);
    }
  }

  for (const effect of effects) queueEffect(effect.table, effect.before, effect.after);
  flushEffects();
  return results;
}

// Serialises all applying work: the dedicated connection handles one
// transaction at a time, and ordering between batches then stays simple.
let applyChain: Promise<unknown> = Promise.resolve();

function exclusive<T>(job: () => Promise<T>): Promise<T> {
  const next = applyChain.catch(() => undefined).then(job);
  applyChain = next;
  return next;
}

// Lets a caller wait until no apply work is in flight.
export function whenApplierIdle(): Promise<void> {
  return applyChain.then(() => undefined, () => undefined);
}

// Applies one push from a peer. Returns one result letter per item, in the
// order the items were sent.
export function applyPush(peer: PeerRuntime, batches: WireTableBatch[]): Promise<ItemResult[]> {
  return exclusive(async () => {
    const catalog = state.catalog;
    const slots: ItemResult[] = [];
    const items: WorkItem[] = [];
    for (const batch of batches) {
      const table = catalog?.tables.get(batch.t);
      for (const wire of batch.items) {
        const slot = slots.length;
        slots.push('r');
        if (!table) continue;
        const built = buildWorkItem(table, batch.cols, wire, peer.nodeId);
        if (typeof built === 'string') {
          logger.warn('Cluster change rejected', { action: 'cluster_change_rejected', table: batch.t, message: built });
          continue;
        }
        built.slot = slot;
        items.push(built);
      }
    }
    const results = await processItems(items);
    let applied = 0;
    for (const [item, result] of results) {
      if (item.slot !== null) slots[item.slot] = result;
      if (result === 'a') applied++;
    }
    peer.rowsReceived += applied;
    return slots;
  });
}

// Decides which offered rows this node still needs.
export async function wantedFromOffer(items: Array<[string, string, string, string, 0 | 1]>): Promise<number[]> {
  const wanted: number[] = [];
  if (items.length === 0) return wanted;
  const byTable = new Map<string, Array<{ index: number; hash: string }>>();
  items.forEach(([table, hash], index) => {
    const list = byTable.get(table) ?? [];
    list.push({ index, hash });
    byTable.set(table, list);
  });
  const known = new Map<string, RowVersion>();
  for (const [table, list] of byTable) {
    if (!state.catalog?.tables.has(table)) continue;
    for (let start = 0; start < list.length; start += 500) {
      const chunk = list.slice(start, start + 500);
      const rows = await prisma.$queryRawUnsafe<Array<{ pk_hash: string; version: bigint; origin: string }>>(
        `SELECT \`pk_hash\`, \`version\`, \`origin\` FROM ${q(STATE_TABLE)} WHERE \`table_name\` = ? `
        + `AND \`pk_hash\` IN (${chunk.map(() => '?').join(', ')})`,
        table, ...chunk.map((entry) => entry.hash),
      );
      for (const row of rows) known.set(itemKey(table, row.pk_hash), { version: BigInt(row.version), origin: row.origin });
    }
  }
  items.forEach(([table, hash, version, origin], index) => {
    if (!state.catalog?.tables.has(table)) return;
    if (isNewer({ version: BigInt(version), origin }, known.get(itemKey(table, hash)) ?? null)) wanted.push(index);
  });
  return wanted;
}

// Retries changes that were set aside. Called after every push and on a timer.
export function retryDeferred(limit = 200): Promise<number> {
  return exclusive(async () => {
    const catalog = state.catalog;
    if (!catalog) return 0;
    const rows = await prisma.clusterDeferred.findMany({ orderBy: { lastTriedAt: 'asc' }, take: limit });
    if (rows.length === 0) return 0;

    const maxAgeMs = config.cluster.deferredMaxAgeHours * 60 * 60 * 1000;
    const items: WorkItem[] = [];
    for (const row of rows) {
      const table = catalog.tables.get(row.tableName);
      let built: WorkItem | string = 'table is not replicated';
      if (table) {
        try {
          const wire = JSON.parse(row.payload) as { cols: string[]; item: WireItem };
          built = buildWorkItem(table, wire.cols, wire.item, row.fromPeer);
        } catch (err) {
          built = firstLine(err);
        }
      }
      const expired = Date.now() - row.firstSeenAt.getTime() > maxAgeMs;
      if (typeof built === 'string' || (expired && row.reason !== 'unique')) {
        // A row whose parent never arrived belongs to something that was
        // deleted in the meantime; it has nowhere to go.
        await prisma.clusterDeferred.deleteMany({ where: { tableName: row.tableName, pkHash: row.pkHash } });
        logger.warn('Cluster deferred change dropped', {
          action: 'cluster_deferred_dropped',
          table: row.tableName,
          reason: typeof built === 'string' ? built : `expired (${row.reason})`,
        });
        continue;
      }
      built.deferred = { attempts: row.attempts, firstSeenAt: row.firstSeenAt.getTime() };
      items.push(built);
    }
    const results = await processItems(items);
    let applied = 0;
    for (const result of results.values()) if (result === 'a') applied++;
    return applied;
  });
}

export function deferredCount(): Promise<number> {
  return prisma.clusterDeferred.count();
}
