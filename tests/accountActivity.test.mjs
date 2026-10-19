import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './helpers/loadTs.mjs';

const { summarizeActivity, topPages, schoolYearStartKey, signInDays, archiveSummary } = await loadTs('src/services/accountActivitySummary.ts');

const days = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'];

test('a day is active from requests, consented visits or a sign-in', () => {
  const s = summarizeActivity({
    days,
    accountDays: [{ dayKey: '2026-10-12', device: 'desktop', client: 'web' }],
    sessions: [{ dayKey: '2026-10-13', startHour: 9, activeSeconds: 600, screens: 4 }],
    signIns: ['2026-10-14', '2026-10-14'],
  });
  assert.deepEqual(s.days.map((d) => d.active), [true, true, true, false, false, false, false]);
  assert.equal(s.totals.activeDays, 3);
  assert.equal(s.totals.logins, 2);
  assert.equal(s.days[2].logins, 2);
  assert.equal(s.totals.activeSeconds, 600);
  assert.equal(s.totals.visits, 1);
  assert.equal(s.totals.screens, 4);
  assert.equal(s.hours[9], 600);
});

test('rows outside the window are ignored', () => {
  const s = summarizeActivity({
    days,
    accountDays: [{ dayKey: '2026-09-01', device: 'ios', client: 'app' }],
    sessions: [{ dayKey: '2026-09-01', startHour: 8, activeSeconds: 100, screens: 1 }],
    signIns: ['2026-09-01'],
  });
  assert.equal(s.totals.activeDays, 0);
  assert.equal(s.totals.logins, 0);
  assert.equal(s.totals.activeSeconds, 0);
});

test('streaks: the longest run, and a quiet today does not end the current one', () => {
  const active = ['2026-10-12', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17'];
  const s = summarizeActivity({
    days,
    accountDays: active.map((dayKey) => ({ dayKey, device: 'android', client: 'app' })),
    sessions: [],
    signIns: [],
  });
  assert.equal(s.totals.longestStreak, 4);
  assert.equal(s.totals.currentStreak, 4);

  const broken = summarizeActivity({
    days,
    accountDays: [{ dayKey: '2026-10-15', device: 'desktop', client: 'web' }],
    sessions: [],
    signIns: [],
  });
  assert.equal(broken.totals.currentStreak, 0);
  assert.equal(broken.totals.longestStreak, 1);
});

test('weekdays and platforms count days, not requests', () => {
  const s = summarizeActivity({
    days,
    accountDays: [
      { dayKey: '2026-10-12', device: 'ios', client: 'app' },
      { dayKey: '2026-10-12', device: 'desktop', client: 'web' },
      { dayKey: '2026-10-13', device: 'android', client: 'web' },
    ],
    sessions: [],
    signIns: [],
  });
  // 2026-10-12 is a Monday.
  assert.deepEqual(s.weekdays, [1, 1, 0, 0, 0, 0, 0]);
  assert.deepEqual(s.platforms, { phone: 2, desktop: 1, app: 1, web: 2 });
});

test('top pages drop the language prefix and query', () => {
  const pages = topPages(['/de/grades/', '/it/grades/?x=1', '/de/home/', '/en/grades/subject/12/', null, '/de/']);
  assert.deepEqual(pages, [
    { page: '/grades', views: 3 },
    { page: '/', views: 1 },
    { page: '/home', views: 1 },
  ]);
});

test('the school year starts on the rollover day', () => {
  assert.equal(schoolYearStartKey('2026-10-18', 8, 1), '2026-08-01');
  assert.equal(schoolYearStartKey('2026-08-01', 8, 1), '2026-08-01');
  assert.equal(schoolYearStartKey('2026-07-31', 8, 1), '2025-08-01');
  assert.equal(schoolYearStartKey('2027-01-05', 9, 15), '2026-09-15');
});

test('counted sign-ins become one day per sign-in', () => {
  assert.deepEqual(signInDays([{ dayKey: '2026-10-14', signIns: 2 }, { dayKey: '2026-10-15', signIns: 0 }, { dayKey: '2026-10-16' }]), ['2026-10-14', '2026-10-14']);
});

test('the archive keeps the figures and only the active days', () => {
  const s = summarizeActivity({ days, accountDays: [{ dayKey: '2026-10-13', device: 'ios', client: 'app' }], sessions: [], signIns: ['2026-10-13'] });
  const a = archiveSummary(s, '2026-08-01', '2027-07-31');
  assert.equal(a.from, '2026-08-01');
  assert.equal(a.totals.activeDays, 1);
  assert.deepEqual(a.days, [['2026-10-13', 1, 0]]);
});
