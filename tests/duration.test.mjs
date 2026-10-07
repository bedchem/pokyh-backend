import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './helpers/loadTs.mjs';

const { tokenLifetimeMs, intQueryParam } = await loadTs('src/utils/duration.ts');
const FALLBACK = 24 * 60 * 60 * 1000;

test('token lifetimes are read the way the signing library reads them', () => {
  assert.equal(tokenLifetimeMs('1h', FALLBACK), 3_600_000);
  assert.equal(tokenLifetimeMs('15m', FALLBACK), 900_000);
  assert.equal(tokenLifetimeMs('7d', FALLBACK), 604_800_000);
  assert.equal(tokenLifetimeMs('2 days', FALLBACK), 172_800_000);
  assert.equal(tokenLifetimeMs(' 30S ', FALLBACK), 30_000);
  assert.equal(tokenLifetimeMs(3600, FALLBACK), 3_600_000, 'a number is seconds');
  assert.equal(tokenLifetimeMs('5000', FALLBACK), 5000, 'a bare numeric string is milliseconds');
});

test('an unreadable lifetime falls back to the long window', () => {
  for (const value of ['', 'soon', '1 fortnight', '-5m', '0', 0, -1, Number.NaN]) {
    assert.equal(tokenLifetimeMs(value, FALLBACK), FALLBACK, String(value));
  }
});

test('pagination values can never become NaN', () => {
  assert.equal(intQueryParam('3', 1, 1, 100), 3);
  assert.equal(intQueryParam(undefined, 20, 1, 100), 20);
  assert.equal(intQueryParam('abc', 20, 1, 100), 20);
  assert.equal(intQueryParam('', 20, 1, 100), 20);
  assert.equal(intQueryParam('-4', 20, 1, 100), 1);
  assert.equal(intQueryParam('9999', 20, 1, 100), 100);
  assert.equal(intQueryParam(['7', '8'], 20, 1, 100), 7);
  assert.equal(intQueryParam('12.9', 20, 1, 100), 12);
  assert.equal(intQueryParam({ a: 1 }, 20, 1, 100), 20);
});
