import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './helpers/loadTs.mjs';

const {
  accountClassForRole,
  accountKindOf,
  containsParentRoleTag,
  findStudentClassIdInData,
  klasseById,
  klasseIdByName,
  lessonClassNames,
  majorityClassName,
  ownClassCandidates,
  pickOwnClass,
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

// ── What a sign-in is ────────────────────────────────────────────────────────

const studentAppData = { data: { user: { name: 'max.muster', roles: ['STUDENT'], person: { id: 12 } } } };
const guardianAppData = { data: { user: { roles: ['LEGAL_GUARDIAN'], person: { id: 40 }, students: [{ id: 12 }] } } };

test('authenticate\'s person type decides: 5 student, 12 guardian, anything else no student', () => {
  assert.equal(accountKindOf(5, studentAppData), 'student');
  assert.equal(accountKindOf(12, studentAppData), 'parent');
  assert.equal(accountKindOf(12, null), 'parent');
  assert.equal(accountKindOf(2, studentAppData), 'other');
  assert.equal(accountKindOf(2, null), 'other');
  assert.equal(accountKindOf('5', studentAppData), 'student');
});

test('a parent login on the child\'s student record is a parent, never a student of the class', () => {
  // personType 5, but tagged as the parents' account.
  assert.equal(accountKindOf(5, { data: { user: { roles: ['STUDENT'], tags: ['Elternaccount'] } } }), 'parent');
  assert.equal(accountKindOf(5, guardianAppData), 'parent');
});

test('without the app-data a student cannot be told from such a parent login: unknown', () => {
  assert.equal(accountKindOf(5, null), 'unknown');
  assert.equal(accountKindOf(undefined, null), 'unknown');
});

test('without a person type (sign-in form, session taken over) the app-data roles decide', () => {
  assert.equal(accountKindOf(undefined, studentAppData), 'student');
  assert.equal(accountKindOf(undefined, guardianAppData), 'parent');
  assert.equal(accountKindOf(undefined, { user: { roles: [{ name: 'Schüler' }] } }), 'student');
  assert.equal(accountKindOf(undefined, { user: { roles: ['TEACHER'] } }), 'other');
  assert.equal(accountKindOf(undefined, { user: { person: { id: 12 } } }), 'unknown');
});

// ── The student's own class ──────────────────────────────────────────────────

test('matches numeric WebUntis ids even when the API serializes them as strings', () => {
  assert.deepEqual(ownClassCandidates('12', { personId: '12', klasseId: '0' }, [{ id: '12', klasse: { id: '345' } }], null), [
    { source: 'students', id: 345 },
  ]);
  assert.equal(studentClassId({ id: 12, classId: '456' }), 456);
  assert.equal(studentClassId({ id: 12, klasse: '567' }), 567);
});

test('class candidates come from the student\'s own records, authenticate first', () => {
  const students = [{ id: 12, klasseId: 345 }, { id: 99, klasseId: 678 }];
  const appData = { data: { user: { person: { id: 12, klasseId: 346 } } } };
  assert.deepEqual(ownClassCandidates(12, { personId: 12, klasseId: 344 }, students, appData), [
    { source: 'authenticate', id: 344 },
    { source: 'students', id: 345 },
    { source: 'app-data', id: 346 },
  ]);
});

test('never borrows another student\'s class for the signed-in student', () => {
  assert.deepEqual(ownClassCandidates(12, { personId: 12, klasseId: 0 }, [{ id: 99, klasseId: 678 }], null), []);
  // `authenticate` answered for somebody else (a session taken over): its class is not this person's.
  assert.deepEqual(ownClassCandidates(12, { personId: 40, klasseId: 678 }, [], null), []);
  assert.deepEqual(ownClassCandidates(0, { personId: 0, klasseId: 678 }, [{ id: 0, klasseId: 678 }], null), []);
});

test('only an id that is one of the school\'s classes counts, named as WebUntis names it', () => {
  const klassen = [{ id: 345, name: '4A', longName: '4. Klasse A' }, { id: 346, name: '4B' }];
  assert.deepEqual(pickOwnClass([{ source: 'authenticate', id: 345 }], klassen), {
    picked: { id: 345, name: '4A', source: 'authenticate' }, rejected: [],
  });
  assert.deepEqual(pickOwnClass([{ source: 'authenticate', id: 999 }, { source: 'students', id: 346 }], klassen), {
    picked: { id: 346, name: '4B', source: 'students' }, rejected: ['authenticate'],
  });
  assert.deepEqual(pickOwnClass([{ source: 'authenticate', id: 999 }], klassen), { picked: null, rejected: ['authenticate'] });
  // The class list could not be read: WebUntis' own id for the student stands, unnamed.
  assert.deepEqual(pickOwnClass([{ source: 'authenticate', id: 999 }], null), {
    picked: { id: 999, name: '', source: 'authenticate' }, rejected: [],
  });
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

test('app-data elements that merely share the person\'s id are never read as the person', () => {
  // WebUntis numbers lessons, rooms and classes on their own: id 12 is a lesson here.
  const appData = {
    data: {
      user: { person: { id: 12 } },
      lessons: [{ id: 12, klasseId: 678 }],
      permissions: { views: [{ id: 12, classId: 679 }] },
    },
  };
  assert.equal(findStudentClassIdInData(appData, 12), 0);
});

// ── The timetable ────────────────────────────────────────────────────────────

const lesson = (...classes) => ({
  position1: [{ current: { type: 'TEACHER', shortName: 'MUE' } }],
  position2: [{ current: { type: 'SUBJECT', shortName: 'D' } }],
  position4: classes.map((name) => ({ current: { type: 'CLASS', shortName: name } })),
});

test('reads the classes of every lesson', () => {
  const json = { days: [{ gridEntries: [lesson('4A'), lesson('4A', '4B'), lesson()] }, { gridEntries: [lesson('4a', '4A')] }] };
  assert.deepEqual(lessonClassNames(json), [['4A'], ['4A', '4B'], ['4A']]);
  assert.deepEqual(lessonClassNames({}), []);
});

test('the class in a clear majority of the lessons wins, not the first class met', () => {
  // The week starts with a lesson shared with 3B: the first class met is not the student's.
  assert.equal(majorityClassName([['3B', '3A'], ['3A'], ['3A'], ['3A', '3C']]), '3A');
  assert.equal(majorityClassName([['3A'], ['3A']]), '3A');
});

test('a timetable that does not tell the class apart gives none', () => {
  // Two classes always taught together.
  assert.equal(majorityClassName([['3A', '3B'], ['3A', '3B'], ['3B', '3A']]), null);
  // No class in more than half of the lessons.
  assert.equal(majorityClassName([['3A'], ['3B'], ['3C'], ['3A']]), null);
  // Too few lessons.
  assert.equal(majorityClassName([['3A']]), null);
  assert.equal(majorityClassName([]), null);
});

test('a class name maps to exactly one of the school\'s classes or to none', () => {
  const klassen = [{ id: 1, name: '3A', longName: '3. Klasse A' }, { id: 2, name: '3B' }, { id: 3, name: 'X' }, { id: 4, name: 'x' }];
  assert.equal(klasseIdByName(klassen, '3a'), 1);
  assert.equal(klasseIdByName(klassen, '3. Klasse A'), 1);
  assert.equal(klasseIdByName(klassen, 'X'), 0);
  assert.equal(klasseIdByName(klassen, '9Z'), 0);
  assert.deepEqual(klasseById(klassen, 2), { id: 2, name: '3B' });
  assert.equal(klasseById(klassen, 99), null);
});

test('exposes no class identity for a detected parent account', () => {
  assert.deepEqual(accountClassForRole(true, 345, '4A'), { klasseId: 0, klasseName: '' });
  assert.deepEqual(accountClassForRole(false, 345, ' 4A '), { klasseId: 345, klasseName: '4A' });
  assert.deepEqual(accountClassForRole(false, 0, '4A'), { klasseId: 0, klasseName: '' });
});
