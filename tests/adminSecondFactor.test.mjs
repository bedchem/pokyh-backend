import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './helpers/loadTs.mjs';

const totp = await loadTs('src/security/totp.ts');
const login = await loadTs('src/security/adminLogin.ts');

// RFC 6238 appendix B, SHA-1 seed "12345678901234567890" (8-digit codes there;
// the 6-digit code is the last six digits of the same value).
const RFC_SECRET = totp.base32Encode(Buffer.from('12345678901234567890'));
const RFC_VECTORS = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
];

test('TOTP codes match the RFC 6238 test vectors', () => {
  for (const [seconds, code] of RFC_VECTORS) {
    assert.equal(totp.totpCode(RFC_SECRET, totp.totpStep(seconds * 1000)), code, `t=${seconds}`);
  }
});

test('base32 round-trips and ignores spacing and case', () => {
  const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 17]);
  const encoded = totp.base32Encode(bytes);
  assert.deepEqual(totp.base32Decode(encoded), bytes);
  assert.deepEqual(totp.base32Decode(encoded.toLowerCase().replace(/(.{4})/g, '$1 ')), bytes);
  assert.throws(() => totp.base32Decode('not base32!'));
  assert.match(totp.generateTotpSecret(), /^[A-Z2-7]{32}$/);
});

test('a code is accepted within one step of drift and never twice', () => {
  const now = 1111111111 * 1000;
  const step = totp.totpStep(now);
  const current = totp.totpCode(RFC_SECRET, step);
  assert.equal(totp.verifyTotp(RFC_SECRET, current, now), step);
  assert.equal(totp.verifyTotp(RFC_SECRET, current.slice(0, 3) + ' ' + current.slice(3), now), step, 'spaces allowed');
  assert.equal(totp.verifyTotp(RFC_SECRET, totp.totpCode(RFC_SECRET, step - 1), now), step - 1);
  assert.equal(totp.verifyTotp(RFC_SECRET, totp.totpCode(RFC_SECRET, step + 1), now), step + 1);
  assert.equal(totp.verifyTotp(RFC_SECRET, totp.totpCode(RFC_SECRET, step - 2), now), null, 'too old');
  assert.equal(totp.verifyTotp(RFC_SECRET, current, now, step), null, 'already used');
  assert.equal(totp.verifyTotp(RFC_SECRET, current, now, step + 1), null, 'a later step was used');
  for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 5']) {
    assert.equal(totp.verifyTotp(RFC_SECRET, bad, now), null, JSON.stringify(bad));
  }
});

test('the otpauth link carries everything an authenticator app needs', () => {
  const url = new URL(totp.otpauthUrl('ABCDEF', 'pfei-eman', 'Pokyh Admin'));
  assert.equal(url.protocol, 'otpauth:');
  assert.equal(url.host, 'totp');
  assert.equal(decodeURIComponent(url.pathname), '/Pokyh Admin:pfei-eman');
  assert.equal(url.searchParams.get('secret'), 'ABCDEF');
  assert.equal(url.searchParams.get('issuer'), 'Pokyh Admin');
  assert.equal(url.searchParams.get('digits'), '6');
  assert.equal(url.searchParams.get('period'), '30');
});

test('recovery codes are single use and forgiving about formatting', () => {
  const codes = totp.generateRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const code of codes) assert.match(code, /^[a-z2-7]{5}-[a-z2-7]{5}$/);

  const hashes = codes.map(totp.hashRecoveryCode);
  const remaining = totp.consumeRecoveryCode(hashes, ` ${codes[3].toUpperCase().replace('-', ' ')} `);
  assert.equal(remaining.length, 9);
  assert.ok(!remaining.includes(hashes[3]));
  assert.equal(totp.consumeRecoveryCode(remaining, codes[3]), null, 'used up');
  assert.equal(totp.consumeRecoveryCode(hashes, 'aaaaa-aaaaa'), null, 'unknown');
  assert.equal(totp.consumeRecoveryCode(hashes, '123456'), null, 'a TOTP code is not a recovery code');
});

test('the sealed TOTP secret opens only with the same master secret', () => {
  const master = 'x'.repeat(40);
  const sealed = totp.sealSecret('JBSWY3DPEHPK3PXP', master);
  assert.ok(!sealed.includes('JBSWY3DPEHPK3PXP'));
  assert.notEqual(sealed, totp.sealSecret('JBSWY3DPEHPK3PXP', master), 'fresh nonce each time');
  assert.equal(totp.openSecret(sealed, master), 'JBSWY3DPEHPK3PXP');
  assert.throws(() => totp.openSecret(sealed, 'y'.repeat(40)));
  // The first character of the ciphertext carries six real bits (the last one
  // of a segment may only carry padding), so this always changes the content.
  const parts = sealed.split('.');
  parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
  assert.throws(() => totp.openSecret(parts.join('.'), master), 'tampered ciphertext');
  assert.throws(() => totp.openSecret('garbage', master));
});

test('an admin made in the panel logs in with the account password', () => {
  // The reported bug: "Admin vergeben" makes an Admin row without its own
  // password, and only the shared hash was ever checked.
  assert.deepEqual(login.adminPasswordHashes({ adminHash: null, userHash: 'user', sharedHash: 'shared' }), ['user', 'shared']);
  assert.deepEqual(login.adminPasswordHashes({ adminHash: null, userHash: null, sharedHash: 'shared' }), ['shared']);
  assert.deepEqual(login.adminPasswordHashes({ adminHash: 'admin', userHash: 'user', sharedHash: 'shared' }), ['admin'], 'a dedicated admin password is the only one');
  assert.deepEqual(login.adminPasswordHashes({ adminHash: null, userHash: null, sharedHash: '' }), []);
});

test('a WebUntis account made admin starts with a one-time password', () => {
  // The reported bug: "Admin vergeben" on a WebUntis account left it with no
  // password the panel would accept.
  assert.equal(login.grantNeedsOneTimePassword({ isUntisUser: true, hasPassword: false }), true);
  assert.equal(login.grantNeedsOneTimePassword({ isUntisUser: true, hasPassword: true }), true, 'never the WebUntis-linked account password');
  assert.equal(login.grantNeedsOneTimePassword({ isUntisUser: false, hasPassword: false }), true);
  assert.equal(login.grantNeedsOneTimePassword({ isUntisUser: false, hasPassword: true }), false, 'a local account keeps its own password');
  assert.equal(login.ADMIN_SETUP_WINDOW_MS, 15 * 60 * 1000);
});

test('a pending grant cannot sign in and lapses at its deadline', () => {
  const deadline = new Date('2026-10-15T15:00:00Z');
  const pending = { mustChangePassword: true, setupExpiresAt: deadline };
  assert.equal(login.adminSetupLapsed(pending, new Date('2026-10-15T14:59:59Z')), false);
  assert.equal(login.adminSetupLapsed(pending, deadline), true);
  assert.equal(login.adminSetupLapsed({ mustChangePassword: false, setupExpiresAt: deadline }, new Date('2026-10-16T00:00:00Z')), false, 'a finished setup never lapses');
  assert.equal(login.adminCanSignIn({ adminHash: 'otp', mustChangePassword: true, needsOneTimePassword: true }), false);
  assert.equal(login.adminCanSignIn({ adminHash: 'own', mustChangePassword: false, needsOneTimePassword: true }), true);
  assert.equal(login.adminCanSignIn({ adminHash: null, mustChangePassword: false, needsOneTimePassword: true }), false, 'an old WebUntis admin without password');
  assert.equal(login.adminCanSignIn({ adminHash: null, mustChangePassword: false, needsOneTimePassword: false }), true);
});

test('only the granting admin sees the one-time password again, and only while pending', () => {
  const now = new Date('2026-10-15T14:50:00Z');
  const pending = { mustChangePassword: true, setupExpiresAt: new Date('2026-10-15T15:00:00Z'), oneTimePasswordEnc: 'v1.sealed', grantedBy: 'ryhox' };
  assert.equal(login.mayViewOneTimePassword(pending, 'ryhox', now), true);
  assert.equal(login.mayViewOneTimePassword(pending, 'other-admin', now), false, 'not another admin');
  assert.equal(login.mayViewOneTimePassword(pending, 'ryhox', new Date('2026-10-15T15:00:00Z')), false, 'not after the deadline');
  assert.equal(login.mayViewOneTimePassword({ ...pending, mustChangePassword: false, oneTimePasswordEnc: null }, 'ryhox', now), false, 'never the password chosen afterwards');
  assert.equal(login.mayViewOneTimePassword({ ...pending, grantedBy: null }, 'ryhox', now), false);
  assert.equal(login.validOneTimePassword('abcdefgh'), true);
  assert.equal(login.validOneTimePassword('short'), false);
  assert.equal(login.validOneTimePassword('x'.repeat(101)), false);
  assert.equal(login.validOneTimePassword(undefined), false);
});

test('the panel changes only passwords it owns', () => {
  assert.equal(login.adminPasswordKind({ hasAccount: true, hasAdminRecord: true, adminHash: 'admin', isUntisUser: true }), 'admin');
  assert.equal(login.adminPasswordKind({ hasAccount: true, hasAdminRecord: true, adminHash: null, isUntisUser: false }), 'account');
  assert.equal(login.adminPasswordKind({ hasAccount: true, hasAdminRecord: true, adminHash: null, isUntisUser: true }), 'admin');
  assert.equal(login.adminPasswordKind({ hasAccount: true, hasAdminRecord: false, adminHash: null, isUntisUser: true }), 'config');
  assert.equal(login.adminPasswordKind({ hasAccount: false, hasAdminRecord: false, adminHash: null, isUntisUser: undefined }), 'config');
});

test('env admin names match regardless of case and keep the configured spelling', () => {
  assert.equal(login.matchEnvAdmin(' Admin ', ['admin', 'ops']), 'admin');
  assert.equal(login.matchEnvAdmin('OPS', ['admin', 'Ops']), 'Ops');
  assert.equal(login.matchEnvAdmin('nexorabi', ['admin']), null);
  assert.equal(login.matchEnvAdmin('', []), null);
});

test('passkeys are bound to the panel domain and refused where WebAuthn cannot work', () => {
  assert.deepEqual(login.passkeyRelyingParty('https://api.pokyh.com', []), { origin: 'https://api.pokyh.com', rpId: 'api.pokyh.com' });
  assert.deepEqual(login.passkeyRelyingParty('https://api.pokyh.com:8443', []), { origin: 'https://api.pokyh.com:8443', rpId: 'api.pokyh.com' });
  assert.deepEqual(login.passkeyRelyingParty('http://localhost:3000', []), { origin: 'http://localhost:3000', rpId: 'localhost' });
  for (const bad of [undefined, '', 'null', 'http://api.pokyh.com', 'https://10.0.0.5', 'https://[::1]', 'http://127.0.0.1:3000', 'https://api.pokyh.com/admin', 'ftp://x.org']) {
    assert.equal(login.passkeyRelyingParty(bad, []), null, String(bad));
  }
  const allowed = ['https://api.pokyh.com'];
  assert.ok(login.passkeyRelyingParty('https://api.pokyh.com', allowed));
  assert.equal(login.passkeyRelyingParty('https://evil.example', allowed), null);
});
