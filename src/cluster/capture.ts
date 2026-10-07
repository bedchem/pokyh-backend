import { spawn } from 'child_process';
import { prisma } from '../db';
import { config } from '../config';
import { logger } from '../utils/logger';
import type { Catalog } from './catalog';
import { OUTBOX_TABLE, STATE_TABLE, TRIGGER_PREFIX, backfillSql, q, triggerDefinitions } from './sqlgen';

// Change capture: installs the per-table triggers and keeps the version
// registry complete.
//
// One rule runs through this file and the rest of the cluster bookkeeping:
// a maintenance statement must never wait for a row lock while it holds
// others. A request that edits several rows could otherwise end up in a
// lock cycle with it, and the database might resolve that cycle by failing
// the request. Maintenance therefore either works on rows nobody else can be
// touching, or picks up only rows that are free at that moment
// (`FOR UPDATE SKIP LOCKED`) and leaves the rest for its next pass.

// Trigger DDL cannot be sent through the prepared-statement protocol the
// Prisma client uses for raw queries, so it goes through the Prisma CLI — the
// same mechanism this server already relies on for `db push` at start-up. The
// connection settings are read from DATABASE_URL in the environment and never
// appear on the command line.
function runSqlScript(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'npx',
      ['prisma', 'db', 'execute', '--stdin', '--schema', 'prisma/schema.prisma'],
      { cwd: process.cwd(), env: process.env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let output = '';
    const onData = (chunk: Buffer) => { output += chunk.toString(); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => child.kill('SIGKILL'), config.dbPushTimeoutMs);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`trigger script failed (code ${code}): ${output.trim().split('\n').slice(-3).join(' | ')}`));
    });
    child.stdin.on('error', () => { /* reported through the exit code */ });
    child.stdin.end(script);
  });
}

async function existingTriggerNames(): Promise<Set<string>> {
  const rows = await prisma.$queryRawUnsafe<Array<{ TRIGGER_NAME: string }>>(
    'SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()',
  );
  return new Set(rows.map((row) => row.TRIGGER_NAME).filter((name) => name.startsWith(TRIGGER_PREFIX)));
}

export interface TriggerReport {
  created: number;
  dropped: number;
  // Tables that had no capture trigger at all although rows of them were
  // already being tracked: writes made in that state were not recorded.
  uncovered: string[];
}

// Brings the installed triggers in line with the current schema and node
// identity. New definitions are created before outdated ones are dropped, so
// there is never a moment in which a write goes unrecorded; during the
// overlap a write is simply recorded twice, which is harmless.
// Tables of which at least one row already has a version record.
export async function trackedTables(): Promise<Set<string>> {
  const rows = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
    `SELECT DISTINCT \`table_name\` FROM ${q(STATE_TABLE)}`,
  );
  return new Set(rows.map((row) => row.table_name));
}

// `trackedBefore` is the set of tables that were already being tracked before
// this start: a table in it that turns out to have no trigger at all was
// written to without being recorded.
export async function ensureTriggers(catalog: Catalog, nodeId: string, trackedBefore: Set<string> = new Set()): Promise<TriggerReport> {
  const desired = catalog.ordered.flatMap((table) => triggerDefinitions(table, nodeId));
  const desiredNames = new Set(desired.map((trigger) => trigger.name));
  const existing = await existingTriggerNames();

  const missing = desired.filter((trigger) => !existing.has(trigger.name));
  const outdated = [...existing].filter((name) => !desiredNames.has(name));
  if (missing.length === 0 && outdated.length === 0) return { created: 0, dropped: 0, uncovered: [] };

  // A table is covered when any capture trigger exists for it, whether of the
  // current or of an outdated definition.
  const covered = new Set<string>();
  for (const name of existing) {
    const match = /^pokyh_cl_[0-9a-f]{8}_[iud]_(.+)$/.exec(name);
    if (match) covered.add(match[1]!);
  }
  const uncovered = [...new Set(missing.map((trigger) => trigger.table))]
    .filter((table) => !covered.has(table) && trackedBefore.has(table));

  const script = [
    ...missing.map((trigger) => `${trigger.sql};`),
    ...outdated.map((name) => `DROP TRIGGER IF EXISTS ${q(name)};`),
  ].join('\n');
  await runSqlScript(script);

  const after = await existingTriggerNames();
  const stillMissing = desired.filter((trigger) => !after.has(trigger.name));
  if (stillMissing.length > 0) {
    throw new Error(`${stillMissing.length} capture trigger(s) could not be created`);
  }
  return { created: missing.length, dropped: outdated.length, uncovered };
}

// Gives every row that has no version yet one. Rows that already have a
// version are not touched (and not locked), so this is safe to repeat on
// every start of a busy server.
export async function backfillVersions(catalog: Catalog, nodeId: string, mode: 'history' | 'now'): Promise<number> {
  let registered = 0;
  for (const table of catalog.ordered) {
    // READ COMMITTED: reading a whole table to register it must not hold
    // locks that make ordinary writers wait.
    const [count] = await prisma.$transaction(
      [prisma.$executeRawUnsafe(backfillSql(table, mode), nodeId)],
      { isolationLevel: 'ReadCommitted' },
    );
    registered += Number(count) || 0;
  }
  return registered;
}

// Starts (or restarts) a complete transfer to one peer. Nothing is copied or
// queued here: the sender walks the version registry from the beginning and
// offers each row by key and version, and the peer asks for what it lacks. A
// peer that already holds the data therefore transfers almost nothing.
export async function startFullTransfer(peerRowId: string): Promise<void> {
  await prisma.clusterPeer.updateMany({
    where: { id: peerRowId },
    data: { scanActive: true, scanTable: null, scanHash: null },
  });
}

const CHUNK = 1_000;
const MAX_PASSES = 5_000;

// Empties a bookkeeping table in small steps, each taking only rows that no
// other transaction is using at that moment. A row that stays behind is one a
// writer is touching right now — which means it is being brought up to date
// by that writer anyway.
async function clearUnlocked(table: string, keyColumns: string[]): Promise<number> {
  const keys = keyColumns.map((column) => q(column)).join(', ');
  let removed = 0;
  let idlePasses = 0;
  for (let pass = 0; pass < MAX_PASSES && idlePasses < 2; pass++) {
    const count = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<Record<string, string>>>(
        `SELECT ${keys} FROM ${q(table)} LIMIT ${CHUNK} FOR UPDATE SKIP LOCKED`,
      );
      if (rows.length === 0) return 0;
      // One statement per row, addressed by its complete primary key: each
      // reads exactly the row locked above. (A single statement with a list
      // of keys may be executed as a scan and then wait for unrelated rows.)
      const where = keyColumns.map((column) => `${q(column)} = ?`).join(' AND ');
      for (const row of rows) {
        await tx.$executeRawUnsafe(`DELETE FROM ${q(table)} WHERE ${where}`, ...keyColumns.map((column) => row[column]));
      }
      return rows.length;
    }, { isolationLevel: 'ReadCommitted', timeout: 60_000 });
    removed += count;
    if (count === 0) {
      idlePasses++;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } else {
      idlePasses = 0;
    }
  }
  return removed;
}

// Makes this node's current data the authoritative version: every row gets a
// fresh version, and a complete transfer to every peer starts. Used after a
// database restore, where the data changed underneath the triggers.
export async function rebuildVersions(catalog: Catalog, nodeId: string): Promise<number> {
  await clearUnlocked(OUTBOX_TABLE, ['peer_id', 'table_name', 'pk_hash']);
  await prisma.clusterDeferred.deleteMany();
  await clearUnlocked(STATE_TABLE, ['table_name', 'pk_hash']);
  const registered = await backfillVersions(catalog, nodeId, 'now');
  const targets = await prisma.clusterTarget.findMany({ select: { peerId: true } });
  for (const target of targets) await startFullTransfer(target.peerId);
  logger.info('Cluster versions rebuilt', { action: 'cluster_versions_rebuilt', rows: registered, peers: targets.length });
  return registered;
}

// Removes version records of rows deleted long ago. Until then the record is
// what tells a returning peer that the row was deleted on purpose.
export async function pruneTombstones(): Promise<number> {
  const cutoff = new Date(Date.now() - config.cluster.tombstoneRetentionDays * 24 * 60 * 60 * 1000);
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRawUnsafe<Array<{ table_name: string; pk_hash: string }>>(
      `SELECT s.\`table_name\`, s.\`pk_hash\` FROM ${q(STATE_TABLE)} s `
      + 'WHERE s.`deleted` = 1 AND s.`changed_at` < ? '
      + `AND NOT EXISTS (SELECT 1 FROM ${q(OUTBOX_TABLE)} o WHERE o.\`table_name\` = s.\`table_name\` AND o.\`pk_hash\` = s.\`pk_hash\`) `
      + `LIMIT ${CHUNK} FOR UPDATE OF s SKIP LOCKED`,
      cutoff,
    );
    if (rows.length === 0) return 0;
    for (const row of rows) {
      await tx.$executeRawUnsafe(
        `DELETE FROM ${q(STATE_TABLE)} WHERE \`table_name\` = ? AND \`pk_hash\` = ?`, row.table_name, row.pk_hash,
      );
    }
    return rows.length;
  }, { isolationLevel: 'ReadCommitted', timeout: 60_000 });
}
