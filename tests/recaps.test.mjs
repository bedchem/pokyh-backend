import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './helpers/loadTs.mjs';

const { recapReaches, parseSections, formatSections, recapStatus, coveredPeriod, topPercent, isDayKey, RECAP_SECTIONS } = await loadTs('src/services/recapRules.ts');
const { summarizeActivity } = await loadTs('src/services/accountActivitySummary.ts');

const A = 'school-a';
const B = 'school-b';
const student = (over = {}) => ({ stableUid: 'u1', schoolId: A, klasseId: 7, role: 'student', ...over });
const reach = (over = {}) => ({ schoolId: null, targetSchools: [], targetClasses: [], targetUsers: [], ...over });

test('a recap without recipients reaches every student of its range', () => {
  assert.equal(recapReaches(reach(), student()), true);
  assert.equal(recapReaches(reach(), student({ schoolId: B })), true);
  assert.equal(recapReaches(reach({ schoolId: A }), student({ schoolId: B })), false);
});

test('chosen schools, classes and students each reach their own', () => {
  assert.equal(recapReaches(reach({ targetSchools: [B] }), student()), false);
  assert.equal(recapReaches(reach({ targetSchools: [A] }), student()), true);
  assert.equal(recapReaches(reach({ targetClasses: [{ schoolId: A, klasseId: 7 }] }), student()), true);
  // A class id names a class of one school only.
  assert.equal(recapReaches(reach({ targetClasses: [{ schoolId: B, klasseId: 7 }] }), student()), false);
  assert.equal(recapReaches(reach({ targetClasses: [{ schoolId: A, klasseId: 8 }] }), student()), false);
  assert.equal(recapReaches(reach({ targetUsers: ['u1'] }), student()), true);
  assert.equal(recapReaches(reach({ targetUsers: ['u2'] }), student()), false);
  // Any mix: one match is enough.
  assert.equal(recapReaches(reach({ targetSchools: [B], targetUsers: ['u1'] }), student()), true);
});

test('a school recap never reaches another school, even a chosen student there', () => {
  assert.equal(recapReaches(reach({ schoolId: A, targetUsers: ['u1'] }), student({ schoolId: B })), false);
});

test('parents only when chosen by name', () => {
  const parent = student({ role: 'parent' });
  assert.equal(recapReaches(reach(), parent), false);
  assert.equal(recapReaches(reach({ targetSchools: [A] }), parent), false);
  assert.equal(recapReaches(reach({ targetUsers: ['u1'] }), parent), true);
});

test('an account without a class is reached by school or name only', () => {
  const none = student({ klasseId: 0 });
  assert.equal(recapReaches(reach({ targetClasses: [{ schoolId: A, klasseId: 0 }] }), none), false);
  assert.equal(recapReaches(reach({ targetSchools: [A] }), none), true);
});

test('sections: empty means every part, the story order is kept', () => {
  assert.deepEqual(parseSections(''), [...RECAP_SECTIONS]);
  assert.deepEqual(parseSections('pokyh,school,nonsense'), ['school', 'pokyh']);
  assert.equal(formatSections([...RECAP_SECTIONS]), '');
  assert.equal(formatSections(['grades', 'school']), 'school,grades');
});

test('status follows the switch and the window', () => {
  const now = Date.parse('2026-06-15T12:00:00Z');
  const at = (iso) => new Date(iso);
  assert.equal(recapStatus({ enabled: false, startsAt: null, endsAt: null }, now), 'disabled');
  assert.equal(recapStatus({ enabled: true, startsAt: null, endsAt: null }, now), 'active');
  assert.equal(recapStatus({ enabled: true, startsAt: at('2026-06-20T00:00:00Z'), endsAt: null }, now), 'scheduled');
  assert.equal(recapStatus({ enabled: true, startsAt: null, endsAt: at('2026-06-15T12:00:00Z') }, now), 'expired');
});

test('the covered period stops today and is null before it begins', () => {
  assert.deepEqual(coveredPeriod('2025-09-01', '2026-06-30', '2026-05-10'), { from: '2025-09-01', to: '2026-05-10' });
  assert.deepEqual(coveredPeriod('2025-09-01', '2026-06-30', '2026-08-01'), { from: '2025-09-01', to: '2026-06-30' });
  assert.equal(coveredPeriod('2026-09-01', '2027-06-30', '2026-08-01'), null);
});

test('top percent: among enough people, never for nothing', () => {
  const others = [1, 2, 3, 4, 5, 6, 7, 8, 9]; // 10 people with me
  assert.equal(topPercent(10, others), 10);
  assert.equal(topPercent(5, others), 60);
  assert.equal(topPercent(0, others), null);
  assert.equal(topPercent(10, [1, 2, 3]), null);
  // At least 1 %, even as the best of a large school.
  assert.equal(topPercent(500, Array.from({ length: 999 }, () => 1)), 1);
});

test('day keys are real calendar days', () => {
  assert.equal(isDayKey('2026-02-28'), true);
  assert.equal(isDayKey('2026-02-30'), false);
  assert.equal(isDayKey('2026-2-3'), false);
});

test('archived days count as active, with their sign-ins and time', () => {
  const s = summarizeActivity({
    days: ['2025-06-01', '2025-06-02', '2025-06-03'],
    accountDays: [],
    sessions: [],
    signIns: [],
    archived: [['2025-06-01', 2, 600], ['2025-06-02', 0, 0], ['2024-01-01', 9, 9]],
  });
  assert.equal(s.totals.activeDays, 2);
  assert.equal(s.totals.logins, 2);
  assert.equal(s.totals.activeSeconds, 600);
  assert.equal(s.totals.longestStreak, 2);
  // No hours or devices are known for them.
  assert.equal(s.hours.reduce((a, b) => a + b, 0), 0);
  assert.equal(s.platforms.web, 0);
});
