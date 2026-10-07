import { prisma } from '../db';
import { config } from '../config';
import { logger } from '../utils/logger';
import type { TableInfo } from './catalog';
import { encodeRow, type WireValue } from './codec';
import type { ItemResult, OfferItem, WireItem, WireTableBatch } from './protocol';
import { state, type PeerRuntime } from './runtime';
import {
  OUTBOX_TABLE,
  STATE_TABLE,
  TARGETS_TABLE,
  columnList,
  computePkHash,
  pkWhere,
  q,
  selectByPkSql,
} from './sqlgen';
import { rpc } from './transport';

// Sends this node's data to one peer. Two sources feed it:
//
//   The queue (cluster_outbox) lists rows that changed and that the peer has
//   not confirmed yet. It holds no content: a row's content is read from its
//   table at the moment of sending, so however often a row changed while a
//   peer was away, it is sent once, in its latest state.
//
//   A complete transfer walks the version registry from start to end. It runs
//   when a peer is paired, re-enabled or resynchronised, and only offers each
//   row by key and version; the peer asks for the ones it lacks.
//
// Both go through the same offer and push calls, and both can be interrupted
// at any point and continue later.

interface Entry {
  table: TableInfo;
  hash: string;
  // Queue generation the entry was read at; null for a complete transfer.
  gen: number | null;
  offerFirst: boolean;
  key: string[];
  version: bigint;
  origin: string;
  deleted: boolean;
}

interface VersionRow {
  pk_hash: string;
  pk: string | null;
  version: bigint | null;
  origin: string | null;
  deleted: number | boolean | null;
}

interface QueueRow extends VersionRow {
  gen: number;
  offer_first: number | boolean;
}

function toEntry(table: TableInfo, row: VersionRow, gen: number | null, offerFirst: boolean): Entry | null {
  if (row.pk === null || row.version === null || row.origin === null) return null;
  let key: string[];
  try {
    key = (JSON.parse(row.pk) as unknown[]).map((part) => String(part));
  } catch {
    return null;
  }
  return {
    table,
    hash: row.pk_hash,
    gen,
    offerFirst,
    key,
    version: BigInt(row.version),
    origin: row.origin,
    deleted: Boolean(Number(row.deleted)),
  };
}

// Removes confirmed entries from the queue. An entry is only removed if it is
// still at the generation that was sent — a row that changed again in the
// meantime stays queued — and only if no writer is touching it right now:
// entries are picked up with SKIP LOCKED, so this never waits for a lock, and
// an entry that is locked is being re-queued by that writer anyway.
async function acknowledge(peer: PeerRuntime, entries: Entry[]): Promise<void> {
  const byTable = new Map<string, Map<string, number>>();
  for (const entry of entries) {
    if (entry.gen === null) continue;
    const expected = byTable.get(entry.table.name) ?? new Map<string, number>();
    expected.set(entry.hash, entry.gen);
    byTable.set(entry.table.name, expected);
  }
  for (const [table, expected] of byTable) {
    const hashes = [...expected.keys()];
    for (let start = 0; start < hashes.length; start += 500) {
      const chunk = hashes.slice(start, start + 500);
      await prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRawUnsafe<Array<{ pk_hash: string; gen: number }>>(
          `SELECT \`pk_hash\`, \`gen\` FROM ${q(OUTBOX_TABLE)} FORCE INDEX (PRIMARY) WHERE \`peer_id\` = ? AND \`table_name\` = ? `
          + `AND \`pk_hash\` IN (${chunk.map(() => '?').join(', ')}) FOR UPDATE SKIP LOCKED`,
          peer.rowId, table, ...chunk,
        );
        const confirmed = rows.filter((row) => expected.get(row.pk_hash) === Number(row.gen)).map((row) => row.pk_hash);
        if (confirmed.length === 0) return;
        // One statement per row, each addressed by its complete primary key.
        // A single statement with a list of keys may be executed as a scan
        // over neighbouring rows — and would then wait for rows it has no
        // business with. Addressed exactly, each statement reads the one row
        // already locked above and nothing else.
        for (const hash of confirmed) {
          await tx.$executeRawUnsafe(
            `DELETE FROM ${q(OUTBOX_TABLE)} WHERE \`peer_id\` = ? AND \`table_name\` = ? AND \`pk_hash\` = ?`,
            peer.rowId, table, hash,
          );
        }
      }, { isolationLevel: 'ReadCommitted', timeout: 60_000 });
    }
  }
}

async function readQueue(peer: PeerRuntime, limit: number): Promise<{ entries: Entry[]; truncated: boolean }> {
  const catalog = state.catalog!;
  const pendingTables = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
    `SELECT DISTINCT \`table_name\` FROM ${q(OUTBOX_TABLE)} WHERE \`peer_id\` = ?`, peer.rowId,
  );
  const known = pendingTables
    .map((row) => catalog.tables.get(row.table_name))
    .filter((table): table is TableInfo => Boolean(table))
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  for (const row of pendingTables) {
    if (catalog.tables.has(row.table_name)) continue;
    // Queued for a table that is no longer replicated.
    await prisma.clusterOutbox.deleteMany({ where: { peerId: peer.rowId, tableName: row.table_name } });
  }

  const entries: Entry[] = [];
  let truncated = false;
  for (const table of known) {
    const remaining = limit - entries.length;
    if (remaining <= 0) { truncated = true; break; }
    const rows = await prisma.$queryRawUnsafe<QueueRow[]>(
      'SELECT o.`pk_hash`, o.`gen`, o.`offer_first`, s.`pk`, s.`version`, s.`origin`, s.`deleted` '
      + `FROM ${q(OUTBOX_TABLE)} o LEFT JOIN ${q(STATE_TABLE)} s ON s.\`table_name\` = o.\`table_name\` AND s.\`pk_hash\` = o.\`pk_hash\` `
      + 'WHERE o.`peer_id` = ? AND o.`table_name` = ? ORDER BY o.`pk_hash` LIMIT ?',
      peer.rowId, table.name, remaining + 1,
    );
    if (rows.length > remaining) {
      truncated = true;
      rows.length = remaining;
    }
    const orphaned: string[] = [];
    for (const row of rows) {
      const entry = toEntry(table, row, Number(row.gen), Boolean(Number(row.offer_first)));
      if (entry) entries.push(entry);
      else orphaned.push(row.pk_hash);
    }
    // A queue entry without a version record has nothing to send.
    for (const hash of orphaned) {
      await prisma.clusterOutbox.deleteMany({ where: { peerId: peer.rowId, tableName: table.name, pkHash: hash } });
    }
  }
  return { entries, truncated };
}

interface TransferPosition {
  table: string | null;
  hash: string | null;
}

// Reads the next stretch of the version registry for a complete transfer:
// tables in dependency order, rows within a table in key order.
async function readTransfer(position: TransferPosition, limit: number): Promise<{ entries: Entry[]; next: TransferPosition | null }> {
  const tables = state.catalog!.ordered;
  let index = position.table ? tables.findIndex((table) => table.name === position.table) : 0;
  let after = position.hash ?? '';
  if (index < 0) {
    // The table at the saved position is gone: continue with the next one.
    index = tables.findIndex((table) => table.name > (position.table ?? ''));
    after = '';
    if (index < 0) return { entries: [], next: null };
  }

  const entries: Entry[] = [];
  let next: TransferPosition | null = null;
  while (index < tables.length) {
    const table = tables[index]!;
    const rows = await prisma.$queryRawUnsafe<VersionRow[]>(
      `SELECT \`pk_hash\`, \`pk\`, \`version\`, \`origin\`, \`deleted\` FROM ${q(STATE_TABLE)} `
      + 'WHERE `table_name` = ? AND `pk_hash` > ? ORDER BY `pk_hash` LIMIT ?',
      table.name, after, limit - entries.length,
    );
    for (const row of rows) {
      const entry = toEntry(table, row, null, true);
      if (entry) entries.push(entry);
    }
    if (rows.length > 0) next = { table: table.name, hash: rows[rows.length - 1]!.pk_hash };
    if (entries.length >= limit) return { entries, next };
    index++;
    after = '';
    if (index < tables.length) next = { table: tables[index]!.name, hash: null };
  }
  return { entries, next: null };
}

// Reads the current content of the given rows. Rows are returned keyed by
// their key hash; a row that no longer exists is simply absent.
async function loadRows(table: TableInfo, entries: Entry[]): Promise<Map<string, Record<string, unknown>>> {
  const found = new Map<string, Record<string, unknown>>();
  const keyColumns = table.pk.map((column, index) => `CAST(${q(column)} AS CHAR CHARACTER SET utf8mb4) AS \`__k${index}\``).join(', ');
  for (let start = 0; start < entries.length; start += 100) {
    const chunk = entries.slice(start, start + 100);
    const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT ${columnList(table)}, ${keyColumns} FROM ${q(table.name)} WHERE ${chunk.map(() => `(${pkWhere(table)})`).join(' OR ')}`,
      ...chunk.flatMap((entry) => entry.key),
    );
    for (const row of rows) {
      found.set(computePkHash(table.pk.map((_, index) => String(row[`__k${index}`]))), row);
    }
  }
  return found;
}

// A row can disappear without its own deletion being recorded: the database
// removes dependent rows itself when their parent is deleted. Peers remove
// theirs the same way, so nothing is lost — the version registry is merely
// brought up to date here, and the deletion is queued like any other.
async function recordImplicitDeletion(entry: Entry): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const current = await tx.$queryRawUnsafe<Array<{ version: bigint; deleted: number | boolean }>>(
      `SELECT \`version\`, \`deleted\` FROM ${q(STATE_TABLE)} WHERE \`table_name\` = ? AND \`pk_hash\` = ? FOR UPDATE SKIP LOCKED`,
      entry.table.name, entry.hash,
    );
    // Not there, already recorded, changed since, or in use by a writer right
    // now: in every one of these cases there is nothing to correct.
    if (!current[0] || Boolean(Number(current[0].deleted)) || BigInt(current[0].version) !== entry.version) return;
    const row = await tx.$queryRawUnsafe<unknown[]>(selectByPkSql(entry.table, false), ...entry.key);
    if (row.length > 0) return;
    await tx.$executeRawUnsafe(
      `UPDATE ${q(STATE_TABLE)} SET \`deleted\` = 1, \`version\` = \`version\` + 1, \`origin\` = ?, \`changed_at\` = CURRENT_TIMESTAMP(3) `
      + 'WHERE `table_name` = ? AND `pk_hash` = ?',
      state.nodeId, entry.table.name, entry.hash,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO ${q(OUTBOX_TABLE)} (\`peer_id\`, \`table_name\`, \`pk_hash\`, \`gen\`, \`offer_first\`, \`queued_at\`) `
      + `SELECT \`peer_id\`, ?, ?, 0, 1, CURRENT_TIMESTAMP(3) FROM ${q(TARGETS_TABLE)} `
      + 'ON DUPLICATE KEY UPDATE `gen` = `gen` + 1, `queued_at` = VALUES(`queued_at`)',
      entry.table.name, entry.hash,
    );
  }, { isolationLevel: 'ReadCommitted' });
}

interface Outgoing {
  entry: Entry;
  item: WireItem;
  size: number;
}

async function pushChunk(peer: PeerRuntime, chunk: Outgoing[], drained: boolean): Promise<ItemResult[]> {
  const batches: WireTableBatch[] = [];
  for (const outgoing of chunk) {
    const last = batches[batches.length - 1];
    if (last && last.t === outgoing.entry.table.name) {
      last.items.push(outgoing.item);
    } else {
      batches.push({
        t: outgoing.entry.table.name,
        cols: outgoing.entry.table.columns.map((column) => column.name),
        items: [outgoing.item],
      });
    }
  }
  const reply = await rpc<{ results: string }>(peer, 'push', { batches, drained }, config.cluster.syncTimeoutMs);
  const results = [...String(reply.results ?? '')] as ItemResult[];
  if (results.length !== chunk.length) throw new Error('peer acknowledged a different number of rows than were sent');
  return results;
}

interface Delivery {
  // Entries the peer has taken responsibility for (or declined as known).
  settled: Entry[];
  rejected: number;
  // True when the last call already told the peer that nothing is left.
  announcedDrained: boolean;
}

// Offers and pushes a set of entries. `drainedAfter` says whether, once these
// are delivered, this node has nothing further for the peer.
async function deliver(peer: PeerRuntime, entries: Entry[], drainedAfter: boolean): Promise<Delivery> {
  const settled: Entry[] = [];

  // Rows that reached this node from elsewhere, and rows of a complete
  // transfer, are offered by key and version first; the peer answers with
  // what it lacks. Rows changed here are sent straight away.
  let toSend = entries.filter((entry) => !entry.offerFirst);
  const offered = entries.filter((entry) => entry.offerFirst);
  if (offered.length > 0) {
    const items: OfferItem[] = offered.map((entry) => [
      entry.table.name, entry.hash, entry.version.toString(), entry.origin, entry.deleted ? 1 : 0,
    ]);
    const reply = await rpc<{ want: number[] }>(peer, 'offer', { items }, config.cluster.syncTimeoutMs);
    const wanted = new Set((reply.want ?? []).filter((index) => Number.isInteger(index)));
    offered.forEach((entry, index) => {
      if (wanted.has(index)) toSend.push(entry);
      else settled.push(entry);
    });
  }

  // Keep the dependency order the entries were read in.
  const order = new Map(entries.map((entry, index) => [entry, index]));
  toSend = toSend.sort((a, b) => order.get(a)! - order.get(b)!);

  const byTable = new Map<TableInfo, Entry[]>();
  for (const entry of toSend) {
    if (entry.deleted) continue;
    const list = byTable.get(entry.table) ?? [];
    list.push(entry);
    byTable.set(entry.table, list);
  }
  const rows = new Map<Entry, Record<string, unknown>>();
  for (const [table, list] of byTable) {
    const found = await loadRows(table, list);
    for (const entry of list) {
      const row = found.get(entry.hash);
      if (row) rows.set(entry, row);
    }
  }

  const outgoing: Outgoing[] = [];
  const unsendable: string[] = [];
  for (const entry of toSend) {
    const base = { h: entry.hash, k: entry.key, v: entry.version.toString(), o: entry.origin };
    if (entry.deleted) {
      outgoing.push({ entry, item: { ...base, d: 1 }, size: 200 });
      continue;
    }
    const row = rows.get(entry);
    if (!row) {
      await recordImplicitDeletion(entry);
      // During a complete transfer the walk simply moves on; a queue entry
      // stays until the recorded deletion replaces it.
      if (entry.gen === null) settled.push(entry);
      continue;
    }
    let encoded: WireValue[];
    try {
      encoded = encodeRow(entry.table.codec, row);
    } catch (err) {
      unsendable.push(`a ${entry.table.name} row could not be encoded (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    const size = JSON.stringify(encoded).length + 200;
    if (size > config.cluster.maxMessageBytes - 65_536) {
      unsendable.push(`a ${entry.table.name} row is larger than CLUSTER_MAX_MESSAGE_BYTES`);
      continue;
    }
    outgoing.push({ entry, item: { ...base, d: 0, r: encoded }, size });
  }

  // A row that cannot be sent stays where it is and is reported: skipping it
  // silently would leave the peer permanently without it.
  let rejected = unsendable.length;
  if (unsendable.length > 0) {
    logger.warn('Cluster rows could not be sent', { action: 'cluster_rows_unsendable', peer: peer.nodeId, reasons: unsendable.slice(0, 5) });
  }
  let announcedDrained = false;
  const sizeLimit = Math.floor(config.cluster.maxMessageBytes / 4);
  let cursor = 0;
  while (cursor < outgoing.length) {
    let size = 0;
    let end = cursor;
    while (end < outgoing.length && (end === cursor || size + outgoing[end]!.size <= sizeLimit)) {
      size += outgoing[end]!.size;
      end++;
    }
    const chunk = outgoing.slice(cursor, end);
    // Only the final call of a round that leaves nothing behind may say so.
    const drained = drainedAfter && end === outgoing.length;
    const results = await pushChunk(peer, chunk, drained);
    announcedDrained = drained;
    results.forEach((result, index) => {
      if (result === 'r') rejected++;
      else settled.push(chunk[index]!.entry);
    });
    peer.rowsSent += results.filter((result) => result === 'a').length;
    cursor = end;
  }
  return { settled, rejected, announcedDrained };
}

async function transferState(peer: PeerRuntime): Promise<{ active: boolean; position: TransferPosition }> {
  const row = await prisma.clusterPeer.findUnique({
    where: { id: peer.rowId },
    select: { scanActive: true, scanTable: true, scanHash: true },
  });
  return { active: Boolean(row?.scanActive), position: { table: row?.scanTable ?? null, hash: row?.scanHash ?? null } };
}

// One round of sending. Returns true when more is waiting.
export async function syncPeer(peer: PeerRuntime): Promise<boolean> {
  const transfer = await transferState(peer);
  const { entries, truncated } = await readQueue(peer, config.cluster.batchSize);

  let announcedDrained = false;
  if (entries.length > 0) {
    const delivery = await deliver(peer, entries, !truncated && !transfer.active);
    await acknowledge(peer, delivery.settled);
    if (delivery.rejected > 0) throw new Error(`${delivery.rejected} row(s) were rejected by the peer (schema difference, or a row too large to send)`);
    announcedDrained = delivery.announcedDrained;
  }

  let transferContinues = false;
  if (transfer.active && !truncated) {
    const step = await readTransfer(transfer.position, config.cluster.batchSize);
    transferContinues = step.next !== null;
    const delivery = step.entries.length > 0
      ? await deliver(peer, step.entries, !transferContinues && !(await hasQueuedRows(peer)))
      : { settled: [], rejected: 0, announcedDrained: false };
    // A rejected row stops the walk at its current position; it is retried.
    if (delivery.rejected > 0) throw new Error(`${delivery.rejected} row(s) were rejected by the peer (schema difference, or a row too large to send)`);
    announcedDrained = delivery.announcedDrained;
    await prisma.clusterPeer.updateMany({
      where: { id: peer.rowId, scanActive: true },
      data: step.next
        ? { scanTable: step.next.table, scanHash: step.next.hash }
        : { scanActive: false, scanTable: null, scanHash: null },
    });
    if (!transferContinues) {
      logger.info('Cluster complete transfer finished', { action: 'cluster_transfer_finished', peer: peer.nodeId });
    }
  } else if (transfer.active) {
    transferContinues = true;
  }

  const more = truncated || transferContinues;
  if (!more && !announcedDrained && (entries.length > 0 || transfer.active) && !(await hasQueuedRows(peer))) {
    // Nothing needed sending in the end, but the peer still learns that this
    // node has nothing further for it.
    await rpc(peer, 'push', { batches: [], drained: true }, config.cluster.syncTimeoutMs);
  }
  return more;
}

export async function hasQueuedRows(peer: PeerRuntime): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<unknown[]>(
    `SELECT 1 FROM ${q(OUTBOX_TABLE)} WHERE \`peer_id\` = ? LIMIT 1`, peer.rowId,
  );
  return rows.length > 0;
}

// True while this node still has anything to deliver to the peer.
export async function hasPendingWork(peer: PeerRuntime): Promise<boolean> {
  if (await hasQueuedRows(peer)) return true;
  return (await transferState(peer)).active;
}

export async function queuedCounts(): Promise<Map<string, number>> {
  const rows = await prisma.$queryRawUnsafe<Array<{ peer_id: string; c: bigint }>>(
    `SELECT \`peer_id\`, COUNT(*) AS c FROM ${q(OUTBOX_TABLE)} GROUP BY \`peer_id\``,
  );
  return new Map(rows.map((row) => [row.peer_id, Number(row.c)]));
}
