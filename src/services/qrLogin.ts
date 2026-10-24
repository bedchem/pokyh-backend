import { randomBytes } from 'crypto';
import { prisma } from '../db';
import { seal, unseal } from '../webuntis/crypto';
import { hashToken, type SignInContext } from './sessions';
import { deviceLabel, placeLabel } from './sessionDevice';

// Signing the website in with the POKYH app, like a messenger's web version:
//
//  1. The website asks for a sign-in (POST /webuntis/qr/start) and shows the
//     code as a QR code; it keeps a second, secret value to ask with.
//  2. The app, signed in, scans the code, shows where the website is (device,
//     place, address) and, once the person confirms, approves it
//     (POST /auth/qr/:code/approve), handing over its sign-in: the WebUntis
//     user name, password and school, as typing them on the website would.
//  3. The website asks (POST /webuntis/qr/poll) and, once approved, is signed
//     in through the same steps as the password sign-in.
//
// A code lives QR_LOGIN_MS and works once. Only hashes of the two values are
// stored; the handed-over sign-in is sealed and deleted with the row.

export const QR_LOGIN_MS = 2 * 60 * 1000;
const QR_PREFIX = 'POKYH-LOGIN:';

export interface QrCredential {
  username: string;
  password?: string;
  key?: string;
  school?: { loginName: string; server: string; name?: string };
  /** The app's own WebUntis session (JSESSIONID), taken over by the website when still signed in. */
  sessionId?: string;
}

const newSecret = () => randomBytes(24).toString('base64url');

/** What the QR code holds. */
export const qrText = (code: string) => `${QR_PREFIX}${code}`;

/** The code from what the app scanned (the whole text or only the code). */
export function codeFromScan(value: string): string | null {
  const code = value.trim().replace(QR_PREFIX, '');
  return /^[A-Za-z0-9_-]{24,64}$/.test(code) ? code : null;
}

export async function startQrLogin(ctx: SignInContext): Promise<{ code: string; poll: string; expiresAt: Date }> {
  const code = newSecret();
  const poll = newSecret();
  const expiresAt = new Date(Date.now() + QR_LOGIN_MS);
  await prisma.qrLogin.create({
    data: {
      codeHash: hashToken(code),
      pollHash: hashToken(poll),
      expiresAt,
      client: ctx.device.client,
      platform: ctx.device.platform,
      os: ctx.device.os.slice(0, 40),
      browser: ctx.device.browser.slice(0, 40),
      ip: ctx.ip,
      country: ctx.country,
      region: ctx.region,
      city: ctx.city,
    },
  });
  return { code, poll, expiresAt };
}

async function pendingByCode(code: string) {
  const row = await prisma.qrLogin.findUnique({ where: { codeHash: hashToken(code) } });
  return row && row.status === 'pending' && row.expiresAt > new Date() ? row : null;
}

/** The website waiting for this code, as the app shows it before confirming; null when gone. */
export async function qrLoginInfo(code: string) {
  const row = await pendingByCode(code);
  if (!row) return null;
  return {
    label: deviceLabel({ os: row.os, browser: row.browser, model: '' }),
    client: row.client || 'web',
    platform: row.platform || 'other',
    os: row.os,
    browser: row.browser,
    ip: row.ip,
    country: row.country,
    region: row.region,
    city: row.city,
    place: placeLabel(row),
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

/** The app confirms: the website may sign in as this account. False when the code is gone. */
export async function approveQrLogin(code: string, stableUid: string, credential: QrCredential | null): Promise<boolean> {
  const { count } = await prisma.qrLogin.updateMany({
    where: { codeHash: hashToken(code), status: 'pending', expiresAt: { gt: new Date() } },
    data: { status: 'approved', stableUid, credential: credential ? seal(credential) : null },
  });
  return count > 0;
}

export type QrPoll =
  | { state: 'expired' }
  | { state: 'pending' }
  | { state: 'approved'; id: string; stableUid: string; credential: QrCredential | null };

/** What the website's secret value stands at. */
export async function pollQrLogin(poll: string): Promise<QrPoll> {
  const row = await prisma.qrLogin.findUnique({ where: { pollHash: hashToken(poll) } });
  if (!row || row.status === 'done' || row.expiresAt <= new Date()) return { state: 'expired' };
  if (row.status !== 'approved' || !row.stableUid) return { state: 'pending' };
  return { state: 'approved', id: row.id, stableUid: row.stableUid, credential: row.credential ? unseal<QrCredential>(row.credential) : null };
}

/** Used: the sealed sign-in goes at once, the row with the next cleanup. */
export async function finishQrLogin(id: string): Promise<void> {
  await prisma.qrLogin.updateMany({ where: { id }, data: { status: 'done', credential: null } });
}

export async function cleanupQrLogins(): Promise<number> {
  const { count } = await prisma.qrLogin.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 60_000) } } });
  return count;
}
