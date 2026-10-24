import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './helpers/loadTs.mjs';

const { readWebLoginState, twoFactorCode } = await loadTs('src/webuntis/webLoginState.ts');

test('the sign-in form\'s answers', () => {
  assert.equal(readWebLoginState({ state: 'SUCCESS' }, false), 'success');
  assert.equal(readWebLoginState({ state: 'LOGIN_ERROR', loginError: 'x' }, false), 'bad_credentials');
  assert.equal(readWebLoginState({ state: 'MUST_SET_PASSWORD' }, false), 'refused');
  assert.equal(readWebLoginState(null, false), 'refused');
});

test('an account with two-factor authentication asks for the code, then refuses a wrong one', () => {
  assert.equal(readWebLoginState({ state: 'TOKEN_REQUIRED' }, false), 'two_factor_required');
  assert.equal(readWebLoginState({ state: 'TOKEN_REQUIRED', invalidToken: true }, false), 'two_factor_invalid');
  assert.equal(readWebLoginState({ state: 'TOKEN_REQUIRED' }, true), 'two_factor_invalid');
});

test('codes are six digits, spaces allowed', () => {
  assert.equal(twoFactorCode('123456'), '123456');
  assert.equal(twoFactorCode('123 456'), '123456');
  assert.equal(twoFactorCode(12345), null);
  assert.equal(twoFactorCode(123456), '123456');
  assert.equal(twoFactorCode('12345a'), null);
  assert.equal(twoFactorCode(undefined), null);
});
