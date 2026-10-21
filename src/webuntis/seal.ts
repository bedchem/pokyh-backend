import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

// AES-256-GCM sealing of a JSON value with a given 32-byte key:
// base64url(12-byte nonce | ciphertext | 16-byte tag). Pure (no configuration),
// tested on its own (tests/webuntisRenewal.test.mjs); ./crypto.ts supplies the key.

export function sealWith(key: Buffer, data: object): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url');
}

/** The sealed value, or null for anything not sealed with this key (or altered). */
export function unsealWith<T>(key: Buffer, token: string | undefined): T | null {
  if (!token || token.length > 8_192) return null;
  try {
    const raw = Buffer.from(token, 'base64url');
    if (raw.length < 12 + 16 + 2) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    const text = Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8');
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
