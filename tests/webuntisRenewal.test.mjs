import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { loadTs } from './helpers/loadTs.mjs';

const { matchRenewal, renewalPayload } = await loadTs('src/webuntis/renewal.ts');
const { sealWith, unsealWith } = await loadTs('src/webuntis/seal.ts');

const key = randomBytes(32);
const HOURS = 4;
const school = { loginName: 'lbs-brixen', server: 'lbs-brixen.webuntis.com', name: 'LBS Brixen' };
const signIn = { username: 'anna.muster', password: 'geheim', school };

// The school list is configuration; a stand-in that accepts any well-formed school.
const rules = (over = {}) => ({
  now: Date.now(),
  maxAgeMs: HOURS * 3600_000,
  defaultSchool: { loginName: 'default-school', server: 'default.webuntis.com' },
  parseSchool: (v) => (v && typeof v.loginName === 'string' && typeof v.server === 'string'
    ? { loginName: v.loginName, server: v.server, ...(typeof v.name === 'string' ? { name: v.name } : {}) }
    : null),
  ...over,
});

const sealedRenewal = (sign = signIn) => sealWith(key, renewalPayload(sign));
const sealedSession = (data = {}) => sealWith(key, { sessionId: 's1', username: 'anna.muster', school, loginAt: Date.now(), ...data });
// What the API does with the two cookies (webuntis/session.ts openRenewal).
const open = (renewal, session) => matchRenewal(unsealWith(key, renewal), unsealWith(key, session), rules());

test('the renewal is sealed, not readable', () => {
  const value = sealedRenewal();
  assert.ok(!value.includes('geheim') && !value.includes('anna'));
});

test('a session with its renewal cookie can be renewed', () => {
  assert.deepEqual(open(sealedRenewal(), sealedSession()), signIn);
});

test('without the session cookie (deleted, expired) there is nothing to renew', () => {
  assert.equal(open(sealedRenewal(), undefined), null);
  assert.equal(open(undefined, sealedSession()), null);
  assert.equal(open(undefined, undefined), null);
});

test('the renewal only belongs to its own session', () => {
  const renew = sealedRenewal();
  assert.equal(open(renew, sealedSession({ username: 'someone.else' })), null);
  assert.equal(open(renew, sealedSession({ school: { loginName: 'other', server: 'other.webuntis.com' } })), null);
  assert.equal(open(renew, sealedSession({ loginAt: Date.now() - (HOURS + 1) * 3600_000 })), null);
});

test('sessions from before schools renew at the default school only', () => {
  const old = sealedSession({ school: undefined });
  const atDefault = sealedRenewal({ ...signIn, school: { loginName: 'default-school', server: 'default.webuntis.com' } });
  assert.equal(open(atDefault, old)?.school.loginName, 'default-school');
  assert.equal(open(sealedRenewal(), old), null);
});

test('other sealed values, other keys and tampered values are refused', () => {
  const current = sealedSession();
  assert.equal(open(current, current), null);
  const renew = sealedRenewal();
  const tampered = renew.slice(0, -2) + (renew.endsWith('A') ? 'BB' : 'AA');
  assert.equal(open(tampered, current), null);
  assert.equal(unsealWith(randomBytes(32), renew), null);
});
