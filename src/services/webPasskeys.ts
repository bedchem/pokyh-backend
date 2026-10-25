import jwt from 'jsonwebtoken';
import { createHash, createHmac, randomBytes, randomUUID } from 'crypto';
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
import { ConflictError, UnauthorizedError, ValidationError } from '../utils/errors';
import type { DeviceUnlock } from '../webuntis/deviceUnlock';

/**
 * Signing in to the installed website with the device's own lock — Face ID,
 * Touch ID, a fingerprint or the device's PIN — instead of the password.
 *
 * Turning it on makes a passkey on the device (WebAuthn, the device's own
 * authenticator, user verification required): the backend keeps its public
 * key, the device the sign-in it unlocks, sealed in its httpOnly cookie
 * pokyh_unlock (webuntis/deviceUnlock.ts). Signing in needs both, the
 * cookie of this device and a fresh answer of its passkey, and then runs the
 * password sign-in with what the cookie holds (routes/webuntis.ts): WebUntis
 * still checks the account every time.
 *
 * As for the admin passkeys (services/adminSecondFactor.ts), every hand-over
 * between two requests is a short-lived token signed with a key derived from
 * JWT_SECRET, so any node of a cluster can finish what another one started.
 */

const RP_NAME = 'POKYH';
const FLOW_TTL_SECONDS = 5 * 60;
// Codes of the authenticator app per ticket, for accounts with two-factor sign-in.
const MAX_CODE_ATTEMPTS = 5;

function flowKey(): string {
  return createHmac('sha256', config.jwtSecret).update('pokyh-web-passkey-flow-v1').digest('hex');
}

type FlowPurpose = 'web-passkey-setup' | 'web-passkey-login' | 'web-passkey-code';

type FlowClaims = {
  purpose: FlowPurpose;
  uid: string;
  cid?: string;
  challenge?: string;
  rpId?: string;
  origin?: string;
};

function signFlow(claims: FlowClaims): string {
  return jwt.sign(claims, flowKey(), { expiresIn: FLOW_TTL_SECONDS, audience: claims.purpose, jwtid: randomUUID() });
}

// A failed sign-in step is a 401. Turning it on happens signed in, where the
// website would read a 401 as "signed out": that failure is a 422.
function flowError(purpose: FlowPurpose, message: string): Error {
  return purpose === 'web-passkey-setup' ? new ValidationError(message) : new UnauthorizedError(message);
}

function readFlow(token: unknown, purpose: FlowPurpose): FlowClaims & { jti: string } {
  const expired = 'Die Anfrage ist abgelaufen. Bitte versuche es noch einmal.';
  if (typeof token !== 'string' || !token || token.length > 4000) throw flowError(purpose, expired);
  try {
    const claims = jwt.verify(token, flowKey(), { audience: purpose }) as FlowClaims & { jti?: string };
    if (claims.purpose !== purpose || !claims.jti || typeof claims.uid !== 'string') throw new Error('wrong purpose');
    return claims as FlowClaims & { jti: string };
  } catch {
    throw flowError(purpose, expired);
  }
}

// Node-local, best effort on top of the 5-minute expiry: a challenge is
// accepted once, a ticket gets a few codes.
const usedChallenges = new TtlCache<true>(FLOW_TTL_SECONDS * 1000);
const codeAttempts = new TtlCache<number>(FLOW_TTL_SECONDS * 1000);

function useChallenge(purpose: FlowPurpose, challenge: string): void {
  if (usedChallenges.get(challenge)) throw flowError(purpose, 'Diese Anfrage wurde schon verwendet. Bitte versuche es noch einmal.');
  usedChallenges.set(challenge, true);
}

export type RelyingParty = { origin: string; rpId: string };

const TRANSPORTS = new Set<AuthenticatorTransportFuture>(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']);

function parseTransports(raw: string): AuthenticatorTransportFuture[] {
  return raw.split(',').filter((entry): entry is AuthenticatorTransportFuture => TRANSPORTS.has(entry as AuthenticatorTransportFuture));
}

// The WebAuthn user handle: one per account and device. A passkey manager
// that syncs (iCloud Keychain, Google Password Manager) keeps one passkey per
// handle, so turning it on again on the same device replaces that device's
// passkey, and turning it on on a second device leaves the first one's alone.
function userHandle(stableUid: string, deviceId: string | null): Uint8Array<ArrayBuffer> {
  const digest = createHash('sha256').update(flowKey()).update('\0user\0').update(stableUid)
    .update('\0device\0').update(deviceId ?? randomBytes(16).toString('hex')).digest();
  return new Uint8Array(digest.subarray(0, 16));
}

// ── Turning it on ───────────────────────────────────────────────────────────

export async function passkeySetupOptions(
  user: { stableUid: string; username: string },
  rp: RelyingParty,
  deviceId: string | null,
): Promise<{ options: PublicKeyCredentialCreationOptionsJSON; challengeToken: string }> {
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rp.rpId,
    userName: user.username,
    userDisplayName: user.username,
    userID: userHandle(user.stableUid, deviceId),
    attestationType: 'none',
    // The device's own lock, not a security key or another phone.
    authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', userVerification: 'required' },
  });
  const challengeToken = signFlow({ purpose: 'web-passkey-setup', uid: user.stableUid, challenge: options.challenge, rpId: rp.rpId, origin: rp.origin });
  return { options, challengeToken };
}

/** Checks the new passkey and keeps its public key; returns its credential id. */
export async function finishPasskeySetup(
  stableUid: string,
  challengeToken: unknown,
  response: RegistrationResponseJSON,
  deviceId: string | null,
): Promise<string> {
  const claims = readFlow(challengeToken, 'web-passkey-setup');
  if (claims.uid !== stableUid || !claims.challenge || !claims.rpId || !claims.origin) {
    throw new ValidationError('Die Anfrage gehört zu einer anderen Anmeldung.');
  }
  useChallenge('web-passkey-setup', claims.challenge);
  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: claims.challenge,
      expectedOrigin: claims.origin,
      expectedRPID: claims.rpId,
      // Face ID, the fingerprint or the PIN checked who holds the device.
      requireUserVerification: true,
    });
  } catch {
    throw new ValidationError('Die Gerätesperre konnte nicht geprüft werden.');
  }
  if (!verification.verified) throw new ValidationError('Die Gerätesperre konnte nicht geprüft werden.');
  const { credential } = verification.registrationInfo;
  if (credential.id.length > 512) throw new ValidationError('Dieses Gerät wird nicht unterstützt.');
  if (await prisma.webPasskey.findUnique({ where: { credentialId: credential.id } })) {
    throw new ConflictError('Diese Anmeldung ist schon eingerichtet.');
  }
  await prisma.webPasskey.create({
    data: {
      stableUid,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: BigInt(credential.counter),
      transports: (credential.transports ?? []).filter((entry) => TRANSPORTS.has(entry)).join(','),
      rpId: claims.rpId,
      deviceId,
    },
  });
  return credential.id;
}

// ── Signing in ──────────────────────────────────────────────────────────────

async function passkeyOf(unlock: DeviceUnlock) {
  const key = await prisma.webPasskey.findUnique({
    where: { credentialId: unlock.cid },
    include: { user: { select: { username: true } } },
  });
  return key && key.stableUid === unlock.uid ? key : null;
}

/** The account this device's passkey signs in to; null when it has none (any more). */
export async function devicePasskey(unlock: DeviceUnlock | null): Promise<{ username: string } | null> {
  const key = unlock ? await passkeyOf(unlock) : null;
  return key ? { username: key.user.username } : null;
}

/** A challenge for this device's passkey; null when it has none (any more) for this address. */
export async function passkeyLoginOptions(
  unlock: DeviceUnlock,
  rp: RelyingParty,
): Promise<{ username: string; options: PublicKeyCredentialRequestOptionsJSON; challengeToken: string } | null> {
  const key = await passkeyOf(unlock);
  if (!key || key.rpId !== rp.rpId) return null;
  const options = await generateAuthenticationOptions({
    rpID: rp.rpId,
    allowCredentials: [{ id: key.credentialId, transports: parseTransports(key.transports) }],
    userVerification: 'required',
  });
  const challengeToken = signFlow({
    purpose: 'web-passkey-login', uid: unlock.uid, cid: unlock.cid, challenge: options.challenge, rpId: rp.rpId, origin: rp.origin,
  });
  return { username: key.user.username, options, challengeToken };
}

/** Verifies the answer of this device's passkey (with its owner checked by the device). */
export async function finishPasskeyLogin(unlock: DeviceUnlock, challengeToken: unknown, response: AuthenticationResponseJSON): Promise<void> {
  const claims = readFlow(challengeToken, 'web-passkey-login');
  if (!claims.challenge || !claims.rpId || !claims.origin) throw new UnauthorizedError('Die Anfrage ist ungültig.');
  // The challenge, the cookie and the answer must all name this device's passkey.
  if (claims.uid !== unlock.uid || claims.cid !== unlock.cid || response?.id !== unlock.cid) {
    throw new UnauthorizedError('Die Anmeldung gehört zu einem anderen Gerät.');
  }
  const key = await passkeyOf(unlock);
  if (!key || key.rpId !== claims.rpId) throw new UnauthorizedError('Auf diesem Gerät ist die Anmeldung nicht (mehr) eingerichtet.');
  useChallenge('web-passkey-login', claims.challenge);
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
      // The passkey replaces the password: the device must have checked its owner.
      requireUserVerification: true,
    });
  } catch {
    throw new UnauthorizedError('Die Gerätesperre konnte nicht geprüft werden.');
  }
  if (!verification.verified) throw new UnauthorizedError('Die Gerätesperre konnte nicht geprüft werden.');
  await prisma.webPasskey.update({
    where: { id: key.id },
    data: { counter: BigInt(verification.authenticationInfo.newCounter), lastUsedAt: new Date() },
  });
}

// An account with two-factor sign-in: after the passkey, WebUntis still wants
// the authenticator app's code. The ticket says the passkey was answered, so
// the code needs no second Face ID.

export function issueCodeTicket(unlock: DeviceUnlock): string {
  return signFlow({ purpose: 'web-passkey-code', uid: unlock.uid, cid: unlock.cid });
}

export function readCodeTicket(ticket: unknown, unlock: DeviceUnlock): void {
  const claims = readFlow(ticket, 'web-passkey-code');
  if (claims.uid !== unlock.uid || claims.cid !== unlock.cid) throw new UnauthorizedError('Die Anmeldung gehört zu einem anderen Gerät.');
  const attempts = (codeAttempts.get(claims.jti) ?? 0) + 1;
  if (attempts > MAX_CODE_ATTEMPTS) throw new UnauthorizedError('Zu viele Versuche. Bitte melde dich neu an.');
  codeAttempts.set(claims.jti, attempts);
}

// ── Turning it off, and what goes by itself ─────────────────────────────────

/** Removes this device's passkey (its cookie goes with the answer). */
export async function removePasskey(unlock: DeviceUnlock): Promise<void> {
  await prisma.webPasskey.deleteMany({ where: { credentialId: unlock.cid, stableUid: unlock.uid } });
}

/**
 * Passkeys not used for as long as their cookie lives (`maxAgeMs`): the
 * device has let the cookie run out, or lost it (index.ts, hourly).
 */
export async function cleanupWebPasskeys(maxAgeMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs);
  const { count } = await prisma.webPasskey.deleteMany({
    where: { OR: [{ lastUsedAt: { lt: cutoff } }, { lastUsedAt: null, createdAt: { lt: cutoff } }] },
  });
  return count;
}
