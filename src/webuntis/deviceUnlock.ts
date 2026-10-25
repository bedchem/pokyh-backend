import { passkeyRelyingParty } from '../security/adminLogin';
import type { RenewalSchool, SavedSignIn } from './renewal';

// Signing in to the installed website with the device's own lock (Face ID,
// Touch ID, a fingerprint, the device's PIN; services/webPasskeys.ts). Pure
// (the school parser is passed in), tested on its own
// (tests/webuntisDeviceUnlock.test.mjs).
//
// What the device keeps, sealed in its httpOnly cookie pokyh_unlock: the
// account, its passkey, and for a WebUntis account the sign-in itself (user
// name, password or app key, school) as the 4-hour renewal cookie holds it.
// Neither half opens anything alone: the cookie counts only together with a
// fresh answer of its passkey, the passkey only together with the cookie.

export interface DeviceUnlock {
  /** The account (users.stable_uid). */
  uid: string;
  /** The passkey's credential id. */
  cid: string;
  /**
   * A WebUntis account's sign-in. None for a POKYH-only account, and none
   * once WebUntis refused it (a changed password): the next password sign-in
   * puts the new one in.
   */
  signIn?: SavedSignIn;
}

type Sealed = { kind?: unknown; uid?: unknown; cid?: unknown; u?: unknown; p?: unknown; k?: unknown; s?: unknown };

/** What the unlock cookie seals (./seal.ts). */
export function unlockPayload(unlock: DeviceUnlock): object {
  const signIn = unlock.signIn
    ? {
      u: unlock.signIn.username,
      ...(unlock.signIn.password !== undefined ? { p: unlock.signIn.password } : { k: unlock.signIn.key }),
      s: unlock.signIn.school,
    }
    : {};
  return { kind: 'unlock', uid: unlock.uid, cid: unlock.cid, ...signIn };
}

/** What an unlock cookie holds, or null for anything else (another cookie's payload, a broken one). */
export function readUnlock(sealed: Sealed | null, parseSchool: (value: unknown) => RenewalSchool | null): DeviceUnlock | null {
  if (sealed?.kind !== 'unlock' || typeof sealed.uid !== 'string' || !sealed.uid || typeof sealed.cid !== 'string' || !sealed.cid) return null;
  const unlock: DeviceUnlock = { uid: sealed.uid, cid: sealed.cid };
  const secret = typeof sealed.p === 'string' ? { password: sealed.p } : typeof sealed.k === 'string' ? { key: sealed.k } : null;
  const school = parseSchool(sealed.s);
  if (typeof sealed.u === 'string' && sealed.u && secret && school) unlock.signIn = { username: sealed.u, ...secret, school };
  return unlock;
}

/**
 * The relying party of a passkey made or used on the website: the page's
 * origin when it is one of the website's own (`allowed`; with
 * `allowLocalhost`, in development, any http://localhost page too), and its
 * domain without "www.", so a passkey made on www.pokyh.com works on
 * pokyh.com and the other way round.
 */
export function websiteRelyingParty(origin: unknown, allowed: readonly string[], allowLocalhost: boolean): { origin: string; rpId: string } | null {
  if (typeof origin !== 'string') return null;
  const local = allowLocalhost && /^http:\/\/localhost(?::\d{1,5})?$/.test(origin);
  if (!local && !allowed.includes(origin)) return null;
  const rp = passkeyRelyingParty(origin, [origin]);
  return rp && { origin: rp.origin, rpId: rp.rpId.replace(/^www\./, '') };
}
