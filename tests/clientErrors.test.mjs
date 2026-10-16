import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './helpers/loadTs.mjs';

const { cleanReport, scrub, cleanPage, browserFamily, LIMITS } = await loadTs('src/security/clientErrorSanitizer.ts');
const { endpointOf } = await loadTs('src/utils/endpoint.ts');

test('tokens, credentials, e-mail addresses and query strings never survive', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdGFibGVVaWQiOiJhYmMifQ.c2lnbmF0dXJlc2lnbmF0dXJl';
  const text = scrub(`fetch https://api.pokyh.com/auth/refresh?token=${jwt}&x=1 failed: Bearer abc.def password=hunter2 for max@example.org key ${'a'.repeat(40)}`);
  assert.ok(!text.includes(jwt));
  assert.ok(!text.includes('hunter2'));
  assert.ok(!text.includes('max@example.org'));
  assert.ok(!text.includes('token='));
  assert.ok(!text.includes('a'.repeat(40)));
  assert.ok(text.includes('/auth/refresh'));
});

test('a report is cut to size and keeps no full URL', () => {
  const report = cleanReport({
    source: 'web',
    message: 'word '.repeat(1000),
    name: 'TypeError<script>',
    stack: Array.from({ length: 100 }, (_, i) => `at f${i} (https://pokyh.com/_next/static/chunks/main.js?v=1:1:${i})`).join('\n'),
    page: 'https://pokyh.com/de/mensa?session=abc#top',
    release: '1.2.3',
  });
  assert.ok(report);
  assert.equal(report.message.length, LIMITS.message);
  assert.equal(report.name, 'TypeErrorscript');
  assert.equal(report.page, '/de/mensa');
  assert.ok(report.stack.split('\n').length <= LIMITS.stackLines);
  assert.ok(!report.stack.includes('https://'));
  assert.match(report.fingerprint, /^[0-9a-f]{16}$/);
});

test('only the apps may report as the apps; "admin" is the server’s to set', () => {
  assert.equal(cleanReport({ source: 'admin', message: 'x' }), null);
  assert.equal(cleanReport({ source: 'web' }), null);
  assert.equal(cleanReport('not an object'), null);
  assert.equal(cleanReport({ source: 'web', message: 'x' }, 'admin').source, 'admin');
});

test('the same error groups together although numbers differ', () => {
  const a = cleanReport({ source: 'web', message: 'Cannot read 12 of undefined', stack: 'at x (/a.js:1:2)' });
  const b = cleanReport({ source: 'web', message: 'Cannot read 99 of undefined', stack: 'at x (/a.js:7:9)' });
  assert.equal(a.fingerprint, b.fingerprint);
});

test('pages keep their path only', () => {
  assert.equal(cleanPage('/de/todos?x=1'), '/de/todos');
  assert.equal(cleanPage('javascript:alert(1)'), '');
  assert.equal(cleanPage(42), '');
});

test('the browser is a family, never the user-agent string', () => {
  assert.equal(browserFamily('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'), 'Safari 18');
  assert.equal(browserFamily('okhttp/4.12.0'), 'Android-App');
  assert.equal(browserFamily(undefined), '');
});

test('request paths group by route, not by id', () => {
  assert.equal(endpointOf('/api/admin/users/5f3a9c1e2b4d6f8a0b1c2d3e4f5a6b7c/todos/0a1b2c3d-1111-2222-3333-444455556666'), '/api/admin/users/:id/todos/:id');
  assert.equal(endpointOf('/users/me'), '/users/me');
  assert.equal(endpointOf('/dish-ratings/batch'), '/dish-ratings/batch');
  assert.equal(endpointOf('/dish-ratings/spaghetti-bolognese'), '/dish-ratings/:id');
  assert.equal(endpointOf('/classes/mine'), '/classes/mine');
  assert.equal(endpointOf('/api/admin/analytics'), '/api/admin/analytics');
  assert.equal(endpointOf('/api/admin/dishes/import-url'), '/api/admin/dishes/import-url');
  assert.equal(endpointOf('/toString/constructor'), '/toString/constructor');
});
