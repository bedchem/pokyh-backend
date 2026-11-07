import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './helpers/loadTs.mjs';

const { IDENTITY_FAILURES, claimedLoginName, normalizedLoginName, sessionIdentity } = await loadTs('src/webuntis/identity.ts');

test('login names compare Unicode-normalised, trimmed and in lower case', () => {
  assert.equal(normalizedLoginName('  Max.Muster '), 'max.muster');
  // A full-width letter is the same login after NFKC.
  assert.equal(normalizedLoginName('ｍax'), 'max');
  assert.equal(normalizedLoginName(undefined), '');
  assert.equal(normalizedLoginName(42), '');
});

test('the token names a login only by a name-like claim, never by a bare number', () => {
  assert.equal(claimedLoginName({ sub: '4711' }), '');
  assert.equal(claimedLoginName({ sub: '4711', username: 'max.muster' }), 'max.muster');
  assert.equal(claimedLoginName({ sub: 'max.muster' }), 'max.muster');
  assert.equal(claimedLoginName({ preferred_username: ' max ' }), 'max');
  assert.equal(claimedLoginName(null), '');
  assert.equal(claimedLoginName({ name: 'Max Muster' }), '');
});

test('a session is the account\'s when WebUntis names that login for it', () => {
  assert.deepEqual(sessionIdentity({ username: 'max.muster', appLoginName: 'Max.Muster' }), { ok: true, loginName: 'max.muster' });
  // Without an app-data name the token's claim decides.
  assert.deepEqual(sessionIdentity({ username: 'max.muster', claims: { sub: 'max.muster' } }), { ok: true, loginName: 'max.muster' });
  // The app-data comes first: a token that names someone else does not override it.
  assert.equal(sessionIdentity({ username: 'max.muster', appLoginName: 'max.muster', claims: { sub: 'x' } }).ok, true);
});

test('another account\'s session, or one WebUntis names nobody for, is refused', () => {
  assert.deepEqual(sessionIdentity({ username: 'max.muster', appLoginName: 'eva.muster' }), { ok: false, code: 'account_mismatch' });
  assert.deepEqual(sessionIdentity({ username: 'max.muster', claims: { sub: 'eva.muster' } }), { ok: false, code: 'account_mismatch' });
  assert.deepEqual(sessionIdentity({ username: 'max.muster' }), { ok: false, code: 'untis_identity_unverified' });
  assert.deepEqual(sessionIdentity({ username: 'max.muster', appLoginName: '', claims: { sub: '4711' } }), { ok: false, code: 'untis_identity_unverified' });
});

test('with the school\'s tenant known, only a session of that tenant counts — the name alone is not enough', () => {
  const base = { username: 'max.muster', appLoginName: 'max.muster', expectedTenantId: '1234500' };
  assert.equal(sessionIdentity({ ...base, tenantId: '1234500' }).ok, true);
  assert.deepEqual(sessionIdentity({ ...base, tenantId: '9999900' }), { ok: false, code: 'tenant_mismatch' });
  assert.deepEqual(sessionIdentity({ ...base }), { ok: false, code: 'untis_identity_unverified' });
  // An unknown tenant binds nothing yet.
  assert.equal(sessionIdentity({ ...base, expectedTenantId: null }).ok, true);
});

test('every failure has an answer: 401 for a session to renew, 403 for the wrong account, 503 when WebUntis is away', () => {
  assert.equal(IDENTITY_FAILURES.untis_session_invalid.status, 401);
  assert.equal(IDENTITY_FAILURES.untis_identity_unverified.status, 401);
  assert.equal(IDENTITY_FAILURES.account_mismatch.status, 403);
  assert.equal(IDENTITY_FAILURES.tenant_mismatch.status, 403);
  assert.equal(IDENTITY_FAILURES.webuntis_unavailable.status, 503);
  for (const failure of Object.values(IDENTITY_FAILURES)) assert.ok(failure.error.length > 10);
});
