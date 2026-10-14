import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'crypto';

// The token of the one-line node installer (provision.ts) and the
// cryptography around it. Pure, with no dependency beyond Node itself, so it
// is tested on its own (tests/clusterInstall) — and mirrored line by line in
// deploy/node/bootstrap.mjs, which runs on the new server; the test checks
// that both sides agree.
//
// A token carries:
//   - where the inviting node's mutually authenticated channel is reached,
//     and the pin of its certificate, so the new server talks to exactly that
//     node and to nobody who merely controls DNS or a certificate authority;
//   - the inviting node's id and the install id;
//   - a 256-bit secret that never travels over the network. Three keys are
//     derived from it: one proves knowledge of the token to the inviting
//     node, one encrypts the configuration it hands over, and one is the
//     one-time pairing secret the new node joins the cluster with.
//
// Whoever holds a valid token can join and receives all data: it is shown
// once, valid for minutes, usable once and never stored in readable form.

export const INSTALL_TOKEN_PREFIX = 'pokyhnode1.';

const LABEL = 'pokyh-cluster/v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const NODE_ID = /^[A-Za-z0-9-]{8,36}$/;
const INSTALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PIN = /^[A-Za-z0-9+/]{43}=$/;

export interface InstallToken {
  // https://host:port of the inviting node's mutually authenticated channel.
  url: string;
  // Every way to reach it, in order (written endpoints, endpoints.ts).
  endpoints?: string[];
  pin: string;
  nodeId: string;
  id: string;
  secret: Buffer;
  expiresAt: Date;
}

export function newInstallSecret(): Buffer {
  return randomBytes(KEY_BYTES);
}

export function encodeInstallToken(token: InstallToken): string {
  const body = {
    v: 1,
    a: token.url,
    f: token.pin,
    n: token.nodeId,
    i: token.id,
    s: token.secret.toString('base64url'),
    e: Math.floor(token.expiresAt.getTime() / 1000),
    ...(token.endpoints && token.endpoints.length > 0 ? { x: token.endpoints.slice(0, 8) } : {}),
  };
  return INSTALL_TOKEN_PREFIX + Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
}

export type DecodedInstallToken = { ok: true; token: InstallToken } | { ok: false; error: string };

const damaged: DecodedInstallToken = { ok: false, error: 'Install token is damaged or incomplete' };

// The channel address must be https with an explicit port and nothing else
// (written as https://host:port — also for 443, which URL would drop).
export function isChannelUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const port = /^https:\/\/(?:\[[^\]]*\]|[^/:?#@\[\]]+):(\d{1,5})$/i.exec(value)?.[1];
    return url.protocol === 'https:' && Boolean(url.hostname) && port !== undefined && Number(port) >= 1 && Number(port) <= 65_535
      && !url.username && !url.password && (url.pathname === '/' || url.pathname === '') && !url.search && !url.hash
      && `https://${url.hostname}:${port}` === value;
  } catch {
    return false;
  }
}

export function decodeInstallToken(text: string, now = Date.now()): DecodedInstallToken {
  const trimmed = text.replace(/\s+/g, '');
  if (!trimmed.startsWith(INSTALL_TOKEN_PREFIX)) return { ok: false, error: 'This is not a Pokyh install token' };
  if (trimmed.length > 2048) return { ok: false, error: 'Install token is too long' };
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(Buffer.from(trimmed.slice(INSTALL_TOKEN_PREFIX.length), 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return damaged;
    body = parsed as Record<string, unknown>;
  } catch {
    return damaged;
  }
  const { v, a, f, n, i, s, e, x } = body;
  if (v !== 1) return { ok: false, error: 'Install token comes from a different Pokyh version' };
  if (typeof a !== 'string' || a.length > 255 || !isChannelUrl(a)) return damaged;
  if (typeof f !== 'string' || !PIN.test(f)) return damaged;
  if (typeof n !== 'string' || !NODE_ID.test(n)) return damaged;
  if (typeof i !== 'string' || !INSTALL_ID.test(i)) return damaged;
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(s)) return damaged;
  if (typeof e !== 'number' || !Number.isInteger(e) || e <= 0) return damaged;
  if (x !== undefined && (!Array.isArray(x) || x.length > 8 || !x.every((item) => typeof item === 'string' && item.length <= 300))) return damaged;
  const expiresAt = new Date(e * 1000);
  if (expiresAt.getTime() <= now) return { ok: false, error: 'Install token has expired — create a new one-line command' };
  return {
    ok: true,
    token: { url: a, pin: f, nodeId: n, id: i, secret: Buffer.from(s, 'base64url'), expiresAt, ...(Array.isArray(x) ? { endpoints: x as string[] } : {}) },
  };
}

// ─── Keys ────────────────────────────────────────────────────────────────────

export interface InstallKeys {
  auth: Buffer;
  enc: Buffer;
  // The one-time pairing secret, in the format of an invite secret.
  pairSecret: string;
}

function derive(secret: Buffer, id: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, Buffer.from(id, 'utf8'), Buffer.from(`${LABEL}/install/${purpose}`, 'utf8'), KEY_BYTES));
}

export function deriveInstallKeys(secret: Buffer, id: string): InstallKeys {
  return {
    auth: derive(secret, id, 'auth'),
    enc: derive(secret, id, 'encrypt'),
    pairSecret: derive(secret, id, 'pair').toString('base64url'),
  };
}

// Length-prefixed fields, so no two field lists encode to the same bytes.
function fields(parts: string[]): Buffer {
  return Buffer.concat(parts.flatMap((part) => {
    const bytes = Buffer.from(part, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length, 0);
    return [length, bytes];
  }));
}

export type InstallPurpose = 'provision' | 'bundle';

// Proves knowledge of the token for one request: bound to the purpose, the
// install, the sender's clock and a fresh nonce.
export function installProof(authKey: Buffer, purpose: InstallPurpose, id: string, timestamp: number, nonce: string): Buffer {
  return createHmac('sha256', authKey).update(fields([`${LABEL}/install/${purpose}`, id, String(timestamp), nonce])).digest();
}

export function proofMatches(expected: Buffer, presented: string): boolean {
  const bytes = Buffer.from(presented, 'base64url');
  return bytes.length === expected.length && timingSafeEqual(bytes, expected);
}

// The configuration a node hands over is sealed under a key only the token's
// holder can derive, bound to the request it answers. A reverse proxy or
// anybody else on the path sees nothing usable even where TLS ends early.
function payloadAad(id: string, nonce: string): Buffer {
  return fields([`${LABEL}/install/payload`, id, nonce]);
}

export function sealInstallPayload(encKey: Buffer, id: string, nonce: string, plaintext: Buffer): { iv: string; ct: string } {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', encKey, iv);
  cipher.setAAD(payloadAad(id, nonce));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { iv: iv.toString('base64url'), ct: body.toString('base64url') };
}

// Throws unless the payload is exactly what the inviting node sealed for this
// install and this request.
export function openInstallPayload(encKey: Buffer, id: string, nonce: string, sealed: { iv: string; ct: string }): Buffer {
  const iv = Buffer.from(sealed.iv, 'base64url');
  const body = Buffer.from(sealed.ct, 'base64url');
  if (iv.length !== IV_BYTES || body.length < TAG_BYTES) throw new Error('sealed payload is malformed');
  const decipher = createDecipheriv('aes-256-gcm', encKey, iv);
  decipher.setAAD(payloadAad(id, nonce));
  decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
  return Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()]);
}
