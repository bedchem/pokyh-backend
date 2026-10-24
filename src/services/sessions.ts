import { createHash, randomBytes } from 'crypto';
import type { Request } from 'express';
import { prisma } from '../db';
import { config } from '../config';
import { clientIp } from '../middleware/requestLogger';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';
import { noteSessionRevocation } from '../utils/revokedTokens';
import { countryFromHeader, placeFromHeader, visitorIp } from './webVisitMeta';
import { deviceFromRequest, deviceIdFrom, deviceLabel, placeLabel, type DeviceInfo } from './sessionDevice';

// An account's signed-in devices and its login history.
//
// Every device that signs in has its own session (one refresh_tokens row) —
// the phone app and the website side by side, each signed out on its own.
// The refresh token is rotated in place, so the row stays the same device; its
// id is the access token's `sid`. A device is recognised again by the refresh
// token it holds, else by its device id (the app's X-Pokyh-Device header, the
// website's pokyh_device cookie), so its automatic renewals never pile up as
// new devices.
//
// Ending a session from elsewhere (the account's device list, an admin) marks
// the row revoked: its access tokens stop working at once
// (utils/revokedTokens.ts), and the device's next automatic sign-in is refused
// with `session_revoked` — the person has to sign in again, which opens a new
// session.

export const DEVICE_HEADER = 'x-pokyh-device';
export const CLIENT_HEADER = 'x-pokyh-client';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface SignInContext {
  device: DeviceInfo;
  deviceId: string | null;
  ip: string | null;
  country: string;
  region: string | null;
  city: string | null;
  /** The refresh token this device already holds (the website's cookie) when it signs in again. */
  currentToken?: string;
  /** An automatic sign-in of a device that is signed in already, not one by the person. */
  renewal: boolean;
}

/** What a request says about the device signing in and where it is. */
export function signInContext(
  req: Request,
  opts: { renewal?: boolean; currentToken?: string | null; deviceId?: string | null } = {},
): SignInContext {
  return {
    device: deviceFromRequest(req.headers['user-agent'], req.headers[CLIENT_HEADER]),
    deviceId: opts.deviceId ?? deviceIdFrom(req.headers[DEVICE_HEADER]),
    ip: visitorIp(clientIp(req), req.headers['cf-connecting-ip']),
    country: countryFromHeader(req.headers['cf-ipcountry']),
    region: placeFromHeader(req.headers['cf-region']),
    city: placeFromHeader(req.headers['cf-ipcity']),
    currentToken: opts.currentToken ?? undefined,
    renewal: opts.renewal === true,
  };
}

/** A sign-in that names no request. */
export const NO_CONTEXT: SignInContext = {
  device: { client: 'other', platform: 'other', os: '', browser: '', model: '' },
  deviceId: null,
  ip: null,
  country: '',
  region: null,
  city: null,
  renewal: false,
};

export class SessionRevokedError extends AppError {
  constructor() {
    super('Dieses Gerät wurde abgemeldet. Bitte melde dich neu an.', 401, 'session_revoked');
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const idleCutoff = () => new Date(Date.now() - config.sessionIdleDays * DAY_MS);

function deviceColumns(device: DeviceInfo) {
  return {
    client: device.client,
    platform: device.platform,
    os: device.os.slice(0, 40),
    browser: device.browser.slice(0, 40),
    model: device.model.slice(0, 60),
  };
}

function placeColumns(ctx: SignInContext) {
  return { ip: ctx.ip, country: ctx.country, region: ctx.region, city: ctx.city };
}

function newRefreshToken() {
  const raw = randomBytes(40).toString('hex');
  return {
    raw,
    tokenHash: hashToken(raw),
    expiresAt: new Date(Date.now() + config.refreshTokenExpiresInHours * 60 * 60 * 1000),
  };
}

type Found = { id: string; revokedAt: Date | null } | null;

// The session this device had: the one of the refresh token it holds, else
// the latest of its device id, else — for clients without one (older apps,
// the Learn BFF) — the latest of the same kind of client and system.
async function findDeviceSession(stableUid: string, ctx: SignInContext): Promise<Found> {
  const select = { id: true, revokedAt: true } as const;
  const idle = idleCutoff();
  if (ctx.currentToken) {
    const held = await prisma.refreshToken.findFirst({ where: { tokenHash: hashToken(ctx.currentToken), stableUid }, select });
    if (held) return held;
  }
  if (ctx.deviceId) {
    return prisma.refreshToken.findFirst({
      where: { stableUid, deviceId: ctx.deviceId, lastUsedAt: { gt: idle } },
      orderBy: { lastUsedAt: 'desc' },
      select,
    });
  }
  return prisma.refreshToken.findFirst({
    where: {
      stableUid, deviceId: null, revokedAt: null, lastUsedAt: { gt: idle },
      client: ctx.device.client, platform: ctx.device.platform, browser: ctx.device.browser.slice(0, 40),
    },
    orderBy: { lastUsedAt: 'desc' },
    select,
  });
}

/**
 * The device session a sign-in continues or opens, with a fresh refresh
 * token. An automatic sign-in of a device whose session was ended from
 * elsewhere is refused (SessionRevokedError).
 */
export async function openSession(stableUid: string, ctx: SignInContext): Promise<{ sid: string; refreshToken: string; isNew: boolean }> {
  const token = newRefreshToken();
  const found = await findDeviceSession(stableUid, ctx);
  if (found?.revokedAt && ctx.renewal) throw new SessionRevokedError();

  const seen = { ...placeColumns(ctx), lastUsedAt: new Date() };
  if (found && !found.revokedAt) {
    await prisma.refreshToken.update({
      where: { id: found.id },
      data: {
        tokenHash: token.tokenHash,
        expiresAt: token.expiresAt,
        // A request that names no device (a server on the device's behalf)
        // keeps what the device itself told.
        ...(ctx.device.client !== 'other' ? deviceColumns(ctx.device) : {}),
        ...(ctx.deviceId ? { deviceId: ctx.deviceId } : {}),
        ...seen,
      },
    });
    return { sid: found.id, refreshToken: token.raw, isNew: false };
  }

  // A new device, or the person signing in again on a device that was signed
  // out from elsewhere: a session of its own.
  const created = await prisma.refreshToken.create({
    data: {
      stableUid,
      tokenHash: token.tokenHash,
      expiresAt: token.expiresAt,
      deviceId: ctx.deviceId,
      ...deviceColumns(ctx.device),
      ...seen,
    },
    select: { id: true },
  });
  await trimSessions(stableUid);
  return { sid: created.id, refreshToken: token.raw, isNew: true };
}

// At most SESSIONS_PER_ACCOUNT_MAX devices: the longest unused ones beyond
// that are signed out.
async function trimSessions(stableUid: string): Promise<void> {
  const active = await prisma.refreshToken.findMany({
    where: { stableUid, revokedAt: null },
    orderBy: { lastUsedAt: 'desc' },
    select: { id: true },
  });
  const surplus = active.slice(config.sessionsPerAccountMax).map((row) => row.id);
  if (surplus.length) await revokeSessionIds(surplus);
}

/**
 * A new refresh token for one the device holds, rotated in place; null when
 * it is unknown, revoked or expired. With the session (`sid`) and its account.
 */
export async function rotateSession(rawToken: string, ctx: SignInContext) {
  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    include: { user: true },
  });
  if (!stored || stored.revokedAt || stored.expiresAt < new Date()) return null;
  const token = newRefreshToken();
  // Rotation is a compare-and-swap on the old hash: of two refreshes racing
  // with the same token only one wins.
  const { count } = await prisma.refreshToken.updateMany({
    where: { id: stored.id, tokenHash: stored.tokenHash, revokedAt: null },
    data: {
      tokenHash: token.tokenHash,
      expiresAt: token.expiresAt,
      ...(ctx.device.browser ? deviceColumns(ctx.device) : {}),
      ...placeColumns(ctx),
      lastUsedAt: new Date(),
    },
  });
  if (count === 0) return null;
  return { sid: stored.id, refreshToken: token.raw, user: stored.user };
}

/** Signs these devices out (their tokens and automatic sign-ins end at once). */
export async function revokeSessionIds(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const revokedAt = new Date();
  const { count } = await prisma.refreshToken.updateMany({ where: { id: { in: ids }, revokedAt: null }, data: { revokedAt } });
  for (const id of ids) noteSessionRevocation(id, revokedAt);
  return count;
}

/** Signs out one device of the account; false when it is not one of its signed-in devices. */
export async function revokeSession(stableUid: string, sid: string): Promise<boolean> {
  const row = await prisma.refreshToken.findFirst({ where: { id: sid, stableUid, revokedAt: null }, select: { id: true } });
  if (!row) return false;
  return (await revokeSessionIds([row.id])) > 0;
}

/** Signs out every device of the account but `keepSid` (none kept when it is null). */
export async function revokeSessions(stableUid: string, keepSid: string | null = null): Promise<number> {
  const rows = await prisma.refreshToken.findMany({
    where: { stableUid, revokedAt: null, ...(keepSid ? { id: { not: keepSid } } : {}) },
    select: { id: true },
  });
  return revokeSessionIds(rows.map((row) => row.id));
}

/** The device holding this refresh token signs itself out. */
export async function endSessionOfToken(rawToken: string): Promise<void> {
  const row = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(rawToken) }, select: { id: true, revokedAt: true } });
  if (row && !row.revokedAt) await revokeSessionIds([row.id]);
}

type SessionRow = {
  id: string; client: string; platform: string; os: string; browser: string; model: string;
  ip: string | null; country: string; region: string | null; city: string | null;
  createdAt: Date; lastUsedAt: Date;
};

/** A device as the account's device list (and the admin panel) shows it. */
export function describeSession(row: SessionRow, currentSid?: string | null) {
  return {
    id: row.id,
    current: currentSid ? row.id === currentSid : false,
    client: row.client || 'other',
    platform: row.platform || 'other',
    os: row.os,
    browser: row.browser,
    model: row.model,
    label: deviceLabel(row),
    ip: row.ip,
    country: row.country,
    region: row.region,
    city: row.city,
    place: placeLabel(row),
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt.toISOString(),
  };
}

export const SESSION_SELECT = {
  id: true, client: true, platform: true, os: true, browser: true, model: true,
  ip: true, country: true, region: true, city: true, createdAt: true, lastUsedAt: true,
} as const;

/** The account's signed-in devices, the current one first, then by last use. */
export async function listSessions(stableUid: string, currentSid?: string | null) {
  const rows = await prisma.refreshToken.findMany({
    where: { stableUid, revokedAt: null, lastUsedAt: { gt: idleCutoff() } },
    orderBy: { lastUsedAt: 'desc' },
    select: SESSION_SELECT,
  });
  const sessions = rows.map((row) => describeSession(row, currentSid));
  return [...sessions.filter((s) => s.current), ...sessions.filter((s) => !s.current)];
}

export type LoginMethod = 'webuntis' | 'office' | 'local' | 'register' | 'qr';

/**
 * Notes a sign-in by the person in the account's login history (best effort).
 * Apps from before device ids sign in again by themselves every hour without
 * saying so; for them only a new device counts as a sign-in.
 */
export async function recordLogin(stableUid: string, ctx: SignInContext, method: LoginMethod, session: { sid: string; isNew: boolean }): Promise<void> {
  if (ctx.renewal) return;
  if (ctx.device.client === 'app' && !ctx.deviceId && !session.isNew) return;
  const sid = session.sid;
  try {
    await prisma.loginEvent.create({
      data: { stableUid, method, sessionId: sid, ...deviceColumns(ctx.device), ...placeColumns(ctx) },
    });
  } catch (err) {
    logger.warn('Login history entry not written', { action: 'login_event_failed', message: err instanceof Error ? err.message.split('\n')[0] : String(err) });
  }
}

/** The account's sign-ins, newest first. */
export async function loginHistory(stableUid: string, take = 100) {
  const rows = await prisma.loginEvent.findMany({
    where: { stableUid },
    orderBy: { createdAt: 'desc' },
    take,
  });
  return rows.map((row) => ({
    id: row.id,
    at: row.createdAt.toISOString(),
    method: row.method,
    client: row.client || 'other',
    platform: row.platform || 'other',
    os: row.os,
    browser: row.browser,
    model: row.model,
    label: deviceLabel(row),
    ip: row.ip,
    country: row.country,
    region: row.region,
    city: row.city,
    place: placeLabel(row),
  }));
}

/**
 * Removes what is no longer needed: devices unused for SESSION_IDLE_DAYS,
 * revoked ones as long ago (so their automatic sign-in stays refused until
 * then), refresh tokens from before device sessions that have expired, and
 * login history older than LOGIN_HISTORY_DAYS.
 */
export async function cleanupSessions(): Promise<{ sessions: number; logins: number }> {
  const idle = idleCutoff();
  const { count: sessions } = await prisma.refreshToken.deleteMany({
    where: {
      OR: [
        { lastUsedAt: { lt: idle } },
        { revokedAt: { lt: idle } },
        { client: '', expiresAt: { lt: new Date(Date.now() - 12 * 60 * 60 * 1000) } },
      ],
    },
  });
  const { count: logins } = await prisma.loginEvent.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - config.loginHistoryDays * DAY_MS) } },
  });
  return { sessions, logins };
}
