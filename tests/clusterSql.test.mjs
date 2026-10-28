import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { loadTs } from './helpers/loadTs.mjs';

const sql = await loadTs('src/cluster/sqlgen.ts');

const NODE = '11111111-2222-3333-4444-555555555555';
const todos = {
  name: 'todos',
  columns: [
    { name: 'id', dataType: 'varchar' },
    { name: 'stable_uid', dataType: 'varchar' },
    { name: 'title', dataType: 'varchar' },
    { name: 'done', dataType: 'tinyint' },
    { name: 'created_at', dataType: 'datetime' },
  ],
  pk: ['id'],
};
const members = {
  name: 'class_members',
  columns: [
    { name: 'class_id', dataType: 'varchar' },
    { name: 'stable_uid', dataType: 'varchar' },
    { name: 'joined_at', dataType: 'datetime' },
  ],
  pk: ['class_id', 'stable_uid'],
};

test('three capture triggers are generated per table', () => {
  const triggers = sql.triggerDefinitions(todos, NODE);
  assert.equal(triggers.length, 3);
  assert.deepEqual(triggers.map((t) => t.sql.match(/AFTER (\w+) ON `todos`/)[1]), ['INSERT', 'UPDATE', 'DELETE']);
  for (const trigger of triggers) {
    assert.match(trigger.name, /^pokyh_cx_[0-9a-f]{8}_[iud]_todos$/);
    assert.ok(trigger.name.length <= 64);
    assert.match(trigger.sql, /@pokyh_cluster_apply IS NULL/, 'applied changes must not be captured again');
    assert.match(trigger.sql, /INSERT INTO `cluster_row_state`/);
    assert.match(trigger.sql, /UUID_SHORT\(\)/, 'every change takes the next place in the change feed');
    assert.doesNotMatch(trigger.sql, /cluster_outbox|cluster_targets/, 'nothing is written per peer');
    assert.ok(trigger.sql.includes(`'${NODE}'`));
  }
});

test('an update is captured only when a value really changed, compared byte for byte', () => {
  const update = sql.triggerDefinitions(todos, NODE)[1].sql;
  assert.match(update, /CAST\(OLD\.`title` AS BINARY\) <=> CAST\(NEW\.`title` AS BINARY\)/);
  assert.match(update, /OLD\.`done` <=> NEW\.`done`/);
  assert.match(update, /AND NOT \(/);
});

test('a primary-key change is recorded as a removal of the old key', () => {
  const update = sql.triggerDefinitions(members, NODE)[1].sql;
  assert.match(update, /CAST\(OLD\.`class_id` AS CHAR CHARACTER SET utf8mb4\), CAST\(OLD\.`stable_uid` AS CHAR CHARACTER SET utf8mb4\)/);
  const tombstoneIndex = update.indexOf("'" + NODE + "', NULL, 1,");
  const liveIndex = update.indexOf("'" + NODE + "', NULL, 0,");
  assert.ok(tombstoneIndex > 0 && liveIndex > tombstoneIndex, 'the old key is removed before the new one is recorded');
});

test('a change is one statement: the version record moves to the end of the feed', () => {
  for (const trigger of sql.triggerDefinitions(todos, NODE)) {
    const statements = trigger.sql.split(';').filter((part) => /INSERT INTO/.test(part));
    assert.ok(statements.length >= 1);
    for (const statement of statements) {
      assert.match(statement, /ON DUPLICATE KEY UPDATE[\s\S]*`seq` = VALUES\(`seq`\)/);
      assert.match(statement, /`via` = NULL/, 'a local change is offered to every peer');
    }
  }
  assert.equal(sql.triggerDefinitions(todos, NODE)[0].sql.match(/INSERT INTO/g).length, 1, 'an insert costs exactly one bookkeeping write');
  assert.match('pokyh_cl_0123abcd_u_todos', sql.TRIGGER_NAME, 'triggers of the previous design are recognised');
  assert.match('pokyh_cx_0123abcd_d_todos', sql.TRIGGER_NAME);
});

test('trigger names follow their definition', () => {
  const base = sql.triggerDefinitions(todos, NODE).map((t) => t.name);
  assert.deepEqual(sql.triggerDefinitions(todos, NODE).map((t) => t.name), base, 'stable for an unchanged definition');
  const otherNode = sql.triggerDefinitions(todos, 'aaaaaaaa-2222-3333-4444-555555555555').map((t) => t.name);
  assert.notDeepEqual(otherNode, base, 'a different node identity needs new triggers');
  const widened = { ...todos, columns: [...todos.columns, { name: 'note', dataType: 'text' }] };
  assert.notEqual(sql.triggerDefinitions(widened, NODE)[1].name, base[1], 'a new column needs a new update trigger');
});

test('unsafe identifiers and node ids never reach SQL text', () => {
  assert.throws(() => sql.triggerDefinitions({ ...todos, name: 'todos`; DROP TABLE users; --' }, NODE), /unsafe/);
  assert.throws(() => sql.triggerDefinitions({ ...todos, columns: [{ name: 'a b', dataType: 'int' }] }, NODE), /unsafe/);
  assert.throws(() => sql.triggerDefinitions(todos, "x' OR '1'='1"), /unsafe/);
  assert.throws(() => sql.triggerDefinitions({ ...todos, pk: [] }, NODE), /primary key/);
  assert.throws(() => sql.backfillSql({ ...todos, name: 'a;b' }, 'history'), /unsafe/);
  assert.equal(sql.isSafeIdentifier('class_members'), true);
  assert.equal(sql.isSafeIdentifier('x'.repeat(65)), false);
});

test('the key hash matches the SQL expression byte for byte', () => {
  // SHA2(CONCAT_WS(0x1F, 'a', '5'), 256) — verified against MySQL 8.0.
  assert.equal(sql.computePkHash(['a', '5']), '3872e4ae3348b84957ed7bf8d8f8b29b142dc6aef7138bbe312055ed67ae61d8');
  assert.equal(sql.computePkHash(['ä']), createHash('sha256').update(Buffer.from('ä', 'utf8')).digest('hex'));
  assert.notEqual(sql.computePkHash(['ab', 'c']), sql.computePkHash(['a', 'bc']));
});

test('backfill takes a row age from its timestamps, or the present after a restore', () => {
  const history = sql.backfillSql(todos, 'history');
  assert.match(history, /^INSERT IGNORE INTO `cluster_row_state`/);
  assert.match(history, /COALESCE\(t\.`created_at`\)/);
  assert.equal((history.match(/\?/g) ?? []).length, 1);
  assert.match(sql.backfillSql(members, 'history'), /COALESCE\(t\.`joined_at`\)/);
  assert.match(sql.backfillSql({ ...todos, columns: [{ name: 'id', dataType: 'varchar' }] }, 'history'), /, 1, \?, 0, UUID_SHORT\(\) FROM `todos` t/);
  assert.match(sql.backfillSql(todos, 'now'), /UTC_TIMESTAMP\(6\)\), \?, 0, UUID_SHORT\(\) FROM `todos` t/);
});

test('backfill only touches rows that have no version yet', () => {
  const history = sql.backfillSql(members, 'history');
  assert.match(history, /LEFT JOIN `cluster_row_state` s ON s\.`table_name` = 'class_members' AND s\.`pk_hash` = SHA2\(/);
  assert.match(history, /WHERE s\.`pk_hash` IS NULL$/);
  assert.match(history, /CAST\(t\.`class_id` AS CHAR CHARACTER SET utf8mb4\), CAST\(t\.`stable_uid` AS CHAR CHARACTER SET utf8mb4\)/);
});

test('row statements bind every value', () => {
  assert.equal(sql.selectByPkSql(members, true), 'SELECT `class_id`, `stable_uid`, `joined_at` FROM `class_members` WHERE `class_id` = ? AND `stable_uid` = ? FOR UPDATE');
  assert.equal(sql.insertSql(members), 'INSERT INTO `class_members` (`class_id`, `stable_uid`, `joined_at`) VALUES (?, ?, ?)');
  assert.equal(sql.updateSql(members), 'UPDATE `class_members` SET `joined_at` = ? WHERE `class_id` = ? AND `stable_uid` = ?');
  assert.equal(sql.deleteSql(members), 'DELETE FROM `class_members` WHERE `class_id` = ? AND `stable_uid` = ?');
  assert.equal(sql.updateSql({ name: 'k', columns: [{ name: 'id', dataType: 'int' }], pk: ['id'] }), null);
  assert.equal((sql.selectManyByPkSql(members, 3).match(/\?/g) ?? []).length, 6);
});
