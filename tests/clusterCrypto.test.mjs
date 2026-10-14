import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './helpers/loadTs.mjs';

const c = await loadTs('src/cluster/crypto.ts');

const PAIRING_KEY = 'correct horse battery staple 42';

// Runs the complete pairing handshake between two parties. Returns what each
// side derived so tests can compare and tamper.
async function pair(keyA, keyB) {
  const ephA = c.generateEphemeral();
  const init = { from: 'node-a', name: 'A', addr: 'https://node-a.example.org', salt: c.randomToken(16), e: ephA.publicKey, n: c.randomToken(16) };
  const mac = c.pairInitMac(await c.derivePairingPsk(keyA, init.salt), init);

  const pskB = await c.derivePairingPsk(keyB, init.salt);
  const initAccepted = c.safeEqual(mac, c.pairInitMac(pskB, init));
  const ephB = c.generateEphemeral();
  const accept = { id: 'node-b', name: 'B', e: ephB.publicKey, n: c.randomToken(16) };
  const keysB = c.pairKeys(pskB, c.sharedSecret(ephB.privateKey, init.e), init, accept);
  const keysA = c.pairKeys(await c.derivePairingPsk(keyA, init.salt), c.sharedSecret(ephA.privateKey, accept.e), init, accept);
  return { initAccepted, keysA, keysB, init, accept };
}

test('both sides of a pairing derive the same link key and confirmations', async () => {
  const { initAccepted, keysA, keysB } = await pair(PAIRING_KEY, PAIRING_KEY);
  assert.equal(initAccepted, true);
  assert.equal(keysA.linkKey.length, 32);
  assert.deepEqual(keysA.linkKey, keysB.linkKey);
  assert.deepEqual(keysA.confirmInitiator, keysB.confirmInitiator);
  assert.deepEqual(keysA.confirmResponder, keysB.confirmResponder);
  assert.notDeepEqual(keysA.confirmInitiator, keysA.confirmResponder);
});

test('a different pairing key is rejected and yields unrelated keys', async () => {
  const { initAccepted, keysA, keysB } = await pair(PAIRING_KEY, `${PAIRING_KEY}!`);
  assert.equal(initAccepted, false);
  assert.notDeepEqual(keysA.linkKey, keysB.linkKey);
  assert.notDeepEqual(keysA.confirmResponder, keysB.confirmResponder);
});

test('every pairing produces a fresh link key', async () => {
  const first = await pair(PAIRING_KEY, PAIRING_KEY);
  const second = await pair(PAIRING_KEY, PAIRING_KEY);
  assert.notDeepEqual(first.keysA.linkKey, second.keysA.linkKey);
});

test('the pairing salt changes the stretched key', async () => {
  const a = await c.derivePairingPsk(PAIRING_KEY, Buffer.alloc(16, 1));
  const b = await c.derivePairingPsk(PAIRING_KEY, Buffer.alloc(16, 2));
  assert.notDeepEqual(a, b);
  assert.deepEqual(a, await c.derivePairingPsk(`  ${PAIRING_KEY}  `, Buffer.alloc(16, 1)));
});

test('the joining node\'s address is covered by the pairing proof', async () => {
  const { init } = await pair(PAIRING_KEY, PAIRING_KEY);
  const psk = await c.derivePairingPsk(PAIRING_KEY, init.salt);
  const genuine = c.pairInitMac(psk, init);
  const redirected = c.pairInitMac(psk, { ...init, addr: 'https://attacker.example.org' });
  assert.equal(c.safeEqual(genuine, redirected), false, 'a changed address no longer matches the proof');
});

test('an altered pairing message breaks the confirmation', async () => {
  const { keysA, init, accept } = await pair(PAIRING_KEY, PAIRING_KEY);
  const psk = await c.derivePairingPsk(PAIRING_KEY, init.salt);
  const eph = c.generateEphemeral();
  const forged = c.pairKeys(psk, c.sharedSecret(eph.privateKey, init.e), init, { ...accept, name: 'someone else' });
  assert.notDeepEqual(forged.confirmResponder, keysA.confirmResponder);
});

function session(linkKeyClient, linkKeyServer) {
  const ephC = c.generateEphemeral();
  const init = { from: 'node-a', to: 'node-b', e: ephC.publicKey, n: c.randomToken(16) };
  const initMac = c.sessionInitMac(linkKeyClient, init);
  const initAccepted = c.safeEqual(initMac, c.sessionInitMac(linkKeyServer, init));
  const ephS = c.generateEphemeral();
  const accept = { sid: c.randomToken(16), e: ephS.publicKey, n: c.randomToken(16) };
  const acceptMac = c.sessionAcceptMac(linkKeyServer, init, accept);
  const acceptAccepted = c.safeEqual(acceptMac, c.sessionAcceptMac(linkKeyClient, init, accept));
  const server = c.sessionKeys(linkKeyServer, c.sharedSecret(ephS.privateKey, init.e), init, accept);
  const client = c.sessionKeys(linkKeyClient, c.sharedSecret(ephC.privateKey, accept.e), init, accept);
  return { initAccepted, acceptAccepted, client, server, sid: accept.sid };
}

test('a session handshake authenticates both sides and agrees on keys', () => {
  const linkKey = c.randomToken(32);
  const s = session(linkKey, linkKey);
  assert.equal(s.initAccepted, true);
  assert.equal(s.acceptAccepted, true);
  assert.deepEqual(s.client.c2s, s.server.c2s);
  assert.deepEqual(s.client.s2c, s.server.s2c);
  assert.notDeepEqual(s.client.c2s, s.client.s2c);
});

test('a session handshake fails without the right link key', () => {
  const s = session(c.randomToken(32), c.randomToken(32));
  assert.equal(s.initAccepted, false);
  assert.equal(s.acceptAccepted, false);
  assert.notDeepEqual(s.client.c2s, s.server.c2s);
});

test('session keys differ between sessions of the same link (forward secrecy)', () => {
  const linkKey = c.randomToken(32);
  assert.notDeepEqual(session(linkKey, linkKey).client.c2s, session(linkKey, linkKey).client.c2s);
});

test('sealed frames round-trip and reject every kind of tampering', () => {
  const key = c.randomToken(32);
  const sid = c.randomToken(16);
  const message = Buffer.from(JSON.stringify({ m: 'hb', secret: 'top-secret-row-content' }));
  const sealed = c.sealFrame(key, 'c2s', sid, 7n, message);

  assert.deepEqual(c.openFrame(key, 'c2s', sid, 7n, sealed), message);
  assert.equal(sealed.includes(Buffer.from('top-secret-row-content')), false, 'payload must not be readable');

  const flipped = Buffer.from(sealed);
  flipped[3] ^= 0x01;
  assert.throws(() => c.openFrame(key, 'c2s', sid, 7n, flipped));
  assert.throws(() => c.openFrame(key, 'c2s', sid, 8n, sealed), 'wrong counter');
  assert.throws(() => c.openFrame(key, 's2c', sid, 7n, sealed), 'wrong direction');
  assert.throws(() => c.openFrame(key, 'c2s', c.randomToken(16), 7n, sealed), 'wrong session');
  assert.throws(() => c.openFrame(c.randomToken(32), 'c2s', sid, 7n, sealed), 'wrong key');
  assert.throws(() => c.openFrame(key, 'c2s', sid, 7n, sealed.subarray(0, sealed.length - 1)), 'truncated');
});

test('request framing round-trips and rejects short input', () => {
  const sid = c.randomToken(16);
  const sealed = c.sealFrame(c.randomToken(32), 'c2s', sid, 99n, Buffer.from('x'));
  const decoded = c.decodeRequest(c.encodeRequest(sid, 99n, sealed));
  assert.deepEqual(decoded.sid, sid);
  assert.equal(decoded.counter, 99n);
  assert.deepEqual(decoded.sealed, sealed);
  assert.equal(c.decodeRequest(Buffer.alloc(10)), null);
});

test('the replay window accepts each counter once, tolerates reordering, drops stale ones', () => {
  const window = new c.ReplayWindow(8n);
  assert.equal(window.accept(0n), true);
  assert.equal(window.accept(0n), false, 'replay');
  assert.equal(window.accept(3n), true);
  assert.equal(window.accept(2n), true, 'out of order but new');
  assert.equal(window.accept(2n), false, 'replay of out-of-order');
  assert.equal(window.accept(100n), true);
  assert.equal(window.accept(92n), false, 'older than the window');
  assert.equal(window.accept(93n), true, 'inside the window');
  assert.equal(window.accept(-1n), false);
  for (let i = 101n; i < 200n; i++) assert.equal(window.accept(i), true);
  assert.equal(window.accept(150n), false);
});

test('wrapped secrets round-trip and are bound to key and context', () => {
  const kek = c.deriveKek('a'.repeat(40));
  const secret = c.randomToken(32);
  const wrapped = c.wrapSecret(kek, secret, 'link:peer-1');
  assert.deepEqual(c.unwrapSecret(kek, wrapped, 'link:peer-1'), secret);
  assert.notEqual(c.wrapSecret(kek, secret, 'link:peer-1'), wrapped, 'nonce must be fresh');
  assert.throws(() => c.unwrapSecret(kek, wrapped, 'link:peer-2'));
  assert.throws(() => c.unwrapSecret(c.deriveKek('b'.repeat(40)), wrapped, 'link:peer-1'));
  assert.throws(() => c.unwrapSecret(kek, wrapped.slice(0, -4) + 'AAAA', 'link:peer-1'));
  assert.throws(() => c.unwrapSecret(kek, 'short', 'link:peer-1'));
});

test('pairing key policy and generator', () => {
  assert.match(c.pairingKeyProblem('short'), /at least 16/);
  assert.match(c.pairingKeyProblem('aaaaaaaaaaaaaaaaaaaaaaaa'), /repetitive/);
  assert.match(c.pairingKeyProblem('x'.repeat(300)), /at most/);
  assert.equal(c.pairingKeyProblem(PAIRING_KEY), null);
  const generated = c.generatePairingKey();
  assert.match(generated, /^([A-Z2-9]{5}-){7}[A-Z2-9]{5}$/);
  assert.equal(c.pairingKeyProblem(generated), null);
  assert.notEqual(generated, c.generatePairingKey());
});

test('a low-order public key is refused', () => {
  const eph = c.generateEphemeral();
  assert.throws(() => c.sharedSecret(eph.privateKey, Buffer.alloc(32)));
  assert.throws(() => c.sharedSecret(eph.privateKey, Buffer.alloc(31)));
});

test('configuration fingerprints match only for equal values on the same link', () => {
  const linkKey = c.randomToken(32);
  assert.equal(c.configFingerprint(linkKey, 'jwt', 'secret-1'), c.configFingerprint(linkKey, 'jwt', 'secret-1'));
  assert.notEqual(c.configFingerprint(linkKey, 'jwt', 'secret-1'), c.configFingerprint(linkKey, 'jwt', 'secret-2'));
  assert.notEqual(c.configFingerprint(linkKey, 'jwt', 'secret-1'), c.configFingerprint(linkKey, 'api', 'secret-1'));
  assert.notEqual(c.configFingerprint(linkKey, 'jwt', 'secret-1'), c.configFingerprint(c.randomToken(32), 'jwt', 'secret-1'));
});

test('field encoding is unambiguous', () => {
  assert.notDeepEqual(c.encodeFields(['ab', 'c']), c.encodeFields(['a', 'bc']));
  assert.notDeepEqual(c.encodeFields(['a', '']), c.encodeFields(['a']));
});
