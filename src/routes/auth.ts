import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { config } from '../config';
import { requireAuth } from '../middleware/auth';
import { authLimiter, learnLoginLimiter, readLimiter, refreshLimiter, writeLimiter } from '../middleware/rateLimiter';
import { generateStableUid, generateClassCode, generateClassId } from '../utils/uid';
import { validateWebUntis } from '../services/webuntis';
import { getLearnConfig } from '../services/learnConfig';
import { reclaimDishRatings } from '../services/dishRatings';
import { logger } from '../utils/logger';
import {
  AccountRole,
  ClassEvidence,
  decideAccountClass,
  decideAccountRole,
  hasClassIdentity,
  normalizeAccountClass,
  parseAccountRole,
} from '../utils/accountClass';
import { resolveSession, type ResolvedAccount } from '../webuntis/accountResolver';
import { defaultSchoolId, forgetUserSchool, SchoolLimitError, schoolForLogin } from '../services/schools';
import { audit } from '../services/audit';
import { announceChange } from '../services/adminLive';
import { forgetSession as forgetUntisSession } from '../webuntis/client';
import {
  clearRefreshCookie,
  clearSignInCookies,
  readRefreshCookie,
  readSession as readUntisSession,
  setRefreshCookie,
  webDeviceId,
} from '../webuntis/session';
import { approveQrLogin, codeFromScan, qrLoginInfo, type QrCredential } from '../services/qrLogin';
import { defaultSchool, parseSchool } from '../webuntis/schools';
import {
  endSessionOfToken,
  listSessions,
  loginHistory,
  NO_CONTEXT,
  openSession,
  recordLogin,
  revokeSession,
  revokeSessions,
  rotateSession,
  signInContext,
  type LoginMethod,
  type SignInContext,
} from '../services/sessions';
import {
  AppError,
  UnauthorizedError,
  ForbiddenError,
  ValidationError,
} from '../utils/errors';

const router = Router();

export type AuthenticatedUserResponse = {
  token: string;
  refreshToken: string;
  /** The device session (services/sessions.ts): the device's own entry in the account's device list. */
  sessionId: string;
  user: {
    stableUid: string;
    username: string;
    webuntisKlasseId: number;
    webuntisKlasseName: string;
    classId: string | null;
    isAdmin: boolean;
    isUntisUser: boolean;
    role: string;
    schoolId: string | null;
  };
};

// ─── helpers ────────────────────────────────────────────────────────────────

// `sid`: the device session (services/sessions.ts) the token belongs to, so
// signing out that one device ends its tokens too.
function signJwt(payload: {
  stableUid: string;
  username: string;
  klasseId: number;
  klasseName: string;
  role: string;
  isUntisUser?: boolean;
  sid: string;
}): string {
  return jwt.sign(payload, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  } as jwt.SignOptions);
}

// Leaves classes (all, or the ones named). A class left empty goes with it,
// unless it holds reminders: those wait for the class's students, whose next
// sign-in that confirms the class joins it again. The relation filters avoid
// racing a student who joins after the membership cleanup.
async function leaveClasses(stableUid: string, classIds?: string[]): Promise<void> {
  const memberships = await prisma.classMember.findMany({
    where: { stableUid, ...(classIds ? { classId: { in: classIds } } : {}) },
    select: { classId: true },
  });
  if (memberships.length === 0) return;

  const left = [...new Set(memberships.map((membership) => membership.classId))];
  await prisma.classMember.deleteMany({ where: { stableUid, classId: { in: left } } });
  await prisma.class.deleteMany({
    where: { id: { in: left }, members: { none: {} }, reminders: { none: {} } },
  });
}

// Auto-join / leave / create class based on webuntisKlasseId. Parent and
// role-less accounts are deliberately never class members, even when a caller
// submits the class of a child or an old deployment left a ClassMember row behind.
//
// `fromWebUntis`: the class was just decided from WebUntis (completeWebUntisLogin),
// so an account without one leaves every class it is in. A POKYH-only account
// keeps the classes an admin put it in.
async function syncUserClass(
  stableUid: string,
  username: string,
  klasseId: number,
  klasseName: string,
  role: AccountRole = 'student',
  schoolId: string = defaultSchoolId(),
  fromWebUntis = false,
): Promise<string | null> {
  if (!hasClassIdentity(role)) {
    await prisma.user.updateMany({
      where: {
        stableUid,
        OR: [
          { webuntisKlasseId: { not: 0 } },
          { webuntisKlasseName: { not: '' } },
        ],
      },
      data: { webuntisKlasseId: 0, webuntisKlasseName: '' },
    });
    await leaveClasses(stableUid);
    return null;
  }

  // 0. No class. From WebUntis that is the answer: no confirmed class, no
  // class membership. For a POKYH-only account an admin's membership stays.
  if (!klasseId || klasseId <= 0) {
    if (fromWebUntis) {
      await leaveClasses(stableUid);
      return null;
    }
    const existing = await prisma.classMember.findFirst({
      where: { stableUid },
      select: { classId: true },
    });
    return existing?.classId ?? null;
  }

  // 1. Reconcile every membership. This also repairs legacy users that were in
  // multiple classes: only the class matching the current WebUntis id survives.
  // WebUntis class ids are per school: a class is the same class only in the
  // account's own school.
  const memberships = await prisma.classMember.findMany({
    where: { stableUid },
    include: {
      class: { select: { webuntisKlasseId: true, schoolId: true, name: true } },
    },
  });
  const sameClass = (c: { webuntisKlasseId: number; schoolId: string | null }) =>
    c.webuntisKlasseId === klasseId && (c.schoolId ?? defaultSchoolId()) === schoolId;
  const existingMembership = memberships.find((membership) => sameClass(membership.class));

  const wrongClassIds = memberships
    .filter((membership) => !sameClass(membership.class))
    .map((membership) => membership.classId);
  if (wrongClassIds.length > 0) await leaveClasses(stableUid, wrongClassIds);

  if (existingMembership) {
    await prisma.classMember.update({
      where: { classId_stableUid: { classId: existingMembership.classId, stableUid } },
      data: { username, role: 'student' },
    });
    // A class made while WebUntis' class list was unreadable has no name yet.
    if (!existingMembership.class.name.trim() && klasseName.trim()) {
      await prisma.class.update({ where: { id: existingMembership.classId }, data: { name: klasseName.trim() } });
    }
    return existingMembership.classId;
  }

  // 2. Find existing class with this webuntisKlasseId in this school
  const targetClass = await prisma.class.findFirst({
    where: { webuntisKlasseId: klasseId, schoolId },
    select: { id: true, name: true },
  });

  if (targetClass) {
    // Join existing class
    await prisma.classMember.upsert({
      where: { classId_stableUid: { classId: targetClass.id, stableUid } },
      create: { classId: targetClass.id, stableUid, username, role },
      update: { username, role },
    });
    if (!targetClass.name.trim() && klasseName.trim()) {
      await prisma.class.update({ where: { id: targetClass.id }, data: { name: klasseName.trim() } });
    }
    return targetClass.id;
  }

  // 3. Create new class
  const newClassId = generateClassId();
  const code = generateClassCode();

  try {
    await prisma.class.create({
      data: {
        id: newClassId,
        name: klasseName,
        code,
        webuntisKlasseId: klasseId,
        createdBy: stableUid,
        createdByName: username,
        schoolId,
        members: {
          create: { stableUid, username, role },
        },
      },
    });
    return newClassId;
  } catch (err: unknown) {
    // Race condition: another process created the class, try to join it
    const existing = await prisma.class.findFirst({
      where: { webuntisKlasseId: klasseId, schoolId },
      select: { id: true },
    });
    if (existing) {
      await prisma.classMember.upsert({
        where: { classId_stableUid: { classId: existing.id, stableUid } },
        create: { classId: existing.id, stableUid, username, role },
        update: { username, role },
      });
      return existing.id;
    }
    throw err;
  }
}

const SCHOOL_TAKEN = 'Dieser Benutzername ist bereits einem Konto einer anderen Schule zugeordnet. Bitte wende dich an den Support.';

/**
 * What a resolved WebUntis sign-in means for the account: a confirmed
 * guardian or student as such; any other account (a teacher, …) has no class
 * and keeps the role it has (`claimed` for a new one).
 */
export function accountFromWebUntis(account: ResolvedAccount, claimed: 'student' | 'parent' = 'student'): {
  role: 'student' | 'parent'; roleConfirmed: boolean; evidence: ClassEvidence;
} {
  if (account.kind === 'parent' || account.kind === 'student') {
    return { role: account.kind, roleConfirmed: true, evidence: account.evidence };
  }
  return { role: claimed, roleConfirmed: false, evidence: account.evidence };
}

/**
 * Creates the normal POKYH session only after a trusted WebUntis validation.
 * Both the established server-to-server login and the Learn-only BFF route use
 * this one path, which prevents their user/profile semantics from diverging.
 *
 * The account's role and class follow what WebUntis said at this sign-in
 * (decideAccountRole, decideAccountClass): a class only when WebUntis named the
 * signed-in student's own; never one a caller merely claims.
 */
export async function completeWebUntisLogin({
  username,
  role,
  roleConfirmed,
  evidence,
  schoolId,
  context = NO_CONTEXT,
  method = 'webuntis',
}: {
  username: string;
  /** What the sign-in is: a guardian, or a student (also: anything WebUntis did not tell). */
  role: 'student' | 'parent';
  /** Whether WebUntis confirmed that role at this sign-in. */
  roleConfirmed: boolean;
  /** What WebUntis said about the signed-in student's own class. */
  evidence: ClassEvidence;
  // The school whose WebUntis validated the account.
  schoolId: string;
  // The device signing in (its session in the account's device list).
  context?: SignInContext;
  method?: LoginMethod;
}): Promise<AuthenticatedUserResponse> {
  // Usernames are unique across the installation, WebUntis names only within
  // a school. The same name signing in through another school is another
  // person: refuse instead of handing them this account (fail closed).
  const refuseOtherSchool = (accountSchool: string | null) => {
    if (!accountSchool || accountSchool === schoolId) return;
    logger.warn('WebUntis login refused: the name belongs to an account of another school', {
      action: 'login_school_mismatch', accountSchool, loginSchool: schoolId,
    });
    throw new AppError(SCHOOL_TAKEN, 409);
  };

  let user = await prisma.user.findUnique({ where: { username } });
  refuseOtherSchool(user?.schoolId ?? null);

  let created = false;
  if (!user) {
    const accountRole = decideAccountRole(null, role, roleConfirmed);
    const decided = decideAccountClass(accountRole, evidence, null);
    try {
      user = await prisma.user.create({
        data: {
          stableUid: generateStableUid(),
          username,
          webuntisKlasseId: decided.klasseId,
          webuntisKlasseName: decided.klasseName,
          classCheckVersion: decided.checkVersion,
          classCheckedAt: decided.confirmed ? new Date() : null,
          isUntisUser: true,
          role: accountRole,
          schoolId,
        },
      });
      created = true;
    } catch (err) {
      // Two first logins of the same account can arrive together (two
      // devices, a retried request). The second create then meets the unique
      // username; that is a successful login, not a conflict.
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err;
      user = await prisma.user.findUnique({ where: { username } });
      if (!user) throw err;
      refuseOtherSchool(user.schoolId);
    }
    if (created) {
      // A recreated account (rollover, rebuild) gets its earlier dish votes back.
      reclaimDishRatings(user.stableUid, user.username).catch((err) => {
        logger.warn('dish rating reclaim failed', { error: err instanceof Error ? err.message : String(err) });
      });
    }
  }

  if (!created) {
    const accountRole = decideAccountRole(user.role, role, roleConfirmed);
    const decided = decideAccountClass(accountRole, evidence, {
      klasseId: user.webuntisKlasseId,
      klasseName: user.webuntisKlasseName,
      checkVersion: user.classCheckVersion,
    });
    if (decided.klasseId !== user.webuntisKlasseId || accountRole !== user.role) {
      logger.info('Account class or role changed at sign-in', {
        action: 'account_class_changed', stableUid: user.stableUid,
        fromClass: user.webuntisKlasseId, toClass: decided.klasseId, fromRole: user.role, toRole: accountRole,
        confirmed: decided.confirmed,
      });
    }
    user = await prisma.user.update({
      where: { username },
      data: {
        webuntisKlasseId: decided.klasseId,
        webuntisKlasseName: decided.klasseName,
        classCheckVersion: decided.checkVersion,
        ...(decided.confirmed ? { classCheckedAt: new Date() } : {}),
        isUntisUser: true,
        role: accountRole,
        // An account from before schools existed joins the school it signs in with.
        ...(user.schoolId ? {} : { schoolId }),
      },
    });
    forgetUserSchool(user.stableUid);
  }

  const classId = await syncUserClass(
    user.stableUid, username, user.webuntisKlasseId, user.webuntisKlasseName, parseAccountRole(user.role), user.schoolId ?? schoolId, true,
  );
  const isAdmin = await prisma.admin.findUnique({ where: { stableUid: user.stableUid } }) !== null;
  const session = await openSession(user.stableUid, context);
  const { sid, refreshToken } = session;
  await recordLogin(user.stableUid, context, method, session);
  const token = signJwt({
    stableUid: user.stableUid,
    username: user.username,
    klasseId: user.webuntisKlasseId,
    klasseName: user.webuntisKlasseName,
    role: user.role,
    isUntisUser: true,
    sid,
  });

  return {
    token,
    refreshToken,
    sessionId: sid,
    user: {
      stableUid: user.stableUid,
      username: user.username,
      webuntisKlasseId: user.webuntisKlasseId,
      webuntisKlasseName: user.webuntisKlasseName,
      classId,
      isAdmin,
      isUntisUser: true,
      role: user.role,
      schoolId: user.schoolId,
    },
  };
}

// The school a trusted WebUntis login names (`school`: its WebUntis login
// name, e.g. "lbs-brixen"), or the default school when it names none — what
// every caller did before schools existed. A school signing in for the first
// time is added (services/schools.ts); a deactivated one is refused rather
// than mapped to another school.
export async function loginSchool(req: Request, ref: { school?: string; schoolName?: string; schoolServer?: string }): Promise<string> {
  if (!ref.school) return defaultSchoolId();
  let found: Awaited<ReturnType<typeof schoolForLogin>>;
  try {
    found = await schoolForLogin({ loginName: ref.school, name: ref.schoolName, server: ref.schoolServer });
  } catch (err) {
    if (err instanceof SchoolLimitError) {
      logger.warn('WebUntis login refused: no further schools may be added', { action: 'school_limit_reached', limit: config.schoolsMax });
      throw new AppError('Diese Schule kann Pokyh im Moment nicht hinzugefügt werden. Bitte wende dich an den Support.', 503);
    }
    throw err;
  }
  if (!found) throw new ValidationError('Unbekannte Schule');
  if (found.created) {
    audit(req, 'school.join', { type: 'school', id: found.school.id }, { name: found.school.name, webuntisSchool: found.school.webuntisSchool }, found.school.id, 'webuntis');
    announceChange(['schools']);
  }
  if (!found.school.active) throw new ForbiddenError('Diese Schule ist bei Pokyh derzeit nicht freigeschaltet');
  return found.school.id;
}

// ─── POST /auth/login ────────────────────────────────────────────────────────

const loginSchema = z.object({
  username: z.string().min(1).max(100).trim().toLowerCase(),
  // The class the app worked out itself. Still accepted from older apps, but
  // never assigned: a class only comes from WebUntis (untisSessionId below).
  // Coerce + default so a missing/string klasseId never 422s a valid login.
  klasseId: z.coerce.number().int().nonnegative().default(0),
  klasseName: z.string().min(0).max(100).default(''),
  // The app's own say: "parent" makes the account a parent, "student" never
  // turns a parent back into a student unless WebUntis confirms it.
  role: z.enum(['student', 'parent']).optional().default('student'),
  // The app's own WebUntis session (JSESSIONID). With it the backend asks
  // WebUntis itself what the account is and which class it belongs to
  // (webuntis/accountResolver.ts); without it the account gets no class.
  untisSessionId: z.string().trim().regex(/^[A-Za-z0-9._-]{8,200}$/).optional(),
  // The WebUntis school the caller validated the account with (its login
  // name). Optional: without it the default school (WEBUNTIS_SCHOOL), as
  // before. Name and server only matter when the school signs in for the
  // first time and is added.
  school: z.string().trim().toLowerCase().min(1).max(100).optional(),
  schoolName: z.string().trim().max(200).optional(),
  schoolServer: z.string().trim().max(253).optional(),
  // An automatic renewal of an expired session (the website signs in again
  // with the credentials it holds), not a sign-in by the person. It is not
  // counted among the account's sign-ins.
  renewal: z.boolean().optional().default(false),
  // How the person signed in to WebUntis, for the login history: with the
  // password, or with the app key (Office 365 schools).
  method: z.enum(['webuntis', 'office']).optional().default('webuntis'),
});

const localLoginSchema = z.object({
  username: z.string().min(1).max(100).trim().toLowerCase(),
  password: z.string().min(1).max(200),
});

const learnLoginSchema = z.object({
  username: z.string().min(1).max(100).trim().toLowerCase(),
  password: z.string().min(1).max(200),
  privacyNoticeVersion: z.string().trim().max(80).optional(),
});

// The Learn BFF has the ordinary API key but deliberately never receives the
// backend's server key. It validates WebUntis credentials here, then receives
// the same signed Pokyh session as the established Pokyh WebUntis login flow.
// No password is stored or logged by this route.
router.post('/learn-login', learnLoginLimiter, async (req: Request, res: Response) => {
  const { username, password, privacyNoticeVersion } = learnLoginSchema.parse(req.body);
  const learnCfg = await getLearnConfig();
  if (!learnCfg.legalGateReady) {
    throw new AppError('Pokyh Learn is not available until its operator completes the required privacy configuration', 503);
  }
  if (learnCfg.legalGateEnabled && privacyNoticeVersion !== learnCfg.privacyNoticeVersion) {
    throw new ValidationError('Please acknowledge the current Pokyh Learn privacy notice before signing in');
  }
  // Only a rejected WebUntis validation is an authentication failure. A
  // fault while creating the Pokyh session afterwards (for example the
  // database being unavailable) must surface as a server error, not tell a
  // correctly authenticated person that their credentials are wrong.
  let untis: Awaited<ReturnType<typeof validateWebUntis>>;
  try {
    untis = await validateWebUntis(username, password);
  } catch {
    throw new UnauthorizedError('WebUntis-Anmeldung fehlgeschlagen');
  }
  // Learn validates against the configured WebUntis school (WEBUNTIS_SCHOOL);
  // what the account is and its class, as for every other sign-in.
  const account = await resolveSession(defaultSchool(), untis.sessionId, username, {
    personId: untis.studentId, klasseId: untis.klasseId, personType: untis.personType,
  });
  const result: AuthenticatedUserResponse = await completeWebUntisLogin({
    username,
    ...accountFromWebUntis(account),
    schoolId: defaultSchoolId(),
    context: signInContext(req),
  });
  if (learnCfg.legalGateEnabled) {
    await prisma.learnProfile.upsert({
      where: { stableUid: result.user.stableUid },
      create: {
        stableUid: result.user.stableUid,
        privacyNoticeVersion: learnCfg.privacyNoticeVersion,
        privacyNoticeAcknowledgedAt: new Date(),
      },
      update: {
        privacyNoticeVersion: learnCfg.privacyNoticeVersion,
        privacyNoticeAcknowledgedAt: new Date(),
      },
    });
  }
  res.json(result);
});

// A POKYH-only account (user name and password, no school account).
async function localPasswordLogin(username: string, password: string, context: SignInContext): Promise<AuthenticatedUserResponse> {
  const user = await prisma.user.findUnique({ where: { username } });
  if (!user || !user.passwordHash) {
    throw new UnauthorizedError('Ungültige Zugangsdaten');
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    throw new UnauthorizedError('Ungültige Zugangsdaten');
  }
  return signInLocalAccount(user, context, 'local');
}

/**
 * The POKYH session of a POKYH-only account whose sign-in is already proven:
 * by its password, or by the POKYH app signed in to it (the QR sign-in).
 */
export async function signInLocalAccount(
  user: Prisma.UserGetPayload<object>,
  context: SignInContext,
  method: LoginMethod,
): Promise<AuthenticatedUserResponse> {
  const admin = await prisma.admin.findUnique({ where: { stableUid: user.stableUid } });
  const role = parseAccountRole(user.role);
  const classId = await syncUserClass(
    user.stableUid,
    user.username,
    user.webuntisKlasseId,
    user.webuntisKlasseName,
    role,
    user.schoolId ?? defaultSchoolId(),
  );
  const accountClass = normalizeAccountClass(role, user.webuntisKlasseId, user.webuntisKlasseName);
  const session = await openSession(user.stableUid, context);
  const { sid, refreshToken } = session;
  await recordLogin(user.stableUid, context, method, session);
  const token = signJwt({
    stableUid: user.stableUid,
    username: user.username,
    klasseId: accountClass.klasseId,
    klasseName: accountClass.klasseName,
    role: user.role,
    isUntisUser: false,
    sid,
  });

  return {
    token,
    refreshToken,
    sessionId: sid,
    user: {
      stableUid: user.stableUid,
      username: user.username,
      webuntisKlasseId: accountClass.klasseId,
      webuntisKlasseName: accountClass.klasseName,
      classId,
      isAdmin: admin !== null,
      isUntisUser: false,
      role: user.role,
      schoolId: user.schoolId,
    },
  };
}

router.post('/login', authLimiter, async (req: Request, res: Response) => {
  const serverKey = req.headers['x-server-key'];

  // ── Local password login (no server key) ──────────────────────────────────
  if (!serverKey) {
    const { username, password } = localLoginSchema.parse(req.body);
    const result = await localPasswordLogin(username, password, signInContext(req));
    res.locals.signedIn = { stableUid: result.user.stableUid, username: result.user.username };
    return res.json(result);
  }

  // ── Server-to-server Untis login ──────────────────────────────────────────
  if (typeof serverKey !== 'string') {
    throw new UnauthorizedError('Invalid X-Server-Key header');
  }

  const expectedBuf = Buffer.from(config.serverKey, 'utf8');
  const actualBuf = Buffer.from(serverKey, 'utf8');
  let validKey = false;
  if (actualBuf.length === expectedBuf.length) {
    try {
      validKey = timingSafeEqual(expectedBuf, actualBuf);
    } catch {
      validKey = false;
    }
  }
  if (!validKey) {
    throw new ForbiddenError('Invalid server key');
  }

  const body = loginSchema.parse(req.body);
  const { username, role, renewal, method, untisSessionId } = body;
  const schoolId = await loginSchool(req, body);

  // What the account is and its class: from WebUntis, when the app handed
  // over its session (of the school it names: login name and server);
  // otherwise only the app's own say, which assigns no class.
  let fromWebUntis: Pick<Parameters<typeof completeWebUntisLogin>[0], 'role' | 'roleConfirmed' | 'evidence'> = {
    role, roleConfirmed: false, evidence: { kind: 'unknown' },
  };
  if (untisSessionId) {
    const school = body.school
      ? parseSchool({ loginName: body.school, server: body.schoolServer, name: body.schoolName })
      : defaultSchool();
    if (school) {
      const account = await resolveSession(school, untisSessionId, username);
      fromWebUntis = accountFromWebUntis(account, role);
    }
  }

  // The app signs in again by itself (renewal: true) whenever its token
  // expires; for a device signed out from elsewhere that is refused
  // (`session_revoked`), and the app signs out.
  const result = await completeWebUntisLogin({
    username, ...fromWebUntis, schoolId,
    context: signInContext(req, { renewal }), method,
  });
  if (!renewal) res.locals.signedIn = { stableUid: result.user.stableUid, username: result.user.username };
  res.json(result);
});

// ─── POST /auth/register ─────────────────────────────────────────────────────

const registerSchema = z.object({
  username: z
    .string()
    .min(3, 'Benutzername muss mindestens 3 Zeichen lang sein')
    .max(30, 'Benutzername darf maximal 30 Zeichen lang sein')
    .regex(/^[a-z0-9_-]+$/, 'Nur Kleinbuchstaben, Zahlen, _ und - erlaubt')
    .trim(),
  password: z.string().min(8, 'Passwort muss mindestens 8 Zeichen lang sein').max(200),
});

// A new POKYH-only account; null when the name is taken.
async function registerLocalAccount(username: string, password: string, context: SignInContext): Promise<{ token: string; refreshToken: string; sessionId: string; user: Omit<AuthenticatedUserResponse['user'], 'schoolId'> } | null> {
  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) return null;

  const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
  const stableUid = generateStableUid();

  const user = await prisma.user.create({
    data: {
      stableUid,
      username,
      webuntisKlasseId: 0,
      webuntisKlasseName: '',
      passwordHash,
      isUntisUser: false,
      // A self-registered local account belongs to the default school.
      schoolId: defaultSchoolId(),
    },
  });

  const session = await openSession(user.stableUid, context);
  const { sid, refreshToken } = session;
  await recordLogin(user.stableUid, context, 'register', session);
  const token = signJwt({
    stableUid: user.stableUid,
    username: user.username,
    klasseId: 0,
    klasseName: '',
    role: user.role,
    isUntisUser: false,
    sid,
  });

  return {
    token,
    refreshToken,
    sessionId: sid,
    user: {
      stableUid: user.stableUid,
      username: user.username,
      webuntisKlasseId: 0,
      webuntisKlasseName: '',
      classId: null,
      isAdmin: false,
      isUntisUser: false,
      role: user.role,
    },
  };
}

router.post('/register', authLimiter, async (req: Request, res: Response) => {
  const { username, password } = registerSchema.parse(req.body);
  const result = await registerLocalAccount(username, password, signInContext(req));
  if (!result) {
    return res.status(409).json({ error: 'Benutzername bereits vergeben' });
  }
  res.locals.signedIn = { stableUid: result.user.stableUid, username: result.user.username };
  res.status(201).json(result);
});

// ─── POST /auth/refresh ──────────────────────────────────────────────────────

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

// A new access token for a refresh token, which is rotated on the way (in
// place: the device keeps its session). Rotating on every use means a refresh
// token that leaks once and gets replayed stops working with the next refresh.
async function refreshSession(rawToken: string, context: SignInContext): Promise<{ token: string; refreshToken: string }> {
  const rotated = await rotateSession(rawToken, context);
  if (!rotated) {
    throw new UnauthorizedError('Invalid or expired refresh token');
  }

  const { user, sid, refreshToken } = rotated;
  const accountClass = normalizeAccountClass(
    parseAccountRole(user.role),
    user.webuntisKlasseId,
    user.webuntisKlasseName,
  );

  const token = signJwt({
    stableUid: user.stableUid,
    username: user.username,
    klasseId: accountClass.klasseId,
    klasseName: accountClass.klasseName,
    role: user.role,
    isUntisUser: user.isUntisUser,
    sid,
  });

  return { token, refreshToken };
}

router.post('/refresh', refreshLimiter, async (req: Request, res: Response) => {
  const { refreshToken: rawToken } = refreshSchema.parse(req.body);
  res.json(await refreshSession(rawToken, signInContext(req)));
});

// ─── The website's cookie sign-in (/auth/web/*) ───────────────────────────────
//
// The website is a static page and talks to this API directly. Its refresh
// token lives in an httpOnly cookie on the API's address (webuntis/session.ts);
// the website only ever sees the short-lived access token, which it keeps in
// its own pokyh_api_token cookie, and the display data for pokyh_user.

// What the website shows for a POKYH-only account; no token, no password.
const localUserCookie = (username: string) => ({
  username, studentId: 0, klasseId: 0, klasseName: '', isUntisUser: false, loginAt: Date.now(),
});

// The browser as a device: its device cookie, and the refresh token it may
// still hold from before (so signing in again keeps its device session).
const webContext = (req: Request, res: Response) =>
  signInContext(req, { deviceId: webDeviceId(req, res), currentToken: readRefreshCookie(req) });

router.post('/web/local-login', authLimiter, async (req: Request, res: Response) => {
  const { username, password } = localLoginSchema.parse(req.body);
  const result = await localPasswordLogin(username, password, webContext(req, res));
  res.locals.signedIn = { stableUid: result.user.stableUid, username: result.user.username };
  setRefreshCookie(res, result.refreshToken);
  res.json({ ok: true, username: result.user.username, token: result.token, user: localUserCookie(result.user.username) });
});

router.post('/web/register', authLimiter, async (req: Request, res: Response) => {
  const { username, password } = registerSchema.parse(req.body);
  const result = await registerLocalAccount(username, password, webContext(req, res));
  if (!result) {
    return res.status(409).json({ error: 'Benutzername bereits vergeben' });
  }
  res.locals.signedIn = { stableUid: result.user.stableUid, username: result.user.username };
  setRefreshCookie(res, result.refreshToken);
  res.status(201).json({ ok: true, username: result.user.username, token: result.token, user: localUserCookie(result.user.username) });
});

router.post('/web/refresh', refreshLimiter, async (req: Request, res: Response) => {
  const rawToken = readRefreshCookie(req);
  if (!rawToken) {
    return res.status(401).json({ error: 'no_refresh_token' });
  }
  let renewed: { token: string; refreshToken: string };
  try {
    renewed = await refreshSession(rawToken, signInContext(req));
  } catch (err) {
    if (!(err instanceof UnauthorizedError)) throw err;
    // Invalid, expired or revoked: gone from the browser, so it stops trying.
    clearRefreshCookie(res);
    return res.status(401).json({ error: 'refresh_failed' });
  }
  setRefreshCookie(res, renewed.refreshToken);
  res.json({ ok: true, token: renewed.token });
});

// Signing out ends the sign-in everywhere it lives: the browser's device
// session ends and every sign-in cookie of this address goes. Needs no valid
// access token: an expired one must still be able to sign out.
router.post('/web/logout', async (req: Request, res: Response) => {
  const rawToken = readRefreshCookie(req);
  if (rawToken) await endSessionOfToken(rawToken).catch(() => {});
  const untis = readUntisSession(req);
  if (untis) forgetUntisSession(untis.sessionId);
  clearSignInCookies(res);
  res.json({ ok: true });
});

// ─── POST /auth/logout ───────────────────────────────────────────────────────

const logoutSchema = z.object({
  refreshToken: z.string().min(1),
});

router.post('/logout', requireAuth, async (req: Request, res: Response) => {
  const body = logoutSchema.safeParse(req.body);
  if (body.success) {
    await endSessionOfToken(body.data.refreshToken).catch(() => {});
  } else if (req.user?.sid) {
    // An app that signs out without its refresh token: the session of its access token.
    await revokeSession(req.user.stableUid, req.user.sid).catch(() => {});
  }
  res.json({ ok: true });
});

// ─── The account's devices and sign-ins (/auth/sessions, /auth/login-history) ─
//
// What the account sees of itself, as on its settings page: where it is
// signed in (device, app or website, place and address, last use), and its
// sign-ins of the last LOGIN_HISTORY_DAYS. Any device can sign out any other.

router.get('/sessions', readLimiter, requireAuth, async (req: Request, res: Response) => {
  const { stableUid, sid } = req.user!;
  res.json({ sessions: await listSessions(stableUid, sid) });
});

router.delete('/sessions/:id', writeLimiter, requireAuth, async (req: Request, res: Response) => {
  const { stableUid, username } = req.user!;
  const id = String(req.params['id'] ?? '').slice(0, 36);
  if (!(await revokeSession(stableUid, id))) {
    return res.status(404).json({ error: 'Dieses Gerät ist nicht (mehr) angemeldet.' });
  }
  logger.info('Device signed out by its account', { action: 'session_revoked_by_user', username });
  res.json({ ok: true });
});

// Every device but the one asking. A token from before device sessions names
// none, and would sign out its own device too: it is refused instead.
router.post('/sessions/sign-out-others', writeLimiter, requireAuth, async (req: Request, res: Response) => {
  const { stableUid, username, sid } = req.user!;
  if (!sid) {
    return res.status(409).json({ error: 'Bitte lade die Seite neu und versuche es noch einmal.', code: 'no_session' });
  }
  const count = await revokeSessions(stableUid, sid);
  logger.info('Other devices signed out by their account', { action: 'sessions_revoked_by_user', username, count });
  res.json({ ok: true, count });
});

router.get('/login-history', readLimiter, requireAuth, async (req: Request, res: Response) => {
  res.json({ logins: await loginHistory(req.user!.stableUid), keptDays: config.loginHistoryDays });
});

// ─── The POKYH app signs the website in (/auth/qr, services/qrLogin.ts) ───────
//
// The app scanned the website's QR code: first it asks which website that is
// (device, place, address — shown to the person before anything happens),
// then, confirmed, it approves the code with its own sign-in. A WebUntis
// account hands over its user name, password (or app key) and school, which
// the website's sign-in then uses exactly like typed ones; the name must be
// this account's.

const QR_GONE = { error: 'Dieser QR-Code ist abgelaufen. Lade die Anmeldeseite am Computer neu.', code: 'qr_expired' };

const qrApproveSchema = z.object({
  username: z.string().trim().toLowerCase().max(100).optional(),
  password: z.string().min(1).max(200).optional(),
  key: z.string().min(1).max(200).optional(),
  // The app's own WebUntis session: the website takes it over (no code needed
  // with two-factor sign-in); the password, if the app has one, renews it later.
  sessionId: z.string().trim().regex(/^[A-Za-z0-9._-]{8,200}$/).optional(),
  school: z.object({
    loginName: z.string().trim().min(1).max(100),
    server: z.string().trim().min(1).max(253),
    name: z.string().trim().max(200).optional(),
  }).optional(),
});

router.get('/qr/:code', readLimiter, requireAuth, async (req: Request, res: Response) => {
  const code = codeFromScan(String(req.params['code'] ?? ''));
  const info = code ? await qrLoginInfo(code) : null;
  if (!info) return res.status(404).json(QR_GONE);
  res.json(info);
});

router.post('/qr/:code/approve', writeLimiter, requireAuth, async (req: Request, res: Response) => {
  const code = codeFromScan(String(req.params['code'] ?? ''));
  if (!code) return res.status(404).json(QR_GONE);
  const { stableUid } = req.user!;
  const user = await prisma.user.findUnique({ where: { stableUid }, select: { username: true, isUntisUser: true } });
  if (!user) throw new UnauthorizedError('User not found');
  const body = qrApproveSchema.parse(req.body ?? {});

  let credential: QrCredential | null = null;
  if (user.isUntisUser) {
    if (!body.password && !body.key && !body.sessionId) {
      return res.status(400).json({ error: 'Melde dich in der App einmal mit Passwort an, dann geht es.', code: 'credential_required' });
    }
    if (body.username !== user.username) {
      return res.status(403).json({ error: 'Die Anmeldung gehört zu einem anderen Konto.', code: 'account_mismatch' });
    }
    if (body.school && !parseSchool(body.school)) {
      return res.status(400).json({ error: 'Diese Schule ist nicht verfügbar.', code: 'school_invalid' });
    }
    credential = {
      username: user.username,
      ...(body.key ? { key: body.key } : body.password ? { password: body.password } : {}),
      ...(body.sessionId ? { sessionId: body.sessionId } : {}),
      ...(body.school ? { school: body.school } : {}),
    };
  }
  if (!(await approveQrLogin(code, stableUid, credential))) return res.status(404).json(QR_GONE);
  logger.info('Website sign-in approved in the app', { action: 'qr_login_approved', username: user.username });
  res.json({ ok: true });
});

// ─── GET /auth/me ────────────────────────────────────────────────────────────

router.get('/me', requireAuth, async (req: Request, res: Response) => {
  const { stableUid } = req.user!;

  const user = await prisma.user.findUnique({ where: { stableUid } });
  if (!user) {
    throw new UnauthorizedError('User not found');
  }

  const role = parseAccountRole(user.role);
  if (!hasClassIdentity(role)) {
    await syncUserClass(
      user.stableUid,
      user.username,
      0,
      '',
      role,
      user.schoolId ?? defaultSchoolId(),
    );
  }

  const admin = await prisma.admin.findUnique({ where: { stableUid } });
  const accountClass = normalizeAccountClass(role, user.webuntisKlasseId, user.webuntisKlasseName);
  const membership = !hasClassIdentity(role)
    ? null
    : await prisma.classMember.findFirst({ where: { stableUid } });

  res.json({
    stableUid: user.stableUid,
    username: user.username,
    webuntisKlasseId: accountClass.klasseId,
    webuntisKlasseName: accountClass.klasseName,
    classId: membership?.classId ?? null,
    isAdmin: admin !== null,
    isUntisUser: user.isUntisUser,
    role: user.role,
    schoolId: user.schoolId,
  });
});

export { router as authRouter };
