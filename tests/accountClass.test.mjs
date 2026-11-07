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
const confirmedClass = { kind: 'class', klasseId: 4711, klasseName: ' 4A ', source: 'authenticate' };
const named = (extra = {}) => ({ klasseId: 4711, klasseName: '4A', checkVersion: V, confirmed: true, classSource: 'authenticate', classNote: null, ...extra });
const unassigned = (classNote, extra = {}) => ({ klasseId: 0, klasseName: '', checkVersion: V, confirmed: true, classSource: null, classNote, ...extra });

test('a class WebUntis names for the student is assigned, recorded as confirmed, with its source', () => {
  assert.deepEqual(decideAccountClass('student', confirmedClass, null), named());
  // It replaces whatever was stored before, checked or not.
  assert.deepEqual(decideAccountClass('student', confirmedClass, { klasseId: 99, klasseName: '9Z', checkVersion: V }), named());
  assert.deepEqual(decideAccountClass('student', { ...confirmedClass, source: 'weekly-data' }, null), named({ classSource: 'weekly-data' }));
});

test('parents, role-less accounts and sign-ins WebUntis says have no class end up in none, with the reason', () => {
  const stored = { klasseId: 4711, klasseName: '4A', checkVersion: V };
  assert.deepEqual(decideAccountClass('parent', confirmedClass, stored), unassigned('role_parent'));
  assert.deepEqual(decideAccountClass('none', confirmedClass, stored), unassigned('role_none'));
  assert.deepEqual(decideAccountClass('student', { kind: 'none', note: 'not_student' }, stored), unassigned('not_student'));
});

test('an account on a pupil record an older account already signs in on gets no class until an admin decides', () => {
  const stored = { klasseId: 4711, klasseName: '4A', checkVersion: V };
  assert.deepEqual(decideAccountClass('student', confirmedClass, stored, { sharedPerson: true }), unassigned('shared_person'));
  // A parent stays a parent, whatever is shared.
  assert.deepEqual(decideAccountClass('parent', confirmedClass, null, { sharedPerson: true }), unassigned('role_parent'));
});

test('an inconclusive sign-in keeps only a class confirmed under the current rules', () => {
  const unknown = { kind: 'unknown', note: 'webuntis_unavailable' };
  assert.deepEqual(decideAccountClass('student', unknown, { klasseId: 4711, klasseName: '4A', checkVersion: V }), named({ confirmed: false, classSource: 'kept' }));
});

test('an inconclusive sign-in never keeps a class nobody confirmed: the account stays unassigned, with the reason', () => {
  const unknown = { kind: 'unknown', note: 'appdata_unreadable' };
  // A class from before the current rules (the one-time check after an update).
  assert.deepEqual(decideAccountClass('student', unknown, { klasseId: 4711, klasseName: '4A', checkVersion: V - 1 }),
    unassigned('appdata_unreadable', { confirmed: false, checkVersion: V - 1 }));
  // A new account.
  assert.deepEqual(decideAccountClass('student', unknown, null), unassigned('appdata_unreadable', { confirmed: false, checkVersion: 0 }));
  // WebUntis answered and names none: checked, nothing to wait for.
  assert.deepEqual(decideAccountClass('student', { kind: 'unknown', note: 'no_class_found' }, null), unassigned('no_class_found'));
  assert.deepEqual(decideAccountClass('student', { kind: 'unknown', note: 'candidate_rejected' }, { klasseId: 9, klasseName: '9Z', checkVersion: V - 1 }),
    unassigned('candidate_rejected'));
  // A "class" without an id is no evidence of one.
  assert.deepEqual(decideAccountClass('student', { kind: 'class', klasseId: 0, klasseName: '4A', source: 'authenticate' }, null),
    unassigned('no_class_found', { confirmed: false, checkVersion: 0 }));
});

const role = (stored, kind, claimed) => decideAccountRole(stored, kind, claimed).role;
const locked = (r) => ({ role: r, roleLocked: true });
const free = (r) => ({ role: r, roleLocked: false });

test('roles: an admin\'s choice stays at every sign-in, whatever WebUntis says', () => {
  for (const kind of ['student', 'parent', 'other', 'unknown']) {
    assert.equal(role(locked('parent'), kind), 'parent');
    assert.equal(role(locked('student'), kind), 'student');
    assert.equal(role(locked('none'), kind), 'none');
  }
});

test('roles: WebUntis never turns a parent into a student — a parent\'s login on the child\'s record looks like the child', () => {
  assert.deepEqual(decideAccountRole(free('parent'), 'student'), { role: 'parent', note: 'student_record_on_parent' });
  assert.equal(role(free('student'), 'parent'), 'parent');
  assert.equal(role(free('student'), 'student'), 'student');
  assert.equal(role(null, 'student'), 'student');
  assert.equal(role(null, 'parent'), 'parent');
});

test('roles: when WebUntis does not tell, the stored role stays and the app\'s say can only make a new account a parent', () => {
  for (const kind of ['other', 'unknown']) {
    assert.equal(role(free('parent'), kind, 'student'), 'parent');
    assert.equal(role(free('student'), kind, 'parent'), 'student');
    assert.equal(role(null, kind, 'parent'), 'parent');
    assert.equal(role(null, kind, 'student'), 'student');
  }
  // "No role" is the admin's and stays, locked or not.
  assert.equal(role(free('none'), 'student'), 'none');
  assert.equal(role(free('none'), 'parent'), 'none');
});
