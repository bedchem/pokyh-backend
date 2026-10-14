import { prisma } from '../db';
import { config } from '../config';
import { logger } from '../utils/logger';
import { isNewer } from './codec';
import {
  digestReplySchema,
  digestRequestSchema,
  rowsReplySchema,
  rowsRequestSchema,
} from './protocol';
import { offerRows, type VersionRow } from './replicator';
import { nowMicros, recordEvent, state, type PeerRuntime } from './runtime';
import { STATE_TABLE, q } from './sqlgen';
import { rpc } from './transport';

// The nodes check each other: every CLUSTER_VERIFY_INTERVAL_MINUTES a node
// compares the version records of all its data with each peer and offers the
// peer whatever it holds in a newer version (the peer does the same in its
// own check, so both directions are covered). Whatever might have slipped
// through — a crash at an unlucky moment, a change made underneath the
// application, a bug — is found and repaired by itself.
//
// The comparison is cheap. Both sides summarise their records per table as a
// count and an XOR of per-row hashes; only a table whose summary differs is
// split by the first characters of the key hash, and only a small group that
// still differs is compared row by row. A node holding the same data as its
// peer exchanges a few dozen numbers. Everything here only reads.

const GROUP_ROWS_LIMIT = 2_000;
const MAX_PREFIX = 4;
const ROWS_LIMIT = 20_000;

type Group = [string, number, string];

// Tombstones that may already be pruned on one side are left out on both:
// those older than half the retention period, by their version (a time both
// sides share).
function verifyFloor(): bigint {
  return nowMicros() - BigInt(config.cluster.tombstoneRetentionDays) * 12n * 60n * 60n * 1_000_000n;
}

const ROW_HASH = "CAST(CONV(SUBSTRING(SHA2(CONCAT(`pk_hash`, ':', `version`, ':', `origin`, ':', `deleted`), 256), 1, 16), 16, 10) AS UNSIGNED)";

export async function localDigest(table: string | null, prefix: string, floor: bigint): Promise<Group[]> {
  const catalog = state.catalog;
  if (!catalog) return [];
  if (table === null) {
    const tables = catalog.ordered.map((info) => info.name);
    if (tables.length === 0) return [];
    const rows = await prisma.$queryRawUnsafe<Array<{ g: string; c: bigint; x: string | null }>>(
      `SELECT \`table_name\` AS g, COUNT(*) AS c, CAST(BIT_XOR(${ROW_HASH}) AS CHAR) AS x FROM ${q(STATE_TABLE)} `
      + `WHERE \`table_name\` IN (${tables.map(() => '?').join(', ')}) AND NOT (\`deleted\` = 1 AND \`version\` < ?) GROUP BY \`table_name\``,
      ...tables, floor,
    );
    return rows.map((row) => [row.g, Number(row.c), row.x ?? '0']);
  }
  if (!catalog.tables.has(table)) return [];
  const rows = await prisma.$queryRawUnsafe<Array<{ g: string; c: bigint; x: string | null }>>(
    `SELECT SUBSTRING(\`pk_hash\`, 1, ?) AS g, COUNT(*) AS c, CAST(BIT_XOR(${ROW_HASH}) AS CHAR) AS x FROM ${q(STATE_TABLE)} `
    + 'WHERE `table_name` = ? AND `pk_hash` LIKE ? AND NOT (`deleted` = 1 AND `version` < ?) GROUP BY g',
    prefix.length + 1, table, `${prefix}%`, floor,
  );
  return rows.map((row) => [row.g, Number(row.c), row.x ?? '0']);
}

interface LocalRow extends VersionRow {
  version: bigint;
  origin: string;
}

async function localRows(table: string, prefix: string, floor: bigint): Promise<LocalRow[]> {
  return prisma.$queryRawUnsafe<LocalRow[]>(
    `SELECT \`pk_hash\`, \`pk\`, \`version\`, \`origin\`, \`deleted\` FROM ${q(STATE_TABLE)} `
    + 'WHERE `table_name` = ? AND `pk_hash` LIKE ? AND NOT (`deleted` = 1 AND `version` < ?) ORDER BY `pk_hash` LIMIT ?',
    table, `${prefix}%`, floor, ROWS_LIMIT,
  );
}

// ─── Answering a peer ────────────────────────────────────────────────────────

export async function handleDigest(params: unknown): Promise<{ groups: Group[] }> {
  const input = digestRequestSchema.parse(params);
  return { groups: await localDigest(input.t, input.p, BigInt(input.floor)) };
}

export async function handleRows(params: unknown): Promise<{ rows: Array<[string, string, string, 0 | 1]>; truncated: boolean }> {
  const input = rowsRequestSchema.parse(params);
  if (!state.catalog?.tables.has(input.t)) return { rows: [], truncated: false };
  const rows = await localRows(input.t, input.p, BigInt(input.floor));
  return {
    rows: rows.map((row) => [row.pk_hash, String(row.version), row.origin, Number(row.deleted) ? 1 : 0]),
    truncated: rows.length >= ROWS_LIMIT,
  };
}

// ─── Checking a peer ─────────────────────────────────────────────────────────

const sameGroup = (a: Group | undefined, b: Group | undefined): boolean => Boolean(a && b && a[1] === b[1] && a[2] === b[2]);

async function compareRows(peer: PeerRuntime, table: string, prefix: string, floor: bigint): Promise<number> {
  const info = state.catalog?.tables.get(table);
  if (!info) return 0;
  const remote = rowsReplySchema.parse(await rpc(peer, 'verify.rows', { t: table, p: prefix, floor: floor.toString() }, config.cluster.syncTimeoutMs));
  const theirs = new Map(remote.rows.map(([hash, version, origin]) => [hash, { version: BigInt(version), origin }]));
  const local = await localRows(table, prefix, floor);
  const newer = local.filter((row) => isNewer({ version: BigInt(row.version), origin: row.origin }, theirs.get(row.pk_hash) ?? null));
  if (newer.length === 0) return 0;
  return offerRows(peer, info, newer);
}

async function descend(peer: PeerRuntime, table: string, prefix: string, floor: bigint, counts: { local: number; remote: number }): Promise<number> {
  if (counts.local + counts.remote <= GROUP_ROWS_LIMIT || prefix.length >= MAX_PREFIX) {
    return compareRows(peer, table, prefix, floor);
  }
  const remote = digestReplySchema.parse(await rpc(peer, 'verify.digest', { t: table, p: prefix, floor: floor.toString() }, config.cluster.syncTimeoutMs));
  const theirs = new Map(remote.groups.map((group) => [group[0], group]));
  const ours = new Map((await localDigest(table, prefix, floor)).map((group) => [group[0], group]));
  let repaired = 0;
  for (const name of new Set([...ours.keys(), ...theirs.keys()])) {
    const mine = ours.get(name);
    if (!mine || sameGroup(mine, theirs.get(name))) continue;
    repaired += await descend(peer, table, name, floor, { local: mine[1], remote: theirs.get(name)?.[1] ?? 0 });
  }
  return repaired;
}

// Compares everything with one peer and sends it what it is missing.
export async function verifyPeer(peer: PeerRuntime): Promise<number> {
  if (peer.verify.running) return 0;
  peer.verify.running = true;
  const floor = verifyFloor();
  try {
    const remote = digestReplySchema.parse(await rpc(peer, 'verify.digest', { t: null, p: '', floor: floor.toString() }, config.cluster.syncTimeoutMs));
    const theirs = new Map(remote.groups.map((group) => [group[0], group]));
    let repaired = 0;
    for (const mine of await localDigest(null, '', floor)) {
      if (sameGroup(mine, theirs.get(mine[0]))) continue;
      repaired += await descend(peer, mine[0], '', floor, { local: mine[1], remote: theirs.get(mine[0])?.[1] ?? 0 });
    }
    peer.verify.lastAt = Date.now();
    peer.verify.repaired = repaired;
    peer.verify.lastError = null;
    await prisma.clusterPeer.updateMany({ where: { id: peer.rowId }, data: { lastVerifiedAt: new Date() } });
    if (repaired > 0) {
      recordEvent('warn', `Data check with ${peer.name || peer.baseUrl}: ${repaired} row(s) differed and were sent`);
      logger.warn('Cluster data check repaired rows', { action: 'cluster_verify_repaired', peer: peer.nodeId, rows: repaired });
    }
    return repaired;
  } catch (err) {
    peer.verify.lastError = err instanceof Error ? err.message.split('\n')[0]!.slice(0, 300) : String(err);
    logger.warn('Cluster data check failed', { action: 'cluster_verify_failed', peer: peer.nodeId, message: peer.verify.lastError });
    return 0;
  } finally {
    peer.verify.running = false;
  }
}
