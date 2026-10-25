import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { loadTs } from './helpers/loadTs.mjs';

const { readUnlock, unlockPayload, websiteRelyingParty } = await loadTs('src/webuntis/deviceUnlock.ts');
const { renewalPayload } = await loadTs('src/webuntis/renewal.ts');
const { sealWith, unsealWith } = await loadTs('src/webuntis/seal.ts');

const key = randomBytes(32);
const school = { loginName: 'lbs-brixen', server: 'lbs-brixen.webuntis.com', name: 'LBS Brixen' };
const signIn = { username: 'anna.muster', password: 'geheim', school };
const parseSchool = (v) => (v && typeof v.loginName === 'string' && typeof v.server === 'string'
  ? { loginName: v.loginName, server: v.server, ...(typeof v.name === 'string' ? { name: v.name } : {}) }
  : null);

// What the API does with the cookie (webuntis/session.ts readUnlockCookie).
const roundTrip = (unlock) => readUnlock(unsealWith(key, sealWith(key, unlockPayload(unlock))), parseSchool);

test('the unlock cookie is sealed, not readable', () => {
  const value = sealWith(key, unlockPayload({ uid: 'u1', cid: 'c1', signIn }));
  assert.ok(!value.includes('geheim') && !value.includes('anna') && !value.includes('c1'));
});

test('a WebUntis account keeps its sign-in, with the password or the app key', () => {
  assert.deepEqual(roundTrip({ uid: 'u1', cid: 'c1', signIn }), { uid: 'u1', cid: 'c1', signIn });
  const withKey = { username: 'anna.muster', key: 'ABCDEFGHIJKLMNOP', school };
  assert.deepEqual(roundTrip({ uid: 'u1', cid: 'c1', signIn: withKey }), { uid: 'u1', cid: 'c1', signIn: withKey });
});

test('a POKYH-only account, or one whose password WebUntis refused, holds no sign-in', () => {
  assert.deepEqual(roundTrip({ uid: 'u1', cid: 'c1' }), { uid: 'u1', cid: 'c1' });
});

test('only an unlock cookie counts: not the renewal cookie, not a broken one', () => {
  assert.equal(readUnlock(unsealWith(key, sealWith(key, renewalPayload(signIn))), parseSchool), null);
  assert.equal(readUnlock(null, parseSchool), null);
  assert.equal(readUnlock({ kind: 'unlock', uid: 'u1' }, parseSchool), null);
  assert.equal(readUnlock({ kind: 'unlock', uid: '', cid: 'c1' }, parseSchool), null);
  assert.equal(unsealWith(randomBytes(32), sealWith(key, unlockPayload({ uid: 'u1', cid: 'c1' }))), null);
});

test('a sign-in without a usable school is left out, the passkey stays', () => {
  const sealed = { ...unlockPayload({ uid: 'u1', cid: 'c1', signIn }), s: { loginName: 'x' } };
  assert.deepEqual(readUnlock(sealed, parseSchool), { uid: 'u1', cid: 'c1' });
});

test('passkeys are made only on the website\'s own addresses', () => {
  const allowed = ['https://pokyh.com', 'https://www.pokyh.com'];
  assert.deepEqual(websiteRelyingParty('https://pokyh.com', allowed, false), { origin: 'https://pokyh.com', rpId: 'pokyh.com' });
  // Both addresses share one passkey domain.
  assert.deepEqual(websiteRelyingParty('https://www.pokyh.com', allowed, false), { origin: 'https://www.pokyh.com', rpId: 'pokyh.com' });
  assert.equal(websiteRelyingParty('https://evil.example', allowed, false), null);
  assert.equal(websiteRelyingParty('https://pokyh.com.evil.example', allowed, false), null);
  assert.equal(websiteRelyingParty(undefined, allowed, false), null);
  assert.equal(websiteRelyingParty('https://evil.example', [], false), null);
  // Plain http only for localhost, and localhost only in development.
  assert.equal(websiteRelyingParty('http://pokyh.com', ['http://pokyh.com'], false), null);
  assert.equal(websiteRelyingParty('http://localhost:3011', allowed, false), null);
  assert.deepEqual(websiteRelyingParty('http://localhost:3011', allowed, true), { origin: 'http://localhost:3011', rpId: 'localhost' });
  assert.equal(websiteRelyingParty('http://localhost.evil.example', allowed, true), null);
});
