import { createHash } from 'crypto';

// SQL text generation for change capture and row transfer. Pure functions over
// a table description — no database access — so the generated statements can
// be inspected and tested directly.
//
// Identifiers always originate from information_schema and are additionally
// restricted to a conservative character set before they are ever placed into
// SQL text; values are always bound as parameters, never interpolated.

export interface SqlColumn {
  name: string;
  dataType: string;
}

export interface SqlTable {
  name: string;
  columns: SqlColumn[];
  pk: string[];
}

const IDENTIFIER = /^[A-Za-z0-9_]+$/;

export function isSafeIdentifier(name: string): boolean {
  return IDENTIFIER.test(name) && name.length <= 64;
}

export function q(identifier: string): string {
  if (!isSafeIdentifier(identifier)) throw new Error(`unsafe SQL identifier: ${identifier}`);
  return `\`${identifier}\``;
}

const STRING_TYPES = new Set([
  'char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext', 'enum', 'set',
]);

// The bookkeeping table the capture triggers write: one row per replicated
// data row, holding its version and its position in the change feed.
export const STATE_TABLE = 'cluster_row_state';
// Tables of the previous design (one queue entry per change and peer). They
// are no longer written and are removed once no trigger refers to them.
export const LEGACY_TABLES = ['cluster_outbox', 'cluster_targets'] as const;
// Set on the dedicated connection that applies changes received from a peer;
// the triggers stay silent for it so an applied change is not captured again
// as if it had been made locally.
export const APPLY_FLAG = '@pokyh_cluster_apply';

const PK_SEPARATOR = '\x1f';
const MICROS_NOW = "TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', UTC_TIMESTAMP(6))";

function pkPart(ref: string, column: string): string {
  const source = ref ? `${ref}.${q(column)}` : q(column);
  return `CAST(${source} AS CHAR CHARACTER SET utf8mb4)`;
}

// SHA-256 over the primary-key values, joined with a separator that cannot
// occur in an identifier. Mirrored exactly by computePkHash() below.
export function pkHashExpr(ref: string, pk: string[]): string {
  return `SHA2(CONCAT_WS(0x1F, ${pk.map((column) => pkPart(ref, column)).join(', ')}), 256)`;
}

export function pkJsonExpr(ref: string, pk: string[]): string {
  return `JSON_ARRAY(${pk.map((column) => pkPart(ref, column)).join(', ')})`;
}

export function computePkHash(pkValues: string[]): string {
  return createHash('sha256').update(Buffer.from(pkValues.join(PK_SEPARATOR), 'utf8')).digest('hex');
}

// Text columns compare case- and accent-insensitively under the default
// collation. A change that only alters capitalisation is still a change and
// must be captured, so text is compared byte for byte.
function unchangedExpr(column: SqlColumn): string {
  const name = q(column.name);
  if (STRING_TYPES.has(column.dataType.toLowerCase())) {
    return `CAST(OLD.${name} AS BINARY) <=> CAST(NEW.${name} AS BINARY)`;
  }
  return `OLD.${name} <=> NEW.${name}`;
}

// The position of a change in this node's change feed. UUID_SHORT() is a
// server-wide counter that only grows (seeded from the server start time), so
// it orders changes without a counter row that every writer would contend for.
export const FEED_SEQ = 'UUID_SHORT()';

// One statement per change: the row's version record is created or moved to
// the end of the feed. Nothing is written per peer — each peer keeps a read
// position in the feed instead — so a change costs the same single small write
// however many nodes there are.
function recordStatements(table: SqlTable, ref: 'NEW' | 'OLD', nodeId: string, deleted: 0 | 1): string {
  const hash = pkHashExpr(ref, table.pk);
  return [
    `INSERT INTO ${q(STATE_TABLE)} (\`table_name\`, \`pk_hash\`, \`pk\`, \`version\`, \`origin\`, \`via\`, \`deleted\`, \`changed_at\`, \`seq\`)`,
    `  VALUES ('${table.name}', ${hash}, ${pkJsonExpr(ref, table.pk)}, ${MICROS_NOW}, '${nodeId}', NULL, ${deleted}, CURRENT_TIMESTAMP(3), ${FEED_SEQ})`,
    '  ON DUPLICATE KEY UPDATE `version` = GREATEST(`version` + 1, VALUES(`version`)), `origin` = VALUES(`origin`), `via` = NULL,',
    '    `deleted` = VALUES(`deleted`), `pk` = VALUES(`pk`), `changed_at` = VALUES(`changed_at`), `seq` = VALUES(`seq`);',
  ].join('\n');
}

export interface TriggerDefinition {
  name: string;
  table: string;
  sql: string;
}

const NODE_ID = /^[A-Za-z0-9-]{1,36}$/;

// The three capture triggers of one table. Each records, inside the writing
// transaction itself, a new version for the affected row and its new place in
// the change feed. The trigger name carries a hash of its own definition, so a
// changed definition (new column, different node identity) yields a new name:
// the new trigger is created first and the old one dropped afterwards, which
// leaves no moment in which a write could go unrecorded.
export function triggerDefinitions(table: SqlTable, nodeId: string): TriggerDefinition[] {
  if (!NODE_ID.test(nodeId)) throw new Error('unsafe node id');
  if (table.pk.length === 0) throw new Error(`table ${table.name} has no primary key`);
  const tableName = q(table.name);

  const insertBody = [
    'BEGIN',
    `IF ${APPLY_FLAG} IS NULL THEN`,
    recordStatements(table, 'NEW', nodeId, 0),
    'END IF;',
    'END',
  ].join('\n');

  const pkUnchanged = table.pk
    .map((column) => `CAST(OLD.${q(column)} AS BINARY) <=> CAST(NEW.${q(column)} AS BINARY)`)
    .join(' AND ');
  const rowUnchanged = table.columns.map(unchangedExpr).join(' AND ');
  const updateBody = [
    'BEGIN',
    `IF ${APPLY_FLAG} IS NULL AND NOT (${rowUnchanged}) THEN`,
    // A changed primary key is a removal of the old row plus a new row.
    `IF NOT (${pkUnchanged}) THEN`,
    recordStatements(table, 'OLD', nodeId, 1),
    'END IF;',
    recordStatements(table, 'NEW', nodeId, 0),
    'END IF;',
    'END',
  ].join('\n');

  const deleteBody = [
    'BEGIN',
    `IF ${APPLY_FLAG} IS NULL THEN`,
    recordStatements(table, 'OLD', nodeId, 1),
    'END IF;',
    'END',
  ].join('\n');

  const build = (kind: 'i' | 'u' | 'd', event: string, body: string): TriggerDefinition => {
    const digest = createHash('sha256').update(`${event}\n${table.name}\n${body}`).digest('hex').slice(0, 8);
    const name = `${TRIGGER_PREFIX}${digest}_${kind}_${table.name}`.slice(0, 64);
    return {
      name,
      table: table.name,
      sql: `CREATE TRIGGER ${q(name)} AFTER ${event} ON ${tableName} FOR EACH ROW\n${body}`,
    };
  };

  return [
    build('i', 'INSERT', insertBody),
    build('u', 'UPDATE', updateBody),
    build('d', 'DELETE', deleteBody),
  ];
}

export const TRIGGER_PREFIX = 'pokyh_cx_';
// Triggers of the previous design; they write the legacy queue tables.
export const LEGACY_TRIGGER_PREFIX = 'pokyh_cl_';
export const TRIGGER_NAME = /^pokyh_c[lx]_[0-9a-f]{8}_[iud]_(.+)$/;

// Columns that, when present, give an existing row a meaningful age.
const VERSION_SOURCE_COLUMNS = ['updated_at', 'created_at', 'joined_at', 'granted_at', 'completed_at', 'revoked_at'];

// Registers rows that exist but have no version yet (rows that predate the
// cluster, or were written while capture was not installed). `mode`:
//   'history' — version taken from the row's own timestamps, so that when two
//               populated nodes are joined the more recently edited copy wins;
//   'now'     — version is the current time, which makes this node's copy the
//               winning one (used after a deliberate database restore).
// Rows that already have a version are filtered out by the join rather than
// attempted and skipped: an attempted duplicate would lock the existing
// version record, and on a busy table that would make ordinary writers wait.
// The single bound parameter is the origin node id.
export function backfillSql(table: SqlTable, mode: 'history' | 'now'): string {
  const available = new Set(table.columns.map((column) => column.name));
  const sources = VERSION_SOURCE_COLUMNS.filter((column) => available.has(column)).map((column) => `t.${q(column)}`);
  const version = mode === 'now' || sources.length === 0
    ? (mode === 'now' ? MICROS_NOW : '1')
    : `GREATEST(1, COALESCE(TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', COALESCE(${sources.join(', ')})), 1))`;
  const hash = pkHashExpr('t', table.pk);
  return [
    `INSERT IGNORE INTO ${q(STATE_TABLE)} (\`table_name\`, \`pk_hash\`, \`pk\`, \`version\`, \`origin\`, \`deleted\`, \`seq\`)`,
    `SELECT '${table.name}', ${hash}, ${pkJsonExpr('t', table.pk)}, ${version}, ?, 0, ${FEED_SEQ} FROM ${q(table.name)} t`,
    `LEFT JOIN ${q(STATE_TABLE)} s ON s.\`table_name\` = '${table.name}' AND s.\`pk_hash\` = ${hash}`,
    'WHERE s.`pk_hash` IS NULL',
  ].join('\n');
}

// ─── Row transfer statements ─────────────────────────────────────────────────

export function columnList(table: SqlTable): string {
  return table.columns.map((column) => q(column.name)).join(', ');
}

export function pkWhere(table: SqlTable): string {
  return table.pk.map((column) => `${q(column)} = ?`).join(' AND ');
}

export function selectByPkSql(table: SqlTable, forUpdate: boolean): string {
  return `SELECT ${columnList(table)} FROM ${q(table.name)} WHERE ${pkWhere(table)}${forUpdate ? ' FOR UPDATE' : ''}`;
}

// Fetches up to `count` rows by primary key in one statement.
export function selectManyByPkSql(table: SqlTable, count: number): string {
  const one = `(${pkWhere(table)})`;
  return `SELECT ${columnList(table)} FROM ${q(table.name)} WHERE ${Array.from({ length: count }, () => one).join(' OR ')}`;
}

export function insertSql(table: SqlTable): string {
  return `INSERT INTO ${q(table.name)} (${columnList(table)}) VALUES (${table.columns.map(() => '?').join(', ')})`;
}

// Parameters: every non-key column in table order, then the key columns.
export function updateSql(table: SqlTable): string | null {
  const keys = new Set(table.pk);
  const assignments = table.columns.filter((column) => !keys.has(column.name)).map((column) => `${q(column.name)} = ?`);
  if (assignments.length === 0) return null;
  return `UPDATE ${q(table.name)} SET ${assignments.join(', ')} WHERE ${pkWhere(table)}`;
}

export function deleteSql(table: SqlTable): string {
  return `DELETE FROM ${q(table.name)} WHERE ${pkWhere(table)}`;
}
