// Row transport encoding. A replicated row travels as JSON, which cannot carry
// dates, binary data or 64-bit integers by itself; this module maps each MySQL
// column type to a lossless wire form and back. It deliberately has no
// imports, so the round trip can be tested without a database.

export type ColumnKind = 'string' | 'number' | 'bigint' | 'datetime' | 'date' | 'binary' | 'decimal' | 'json';

export interface CodecColumn {
  name: string;
  kind: ColumnKind;
}

export type WireValue = string | number | boolean | null;

// `dataType` is information_schema.COLUMNS.DATA_TYPE.
export function kindOf(dataType: string): ColumnKind {
  switch (dataType.toLowerCase()) {
    case 'datetime':
    case 'timestamp':
      return 'datetime';
    case 'date':
      return 'date';
    case 'tinyblob':
    case 'blob':
    case 'mediumblob':
    case 'longblob':
    case 'binary':
    case 'varbinary':
    case 'bit':
      return 'binary';
    case 'bigint':
      return 'bigint';
    case 'tinyint':
    case 'smallint':
    case 'mediumint':
    case 'int':
    case 'integer':
    case 'float':
    case 'double':
    case 'year':
      return 'number';
    case 'decimal':
    case 'numeric':
      return 'decimal';
    case 'json':
      return 'json';
    default:
      return 'string';
  }
}

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new Error('binary column did not contain binary data');
}

function encodeValue(kind: ColumnKind, value: unknown): WireValue {
  if (value === null || value === undefined) return null;
  switch (kind) {
    case 'datetime': {
      const date = value instanceof Date ? value : new Date(String(value));
      if (Number.isNaN(date.getTime())) throw new Error('invalid datetime value');
      return date.toISOString();
    }
    case 'date': {
      const date = value instanceof Date ? value : new Date(String(value));
      if (Number.isNaN(date.getTime())) throw new Error('invalid date value');
      return date.toISOString().slice(0, 10);
    }
    case 'binary':
      return toBuffer(value).toString('base64');
    case 'bigint':
      return typeof value === 'bigint' ? value.toString() : String(value);
    case 'number':
      if (typeof value === 'bigint') return Number(value);
      if (typeof value === 'boolean') return value ? 1 : 0;
      return Number(value);
    case 'decimal':
      return String(value);
    case 'json':
      return typeof value === 'string' ? value : JSON.stringify(value);
    default:
      return String(value);
  }
}

function decodeValue(kind: ColumnKind, value: WireValue): unknown {
  if (value === null) return null;
  switch (kind) {
    case 'datetime': {
      const date = new Date(String(value));
      if (Number.isNaN(date.getTime())) throw new Error('invalid datetime value');
      return date;
    }
    case 'date': {
      const date = new Date(`${String(value)}T00:00:00.000Z`);
      if (Number.isNaN(date.getTime())) throw new Error('invalid date value');
      return date;
    }
    case 'binary':
      return Buffer.from(String(value), 'base64');
    case 'bigint':
      return BigInt(String(value));
    case 'number': {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new Error('invalid numeric value');
      return number;
    }
    default:
      return String(value);
  }
}

// Encodes a database row into wire values in the order of `columns`.
export function encodeRow(columns: CodecColumn[], row: Record<string, unknown>): WireValue[] {
  return columns.map((column) => encodeValue(column.kind, row[column.name]));
}

// Decodes wire values back into values that can be bound to a query.
export function decodeRow(columns: CodecColumn[], values: WireValue[]): unknown[] {
  if (values.length !== columns.length) throw new Error('row does not match the column list');
  return columns.map((column, index) => decodeValue(column.kind, values[index] ?? null));
}

// ─── Versions ────────────────────────────────────────────────────────────────
// A row version is (microsecond timestamp, origin node id). The larger pair
// wins; the node id only ever breaks an exact timestamp tie, and it does so
// identically on every node.

export interface RowVersion {
  version: bigint;
  origin: string;
}

export function compareVersions(a: RowVersion, b: RowVersion): number {
  if (a.version !== b.version) return a.version > b.version ? 1 : -1;
  if (a.origin === b.origin) return 0;
  return a.origin > b.origin ? 1 : -1;
}

// True when `incoming` must replace what is stored locally. A row that has
// never been seen locally (`local` is null) is always newer.
export function isNewer(incoming: RowVersion, local: RowVersion | null): boolean {
  if (!local) return true;
  return compareVersions(incoming, local) > 0;
}
