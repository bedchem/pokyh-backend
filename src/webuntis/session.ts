import { randomBytes } from 'crypto';
import type { CookieOptions, NextFunction, Request, Response } from 'express';
import { config } from '../config';
import { deviceIdFrom } from '../services/sessionDevice';
import { isSessionRevoked } from '../utils/revokedTokens';
import type { UntisSession } from './client';
import { seal, unseal } from './crypto';
import { readUnlock, unlockPayload, type DeviceUnlock } from './deviceUnlock';
import { matchRenewal, renewalPayload, type SavedSignIn } from './renewal';
import { defaultSchool, parseSchool, type UntisSchool } from './schools';

// A website sign-in lives in the browser's cookies and nowhere else, so
// deleting them signs out. All of them are httpOnly (page scripts cannot read
// them), host-only on the API's address, Secure and SameSite=Strict:
//
//   pokyh_session      the WebUntis session, sealed (AES-GCM), 4 hours
//   pokyh_renew        user name, password and school, sealed, 4 hours, sent
//                      only to the sign-in address; lets the API sign in again
//                      by itself when WebUntis ends its session early, and is
//                      only accepted next to the session it belongs to
//   pokyh_api_refresh  the POKYH refresh token, 30 days
//   pokyh_device       a random id of this browser, 400 days: the account's
//                      device list knows the browser again when it signs in
//                      anew (services/sessions.ts); outlives signing out
//   pokyh_unlock       the installed website's sign-in with the device's own
//                      lock (services/webPasskeys.ts): account, passkey and
//                      the sign-in as pokyh_renew holds it, sealed, 180 days
//                      from its last use, sent only to the sign-in address;
//                      counts only with a fresh answer of its passkey and
//                      outlives signing out (it is turned off in the settings)
//
// The website's own pokyh_user and pokyh_api_token cookies are set by the
// website from the sign-in's answer.

declare global {
  namespace Express {
    interface Request {
      untis?: UntisSession;
    }
  }
}

export const SESSION_COOKIE = 'pokyh_session';
export const RENEWAL_COOKIE = 'pokyh_renew';
export const REFRESH_COOKIE = 'pokyh_api_refresh';
export const DEVICE_COOKIE = 'pokyh_device';
export const UNLOCK_COOKIE = 'pokyh_unlock';
export const RENEWAL_PATH = '/webuntis/login';
const REFRESH_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// Browsers cap cookie lifetimes at 400 days.
const DEVICE_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;
export const UNLOCK_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

function cookieOptions(path = '/'): CookieOptions {
  return { httpOnly: true, secure: config.webuntis.cookieSecure, sameSite: 'strict', path };
}

export type { SavedSignIn };

export function setSessionCookie(res: Response, session: UntisSession): void {
  res.cookie(SESSION_COOKIE, seal(session), { ...cookieOptions(), maxAge: config.webuntis.sessionMaxAgeMs });
}

export function sealRenewal(res: Response, signIn: SavedSignIn): void {
  res.cookie(RENEWAL_COOKIE, seal(renewalPayload(signIn)), { ...cookieOptions(RENEWAL_PATH), maxAge: config.webuntis.sessionMaxAgeMs });
}

/** This device's sign-in with its lock; set again on every use, so its 180 days count from the last one. */
export function setUnlockCookie(res: Response, unlock: DeviceUnlock): void {
  res.cookie(UNLOCK_COOKIE, seal(unlockPayload(unlock)), { ...cookieOptions(RENEWAL_PATH), maxAge: UNLOCK_MAX_AGE_MS });
}

export function clearUnlockCookie(res: Response): void {
  res.clearCookie(UNLOCK_COOKIE, cookieOptions(RENEWAL_PATH));
}

export function setRefreshCookie(res: Response, refreshToken: string): void {
  res.cookie(REFRESH_COOKIE, refreshToken, { ...cookieOptions(), maxAge: REFRESH_MAX_AGE_MS });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, cookieOptions());
}

/** Ends the website sign-in in this browser: every cookie above goes but pokyh_device and pokyh_unlock. */
export function clearSignInCookies(res: Response): void {
  res.clearCookie(SESSION_COOKIE, cookieOptions());
  res.clearCookie(RENEWAL_COOKIE, cookieOptions(RENEWAL_PATH));
  clearRefreshCookie(res);
}

function cookie(req: Request, name: string): string | undefined {
  const value = (req.cookies as Record<string, unknown> | undefined)?.[name];
  return typeof value === 'string' && value ? value : undefined;
}

export function readRefreshCookie(req: Request): string | undefined {
  return cookie(req, REFRESH_COOKIE);
}

/** What this device's unlock cookie holds, or null when it has none. */
export function readUnlockCookie(req: Request): DeviceUnlock | null {
  return readUnlock(unseal(cookie(req, UNLOCK_COOKIE)), parseSchool);
}

/** This browser's device id from its device cookie; a new one (and the cookie) when it has none. */
export function webDeviceId(req: Request, res: Response): string {
  const id = deviceIdFrom(cookie(req, DEVICE_COOKIE)) ?? randomBytes(18).toString('base64url');
  // Set again on every sign-in, so the 400 days count from the last one.
  res.cookie(DEVICE_COOKIE, id, { ...cookieOptions(), maxAge: DEVICE_MAX_AGE_MS });
  return id;
}

function fresh(loginAt: unknown): boolean {
  return typeof loginAt !== 'number' || Date.now() - loginAt <= config.webuntis.sessionMaxAgeMs;
}

/** The request's WebUntis session, or null: none, altered, or older than 4 hours. */
export function readSession(req: Request): UntisSession | null {
  const session = unseal<UntisSession>(cookie(req, SESSION_COOKIE));
  if (!session || typeof session.sessionId !== 'string' || !session.sessionId || typeof session.username !== 'string') return null;
  return fresh(session.loginAt) ? session : null;
}

/**
 * The saved sign-in of the request's session, or null when there is none:
 * no renewal cookie, no session cookie, an expired session, or one of a
 * different account or school (./renewal.ts).
 */
export function openRenewal(req: Request): SavedSignIn | null {
  return matchRenewal(
    unseal(cookie(req, RENEWAL_COOKIE)),
    unseal<{ username?: string; school?: UntisSchool; loginAt?: number }>(cookie(req, SESSION_COOKIE)),
    { now: Date.now(), maxAgeMs: config.webuntis.sessionMaxAgeMs, parseSchool, defaultSchool: defaultSchool() },
  );
}

/**
 * Routes that act with the person's WebUntis session; 401 `session_expired`
 * without one. A browser signed out from elsewhere (its device session
 * revoked) loses every sign-in cookie and gets `session_revoked`.
 */
export function requireUntisSession(req: Request, res: Response, next: NextFunction): void {
  const session = readSession(req);
  if (!session) {
    res.clearCookie(SESSION_COOKIE, cookieOptions());
    res.status(401).json({ error: 'session_expired' });
    return;
  }
  if (isSessionRevoked(session.pokyhSid)) {
    clearSignInCookies(res);
    res.status(401).json({ error: 'session_expired', code: 'session_revoked' });
    return;
  }
  req.untis = session;
  next();
}
