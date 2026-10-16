import { prisma } from '../db';
import { config } from '../config';
import { kindOf, type CodecColumn } from './codec';
import { fingerprintOf } from './scopeRules';
import { isSafeIdentifier, type SqlTable } from './sqlgen';

// The set of replicated tables, read from the live database rather than
// maintained by hand: a table added to the Prisma schema is replicated the
// next time the server starts, with no cluster code to touch.

// Operational tables whose content only makes sense on the node that wrote
// it. Everything with the `cluster_` prefix is replication bookkeeping.
const NODE_LOCAL_TABLES = new Set([
  'request_logs',
  'frontend_activity_logs',
  'client_error_logs',
  'request_account_days',
  'backup_config',
  '_prisma_migrations',
]);
const NODE_LOCAL_PREFIX = 'cluster_';

export interface UniqueIndex {
  name: string;
  columns: string[];
}

export interface TableInfo extends SqlTable {
  codec: CodecColumn[];
  uniques: UniqueIndex[];
  // Parents sort before children; rows are sent and applied in this order so
  // a child rarely arrives before the row it refers to.
  rank: number;
  createdAtColumn: string | null;
  fkColumns: Set<string>;
  maxLength: Map<string, number>;
}

export interface Catalog {
  tables: Map<string, TableInfo>;
  ordered: TableInfo[];
  // Identifies the replicated schema. Two nodes exchange rows only while
  // their fingerprints match, so a rolling upgrade pauses replication instead
  // of writing rows into a table of a different shape.
  fingerprint: string;
  // The lines the fingerprint is made of ("c|table|…", "u|table|…").
  signature: string[];
}

function isReplicated(table: string): boolean {
  const name = table.toLowerCase();
  if (!isSafeIdentifier(table)) return false;
  if (name.startsWith(NODE_LOCAL_PREFIX)) return false;
  if (NODE_LOCAL_TABLES.has(name)) return false;
  if (config.cluster.excludeTables.includes(name)) return false;
  return true;
}

interface ColumnRow {
  TABLE_NAME: string;
  COLUMN_NAME: string;
  DATA_TYPE: string;
  COLUMN_TYPE: string;
  IS_NULLABLE: string;
  EXTRA: string | null;
  CHARACTER_MAXIMUM_LENGTH: bigint | number | null;
}

interface IndexRow {
  TABLE_NAME: string;
  INDEX_NAME: string;
  NON_UNIQUE: bigint | number;
  COLUMN_NAME: string;
}

interface ForeignKeyRow {
  TABLE_NAME: string;
  COLUMN_NAME: string;
  REFERENCED_TABLE_NAME: string;
}

export async function loadCatalog(): Promise<Catalog> {
  const [tableRows, columnRows, indexRows, foreignKeyRows] = await Promise.all([
    prisma.$queryRawUnsafe<Array<{ TABLE_NAME: string }>>(
      "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'",
    ),
    prisma.$queryRawUnsafe<ColumnRow[]>(
      'SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, EXTRA, CHARACTER_MAXIMUM_LENGTH '
      + 'FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION',
    ),
    prisma.$queryRawUnsafe<IndexRow[]>(
      'SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, COLUMN_NAME FROM information_schema.STATISTICS '
      + 'WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX',
    ),
    prisma.$queryRawUnsafe<ForeignKeyRow[]>(
      'SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE '
      + 'WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL',
    ),
  ]);

  const tables = new Map<string, TableInfo>();
  for (const row of tableRows) {
    if (!isReplicated(row.TABLE_NAME)) continue;
    tables.set(row.TABLE_NAME, {
      name: row.TABLE_NAME,
      columns: [],
      pk: [],
      codec: [],
      uniques: [],
      rank: 0,
      createdAtColumn: null,
      fkColumns: new Set(),
      maxLength: new Map(),
    });
  }

  const signature: string[] = [];
  for (const row of columnRows) {
    const table = tables.get(row.TABLE_NAME);
    if (!table) continue;
    // A generated column is computed by the database on each node. (A plain
    // column with a default expression reports "DEFAULT_GENERATED" here and
    // is an ordinary, replicated column.)
    if (/\b(VIRTUAL|STORED) GENERATED\b/i.test(row.EXTRA ?? '')) continue;
    if (!isSafeIdentifier(row.COLUMN_NAME)) {
      tables.delete(row.TABLE_NAME);
      continue;
    }
    table.columns.push({ name: row.COLUMN_NAME, dataType: row.DATA_TYPE });
    table.codec.push({ name: row.COLUMN_NAME, kind: kindOf(row.DATA_TYPE) });
    if (row.CHARACTER_MAXIMUM_LENGTH !== null) table.maxLength.set(row.COLUMN_NAME, Number(row.CHARACTER_MAXIMUM_LENGTH));
    if (row.COLUMN_NAME === 'created_at') table.createdAtColumn = 'created_at';
    signature.push(`c|${row.TABLE_NAME}|${row.COLUMN_NAME}|${row.COLUMN_TYPE}|${row.IS_NULLABLE}`);
  }

  const indexes = new Map<string, { table: string; name: string; unique: boolean; columns: string[] }>();
  for (const row of indexRows) {
    if (!tables.has(row.TABLE_NAME)) continue;
    const key = `${row.TABLE_NAME}|${row.INDEX_NAME}`;
    const entry = indexes.get(key)
      ?? { table: row.TABLE_NAME, name: row.INDEX_NAME, unique: Number(row.NON_UNIQUE) === 0, columns: [] };
    entry.columns.push(row.COLUMN_NAME);
    indexes.set(key, entry);
  }
  for (const index of indexes.values()) {
    const table = tables.get(index.table);
    if (!table || !index.unique) continue;
    if (index.name === 'PRIMARY') table.pk = index.columns;
    else table.uniques.push({ name: index.name, columns: index.columns });
    signature.push(`u|${index.table}|${index.name}|${index.columns.join(',')}`);
  }

  // A table without a primary key has no stable row identity to replicate by.
  for (const [name, table] of tables) {
    if (table.pk.length === 0 || table.columns.length === 0) tables.delete(name);
  }

  const parents = new Map<string, Set<string>>();
  for (const row of foreignKeyRows) {
    const table = tables.get(row.TABLE_NAME);
    if (!table) continue;
    table.fkColumns.add(row.COLUMN_NAME);
    if (!tables.has(row.REFERENCED_TABLE_NAME) || row.REFERENCED_TABLE_NAME === row.TABLE_NAME) continue;
    const set = parents.get(row.TABLE_NAME) ?? new Set<string>();
    set.add(row.REFERENCED_TABLE_NAME);
    parents.set(row.TABLE_NAME, set);
  }
  const visiting = new Set<string>();
  const rankOf = (name: string): number => {
    const table = tables.get(name);
    if (!table) return 0;
    if (table.rank > 0 || visiting.has(name)) return table.rank;
    visiting.add(name);
    let rank = 0;
    for (const parent of parents.get(name) ?? []) rank = Math.max(rank, rankOf(parent) + 1);
    visiting.delete(name);
    table.rank = rank;
    return rank;
  };
  for (const name of tables.keys()) rankOf(name);

  const ordered = [...tables.values()].sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  return { tables, ordered, fingerprint: fingerprintOf(signature), signature };
}
