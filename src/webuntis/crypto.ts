import { createHash } from 'crypto';
import { config } from '../config';
import { sealWith, unsealWith } from './seal';

// The website's WebUntis session and its sealed sign-in live in the browser
// only, in httpOnly cookies sealed with AES-256-GCM (./seal.ts). The key comes
// from WEBUNTIS_SESSION_SECRET or, when that is empty, from JWT_SECRET; every
// node of a cluster shares both, so a cookie sealed by one node opens on any
// other.

let key: Buffer | null = null;

function sealKey(): Buffer {
  key ??= createHash('sha256')
    .update(`${config.webuntis.sessionSecret || config.jwtSecret}:pokyh-webuntis-session`)
    .digest();
  return key;
}

export function seal(data: object): string {
  return sealWith(sealKey(), data);
}

/** The sealed value, or null for anything not sealed with this key (or altered). */
export function unseal<T>(token: string | undefined): T | null {
  return unsealWith<T>(sealKey(), token);
}
