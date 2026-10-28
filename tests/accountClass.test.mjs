import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/utils/accountClass.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const {
  CLASS_CHECK_VERSION,
  decideAccountClass,
  decideAccountRole,
  hasClassIdentity,
  mayJoinClass,
  normalizeAccountClass,
  parseAccountRole,
} = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
);

test('parent accounts always receive an empty class identity', () => {
  assert.deepEqual(normalizeAccountClass('parent', 4711, ' 4A '), {
    klasseId: 0,
    klasseName: '',
  });
  assert.equal(mayJoinClass('parent'), false);
});

test('student class data remains available and is normalized', () => {
  assert.deepEqual(normalizeAccountClass('student', 4711, ' 4A '), {
    klasseId: 4711,
    klasseName: '4A',
  });
  assert.equal(mayJoinClass('student'), true);
});

test('invalid student class ids stay unassigned instead of creating class zero', () => {
  // A class name without a class is no class: nothing to show either.
  assert.deepEqual(normalizeAccountClass('student', 0, 'unknown'), {
    klasseId: 0,
    klasseName: '',
  });
  assert.deepEqual(normalizeAccountClass('student', -3, '4A'), { klasseId: 0, klasseName: '' });
  assert.deepEqual(normalizeAccountClass('student', 1.5, '4A'), { klasseId: 0, klasseName: '' });
});

test('accounts without a role have no class identity, like parents', () => {
  assert.deepEqual(normalizeAccountClass('none', 4711, ' 4A '), {
    klasseId: 0,
    klasseName: '',
  });
  assert.equal(mayJoinClass('none'), false);
  assert.equal(hasClassIdentity('none'), false);
  assert.equal(hasClassIdentity('student'), true);
});

test('stored roles parse to the known roles, unknown ones stay students', () => {
  assert.equal(parseAccountRole('parent'), 'parent');
  assert.equal(parseAccountRole('none'), 'none');
  assert.equal(parseAccountRole('student'), 'student');
  assert.equal(parseAccountRole('admin'), 'student');
  assert.equal(parseAccountRole(undefined), 'student');
});

const V = CLASS_CHECK_VERSION;
const confirmedClass = { kind: 'class', klasseId: 4711, klasseName: ' 4A ' };

test('a class WebUntis names for the student is assigned and recorded as confirmed', () => {
  assert.deepEqual(decideAccountClass('student', confirmedClass, null), {
    klasseId: 4711, klasseName: '4A', checkVersion: V, confirmed: true,
  });
  // It replaces whatever was stored before, checked or not.
  assert.deepEqual(decideAccountClass('student', confirmedClass, { klasseId: 99, klasseName: '9Z', checkVersion: V }), {
    klasseId: 4711, klasseName: '4A', checkVersion: V, confirmed: true,
  });
});

test('parents, role-less accounts and sign-ins WebUntis says have no class end up in none', () => {
  const stored = { klasseId: 4711, klasseName: '4A', checkVersion: V };
  for (const [role, evidence] of [['parent', confirmedClass], ['none', confirmedClass], ['student', { kind: 'none' }]]) {
    assert.deepEqual(decideAccountClass(role, evidence, stored), { klasseId: 0, klasseName: '', checkVersion: V, confirmed: true });
  }
});

test('an inconclusive sign-in keeps only a class confirmed under the current rules', () => {
  const unknown = { kind: 'unknown' };
  assert.deepEqual(decideAccountClass('student', unknown, { klasseId: 4711, klasseName: '4A', checkVersion: V }), {
    klasseId: 4711, klasseName: '4A', checkVersion: V, confirmed: false,
  });
});

test('an inconclusive sign-in never keeps a class nobody confirmed: the account stays unassigned', () => {
  const unknown = { kind: 'unknown' };
  // A class from before the current rules (the one-time check after an update).
  assert.deepEqual(decideAccountClass('student', unknown, { klasseId: 4711, klasseName: '4A', checkVersion: V - 1 }), {
    klasseId: 0, klasseName: '', checkVersion: V - 1, confirmed: false,
  });
  // A new account.
  assert.deepEqual(decideAccountClass('student', unknown, null), { klasseId: 0, klasseName: '', checkVersion: 0, confirmed: false });
  // A "class" without an id is no evidence of one.
  assert.deepEqual(decideAccountClass('student', { kind: 'class', klasseId: 0, klasseName: '4A' }, null), {
    klasseId: 0, klasseName: '', checkVersion: 0, confirmed: false,
  });
});

test('roles: WebUntis decides, an unconfirmed say never turns a parent into a student', () => {
  assert.equal(decideAccountRole('parent', 'student', true), 'student');
  assert.equal(decideAccountRole('student', 'parent', true), 'parent');
  assert.equal(decideAccountRole('parent', 'student', false), 'parent');
  assert.equal(decideAccountRole('student', 'parent', false), 'parent');
  assert.equal(decideAccountRole(null, 'student', false), 'student');
  assert.equal(decideAccountRole('student', 'student', false), 'student');
  // "No role" is the admin's and stays.
  assert.equal(decideAccountRole('none', 'student', true), 'none');
  assert.equal(decideAccountRole('none', 'parent', false), 'none');
});
