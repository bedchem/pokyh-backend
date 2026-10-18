import jwt from 'jsonwebtoken';
import { createHash, createHmac, randomUUID } from 'crypto';
import QRCode from 'qrcode';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { config } from '../config';
import { prisma } from '../db';
import { TtlCache } from '../utils/cache';
import { ConflictError, NotFoundError, UnauthorizedError, ValidationError } from '../utils/errors';
import {
  consumeRecoveryCode,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  openSecret,
  otpauthUrl,
  sealSecret,
  verifyTotp,
} from '../security/totp';

/**
 * Second factors of the admin panel login: an authenticator app (TOTP) with
 * one-time recovery codes, and passkeys. A passkey alone opens the panel
 * (possession + the device's own PIN/biometrics); after a password, either
 * factor completes the login.
 *
 * Every hand-over between two requests (the ticket after a correct password,
 * a WebAuthn challenge) is a short-lived token signed with a key derived from
 * JWT_SECRET — never with JWT_SECRET itself, so it can never be mistaken for
 * a user or admin session — and no node has to remember it: any node of a
 * cluster can finish a login another one started.
 */

const ISSUER = 'Pokyh Admin';
const FLOW_TTL_SECONDS = 5 * 60;
const MAX_TICKET_ATTEMPTS = 6;

function flowKey(): string {
  return createHmac('sha256', config.jwtSecret).update('pokyh-admin-login-flow-v1').digest('hex');
}

type FlowPurpose = 'second-factor' | 'passkey-register' | 'passkey-login';

type FlowClaims = {
  purpose: FlowPurpose;
  username?: string;
  challenge?: string;
  rpId?: string;
  origin?: string;
  // A passkey challenge started from a ticket stays tied to that ticket.
  ticketId?: string;
};

function signFlow(claims: FlowClaims): string {
  return jwt.sign(claims, flowKey(), { expiresIn: FLOW_TTL_SECONDS, audience: claims.purpose, jwtid: randomUUID() });
}

// A failed login step is a 401. Adding a passkey happens inside a session,
// where the panel would read a 401 as "logged out" — that failure is a 422.
function flowError(purpose: FlowPurpose, message: string): Error {
  return purpose === 'passkey-register' ? new ValidationError(message) : new UnauthorizedError(message);
}

function readFlow(token: unknown, purpose: FlowPurpose): FlowClaims & { jti: string } {
  const expired = purpose === 'passkey-register' ? 'Anfrage abgelaufen — bitte erneut versuchen' : 'Anmeldung abgelaufen — bitte neu anmelden';
  if (typeof token !== 'string' || !token) throw flowError(purpose, expired);
  try {
    const claims = jwt.verify(token, flowKey(), { audience: purpose }) as FlowClaims & { jti?: string };
    if (claims.purpose !== purpose || !claims.jti) throw new Error('wrong purpose');
    return claims as FlowClaims & { jti: string };
  } catch {
    throw flowError(purpose, expired);
  }
}

// Node-local, best effort on top of the 5-minute expiry: a ticket gets a few
// tries at a code, and a WebAuthn challenge is accepted once.
const ticketAttempts = new TtlCache<number>(FLOW_TTL_SECONDS * 1000);
const usedChallenges = new TtlCache<true>(FLOW_TTL_SECONDS * 1000);

function useChallenge(purpose: FlowPurpose, challenge: string): void {
  if (usedChallenges.get(challenge)) throw flowError(purpose, 'Passkey-Anfrage wurde bereits verwendet');
  usedChallenges.set(challenge, true);
}

// ── Status ─────────────────────────────────────────────────────────────────

export type PasskeySummary = { id: string; name: string; rpId: string; backedUp: boolean; createdAt: string; lastUsedAt: string | null };

export type SecurityStatus = {
  username: string;
  totpEnabled: boolean;
  recoveryCodesLeft: number;
  passkeys: PasskeySummary[];
};

function parseHashes(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

export async function securityStatus(username: string): Promise<SecurityStatus> {
  const [totp, passkeys] = await Promise.all([
    prisma.adminTotp.findUnique({ where: { username } }),
    prisma.adminPasskey.findMany({ where: { username }, orderBy: { createdAt: 'asc' } }),
  ]);
  return {
    username,
    totpEnabled: Boolean(totp?.enabledAt),
    recoveryCodesLeft: totp?.enabledAt ? parseHashes(totp.recoveryCodes).length : 0,
    passkeys: passkeys.map((key) => ({
      id: key.id,
      name: key.name,
      rpId: key.rpId,
      backedUp: key.backedUp,
      createdAt: key.createdAt.toISOString(),
      lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    })),
  };
}

export type SecondFactorMethods = { totp: boolean; passkey: boolean };

export async function secondFactorMethods(username: string): Promise<SecondFactorMethods> {
  const [totp, passkeys] = await Promise.all([
    prisma.adminTotp.findUnique({ where: { username }, select: { enabledAt: true } }),
    prisma.adminPasskey.count({ where: { username } }),
  ]);
  return { totp: Boolean(totp?.enabledAt), passkey: passkeys > 0 };
}

/** Removes every second factor of an admin (revoked admin, deleted account, lost phone). */
export async function clearSecondFactors(username: string): Promise<void> {
  await prisma.$transaction([
    prisma.adminTotp.deleteMany({ where: { username } }),
    prisma.adminPasskey.deleteMany({ where: { username } }),
  ]);
}

// ── Ticket after a correct password ────────────────────────────────────────

export function issueSecondFactorTicket(username: string): string {
  return signFlow({ purpose: 'second-factor', username });
}

export function readSecondFactorTicket(ticket: unknown): { username: string; ticketId: string } {
  const claims = readFlow(ticket, 'second-factor');
  if (!claims.username) throw new UnauthorizedError('Anmeldung abgelaufen — bitte neu anmelden');
  const attempts = (ticketAttempts.get(claims.jti) ?? 0) + 1;
  if (attempts > MAX_TICKET_ATTEMPTS) throw new UnauthorizedError('Zu viele Versuche — bitte neu anmelden');
  ticketAttempts.set(claims.jti, attempts);
  return { username: claims.username, ticketId: claims.jti };
}

// ── Authenticator app (TOTP) ───────────────────────────────────────────────

export async function startTotpSetup(username: string): Promise<{ secret: string; otpauthUrl: string; qrSvg: string }> {
  const existing = await prisma.adminTotp.findUnique({ where: { username } });
  if (existing?.enabledAt) throw new ConflictError('Die Authenticator-App ist bereits eingerichtet');
  const secret = generateTotpSecret();
  const secretEnc = sealSecret(secret, config.jwtSecret);
  await prisma.adminTotp.upsert({
    where: { username },
    create: { username, secretEnc, recoveryCodes: '[]' },
    update: { secretEnc, enabledAt: null, lastUsedStep: 0, recoveryCodes: '[]' },
  });
  const url = otpauthUrl(secret, username, ISSUER);
  const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  return { secret, otpauthUrl: url, qrSvg };
}

function readSecret(secretEnc: string): string {
  try {
    return openSecret(secretEnc, config.jwtSecret);
  } catch {
    // JWT_SECRET changed since the set-up: the stored secret is unreadable.
    throw new ValidationError('2FA-Geheimnis nicht lesbar (JWT_SECRET geändert?) — npm run reset-admin-2fa <name>');
  }
}

/** Accepts a TOTP step only if no other request used it (or a later one) first. */
async function acceptTotpStep(username: string, step: number): Promise<boolean> {
  const updated = await prisma.adminTotp.updateMany({
    where: { username, lastUsedStep: { lt: step } },
    data: { lastUsedStep: step },
  });
  return updated.count === 1;
}

export async function enableTotp(username: string, code: string): Promise<string[]> {
  const row = await prisma.adminTotp.findUnique({ where: { username } });
  if (!row) throw new ValidationError('Starte zuerst die Einrichtung');
  if (row.enabledAt) throw new ConflictError('Die Authenticator-App ist bereits eingerichtet');
  const step = verifyTotp(readSecret(row.secretEnc), code, Date.now(), row.lastUsedStep);
  if (step === null) throw new ValidationError('Code stimmt nicht — prüfe die Uhrzeit des Geräts');
  const codes = generateRecoveryCodes();
  await prisma.adminTotp.update({
    where: { username },
    data: { enabledAt: new Date(), lastUsedStep: step, recoveryCodes: JSON.stringify(codes.map(hashRecoveryCode)) },
  });
  return codes;
}

/**
 * Checks a code from the authenticator app or one of the recovery codes and
 * uses it up. Returns which kind it was, or null. With `allowTotp` false only
 * a recovery code counts (a login that has to be confirmed with a passkey).
 */
export async function useSecondFactorCode(username: string, code: string, allowTotp = true): Promise<'totp' | 'recovery' | null> {
  const row = await prisma.adminTotp.findUnique({ where: { username } });
  if (!row?.enabledAt) return null;
  const step = allowTotp ? verifyTotp(readSecret(row.secretEnc), code, Date.now(), row.lastUsedStep) : null;
  if (step !== null) return (await acceptTotpStep(username, step)) ? 'totp' : null;
  const remaining = consumeRecoveryCode(parseHashes(row.recoveryCodes), code);
  if (!remaining) return null;
  // Only if the list is still the one read above: a recovery code is used once.
  const updated = await prisma.adminTotp.updateMany({
    where: { username, recoveryCodes: row.recoveryCodes },
    data: { recoveryCodes: JSON.stringify(remaining) },
  });
  return updated.count === 1 ? 'recovery' : null;
}

/**
 * Moving the authenticator app to a new device without a gap: a current code
 * (or a recovery code) starts it, the new secret waits beside the old one,
 * and a code from the new device swaps them. Recovery codes stay valid.
 */
export async function startTotpMove(username: string, code: string): Promise<{ secret: string; otpauthUrl: string; qrSvg: string }> {
  const row = await prisma.adminTotp.findUnique({ where: { username } });
  if (!row?.enabledAt) throw new ValidationError('Die Authenticator-App ist noch nicht eingerichtet');
  if (!(await useSecondFactorCode(username, code))) throw new ValidationError('Code stimmt nicht');
  const secret = generateTotpSecret();
  await prisma.adminTotp.update({ where: { username }, data: { pendingSecretEnc: sealSecret(secret, config.jwtSecret) } });
  const url = otpauthUrl(secret, username, ISSUER);
  const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  return { secret, otpauthUrl: url, qrSvg };
}

export async function finishTotpMove(username: string, code: string): Promise<void> {
  const row = await prisma.adminTotp.findUnique({ where: { username } });
  if (!row?.enabledAt || !row.pendingSecretEnc) throw new ValidationError('Starte den Umzug zuerst');
  const step = verifyTotp(readSecret(row.pendingSecretEnc), code, Date.now(), 0);
  if (step === null) throw new ValidationError('Code stimmt nicht — prüfe die Uhrzeit des neuen Geräts');
  const updated = await prisma.adminTotp.updateMany({
    where: { username, pendingSecretEnc: row.pendingSecretEnc },
    data: { secretEnc: row.pendingSecretEnc, pendingSecretEnc: null, lastUsedStep: step },
  });
  if (updated.count === 0) throw new ValidationError('Der Umzug wurde inzwischen neu gestartet');
}

export async function disableTotp(username: string, code: string): Promise<void> {
  if (!(await useSecondFactorCode(username, code))) throw new ValidationError('Code stimmt nicht');
  await prisma.adminTotp.deleteMany({ where: { username } });
}

export async function regenerateRecoveryCodes(username: string, code: string): Promise<string[]> {
  if (!(await useSecondFactorCode(username, code))) throw new ValidationError('Code stimmt nicht');
  const codes = generateRecoveryCodes();
  await prisma.adminTotp.update({ where: { username }, data: { recoveryCodes: JSON.stringify(codes.map(hashRecoveryCode)) } });
  return codes;
}

// ── Passkeys ───────────────────────────────────────────────────────────────

export type RelyingParty = { origin: string; rpId: string };

const TRANSPORTS = new Set<AuthenticatorTransportFuture>(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']);

function parseTransports(raw: string): AuthenticatorTransportFuture[] {
  return raw.split(',').filter((entry): entry is AuthenticatorTransportFuture => TRANSPORTS.has(entry as AuthenticatorTransportFuture));
}

// A stable, opaque WebAuthn user handle per admin: a passkey manager then
// keeps one passkey per admin and device instead of piling them up.
function userHandle(username: string): Uint8Array<ArrayBuffer> {
  const digest = createHash('sha256').update(flowKey()).update('\0user\0').update(username).digest();
  return new Uint8Array(digest.subarray(0, 16));
}

export async function passkeyRegistrationOptions(
  username: string,
  rp: RelyingParty,
): Promise<{ options: PublicKeyCredentialCreationOptionsJSON; challengeToken: string }> {
  const existing = await prisma.adminPasskey.findMany({ where: { username, rpId: rp.rpId } });
  const options = await generateRegistrationOptions({
    rpName: ISSUER,
    rpID: rp.rpId,
    userName: username,
    userDisplayName: username,
    userID: userHandle(username),
    attestationType: 'none',
    excludeCredentials: existing.map((key) => ({ id: key.credentialId, transports: parseTransports(key.transports) })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
  const challengeToken = signFlow({ purpose: 'passkey-register', username, challenge: options.challenge, rpId: rp.rpId, origin: rp.origin });
  return { options, challengeToken };
}

export async function finishPasskeyRegistration(
  username: string,
  challengeToken: unknown,
  response: RegistrationResponseJSON,
  name: string,
): Promise<PasskeySummary> {
  const claims = readFlow(challengeToken, 'passkey-register');
  if (claims.username !== username || !claims.challenge || !claims.rpId || !claims.origin) {
    throw new ValidationError('Passkey-Anfrage gehört zu einer anderen Anmeldung');
  }
  useChallenge('passkey-register', claims.challenge);
  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: claims.challenge,
      expectedOrigin: claims.origin,
      expectedRPID: claims.rpId,
      requireUserVerification: false,
    });
  } catch {
    throw new ValidationError('Passkey konnte nicht geprüft werden');
  }
  if (!verification.verified) throw new ValidationError('Passkey konnte nicht geprüft werden');
  const { credential, credentialBackedUp } = verification.registrationInfo;
  if (credential.id.length > 512) throw new ValidationError('Dieser Passkey wird nicht unterstützt');
  if (await prisma.adminPasskey.findUnique({ where: { credentialId: credential.id } })) {
    throw new ConflictError('Dieser Passkey ist bereits gespeichert');
  }
  const row = await prisma.adminPasskey.create({
    data: {
      username,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: BigInt(credential.counter),
      transports: (credential.transports ?? []).filter((entry) => TRANSPORTS.has(entry)).join(','),
      rpId: claims.rpId,
      name: name.trim().slice(0, 100) || 'Passkey',
      backedUp: credentialBackedUp,
    },
  });
  return {
    id: row.id,
    name: row.name,
    rpId: row.rpId,
    backedUp: row.backedUp,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: null,
  };
}

/**
 * Options for a passkey login. Without a username the browser offers every
 * passkey it holds for this domain (the "Mit Passkey anmelden" button); with
 * a ticket only that admin's passkeys count (second factor after a password).
 */
export async function passkeyLoginOptions(
  rp: RelyingParty,
  ticket?: { username: string; ticketId: string },
): Promise<{ options: PublicKeyCredentialRequestOptionsJSON; challengeToken: string }> {
  const allow = ticket
    ? await prisma.adminPasskey.findMany({ where: { username: ticket.username, rpId: rp.rpId } })
    : [];
  if (ticket && allow.length === 0) throw new ValidationError('Für diese Adresse ist kein Passkey gespeichert');
  const options = await generateAuthenticationOptions({
    rpID: rp.rpId,
    allowCredentials: allow.map((key) => ({ id: key.credentialId, transports: parseTransports(key.transports) })),
    userVerification: ticket ? 'preferred' : 'required',
  });
  const challengeToken = signFlow({
    purpose: 'passkey-login',
    challenge: options.challenge,
    rpId: rp.rpId,
    origin: rp.origin,
    ...(ticket ? { username: ticket.username, ticketId: ticket.ticketId } : {}),
  });
  return { options, challengeToken };
}

/** Verifies a passkey assertion and returns the admin username it belongs to. */
export async function finishPasskeyLogin(
  challengeToken: unknown,
  response: AuthenticationResponseJSON,
  ticket?: { username: string; ticketId: string },
): Promise<string> {
  const claims = readFlow(challengeToken, 'passkey-login');
  if (!claims.challenge || !claims.rpId || !claims.origin) throw new UnauthorizedError('Passkey-Anfrage ungültig');
  // A challenge started as second factor finishes only with its own ticket,
  // and a passwordless challenge never finishes a ticket.
  if ((claims.ticketId ?? null) !== (ticket?.ticketId ?? null)) throw new UnauthorizedError('Passkey-Anfrage gehört zu einer anderen Anmeldung');
  const key = typeof response?.id === 'string'
    ? await prisma.adminPasskey.findUnique({ where: { credentialId: response.id } })
    : null;
  if (!key || key.rpId !== claims.rpId || (ticket && key.username !== ticket.username)) {
    throw new UnauthorizedError('Unbekannter Passkey');
  }
  useChallenge('passkey-login', claims.challenge);
  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: claims.challenge,
      expectedOrigin: claims.origin,
      expectedRPID: claims.rpId,
      credential: {
        id: key.credentialId,
        publicKey: new Uint8Array(Buffer.from(key.publicKey, 'base64url')),
        counter: Number(key.counter),
        transports: parseTransports(key.transports),
      },
      // Alone, a passkey replaces password and second factor, so the device
      // must have checked its owner (PIN / biometrics).
      requireUserVerification: !ticket,
    });
  } catch {
    throw new UnauthorizedError('Passkey konnte nicht geprüft werden');
  }
  if (!verification.verified) throw new UnauthorizedError('Passkey konnte nicht geprüft werden');
  await prisma.adminPasskey.update({
    where: { id: key.id },
    data: {
      counter: BigInt(verification.authenticationInfo.newCounter),
      backedUp: verification.authenticationInfo.credentialBackedUp,
      lastUsedAt: new Date(),
    },
  });
  return key.username;
}

export async function renamePasskey(username: string, id: string, name: string): Promise<void> {
  const trimmed = name.trim().slice(0, 100);
  if (!trimmed) throw new ValidationError('Name fehlt');
  const updated = await prisma.adminPasskey.updateMany({ where: { id, username }, data: { name: trimmed } });
  if (updated.count === 0) throw new NotFoundError('Passkey nicht gefunden');
}

export async function deletePasskey(username: string, id: string): Promise<void> {
  const deleted = await prisma.adminPasskey.deleteMany({ where: { id, username } });
  if (deleted.count === 0) throw new NotFoundError('Passkey nicht gefunden');
}
