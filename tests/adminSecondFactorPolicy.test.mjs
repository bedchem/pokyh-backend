import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './helpers/loadTs.mjs';

const policy = await loadTs('src/security/adminSecondFactorPolicy.ts');
const server = { totp: true, passkey: false };
const none = { totp: false, passkey: false };

test('the authenticator app is required for everyone; a passkey follows the account, then the server', () => {
  assert.deepEqual(policy.requirementsFor(null, false, server), { totp: true, passkey: false });
  assert.deepEqual(policy.requirementsFor(true, false, server), { totp: true, passkey: true });
  assert.deepEqual(policy.requirementsFor(false, false, { totp: true, passkey: true }), { totp: true, passkey: false });
  assert.deepEqual(policy.requirementsFor(undefined, false, { totp: true, passkey: true }), { totp: true, passkey: true });
});

test('server owners always follow the server settings', () => {
  assert.deepEqual(policy.requirementsFor(true, true, server), { totp: true, passkey: false });
  assert.deepEqual(policy.requirementsFor(false, true, { totp: true, passkey: true }), { totp: true, passkey: true });
});

test('whatever is required and missing has to be set up first', () => {
  const both = { totp: true, passkey: true };
  assert.deepEqual(policy.missingFactors(both, none), ['totp', 'passkey']);
  assert.deepEqual(policy.missingFactors(both, { totp: true, passkey: false }), ['passkey']);
  assert.equal(policy.setupPending({ totp: true, passkey: false }, { totp: false, passkey: true }), true, 'a passkey does not replace the app');
  assert.equal(policy.setupPending({ totp: true, passkey: false }, { totp: true, passkey: false }), false);
  assert.equal(policy.setupPending({ totp: false, passkey: false }, none), false);
});

test('a required factor cannot go while it is the last of its kind', () => {
  const required = { totp: true, passkey: true };
  assert.equal(policy.mayRemoveFactor('totp', required, { totp: false, passkey: true }), false);
  assert.equal(policy.mayRemoveFactor('passkey', required, { totp: true, passkey: false }), false);
  assert.equal(policy.mayRemoveFactor('passkey', required, { totp: true, passkey: true }), true, 'another passkey is left');
  assert.equal(policy.mayRemoveFactor('passkey', { totp: true, passkey: false }, { totp: true, passkey: false }), true);
});

test('a required passkey confirms the login; otherwise whatever is set up', () => {
  assert.deepEqual(policy.loginSteps({ totp: true, passkey: true }, { totp: true, passkey: true }), { totp: false, passkey: true });
  assert.deepEqual(policy.loginSteps({ totp: true, passkey: true }, { totp: true, passkey: false }), { totp: true, passkey: false }, 'not set up yet: the app, then the set-up');
  assert.deepEqual(policy.loginSteps({ totp: true, passkey: false }, { totp: true, passkey: true }), { totp: true, passkey: true });
  assert.deepEqual(policy.loginSteps({ totp: true, passkey: false }, none), none);
});

test('lowering the own passkey requirement takes another admin; owners follow the .env', () => {
  const base = { serverDefault: false };
  assert.equal(policy.requirementChange({ ...base, self: true, targetOwner: false, required: false }), 'self-lower');
  assert.equal(policy.requirementChange({ ...base, self: true, targetOwner: false, required: null }), 'self-lower');
  assert.equal(policy.requirementChange({ ...base, self: true, targetOwner: false, required: true }), 'ok');
  assert.equal(policy.requirementChange({ serverDefault: true, self: true, targetOwner: false, required: null }), 'ok');
  assert.equal(policy.requirementChange({ ...base, self: false, targetOwner: false, required: false }), 'ok');
  assert.equal(policy.requirementChange({ ...base, self: false, targetOwner: true, required: true }), 'owner');
});
