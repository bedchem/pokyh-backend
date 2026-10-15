import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords (RFC 6238, HMAC-SHA1, 6 digits, 30 s) for the
 * admin panel's second factor — the format every authenticator app reads —
 * plus the one-time recovery codes that stand in when the phone is gone.
 * Depends on Node built-ins only, so it is unit-tested without a database.
 */

const STEP_SECONDS = 30;
const DIGITS = 6;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('invalid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// 160 bits, the size RFC 4226 recommends for HMAC-SHA1.
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 15;
  const binary = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(binary).padStart(DIGITS, '0');
}

/**
 * The step a code belongs to, or null. Accepts the current step and one on
 * either side (clock drift), but never a step at or before `lastUsedStep`, so
 * a code seen once — over a shoulder, in a proxy log — cannot be used again.
 */
export function verifyTotp(secret: string, code: string, nowMs: number, lastUsedStep = 0): number | null {
  const digits = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(digits)) return null;
  const current = totpStep(nowMs);
  for (const step of [current - 1, current, current + 1]) {
    if (step <= lastUsedStep) continue;
    if (timingSafeEqual(Buffer.from(totpCode(secret, step)), Buffer.from(digits))) return step;
  }
  return null;
}

export function otpauthUrl(secret: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ── Recovery codes ──────────────────────────────────────────────────────────
// Ten codes of 10 base32 characters (50 bits) each, shown once as xxxxx-xxxxx.
// High-entropy, so a plain SHA-256 is the right hash: nothing to brute-force.

const RECOVERY_CODE_COUNT = 10;

export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z2-7]/g, '');
}

export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');
}

export function generateRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const raw = base32Encode(randomBytes(7)).slice(0, 10).toLowerCase();
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

/** The remaining hashes after using `code`, or null when it is not one of them. */
export function consumeRecoveryCode(hashes: readonly string[], code: string): string[] | null {
  if (normalizeRecoveryCode(code).length !== 10) return null;
  const wanted = Buffer.from(hashRecoveryCode(code));
  let match = -1;
  hashes.forEach((hash, index) => {
    if (hash.length === wanted.length && timingSafeEqual(Buffer.from(hash), wanted)) match = index;
  });
  return match < 0 ? null : hashes.filter((_, index) => index !== match);
}

// ── Secret at rest ──────────────────────────────────────────────────────────
// The TOTP secret is stored sealed (AES-256-GCM) so a database export or
// backup alone does not hand out working second factors.

function sealKey(masterSecret: string): Buffer {
  return createHmac('sha256', masterSecret).update('pokyh-admin-totp-secret-v1').digest();
}

export function sealSecret(plain: string, masterSecret: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sealKey(masterSecret), nonce);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', nonce.toString('base64url'), body.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
}

export function openSecret(sealed: string, masterSecret: string): string {
  const [version, nonce, body, tag] = sealed.split('.');
  if (version !== 'v1' || !nonce || !body || !tag) throw new Error('unreadable sealed secret');
  const decipher = createDecipheriv('aes-256-gcm', sealKey(masterSecret), Buffer.from(nonce, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
}
