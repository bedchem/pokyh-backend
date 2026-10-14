import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  scrypt,
  timingSafeEqual,
  type KeyObject,
} from 'crypto';

// Cryptographic building blocks of the node-to-node channel. This module has
// no dependency on configuration, the database or the network, so every
// property it promises can be verified in isolation (tests/clusterCrypto).
//
// Only standard, well-reviewed primitives from Node's own crypto module are
// composed here — X25519, HKDF-SHA256, HMAC-SHA256, scrypt and AES-256-GCM.
// Nothing in this file invents a primitive.
//
// Two handshakes build on them:
//
//   Pairing  — run once per peer, with the one-time secret of an invite code
//              (or of an introduction by a common peer). It is stretched with
//              scrypt and a fresh random salt into a
//              pre-shared key that authenticates an ephemeral X25519
//              exchange. The result is a random-looking 256-bit link key; the
//              pairing key itself is discarded afterwards.
//
//   Session  — run whenever a node (re)connects to a paired peer. A new
//              ephemeral X25519 exchange is authenticated with the link key,
//              and the link key is mixed into the derived session keys. A
//              recorded session therefore stays confidential even if the link
//              key leaks later (forward secrecy), and nobody without the link
//              key can complete the handshake.
//
// Every message inside a session is sealed with AES-256-GCM under a
// direction-specific key and a strictly unique counter nonce.

export const PROTOCOL_VERSION = 2;
const LABEL = 'pokyh-cluster/v1';

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
export const SESSION_ID_BYTES = 16;
export const HANDSHAKE_NONCE_BYTES = 16;
export const PAIRING_SALT_BYTES = 16;
export const X25519_PUBLIC_BYTES = 32;

// ─── Small helpers ───────────────────────────────────────────────────────────

export function sha256(...parts: Buffer[]): Buffer {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
}

export function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

export function hkdf(ikm: Buffer, salt: Buffer, info: string, length = KEY_BYTES): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from(`${LABEL}/${info}`, 'utf8'), length));
}

// Constant-time comparison that tolerates a length mismatch.
export function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Unambiguous transcript encoding: every field is preceded by its length, so
// no two different field lists can ever serialise to the same bytes.
export function encodeFields(fields: Array<string | Buffer>): Buffer {
  const parts: Buffer[] = [];
  for (const field of fields) {
    const bytes = typeof field === 'string' ? Buffer.from(field, 'utf8') : field;
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length, 0);
    parts.push(length, bytes);
  }
  return Buffer.concat(parts);
}

function counterBytes(counter: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(counter, 0);
  return out;
}

// ─── Wrapping secrets at rest ────────────────────────────────────────────────
// Link keys live in the database. They are stored only in this wrapped form,
// so a database dump on its own does not reveal them.

export function deriveKek(secret: string): Buffer {
  return hkdf(Buffer.from(secret, 'utf8'), Buffer.from(`${LABEL}/kek-salt`, 'utf8'), 'key-encryption');
}

export function wrapSecret(kek: Buffer, plaintext: Buffer, context: string): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', kek, nonce);
  cipher.setAAD(Buffer.from(`${LABEL}/wrap/${context}`, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64url');
}

// Throws when the value was produced with a different key or context, or was
// altered in any way.
export function unwrapSecret(kek: Buffer, wrapped: string, context: string): Buffer {
  const raw = Buffer.from(wrapped, 'base64url');
  if (raw.length < NONCE_BYTES + TAG_BYTES) throw new Error('wrapped secret is malformed');
  const nonce = raw.subarray(0, NONCE_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);
  const body = raw.subarray(NONCE_BYTES, raw.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', kek, nonce);
  decipher.setAAD(Buffer.from(`${LABEL}/wrap/${context}`, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

// ─── Pairing key ─────────────────────────────────────────────────────────────

const BASE32 = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L — safe to read aloud

// A fresh pairing key with well over 128 bits of entropy, grouped for typing.
export function generatePairingKey(): string {
  // Rejection sampling keeps every character exactly equally likely.
  const limit = 256 - (256 % BASE32.length);
  let out = '';
  while (out.length < 40) {
    for (const byte of randomBytes(64)) {
      if (byte >= limit) continue;
      out += BASE32[byte % BASE32.length];
      if (out.length === 40) break;
    }
  }
  return out.match(/.{1,5}/g)!.join('-');
}

export const PAIRING_KEY_MIN_LENGTH = 16;
export const PAIRING_KEY_MAX_LENGTH = 256;

export function normalizePairingKey(key: string): string {
  return key.normalize('NFKC').trim();
}

// Returns a human-readable reason when a pairing key is too weak to accept.
export function pairingKeyProblem(key: string): string | null {
  const normalized = normalizePairingKey(key);
  if (normalized.length < PAIRING_KEY_MIN_LENGTH) {
    return `Pairing key must be at least ${PAIRING_KEY_MIN_LENGTH} characters long`;
  }
  if (normalized.length > PAIRING_KEY_MAX_LENGTH) {
    return `Pairing key must be at most ${PAIRING_KEY_MAX_LENGTH} characters long`;
  }
  if (new Set(normalized).size < 8) {
    return 'Pairing key is too repetitive — use the generated key or a longer passphrase';
  }
  return null;
}

// Memory-hard stretching: an eavesdropper who records a pairing attempt has to
// spend this cost for every single guess of the pairing key.
const SCRYPT_COST = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

export function derivePairingPsk(pairingKey: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(Buffer.from(normalizePairingKey(pairingKey), 'utf8'), salt, KEY_BYTES, SCRYPT_COST, (err, key) => {
      if (err) reject(err); else resolve(key);
    });
  });
}

// ─── X25519 ──────────────────────────────────────────────────────────────────

const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

export interface Ephemeral {
  publicKey: Buffer;
  privateKey: KeyObject;
}

export function generateEphemeral(): Ephemeral {
  const pair = generateKeyPairSync('x25519');
  const spki = pair.publicKey.export({ type: 'spki', format: 'der' });
  return { publicKey: Buffer.from(spki.subarray(spki.length - X25519_PUBLIC_BYTES)), privateKey: pair.privateKey };
}

export function sharedSecret(privateKey: KeyObject, peerPublic: Buffer): Buffer {
  if (peerPublic.length !== X25519_PUBLIC_BYTES) throw new Error('peer public key has the wrong length');
  const publicKey = createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, peerPublic]),
    format: 'der',
    type: 'spki',
  });
  const shared = diffieHellman({ privateKey, publicKey });
  // A low-order peer key would force an all-zero result regardless of our own
  // key; such a "shared" secret is known to everyone and must be refused.
  if (shared.every((byte) => byte === 0)) throw new Error('peer public key is not acceptable');
  return shared;
}

// ─── Pairing handshake ───────────────────────────────────────────────────────

export interface PairInit {
  from: string;
  name: string;
  addr: string;
  salt: Buffer;
  e: Buffer;
  n: Buffer;
}

export interface PairAccept {
  id: string;
  name: string;
  e: Buffer;
  n: Buffer;
}

function pairInitTranscript(init: PairInit): Buffer {
  return encodeFields(['pair-init', String(PROTOCOL_VERSION), init.from, init.name, init.addr, init.salt, init.e, init.n]);
}

// Proves, before the responder commits any state, that the initiator knows the
// pairing key.
export function pairInitMac(psk: Buffer, init: PairInit): Buffer {
  return hmac(hkdf(psk, init.salt, 'pair/init-mac'), pairInitTranscript(init));
}

export interface PairKeys {
  confirmInitiator: Buffer;
  confirmResponder: Buffer;
  linkKey: Buffer;
}

// Both sides call this with identical inputs once the ephemeral keys have been
// exchanged. The confirmation tags let each side verify that the other derived
// the very same link key before either of them stores it.
export function pairKeys(psk: Buffer, shared: Buffer, init: PairInit, accept: PairAccept): PairKeys {
  const transcript = sha256(
    pairInitTranscript(init),
    encodeFields(['pair-accept', accept.id, accept.name, accept.e, accept.n]),
  );
  const master = hkdf(shared, psk, 'pair/master');
  return {
    confirmInitiator: hmac(hkdf(master, transcript, 'pair/confirm-initiator'), transcript),
    confirmResponder: hmac(hkdf(master, transcript, 'pair/confirm-responder'), transcript),
    linkKey: hkdf(master, transcript, 'pair/link-key'),
  };
}

// ─── Session handshake ───────────────────────────────────────────────────────

export interface SessionInit {
  from: string;
  to: string;
  e: Buffer;
  n: Buffer;
}

export interface SessionAccept {
  sid: Buffer;
  e: Buffer;
  n: Buffer;
}

function sessionInitTranscript(init: SessionInit): Buffer {
  return encodeFields(['session-init', String(PROTOCOL_VERSION), init.from, init.to, init.e, init.n]);
}

function sessionFullTranscript(init: SessionInit, accept: SessionAccept): Buffer {
  return sha256(
    sessionInitTranscript(init),
    encodeFields(['session-accept', accept.sid, accept.e, accept.n]),
  );
}

export function sessionInitMac(linkKey: Buffer, init: SessionInit): Buffer {
  return hmac(hkdf(linkKey, init.n, 'session/init-mac'), sessionInitTranscript(init));
}

export function sessionAcceptMac(linkKey: Buffer, init: SessionInit, accept: SessionAccept): Buffer {
  return hmac(hkdf(linkKey, accept.n, 'session/accept-mac'), sessionFullTranscript(init, accept));
}

export interface SessionKeys {
  c2s: Buffer;
  s2c: Buffer;
}

export function sessionKeys(linkKey: Buffer, shared: Buffer, init: SessionInit, accept: SessionAccept): SessionKeys {
  const transcript = sessionFullTranscript(init, accept);
  const master = hkdf(shared, linkKey, 'session/master');
  return {
    c2s: hkdf(master, transcript, 'session/client-to-server'),
    s2c: hkdf(master, transcript, 'session/server-to-client'),
  };
}

// ─── Sealed frames ───────────────────────────────────────────────────────────

export type Direction = 'c2s' | 's2c';

function frameNonce(counter: bigint): Buffer {
  // Each direction has its own key, so a counter is all a nonce needs to be
  // unique for the lifetime of that key.
  return Buffer.concat([Buffer.alloc(NONCE_BYTES - 8), counterBytes(counter)]);
}

function frameAad(direction: Direction, sid: Buffer, counter: bigint): Buffer {
  return encodeFields([`${LABEL}/frame`, direction, sid, counterBytes(counter)]);
}

export function sealFrame(key: Buffer, direction: Direction, sid: Buffer, counter: bigint, plaintext: Buffer): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, frameNonce(counter));
  cipher.setAAD(frameAad(direction, sid, counter));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([body, cipher.getAuthTag()]);
}

// Throws unless the frame is exactly what the holder of `key` sealed for this
// session, direction and counter.
export function openFrame(key: Buffer, direction: Direction, sid: Buffer, counter: bigint, sealed: Buffer): Buffer {
  if (sealed.length < TAG_BYTES) throw new Error('frame is too short');
  const decipher = createDecipheriv('aes-256-gcm', key, frameNonce(counter));
  decipher.setAAD(frameAad(direction, sid, counter));
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)), decipher.final()]);
}

const REQUEST_HEADER_BYTES = SESSION_ID_BYTES + 8;

export function encodeRequest(sid: Buffer, counter: bigint, sealed: Buffer): Buffer {
  return Buffer.concat([sid, counterBytes(counter), sealed]);
}

export function decodeRequest(body: Buffer): { sid: Buffer; counter: bigint; sealed: Buffer } | null {
  if (body.length < REQUEST_HEADER_BYTES + TAG_BYTES) return null;
  return {
    sid: body.subarray(0, SESSION_ID_BYTES),
    counter: body.readBigUInt64BE(SESSION_ID_BYTES),
    sealed: body.subarray(REQUEST_HEADER_BYTES),
  };
}

// ─── Replay protection ───────────────────────────────────────────────────────
// Requests of one session may arrive slightly out of order, so a strict
// "must be larger than the last" rule would reject legitimate traffic. This
// accepts every counter exactly once within a sliding window and nothing
// older than the window.

export class ReplayWindow {
  private highest = -1n;
  private readonly seen = new Set<bigint>();

  constructor(private readonly size = 4096n) {}

  accept(counter: bigint): boolean {
    if (counter < 0n) return false;
    if (this.highest >= 0n && counter <= this.highest - this.size) return false;
    if (this.seen.has(counter)) return false;
    this.seen.add(counter);
    if (counter > this.highest) this.highest = counter;
    if (this.seen.size > Number(this.size) * 2) {
      const floor = this.highest - this.size;
      for (const value of this.seen) {
        if (value <= floor) this.seen.delete(value);
      }
    }
    return true;
  }
}

// ─── Configuration comparison ────────────────────────────────────────────────
// Lets two paired nodes find out whether a setting (for example the token
// signing secret) is identical on both, without either of them sending it.

export function configFingerprint(linkKey: Buffer, label: string, value: string): string {
  return hmac(hkdf(linkKey, Buffer.from(label, 'utf8'), 'config-fingerprint'), Buffer.from(value, 'utf8'))
    .subarray(0, 16)
    .toString('hex');
}

export function randomToken(bytes: number): Buffer {
  return randomBytes(bytes);
}
