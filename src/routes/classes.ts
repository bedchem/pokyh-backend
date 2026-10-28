import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { readLimiter, writeLimiter } from '../middleware/rateLimiter';
import { ForbiddenError, NotFoundError, ConflictError } from '../utils/errors';
import { generateClassCode, generateClassId } from '../utils/uid';
import { CLASS_CHECK_VERSION, mayJoinClass } from '../utils/accountClass';
import { defaultSchoolId, schoolOfUser } from '../services/schools';
import { loadAccess } from '../services/adminAccess';
import { can } from '../security/permissions';

const router = Router();

// GET /classes/mine — get user's class
router.get('/mine', readLimiter, requireAuth, async (req: Request, res: Response) => {
  const { stableUid, role } = req.user!;
  // The account's class as stored now, not as the access token remembers it:
  // a class a sign-in has since taken away is gone at once.
  const currentUser = await prisma.user.findUnique({
    where: { stableUid },
    select: { role: true, webuntisKlasseId: true },
  });

  if (!mayJoinClass(role) || !currentUser || !mayJoinClass(currentUser.role) || currentUser.webuntisKlasseId <= 0) {
    res.json(null);
    return;
  }

  const schoolId = await schoolOfUser(stableUid);
  const membership = await prisma.classMember.findFirst({
    where: {
      stableUid,
      class: { webuntisKlasseId: currentUser.webuntisKlasseId, schoolId },
    },
    include: {
      class: {
        include: {
          // Filter legacy parent rows defensively; new parent rows are forbidden.
          members: {
            where: { role: { not: 'parent' } },
            select: { stableUid: true, username: true },
          },
        },
      },
    },
  });

  if (!membership) {
    res.json(null);
    return;
  }

  res.json(membership.class);
});

// GET /classes/:classId — get class with members (must be member)
router.get('/:classId', readLimiter, requireAuth, async (req: Request, res: Response) => {
  const classId = req.params['classId'] as string;
  const { stableUid, role } = req.user!;
  const currentUser = await prisma.user.findUnique({
    where: { stableUid },
    select: { role: true },
  });

  if (!mayJoinClass(role) || !currentUser || !mayJoinClass(currentUser.role)) {
    throw new ForbiddenError('Eltern-Accounts werden keiner Klasse zugeteilt');
  }

  const membership = await prisma.classMember.findUnique({
    where: { classId_stableUid: { classId, stableUid } },
  });

  if (!membership) {
    throw new ForbiddenError('You are not a member of this class');
  }

  const cls = await prisma.class.findUnique({
    where: { id: classId },
    include: {
      // Filter legacy parent rows defensively; new parent rows are forbidden.
      members: {
        where: { role: { not: 'parent' } },
        select: { stableUid: true, username: true, joinedAt: true },
      },
    },
  });

  if (!cls) {
    throw new NotFoundError('Class not found');
  }

  res.json(cls);
});

// POST /classes — create class (admin only)
const createClassSchema = z.object({
  name: z.string().min(1).max(100),
  webuntisKlasseId: z.number().int().positive(),
});

router.post('/', writeLimiter, requireAuth, async (req: Request, res: Response) => {
  const { stableUid, username } = req.user!;
  const schoolId = await schoolOfUser(stableUid);

  // Like the admin panel: an admin account (or an operator configured through
  // ADMIN_USERNAMES) that may manage the classes of this account's school.
  const admin = await prisma.admin.findUnique({ where: { stableUid }, select: { mustChangePassword: true } });
  const access = await loadAccess(username);
  if (!((admin && !admin.mustChangePassword) || access.owner) || !can(access, 'classes.manage', schoolId)) {
    throw new ForbiddenError('Admin access required');
  }

  const body = createClassSchema.parse(req.body);

  // Check for existing class with this webuntisKlasseId (ids are per school)
  const existing = await prisma.class.findFirst({
    where: { webuntisKlasseId: body.webuntisKlasseId, schoolId },
  });
  if (existing) {
    throw new ConflictError('A class with this WebUntis class ID already exists');
  }

  const id = generateClassId();
  const code = generateClassCode();

  const cls = await prisma.class.create({
    data: {
      id,
      name: body.name,
      code,
      webuntisKlasseId: body.webuntisKlasseId,
      createdBy: stableUid,
      createdByName: username,
      schoolId,
    },
  });

  res.status(201).json(cls);
});

// POST /classes/join — join by code
const joinSchema = z.object({
  code: z.string().length(6).toUpperCase(),
});

router.post('/join', writeLimiter, requireAuth, async (req: Request, res: Response) => {
  const { stableUid, username, role } = req.user!;
  const body = joinSchema.parse(req.body);
  const currentUser = await prisma.user.findUnique({
    where: { stableUid },
    select: { role: true, isUntisUser: true, webuntisKlasseId: true, classCheckVersion: true },
  });

  // Consult the persisted role as well as the JWT so a token issued before an
  // admin changes the account to parent cannot recreate a membership.
  if (!mayJoinClass(role) || !currentUser || !mayJoinClass(currentUser.role)) {
    throw new ForbiddenError('Eltern-Accounts werden keiner Klasse zugeteilt');
  }

  const cls = await prisma.class.findUnique({ where: { code: body.code } });
  // A code only opens a class of the account's own school.
  if (!cls || (cls.schoolId ?? defaultSchoolId()) !== (await schoolOfUser(stableUid))) {
    throw new NotFoundError('Class not found with that code');
  }

  // A WebUntis account belongs to the one class WebUntis confirmed for it,
  // never to another one by its code.
  const ownClass = currentUser.webuntisKlasseId > 0 && currentUser.classCheckVersion === CLASS_CHECK_VERSION
    && cls.webuntisKlasseId === currentUser.webuntisKlasseId;
  if (currentUser.isUntisUser && !ownClass) {
    throw new ForbiddenError('Du kannst nur deiner eigenen Klasse beitreten');
  }

  // Already a member?
  const existing = await prisma.classMember.findUnique({
    where: { classId_stableUid: { classId: cls.id, stableUid } },
  });
  if (existing) {
    res.json({ classId: cls.id, message: 'Already a member' });
    return;
  }

  await prisma.classMember.create({
    data: { classId: cls.id, stableUid, username, role: 'student' },
  });

  res.json({ classId: cls.id });
});

// POST /classes/:classId/leave — leave class
router.post('/:classId/leave', writeLimiter, requireAuth, async (req: Request, res: Response) => {
  const classId = req.params['classId'] as string;
  const { stableUid } = req.user!;

  const membership = await prisma.classMember.findUnique({
    where: { classId_stableUid: { classId, stableUid } },
  });

  if (!membership) {
    throw new NotFoundError('You are not a member of this class');
  }

  await prisma.classMember.delete({
    where: { classId_stableUid: { classId, stableUid } },
  });

  // If last member, delete the class
  const remainingCount = await prisma.classMember.count({ where: { classId } });
  if (remainingCount === 0) {
    await prisma.class.delete({ where: { id: classId } }).catch(() => {});
  }

  res.json({ ok: true });
});

export { router as classesRouter };
