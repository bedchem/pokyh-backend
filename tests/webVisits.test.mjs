import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadTs } from './helpers/loadTs.mjs';

const {
  normaliseIp,
  isInternalIp,
  visitorIp,
  countryFromHeader,
  placeFromHeader,
  sendsGpc,
  visitPage,
  visitorSource,
} = await loadTs('src/services/webVisitMeta.ts');

test('addresses are normalised and anything else is refused', () => {
  assert.equal(normaliseIp(' 203.0.113.7 '), '203.0.113.7');
  assert.equal(normaliseIp('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(normaliseIp('2001:DB8::1'), '2001:db8::1');
  assert.equal(normaliseIp('999.1.1.1'), null);
  assert.equal(normaliseIp('unknown'), null);
  assert.equal(normaliseIp('<script>'), null);
  assert.equal(normaliseIp(''), null);
  assert.equal(normaliseIp(null), null);
  assert.equal(normaliseIp('1'.repeat(46)), null);
});

test('internal addresses are recognised', () => {
  for (const ip of ['10.0.0.1', '127.0.0.1', '172.16.4.2', '172.31.255.1', '192.168.1.20', '169.254.0.1', '100.64.0.1', '::1', 'fd12:3456::1', 'fe80::1']) {
    assert.equal(isInternalIp(ip), true, ip);
  }
  for (const ip of ['203.0.113.7', '172.32.0.1', '8.8.8.8', '2001:db8::1']) {
    assert.equal(isInternalIp(ip), false, ip);
  }
});

test('behind a local proxy the edge header names the visitor, otherwise the direct address wins', () => {
  // Cloudflare Tunnel: the connector connects from inside the network.
  assert.equal(visitorIp('172.18.0.5', '198.51.100.23'), '198.51.100.23');
  assert.equal(visitorIp('::ffff:127.0.0.1', ['198.51.100.23']), '198.51.100.23');
  // A public peer cannot choose its address through the header.
  assert.equal(visitorIp('203.0.113.7', '198.51.100.23'), '203.0.113.7');
  // No usable header: the direct address, internal or not.
  assert.equal(visitorIp('172.18.0.5', 'garbage'), '172.18.0.5');
  assert.equal(visitorIp(undefined, undefined), null);
});

test('a signed-in visitor counts by account, a guest by device', () => {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0';
  // Three accounts on one browser are three visitors…
  const accounts = ['a', 'b', 'c'].map((uid) => visitorSource(uid, '203.0.113.7', ua));
  assert.equal(new Set(accounts).size, 3);
  // …one account on two devices is one…
  assert.equal(visitorSource('a', '203.0.113.7', ua), visitorSource('a', '198.51.100.1', 'Mozilla/5.0 (iPhone)'));
  // …and guests are told apart by address and browser.
  assert.equal(visitorSource(null, '203.0.113.7', ua), visitorSource(null, '203.0.113.7', ua));
  assert.notEqual(visitorSource(null, '203.0.113.7', ua), visitorSource(null, '203.0.113.8', ua));
  assert.notEqual(visitorSource(null, '203.0.113.7', ua), visitorSource('a', '203.0.113.7', ua));
});

test('the cleanup rekeys signed-in visits with the very formula the count uses', () => {
  // visitorKeyFor hashes `${salt}:${source}`; the SQL in index.ts must build
  // the same string from the stored account key.
  assert.equal(visitorSource('0123456789abcdef', '203.0.113.7', 'ua'), 'web-account:0123456789abcdef');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const index = readFileSync(join(root, 'src', 'index.ts'), 'utf8');
  const job = index.slice(index.indexOf('async function cleanupWebVisits'), index.indexOf('let backgroundJobsStarted'));
  assert.ok(job.includes("LEFT(SHA2(CONCAT(s.salt, ':web-account:', w.account_key), 256), 16)"), 'same string, same hash, same length');
  assert.ok(job.includes('JOIN usage_day_salts s ON s.day_key = w.day_key'), 'only while the day salt exists');
});

test('countries are two-letter codes, unknown and Tor are none', () => {
  assert.equal(countryFromHeader('it'), 'IT');
  assert.equal(countryFromHeader(['AT']), 'AT');
  assert.equal(countryFromHeader('XX'), '');
  assert.equal(countryFromHeader('T1'), '');
  assert.equal(countryFromHeader('Italy'), '');
  assert.equal(countryFromHeader(undefined), '');
});

test('place names arrive decoded and bounded', () => {
  assert.equal(placeFromHeader('Bolzano'), 'Bolzano');
  // UTF-8 bytes read as Latin-1, as Node hands them over.
  const garbled = Buffer.from('Sankt Pölten', 'utf8').toString('latin1');
  assert.equal(placeFromHeader(garbled), 'Sankt Pölten');
  // Real Latin-1 that is not UTF-8 stays as it is.
  assert.equal(placeFromHeader('Mötling'), 'Mötling');
  assert.equal(placeFromHeader('  '), null);
  assert.equal(placeFromHeader('a\u0000b'), 'ab');
  assert.equal(placeFromHeader('x'.repeat(200)).length, 80);
});

test('the Global Privacy Control signal is read', () => {
  assert.equal(sendsGpc('1'), true);
  assert.equal(sendsGpc(' 1 '), true);
  assert.equal(sendsGpc('0'), false);
  assert.equal(sendsGpc(undefined), false);
});

test('pages lose language, query, ids and the trailing slash', () => {
  assert.equal(visitPage('/de/timetable/'), '/timetable');
  assert.equal(visitPage('/it/messages/123/?x=1'), '/messages/:id');
  assert.equal(visitPage('/en/grades/subject/9f3a2c11-aa'), '/grades/subject/:id');
  assert.equal(visitPage('/de/'), '/');
  assert.equal(visitPage('/'), '/');
  assert.equal(visitPage('https://evil.example/'), '');
  assert.equal(visitPage(undefined), '');
  assert.equal(visitPage(`/${'z'.repeat(300)}`).length, 200);
});

test('expired website visits lose their address and place instead of being deleted', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const index = readFileSync(join(root, 'src', 'index.ts'), 'utf8');
  const job = index.slice(index.indexOf('async function cleanupWebVisits'), index.indexOf('let backgroundJobsStarted'));
  assert.ok(job.includes('SET ip = NULL, region = NULL, city = NULL, stable_uid = NULL, account_key = NULL'), 'the job removes address, place, name and account key');
  assert.ok(job.includes('privacy_consents WHERE usage_stats = 1'), 'names stay only with consent');
  assert.ok(job.includes('config.requestLogRetentionDays'), 'the job keeps addresses as long as the request logs');
  assert.ok(!/DELETE\s+FROM|deleteMany/i.test(job), 'the job never deletes rows');
  assert.ok(index.includes('cleanupWebVisits().catch'), 'the job is scheduled');
});
