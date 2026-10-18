import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './helpers/loadTs.mjs';

const policy = await loadTs('src/security/adminSecondFactorPolicy.ts');
const none = { totp: false, passkey: false };

test('an account follows the installation default until it is set', () => {
  assert.equal(policy.secondFactorRequired(null, false, true), true);
  assert.equal(policy.secondFactorRequired(undefined, false, false), false);
  assert.equal(policy.secondFactorRequired(false, false, true), false);
  assert.equal(policy.secondFactorRequired(true, false, false), true);
});

test('server owners always follow the installation default', () => {
  assert.equal(policy.secondFactorRequired(false, true, true), true);
  assert.equal(policy.secondFactorRequired(true, true, false), false);
});

test('required without any factor: only the set-up is open', () => {
  assert.equal(policy.secondFactorSetupPending(true, none), true);
  assert.equal(policy.secondFactorSetupPending(true, { totp: true, passkey: false }), false);
  assert.equal(policy.secondFactorSetupPending(true, { totp: false, passkey: true }), false);
  assert.equal(policy.secondFactorSetupPending(false, none), false);
});

test('the last factor cannot go while one is required', () => {
  assert.equal(policy.mayRemoveFactor(true, none), false);
  assert.equal(policy.mayRemoveFactor(true, { totp: false, passkey: true }), true);
  assert.equal(policy.mayRemoveFactor(false, none), true);
});

test('lowering the own requirement takes another admin; owners follow the .env', () => {
  const base = { installationDefault: true };
  assert.equal(policy.requirementChange({ ...base, self: true, targetOwner: false, required: false }), 'self-lower');
  assert.equal(policy.requirementChange({ ...base, self: true, targetOwner: false, required: true }), 'ok');
  assert.equal(policy.requirementChange({ ...base, self: true, targetOwner: false, required: null }), 'ok');
  assert.equal(policy.requirementChange({ installationDefault: false, self: true, targetOwner: false, required: null }), 'self-lower');
  assert.equal(policy.requirementChange({ ...base, self: false, targetOwner: false, required: false }), 'ok');
  assert.equal(policy.requirementChange({ ...base, self: false, targetOwner: true, required: true }), 'owner');
});
