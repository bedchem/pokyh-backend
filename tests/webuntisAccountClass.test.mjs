import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './helpers/loadTs.mjs';

const {
  accountClassForRole,
  containsParentRoleTag,
  findStudentClassIdInData,
  resolveOwnStudentClassId,
  studentClassId,
} = await loadTs('src/webuntis/accountClass.ts');

test('recognizes the real Elternaccount tag regardless of case or separator', () => {
  assert.equal(containsParentRoleTag({ user: { tags: ['Elternaccount'] } }), true);
  assert.equal(containsParentRoleTag({ user: { roles: [{ name: 'ELTERN-ACCOUNT' }] } }), true);
  assert.equal(containsParentRoleTag({ user: { tags: ['Schueler'] } }), false);
});

test('keeps configured parent tags additive to the built-in markers', () => {
  assert.equal(containsParentRoleTag({ role: 'CUSTOM_GUARDIAN' }, ['CUSTOM_GUARDIAN']), true);
  assert.equal(containsParentRoleTag({ tag: 'Elternaccount' }, ['CUSTOM_GUARDIAN']), true);
});

test('recovers a student class when authenticate returns zero', () => {
  const students = [
    { id: 12, klasseId: 345 },
    { id: 99, klasseId: 678 },
  ];
  assert.equal(resolveOwnStudentClassId(0, 12, students), 345);
});

test('matches numeric WebUntis ids even when the API serializes them as strings', () => {
  assert.equal(resolveOwnStudentClassId('0', '12', [{ id: '12', klasse: { id: '345' } }]), 345);
  assert.equal(studentClassId({ id: 12, classId: '456' }), 456);
  assert.equal(studentClassId({ id: 12, klasse: '567' }), 567);
});

test('never borrows another student class for the logged-in student', () => {
  assert.equal(resolveOwnStudentClassId(0, 12, [{ id: 99, klasseId: 678 }]), 0);
});

test('recovers class data nested beside the matching student in app-data', () => {
  const appData = {
    data: {
      user: {
        students: [
          { id: 12, klasse: { id: 345 } },
          { id: 99, klasseId: 678 },
        ],
      },
    },
  };
  assert.equal(findStudentClassIdInData(appData, 12), 345);
  assert.equal(findStudentClassIdInData(appData, 77), 0);
});

test('exposes no class identity for a detected parent account', () => {
  assert.deepEqual(accountClassForRole(true, 345, '4A'), { klasseId: 0, klasseName: '' });
  assert.deepEqual(accountClassForRole(false, 345, ' 4A '), { klasseId: 345, klasseName: '4A' });
});
