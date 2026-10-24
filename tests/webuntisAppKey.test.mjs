import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './helpers/loadTs.mjs';

const { normaliseAppKey, appKeyRequest, readAppKeyAccount } = await loadTs('src/webuntis/appKey.ts');
const totp = await loadTs('src/security/totp.ts');

// RFC 6238's SHA-1 test secret, as WebUntis would show it (base32).
const RFC_KEY = totp.base32Encode(Buffer.from('12345678901234567890'));

test('the key is taken as WebUntis shows it, in any case and with spaces', () => {
  assert.equal(normaliseAppKey('abcd efgh ijkl mnop'), 'ABCDEFGHIJKLMNOP');
  assert.equal(normaliseAppKey(' ABCD-EFGH-IJKL-MNOP\n'), 'ABCDEFGHIJKLMNOP');
  assert.equal(normaliseAppKey(`${RFC_KEY}====`), RFC_KEY);
});

test('anything that is not a key is refused', () => {
  assert.equal(normaliseAppKey('geheim'), '');
  assert.equal(normaliseAppKey('ABCDEFGH01890000'), '');
  assert.equal(normaliseAppKey('ABCDEFGH'), '');
  assert.equal(normaliseAppKey(undefined), '');
  assert.equal(normaliseAppKey(12345), '');
});

test('the sign-in sends the one-time code of the moment, never the key', () => {
  const now = 59_000;
  const body = appKeyRequest('anna.muster', RFC_KEY, now);
  assert.equal(body.method, 'getUserData2017');
  assert.deepEqual(body.params[0].auth, { clientTime: now, user: 'anna.muster', otp: '287082' });
  assert.ok(!JSON.stringify(body).includes(RFC_KEY));
});

test('the code keeps its leading zeros', () => {
  // RFC 6238, T = 1111111109 s: 07081804 → 081804.
  const body = appKeyRequest('anna.muster', RFC_KEY, 1111111109_000);
  assert.equal(body.params[0].auth.otp, '081804');
});

test('whom the key signed in comes from the answer', () => {
  assert.deepEqual(
    readAppKeyAccount({ userData: { elemType: 'STUDENT', elemId: 4711, klassenIds: [812], displayName: 'Muster Anna' } }),
    { personId: 4711, personType: 5, klasseId: 812 },
  );
  assert.deepEqual(readAppKeyAccount({ userData: { elemType: 'legal_guardian', elemId: 9, klassenIds: [1, 2] } }), { personId: 9, personType: 12, klasseId: 0 });
});

test('an answer that names nobody resolves later, not wrongly', () => {
  assert.deepEqual(readAppKeyAccount({}), { personId: 0, klasseId: 0 });
  assert.deepEqual(readAppKeyAccount(null), { personId: 0, klasseId: 0 });
  assert.deepEqual(readAppKeyAccount({ userData: { elemType: 'ROOM', elemId: -1, klassenIds: 'x' } }), { personId: 0, klasseId: 0 });
});
