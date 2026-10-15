import { Router, Request, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { config } from '../config';
import { requireAdmin } from '../middleware/requireAdmin';
import { clientIp } from '../middleware/requestLogger';
import { logger } from '../utils/logger';
import { UnauthorizedError, ValidationError } from '../utils/errors';
import { passkeyRelyingParty } from '../security/adminLogin';
import { checkAdminPassword, findAdminAccount, issueAdminToken } from '../services/adminLogin';
import {
  deletePasskey,
  disableTotp,
  enableTotp,
  finishPasskeyLogin,
  finishPasskeyRegistration,
  passkeyLoginOptions,
  passkeyRegistrationOptions,
  readSecondFactorTicket,
  regenerateRecoveryCodes,
  renamePasskey,
  securityStatus,
  startTotpSetup,
  useSecondFactorCode,
  type RelyingParty,
} from '../services/adminSecondFactor';

// ─── Admin panel: second factor and passkeys ──────────────────────────────────
//
//   POST /api/admin/auth/2fa                    ticket + code (app or recovery)
//   POST /api/admin/auth/2fa/passkey/options    ticket → WebAuthn challenge
//   POST /api/admin/auth/2fa/passkey            ticket + passkey assertion
//   POST /api/admin/auth/passkey/options        passwordless: WebAuthn challenge
//   POST /api/admin/auth/passkey                passwordless: passkey assertion
//
//   GET    /api/admin/account/security          the signed-in admin's factors
//   POST   /api/admin/account/totp/setup        new secret + QR code
//   POST   /api/admin/account/totp/enable       first code → recovery codes
//   POST   /api/admin/account/totp/disable      a code
//   POST   /api/admin/account/recovery-codes    a code → new recovery codes
//   POST   /api/admin/account/passkeys/options  password → WebAuthn challenge
//   POST   /api/admin/account/passkeys          the new passkey
//   PATCH  /api/admin/account/passkeys/:id      rename
//   DELETE /api/admin/account/passkeys/:id
//
// Every response that completes a login is the same { token } the password
// login returns, so the panel stores it the same way.

const router = Router();

// Same budget as the password login, counted separately.
function loginStepLimiter() {
  return rateLimit({
    windowMs: config.rateLimit.adminLoginWindowMs,
    max: config.rateLimit.adminLoginMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts, please try again later' },
  });
}
const secondFactorLimiter = loginStepLimiter();
const passkeyLoginLimiter = loginStepLimiter();

function relyingParty(req: Request, inSession: boolean): RelyingParty {
  const rp = passkeyRelyingParty(req.get('origin'), config.adminPasskeyOrigins);
  if (rp) return rp;
  const message = 'Passkeys gehen nur über https (oder localhost) und unter einem Domainnamen';
  // Inside a session the panel reads a 401 as "logged out".
  throw inSession ? new ValidationError(message) : new UnauthorizedError(message);
}

async function completeLogin(req: Request, res: Response, username: string, method: string): Promise<void> {
  // Admin rights may have been taken away since the first step.
  const still = await findAdminAccount(username);
  if (!still.ok) {
    logger.warn('Admin login failed: account is no longer an admin', { action: 'admin_login_failed', reason: still.reason, username, ip: clientIp(req) });
    throw new UnauthorizedError('Invalid credentials');
  }
  const token = issueAdminToken(still.account.username);
  logger.info('Admin login successful', { action: 'admin_login', method, username: still.account.username, ip: clientIp(req), userAgent: req.headers['user-agent'] });
  res.json({ token });
}

function sessionUsername(req: Request): string {
  return req.adminUser!.username;
}

// ── Second step after the password ──────────────────────────────────────────

const codeBody = z.object({ ticket: z.string().min(1).max(2000), code: z.string().trim().min(1).max(40) });

router.post('/auth/2fa', secondFactorLimiter, async (req: Request, res: Response): Promise<void> => {
  const { ticket, code } = codeBody.parse(req.body);
  const { username } = readSecondFactorTicket(ticket);
  const used = await useSecondFactorCode(username, code);
  if (!used) {
    logger.warn('Admin login failed: wrong second-factor code', { action: 'admin_login_failed', reason: 'wrong-code', username, ip: clientIp(req) });
    throw new UnauthorizedError('Code stimmt nicht');
  }
  if (used === 'recovery') logger.warn('Admin login with a recovery code', { action: 'admin_recovery_code_used', username, ip: clientIp(req) });
  await completeLogin(req, res, username, used === 'recovery' ? 'password+recovery-code' : 'password+totp');
});

const ticketBody = z.object({ ticket: z.string().min(1).max(2000) });

router.post('/auth/2fa/passkey/options', secondFactorLimiter, async (req: Request, res: Response): Promise<void> => {
  const { ticket } = ticketBody.parse(req.body);
  const claims = readSecondFactorTicket(ticket);
  res.json(await passkeyLoginOptions(relyingParty(req, false), claims));
});

const assertionBody = z.object({
  challengeToken: z.string().min(1).max(4000),
  response: z.record(z.unknown()),
});

router.post('/auth/2fa/passkey', secondFactorLimiter, async (req: Request, res: Response): Promise<void> => {
  const body = assertionBody.extend({ ticket: z.string().min(1).max(2000) }).parse(req.body);
  const claims = readSecondFactorTicket(body.ticket);
  const username = await finishPasskeyLogin(body.challengeToken, body.response as unknown as AuthenticationResponseJSON, claims);
  await completeLogin(req, res, username, 'password+passkey');
});

// ── Passwordless passkey login ──────────────────────────────────────────────

router.post('/auth/passkey/options', passkeyLoginLimiter, async (req: Request, res: Response): Promise<void> => {
  res.json(await passkeyLoginOptions(relyingParty(req, false)));
});

router.post('/auth/passkey', passkeyLoginLimiter, async (req: Request, res: Response): Promise<void> => {
  const body = assertionBody.parse(req.body);
  let username: string;
  try {
    username = await finishPasskeyLogin(body.challengeToken, body.response as unknown as AuthenticationResponseJSON);
  } catch (err) {
    logger.warn('Admin login failed: passkey', { action: 'admin_login_failed', reason: 'passkey', ip: clientIp(req) });
    throw err;
  }
  await completeLogin(req, res, username, 'passkey');
});

// ── The signed-in admin's own factors ───────────────────────────────────────

router.get('/account/security', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  res.json(await securityStatus(sessionUsername(req)));
});

router.post('/account/totp/setup', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  res.json(await startTotpSetup(sessionUsername(req)));
});

const accountCodeBody = z.object({ code: z.string().trim().min(1).max(40) });

router.post('/account/totp/enable', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const { code } = accountCodeBody.parse(req.body);
  const username = sessionUsername(req);
  const recoveryCodes = await enableTotp(username, code);
  logger.info('Admin security: authenticator app enabled', { action: 'admin_totp_enabled', username, ip: clientIp(req) });
  res.json({ recoveryCodes });
});

router.post('/account/totp/disable', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const { code } = accountCodeBody.parse(req.body);
  const username = sessionUsername(req);
  await disableTotp(username, code);
  logger.info('Admin security: authenticator app disabled', { action: 'admin_totp_disabled', username, ip: clientIp(req) });
  res.status(204).send();
});

router.post('/account/recovery-codes', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const { code } = accountCodeBody.parse(req.body);
  const username = sessionUsername(req);
  const recoveryCodes = await regenerateRecoveryCodes(username, code);
  logger.info('Admin security: recovery codes renewed', { action: 'admin_recovery_codes_renewed', username, ip: clientIp(req) });
  res.json({ recoveryCodes });
});

// A new passkey is a new way in without the password, so a stolen session
// token alone must not be enough to add one: the password is asked again.
router.post('/account/passkeys/options', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const { password } = z.object({ password: z.string().min(1).max(200) }).parse(req.body);
  const username = sessionUsername(req);
  const lookup = await findAdminAccount(username);
  if (!lookup.ok || (await checkAdminPassword(lookup.account, password)) !== 'ok') {
    logger.warn('Admin security: wrong password before adding a passkey', { action: 'admin_passkey_reauth_failed', username, ip: clientIp(req) });
    throw new ValidationError('Passwort stimmt nicht');
  }
  res.json(await passkeyRegistrationOptions(username, relyingParty(req, true)));
});

router.post('/account/passkeys', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const body = z.object({
    challengeToken: z.string().min(1).max(4000),
    response: z.record(z.unknown()),
    name: z.string().max(100).default(''),
  }).parse(req.body);
  const username = sessionUsername(req);
  const passkey = await finishPasskeyRegistration(username, body.challengeToken, body.response as unknown as RegistrationResponseJSON, body.name);
  logger.info('Admin security: passkey added', { action: 'admin_passkey_added', username, rpId: passkey.rpId, ip: clientIp(req) });
  res.status(201).json(passkey);
});

router.patch('/account/passkeys/:id', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const { name } = z.object({ name: z.string().max(100) }).parse(req.body);
  await renamePasskey(sessionUsername(req), String(req.params['id']), name);
  res.status(204).send();
});

router.delete('/account/passkeys/:id', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const username = sessionUsername(req);
  await deletePasskey(username, String(req.params['id']));
  logger.info('Admin security: passkey removed', { action: 'admin_passkey_removed', username, ip: clientIp(req) });
  res.status(204).send();
});

export { router as adminSecurityRouter };
