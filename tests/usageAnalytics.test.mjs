import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './helpers/loadTs.mjs';

const {
  classifyUserAgent,
  creditedSeconds,
  dayAxis,
  lengthBandOf,
  localDayAndHour,
  platformOf,
  startOfLocalDay,
  weekdayOf,
  MAX_PING_SECONDS,
  MAX_SESSION_SECONDS,
} = await loadTs('src/services/usageAnalytics.ts');

test('user agents are sorted into device families', () => {
  const cases = [
    ['okhttp/5.5.0', { device: 'android', client: 'app' }],
    ['POKYH/42 CFNetwork/1568.100.1 Darwin/24.0.0', { device: 'ios', client: 'app' }],
    ['Dart/3.5 (dart:io)', { device: 'other', client: 'app' }],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', { device: 'ios', client: 'web' }],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36', { device: 'android', client: 'web' }],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36', { device: 'desktop', client: 'web' }],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', { device: 'desktop', client: 'web' }],
  ];
  for (const [ua, expected] of cases) assert.deepEqual(classifyUserAgent(ua), expected, ua);
});

test('servers, scripts and bots are not counted as a device', () => {
  for (const ua of ['', null, undefined, 'node', 'undici', 'curl/8.4.0', 'python-requests/2.31', 'Mozilla/5.0 (compatible; Googlebot/2.1)', 'Mozilla/5.0 HeadlessChrome/120']) {
    assert.equal(classifyUserAgent(ua), null, String(ua));
  }
});

test('a ping is credited no more than the wall clock allows', () => {
  assert.equal(creditedSeconds(60, 60_000, 0), 60);
  assert.equal(creditedSeconds(600, 60_000, 0), 65, 'a minute between pings plus slack');
  assert.equal(creditedSeconds(10_000, 3_600_000, 0), MAX_PING_SECONDS);
  assert.equal(creditedSeconds(60, 60_000, MAX_SESSION_SECONDS), 0, 'a full visit stops growing');
  assert.equal(creditedSeconds(60, 60_000, MAX_SESSION_SECONDS - 10), 10);
  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(creditedSeconds(bad, 60_000, 0), 0, String(bad));
  assert.equal(creditedSeconds(30, -1000, 0), 5, 'a clock running backwards still credits only the slack');
});

test('days and hours follow the analytics timezone across DST', () => {
  // 22:30 UTC in summer is already the next day in Rome (UTC+2).
  assert.deepEqual(localDayAndHour(new Date('2026-07-01T22:30:00Z'), 'Europe/Rome'), { dayKey: '2026-07-02', hour: 0 });
  // In winter (UTC+1) 22:30 UTC is 23:30 on the same day.
  assert.deepEqual(localDayAndHour(new Date('2026-01-15T22:30:00Z'), 'Europe/Rome'), { dayKey: '2026-01-15', hour: 23 });
  // An unknown zone falls back to UTC instead of throwing.
  assert.deepEqual(localDayAndHour(new Date('2026-01-15T22:30:00Z'), 'Mars/Olympus'), { dayKey: '2026-01-15', hour: 22 });
});

test('local midnight is found on both sides of a DST change', () => {
  assert.equal(startOfLocalDay('2026-07-02', 'Europe/Rome').toISOString(), '2026-07-01T22:00:00.000Z');
  assert.equal(startOfLocalDay('2026-01-15', 'Europe/Rome').toISOString(), '2026-01-14T23:00:00.000Z');
  // The day the clocks go forward (29 March 2026) still starts at 00:00 CET.
  assert.equal(startOfLocalDay('2026-03-29', 'Europe/Rome').toISOString(), '2026-03-28T23:00:00.000Z');
  assert.equal(startOfLocalDay('2026-03-30', 'Europe/Rome').toISOString(), '2026-03-29T22:00:00.000Z');
});

test('the day axis has exactly the requested number of distinct days', () => {
  const now = new Date('2026-10-26T10:00:00Z'); // the day after the clocks go back
  const axis = dayAxis(30, 'Europe/Rome', now);
  assert.equal(axis.length, 30);
  assert.equal(new Set(axis).size, 30);
  assert.equal(axis.at(-1), '2026-10-26');
  assert.equal(axis[0], '2026-09-27');
  assert.deepEqual([...axis].sort(), axis);
});

test('weekdays start on Monday and session lengths fall into bands', () => {
  assert.equal(weekdayOf('2026-10-12'), 0); // Monday
  assert.equal(weekdayOf('2026-10-18'), 6); // Sunday
  assert.equal(lengthBandOf(0), 0);
  assert.equal(lengthBandOf(59), 0);
  assert.equal(lengthBandOf(60), 1);
  assert.equal(lengthBandOf(899), 2);
  assert.equal(lengthBandOf(1800), 4);
  assert.equal(lengthBandOf(100_000), 4);
});

test('only the native apps count as iPhone or Android; every browser is web', () => {
  assert.equal(platformOf('ios', 'app'), 'ios');
  assert.equal(platformOf('android', 'app'), 'android');
  assert.equal(platformOf('other', 'app'), 'other');
  for (const device of ['ios', 'android', 'desktop', 'other']) {
    assert.equal(platformOf(device, 'browser'), 'web', device);
    assert.equal(platformOf(device, 'pwa'), 'web', device);
    assert.equal(platformOf(device, 'web'), 'web', device);
  }
});
