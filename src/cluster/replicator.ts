import { prisma } from '../db';
import { config } from '../config';
import { logger } from '../utils/logger';
import type { TableInfo } from './catalog';
import { encodeRow, type WireValue } from './codec';
import type { ItemResult, OfferItem, WireItem, WireTableBatch } from './protocol';
import { state, type PeerRuntime } from './runtime';
import { STATE_TABLE, columnList, computePkHash, pkWhere, q, selectByPkSql } from './sqlgen';
import { rpc } from './transport';

// Sends this node's data to one peer. Two sources feed it:
//
//   The change feed. Every change moves its row's version record to the end
//   of cluster_row_state ordered by `seq`. Each peer has a read position in
//   that order; a round reads what lies beyond it and delivers it. Nothing is
//   written per change and peer — only the position, once per package — and
//   a row that changed many times while a peer was away is read once, in its
//   latest state.
//
//   A complete transfer walks the version registry table by table. It runs
//   when a peer is paired, re-enabled or resynchronised, and only offers each
//   row by key and version; the peer asks for the ones it lacks.
//
// Both go through the same offer and push calls, and both can be interrupted
// at any point and continue later.
//
// Batching is adaptive: a change goes out once the feed has been quiet for
// CLUSTER_BATCH_IDLE_MS; while changes keep coming they are collected for at
// most CLUSTER_BATCH_MAX_DELAY_MS, or until a package is full, and then sent
// as one compressed call.

interface Entry {
  table: TableInfo;
  hash: string;
  // Position in the feed; null for a complete transfer.
  seq: bigint | null;
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

interface FeedRow extends VersionRow {
  table_name: string;
  via: string | null;
  seq: bigint;
}

function toEntry(table: TableInfo, row: VersionRow, seq: bigint | null, offerFirst: boolean): Entry | null {
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
    seq,
    offerFirst,
    key,
    version: BigInt(row.version),
    origin: row.origin,
    deleted: Boolean(Number(row.deleted)),
  };
}

const feedKey = (table: string, hash: string): string => `${table}|${hash}`;

// ─── Commit horizon ──────────────────────────────────────────────────────────
// A position is taken when a change is recorded, but becomes visible only when
// its transaction commits — possibly after changes with later positions. A
// read position must therefore not be stored past changes that might still
// commit. Samples of the newest position are kept for one horizon: every
// position seen at least CLUSTER_COMMIT_HORIZON_MS ago belongs to a
// transaction that has finished by now.

const samples: Array<{ at: number; seq: bigint }> = [];

export function noteFeedHead(seq: bigint): void {
  const now = Date.now();
  const last = samples[samples.length - 1];
  if (last && last.seq === seq && now - last.at < 1_000) return;
  samples.push({ at: now, seq });
  const keepFrom = now - config.cluster.commitHorizonMs - 10_000;
  while (samples.length > 2 && samples[1]!.at < keepFrom) samples.shift();
}

// The newest position below which every change is committed.
export function stableFeedPosition(): bigint {
  const limit = Date.now() - config.cluster.commitHorizonMs;
  let stable: bigint | null = null;
  for (const sample of samples) {
    if (sample.at > limit) break;
    stable = sample.seq;
  }
  // Right after start-up nothing is old enough yet. The position at start-up
  // is safe: no transaction of this process was open before it started.
  return stable ?? state.startupSeq;
}

export async function readFeedHead(): Promise<bigint> {
  const rows = await prisma.$queryRawUnsafe<Array<{ m: bigint | null }>>(`SELECT MAX(\`seq\`) AS m FROM ${q(STATE_TABLE)}`);
  const head = BigInt(rows[0]?.m ?? 0);
  noteFeedHead(head);
  return head;
}

// ─── Reading ─────────────────────────────────────────────────────────────────

// Re-reading the span between the stored position and the read position
// catches a change that committed late. It is cheap — rows already delivered
// are recognised by version — but not free, so it runs now and then.
const SWEEP_EVERY_MS = 30_000;

async function readFeed(peer: PeerRuntime, from: bigint, limit: number): Promise<{ rows: FeedRow[]; truncated: boolean }> {
  const rows = await prisma.$queryRawUnsafe<FeedRow[]>(
    `SELECT \`table_name\`, \`pk_hash\`, \`pk\`, \`version\`, \`origin\`, \`via\`, \`deleted\`, \`seq\` FROM ${q(STATE_TABLE)} `
    + 'WHERE `seq` > ? ORDER BY `seq` LIMIT ?',
    from, limit + 1,
  );
  const truncated = rows.length > limit;
  if (truncated) rows.length = limit;
  return { rows, truncated };
}

interface FeedBatch {
  entries: Entry[];
  // Furthest position covered by this read.
  readTo: bigint;
  truncated: boolean;
  // Rows skipped because the peer has them (its own changes, ones it sent us).
  skipped: Array<{ key: string; version: bigint; seq: bigint }>;
}

async function nextFeedBatch(peer: PeerRuntime, from: bigint): Promise<FeedBatch> {
  const catalog = state.catalog!;
  const { rows, truncated } = await readFeed(peer, from, config.cluster.batchSize);
  const entries: Entry[] = [];
  const skipped: FeedBatch['skipped'] = [];
  let readTo = from;
  for (const row of rows) {
    const seq = BigInt(row.seq);
    if (seq > readTo) readTo = seq;
    const table = catalog.tables.get(row.table_name);
    if (!table || row.version === null) continue;
    const key = feedKey(row.table_name, row.pk_hash);
    const version = BigInt(row.version);
    const known = peer.feed.sent.get(key);
    if (known && known.version === version) continue;
    // The peer wrote this version itself or handed it to us: it has it.
    if (row.origin === peer.nodeId || row.via === peer.nodeId) {
      skipped.push({ key, version, seq });
      continue;
    }
    // Changes made here are sent outright; changes that reached this node
    // from elsewhere, and anything recorded before this process started
    // (which may have gone out already), are offered by version first.
    const offerFirst = row.origin !== state.nodeId || seq <= state.startupSeq;
    const entry = toEntry(table, row, seq, offerFirst);
    if (entry) entries.push(entry);
  }
  return { entries, readTo, truncated, skipped };
}

// ─── Complete transfer ───────────────────────────────────────────────────────

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

// ─── Delivering ──────────────────────────────────────────────────────────────

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
// brought up to date here, which also puts the deletion into the feed.
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
      `UPDATE ${q(STATE_TABLE)} SET \`deleted\` = 1, \`version\` = \`version\` + 1, \`origin\` = ?, \`via\` = NULL, `
      + '`changed_at` = CURRENT_TIMESTAMP(3), `seq` = UUID_SHORT() WHERE `table_name` = ? AND `pk_hash` = ?',
      state.nodeId, entry.table.name, entry.hash,
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
  // Entries that could not be delivered this time and have to be tried again.
  unsettled: Entry[];
  // True when the last call already told the peer that nothing is left.
  announcedDrained: boolean;
}

// Offers and pushes a set of entries. `drainedAfter` says whether, once these
// are delivered, this node has nothing further for the peer.
export async function deliver(peer: PeerRuntime, entries: Entry[], drainedAfter: boolean): Promise<Delivery> {
  const settled: Entry[] = [];
  const unsettled: Entry[] = [];

  // Rows that reached this node from elsewhere, and rows of a complete
  // transfer, are offered by key and version first; the peer answers with
  // what it lacks. Rows changed here are sent straight away.
  let toSend = entries.filter((entry) => !entry.offerFirst);
  const offered = entries.filter((entry) => entry.offerFirst);
  for (let start = 0; start < offered.length; start += 2_000) {
    const chunk = offered.slice(start, start + 2_000);
    const items: OfferItem[] = chunk.map((entry) => [
      entry.table.name, entry.hash, entry.version.toString(), entry.origin, entry.deleted ? 1 : 0,
    ]);
    const reply = await rpc<{ want: number[] }>(peer, 'offer', { items }, config.cluster.syncTimeoutMs);
    const wanted = new Set((reply.want ?? []).filter((index) => Number.isInteger(index)));
    chunk.forEach((entry, index) => {
      if (wanted.has(index)) toSend.push(entry);
      else settled.push(entry);
    });
  }

  // Keep the order the entries were read in (parents before children in a
  // complete transfer, oldest change first in the feed).
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
      // Gone without its deletion being recorded. Recording it now puts the
      // deletion at the end of the feed, where it is picked up next.
      await recordImplicitDeletion(entry);
      settled.push(entry);
      continue;
    }
    let encoded: WireValue[];
    try {
      encoded = encodeRow(entry.table.codec, row);
    } catch (err) {
      unsendable.push(`a ${entry.table.name} row could not be encoded (${err instanceof Error ? err.message : String(err)})`);
      unsettled.push(entry);
      continue;
    }
    const size = JSON.stringify(encoded).length + 200;
    if (size > config.cluster.maxMessageBytes - 65_536) {
      unsendable.push(`a ${entry.table.name} row is larger than CLUSTER_MAX_MESSAGE_BYTES`);
      unsettled.push(entry);
      continue;
    }
    outgoing.push({ entry, item: { ...base, d: 0, r: encoded }, size });
  }

  // A row that cannot be sent stays where it is and is reported: skipping it
  // silently would leave the peer permanently without it.
  if (unsendable.length > 0) {
    logger.warn('Cluster rows could not be sent', { action: 'cluster_rows_unsendable', peer: peer.nodeId, reasons: unsendable.slice(0, 5) });
  }
  let announcedDrained = false;
  const sizeLimit = Math.floor(config.cluster.maxMessageBytes / 2);
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
    const drained = drainedAfter && end === outgoing.length && unsettled.length === 0;
    const results = await pushChunk(peer, chunk, drained);
    announcedDrained = drained;
    results.forEach((result, index) => {
      if (result === 'r') unsettled.push(chunk[index]!.entry);
      else settled.push(chunk[index]!.entry);
    });
    peer.rowsSent += results.filter((result) => result === 'a').length;
    cursor = end;
  }
  return { settled, unsettled, announcedDrained };
}

// ─── Feed position ───────────────────────────────────────────────────────────
// Reading moves `readTo` forward as rows are delivered. The stored position
// (`cursor`) moves only at the end of a sweep: a pass over everything from
// the stored position up to where reading had got to, which picks up any
// change that committed after reading had passed its position. When a sweep
// completes, every change up to the commit horizon at its start has been seen
// and delivered, so the position may move there — one small write about every
// half minute, however many rows went out.

function remember(peer: PeerRuntime, batch: FeedBatch, delivery: Delivery | null): bigint | null {
  const feed = peer.feed;
  for (const entry of delivery?.settled ?? []) {
    if (entry.seq !== null) feed.sent.set(feedKey(entry.table.name, entry.hash), { version: entry.version, seq: entry.seq });
  }
  for (const skip of batch.skipped) feed.sent.set(skip.key, { version: skip.version, seq: skip.seq });
  return (delivery?.unsettled ?? []).reduce<bigint | null>(
    (min, entry) => (entry.seq !== null && (min === null || entry.seq < min) ? entry.seq : min), null,
  );
}

async function moveCursor(peer: PeerRuntime, target: bigint): Promise<void> {
  const feed = peer.feed;
  if (target <= feed.cursor) return;
  feed.cursor = target;
  for (const [key, sent] of feed.sent) {
    if (sent.seq <= target) feed.sent.delete(key);
  }
  feed.lastPersistAt = Date.now();
  await prisma.clusterPeer.updateMany({ where: { id: peer.rowId, sentSeq: { lt: target } }, data: { sentSeq: target } });
}

// ─── One round ───────────────────────────────────────────────────────────────

async function transferState(peer: PeerRuntime): Promise<{ active: boolean; position: TransferPosition }> {
  const row = await prisma.clusterPeer.findUnique({
    where: { id: peer.rowId },
    select: { scanActive: true, scanTable: true, scanHash: true },
  });
  return { active: Boolean(row?.scanActive), position: { table: row?.scanTable ?? null, hash: row?.scanHash ?? null } };
}

// Whether to send what has accumulated now or to wait for more.
function shouldSendNow(peer: PeerRuntime, batch: FeedBatch, head: bigint): boolean {
  const now = Date.now();
  const feed = peer.feed;
  if (batch.entries.length === 0) {
    feed.pendingSince = null;
    return false;
  }
  if (batch.truncated) return true;
  if (feed.pendingSince === null) feed.pendingSince = now;
  const quietFor = now - feed.lastNewAt;
  const waitingFor = now - feed.pendingSince;
  // Everything up to the newest change is in hand and the feed has been quiet
  // long enough, or the oldest change has waited long enough.
  const allInHand = head <= batch.readTo;
  return (allInHand && quietFor >= config.cluster.batchIdleMs) || waitingFor >= config.cluster.batchMaxDelayMs;
}

async function sendFeedBatch(peer: PeerRuntime, batch: FeedBatch, drainedAfter: boolean): Promise<Delivery> {
  const delivery = await deliver(peer, batch.entries, drainedAfter);
  const firstUnsettled = remember(peer, batch, delivery);
  const feed = peer.feed;
  if (firstUnsettled !== null) {
    // Reading resumes just before the row that has to be retried.
    if (feed.readTo >= firstUnsettled) feed.readTo = firstUnsettled - 1n;
    throw new Error(`${delivery.unsettled.length} row(s) were rejected by the peer (schema difference, or a row too large to send)`);
  }
  return delivery;
}

// One step of the sweep (see above). Returns true while it is not finished.
async function sweepStep(peer: PeerRuntime): Promise<boolean> {
  const feed = peer.feed;
  if (!feed.sweep) feed.sweep = { pos: feed.cursor, until: feed.readTo, stable: stableFeedPosition() };
  const sweep = feed.sweep;
  const batch = await nextFeedBatch(peer, sweep.pos);
  if (batch.entries.length > 0) await sendFeedBatch(peer, batch, false);
  else remember(peer, batch, null);
  sweep.pos = batch.readTo;
  if (batch.truncated && sweep.pos < sweep.until) return true;
  feed.sweep = null;
  feed.lastSweepAt = Date.now();
  const target = sweep.stable < sweep.until ? sweep.stable : sweep.until;
  await moveCursor(peer, target);
  return false;
}

// One round of sending. Returns true when more is waiting right away.
export async function syncPeer(peer: PeerRuntime, head: bigint): Promise<boolean> {
  const feed = peer.feed;
  if (head > feed.lastHead) {
    feed.lastNewAt = Date.now();
    feed.lastHead = head;
  }
  const transfer = await transferState(peer);
  peer.transferActive = transfer.active;

  let announcedDrained = false;
  let more = false;
  const batch = await nextFeedBatch(peer, feed.readTo);
  if (shouldSendNow(peer, batch, head)) {
    const delivery = await sendFeedBatch(peer, batch, !batch.truncated && !transfer.active);
    if (batch.readTo > feed.readTo) feed.readTo = batch.readTo;
    feed.pendingSince = null;
    announcedDrained = delivery.announcedDrained;
    more = batch.truncated;
  } else if (batch.entries.length === 0) {
    // Only rows the peer already has: reading may move on.
    remember(peer, batch, null);
    if (batch.readTo > feed.readTo) feed.readTo = batch.readTo;
    more = batch.truncated;
  }

  if (feed.sweep || Date.now() - feed.lastSweepAt > SWEEP_EVERY_MS) {
    if (await sweepStep(peer)) more = true;
  }

  let transferContinues = false;
  if (transfer.active) {
    const step = await readTransfer(transfer.position, config.cluster.batchSize);
    transferContinues = step.next !== null;
    const delivery = step.entries.length > 0
      ? await deliver(peer, step.entries, !transferContinues && head <= feed.readTo)
      : { settled: [], unsettled: [], announcedDrained: false };
    // A rejected row stops the walk at its current position; it is retried.
    if (delivery.unsettled.length > 0) throw new Error(`${delivery.unsettled.length} row(s) were rejected by the peer (schema difference, or a row too large to send)`);
    announcedDrained = delivery.announcedDrained;
    await prisma.clusterPeer.updateMany({
      where: { id: peer.rowId, scanActive: true },
      data: step.next
        ? { scanTable: step.next.table, scanHash: step.next.hash }
        : { scanActive: false, scanTable: null, scanHash: null },
    });
    if (!transferContinues) {
      peer.transferActive = false;
      logger.info('Cluster complete transfer finished', { action: 'cluster_transfer_finished', peer: peer.nodeId });
    }
  }

  const caughtUp = !more && !transferContinues && head <= feed.readTo && feed.pendingSince === null;
  if (announcedDrained) {
    feed.drainAnnouncedAt = Date.now();
  } else if (caughtUp && feed.drainAnnouncedAt < feed.lastNewAt) {
    // Nothing needed sending in the end, but the peer still learns that this
    // node has nothing further for it.
    await rpc(peer, 'push', { batches: [], drained: true }, config.cluster.syncTimeoutMs);
    feed.drainAnnouncedAt = Date.now();
  }
  return more || transferContinues;
}

// Offers rows by version (used by the data check): the peer asks for those it
// lacks or holds in an older version. Returns how many it asked for.
export async function offerRows(peer: PeerRuntime, table: TableInfo, rows: VersionRow[]): Promise<number> {
  const entries = rows
    .map((row) => toEntry(table, row, null, true))
    .filter((entry): entry is Entry => entry !== null);
  if (entries.length === 0) return 0;
  const before = peer.rowsSent;
  await deliver(peer, entries, false);
  return peer.rowsSent - before;
}

export type { VersionRow };

// True while this node still has anything to deliver to the peer. The peer
// relies on this: only once a sender has nothing further does it give up on a
// change whose parent row never arrived.
export function hasPendingWork(peer: PeerRuntime, head: bigint): boolean {
  return peer.transferActive || head > peer.feed.readTo || peer.feed.pendingSince !== null || peer.feed.sweep !== null;
}

// Changes in the feed that the peer has not received yet (an upper bound:
// rows it already holds are only recognised while sending). Counted up to a
// cap, so a peer that was away for long does not make every status call scan
// its whole backlog.
export const PENDING_COUNT_CAP = 100_000;

export async function pendingCount(peer: PeerRuntime): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ c: bigint }>>(
    `SELECT COUNT(*) AS c FROM (SELECT 1 FROM ${q(STATE_TABLE)} WHERE \`seq\` > ? LIMIT ${PENDING_COUNT_CAP}) pending`, peer.feed.readTo,
  );
  return Number(rows[0]?.c ?? 0);
}
