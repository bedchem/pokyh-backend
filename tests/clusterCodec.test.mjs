import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './helpers/loadTs.mjs';

const codec = await loadTs('src/cluster/codec.ts');

const columns = [
  ['id', 'varchar'], ['n', 'int'], ['flag', 'tinyint'], ['big', 'bigint'], ['at', 'datetime'],
  ['day', 'date'], ['ratio', 'double'], ['image', 'longblob'], ['body', 'longtext'], ['empty', 'varchar'],
].map(([name, dataType]) => ({ name, kind: codec.kindOf(dataType) }));

test('a row survives the JSON round trip without losing type or precision', () => {
  const row = {
    id: 'héllo ✓',
    n: -42,
    flag: 1,
    big: 9007199254740993n,
    at: new Date('2026-10-07T12:34:56.789Z'),
    day: new Date('2026-10-07T00:00:00.000Z'),
    ratio: 1.0000000000000002,
    image: Buffer.from([0, 255, 1, 2, 128]),
    body: 'line1\nline2 "quoted" \\ backslash',
    empty: null,
  };
  const wire = JSON.parse(JSON.stringify(codec.encodeRow(columns, row)));
  const decoded = codec.decodeRow(columns, wire);
  const byName = Object.fromEntries(columns.map((column, index) => [column.name, decoded[index]]));

  assert.equal(byName.id, row.id);
  assert.equal(byName.n, -42);
  assert.equal(byName.flag, 1);
  assert.equal(byName.big, 9007199254740993n);
  assert.equal(byName.at.toISOString(), '2026-10-07T12:34:56.789Z');
  assert.equal(byName.day.toISOString(), '2026-10-07T00:00:00.000Z');
  assert.equal(byName.ratio, 1.0000000000000002);
  assert.deepEqual(byName.image, row.image);
  assert.equal(byName.body, row.body);
  assert.equal(byName.empty, null);
});

test('binary data is accepted as Uint8Array as well as Buffer', () => {
  const cols = [{ name: 'image', kind: 'binary' }];
  const wire = codec.encodeRow(cols, { image: new Uint8Array([1, 2, 3]) });
  assert.deepEqual(codec.decodeRow(cols, wire)[0], Buffer.from([1, 2, 3]));
});

test('malformed input is rejected instead of being written', () => {
  const cols = [{ name: 'at', kind: 'datetime' }];
  assert.throws(() => codec.decodeRow(cols, ['not a date']));
  assert.throws(() => codec.decodeRow(cols, []), /column list/);
  assert.throws(() => codec.decodeRow([{ name: 'n', kind: 'number' }], ['abc']));
  assert.throws(() => codec.encodeRow([{ name: 'image', kind: 'binary' }], { image: 'text' }));
});

test('column kinds follow the MySQL data type', () => {
  assert.equal(codec.kindOf('DATETIME'), 'datetime');
  assert.equal(codec.kindOf('timestamp'), 'datetime');
  assert.equal(codec.kindOf('date'), 'date');
  assert.equal(codec.kindOf('longblob'), 'binary');
  assert.equal(codec.kindOf('bigint'), 'bigint');
  assert.equal(codec.kindOf('tinyint'), 'number');
  assert.equal(codec.kindOf('double'), 'number');
  assert.equal(codec.kindOf('varchar'), 'string');
  assert.equal(codec.kindOf('mediumtext'), 'string');
});

test('last-writer-wins ordering is total and deterministic', () => {
  const v = (version, origin) => ({ version, origin });
  assert.equal(codec.isNewer(v(2n, 'a'), v(1n, 'z')), true, 'later timestamp wins');
  assert.equal(codec.isNewer(v(1n, 'z'), v(2n, 'a')), false);
  assert.equal(codec.isNewer(v(5n, 'b'), v(5n, 'a')), true, 'node id breaks an exact tie');
  assert.equal(codec.isNewer(v(5n, 'a'), v(5n, 'b')), false);
  assert.equal(codec.isNewer(v(5n, 'a'), v(5n, 'a')), false, 'the same version is not newer');
  assert.equal(codec.isNewer(v(1n, 'a'), null), true, 'an unknown row is always accepted');
  assert.equal(codec.compareVersions(v(5n, 'a'), v(5n, 'a')), 0);
});
