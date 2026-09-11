import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { prisma } from '../db';
import { optionalAuth, requireAuth } from '../middleware/auth';
import { readLimiter, writeLimiter } from '../middleware/rateLimiter';
import { ForbiddenError, NotFoundError } from '../utils/errors';

const router = Router();

type CoursePermission = 'NONE' | 'VIEW' | 'EDIT' | 'MANAGE';

const permissionRank: Record<CoursePermission, number> = {
  NONE: 0,
  VIEW: 1,
  EDIT: 2,
  MANAGE: 3,
};

const courseVisibilitySchema = z.enum(['PRIVATE', 'TEAM', 'PUBLIC']);
const courseStatusSchema = z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']);
const coursePermissionSchema = z.enum(['VIEW', 'EDIT', 'MANAGE']);
const teamRoleSchema = z.enum(['MANAGER', 'MEMBER']);
const sectionTypeSchema = z.enum(['LESSON', 'VOCABULARY', 'GRAMMAR', 'QUIZ']);
const quizModeSchema = z.enum(['PRACTICE', 'REVIEW', 'WRONG_ANSWERS']);
const quizDirectionSchema = z.enum(['SOURCE_TO_TARGET', 'TARGET_TO_SOURCE']);

const uuidSchema = z.string().uuid();
const trimmedText = (max: number) => z.string().trim().min(1).max(max);
const optionalTrimmedText = (max: number) => z.string().trim().max(max).optional();

const courseSectionSchema = z.object({
  title: trimmedText(200),
  summary: optionalTrimmedText(2000).default(''),
  type: sectionTypeSchema.default('LESSON'),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
  content: z.record(z.unknown()).default({}),
});

const createCourseSchema = z.object({
  title: trimmedText(160),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(191).optional(),
  summary: optionalTrimmedText(2000).default(''),
  subject: optionalTrimmedText(120).default(''),
  language: optionalTrimmedText(80).default(''),
  level: optionalTrimmedText(50).default(''),
  visibility: courseVisibilitySchema.default('PRIVATE'),
  status: courseStatusSchema.default('DRAFT'),
  coverImageUrl: z.string().trim().url().max(1000).or(z.literal('')).optional().default(''),
  teamId: uuidSchema.optional().nullable(),
  sections: z.array(courseSectionSchema).max(100).default([]),
}).superRefine((body, ctx) => {
  if (body.visibility === 'TEAM' && !body.teamId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['teamId'], message: 'A TEAM course requires a teamId' });
  }
  if (body.visibility !== 'TEAM' && body.teamId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['teamId'], message: 'teamId is only valid for TEAM courses' });
  }

  const sortOrders = new Set<number>();
  body.sections.forEach((section, index) => {
    const sortOrder = section.sortOrder ?? index;
    if (sortOrders.has(sortOrder)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sections', index, 'sortOrder'],
        message: 'Section sortOrder values must be unique within a course',
      });
    }
    sortOrders.add(sortOrder);
  });
});

const profileSchema = z.object({
  dailyGoalMinutes: z.number().int().min(1).max(24 * 60).optional(),
  timezone: z.string().trim().max(80).optional(),
}).refine((body) => Object.keys(body).length > 0, {
  message: 'At least one profile field is required',
});

const progressSchema = z.object({
  status: z.enum(['ACTIVE', 'PAUSED', 'COMPLETED']).optional(),
  progressPercent: z.number().min(0).max(100).optional(),
  completedSections: z.number().int().min(0).max(100_000).optional(),
}).refine((body) => Object.keys(body).length > 0, {
  message: 'At least one progress field is required',
});

const vocabularyCreateSchema = z.object({
  courseId: uuidSchema,
  sectionId: uuidSchema.optional().nullable(),
  sourceLanguage: trimmedText(20),
  targetLanguage: optionalTrimmedText(20).default(''),
  sourceText: trimmedText(500),
  // A learner may capture just a word. Such an entry is saved with local
  // context but remains outside graded queues until an authorized editor adds
  // an approved answer on the server.
  targetText: optionalTrimmedText(500).default(''),
  article: optionalTrimmedText(40).default(''),
  partOfSpeech: optionalTrimmedText(80).default(''),
  notes: optionalTrimmedText(2000).default(''),
  tags: z.array(z.string().trim().min(1).max(80)).max(25).default([]),
});

const vocabularyUpdateSchema = z.object({
  sectionId: uuidSchema.optional().nullable(),
  sourceLanguage: trimmedText(20).optional(),
  targetLanguage: trimmedText(20).optional(),
  sourceText: trimmedText(500).optional(),
  targetText: trimmedText(500).optional(),
  article: optionalTrimmedText(40),
  partOfSpeech: optionalTrimmedText(80),
  notes: optionalTrimmedText(2000),
  tags: z.array(z.string().trim().min(1).max(80)).max(25).optional(),
}).refine((body) => Object.keys(body).length > 0, {
  message: 'At least one vocabulary field is required',
});

const quizAnswerSchema = z.object({
  entryId: uuidSchema,
  answer: z.string().trim().max(500),
  direction: quizDirectionSchema.default('SOURCE_TO_TARGET'),
});

const quizAttemptSchema = z.object({
  courseId: uuidSchema,
  mode: quizModeSchema.default('PRACTICE'),
  idempotencyKey: z.string().trim().min(8).max(191).optional(),
  answers: z.array(quizAnswerSchema).min(1).max(100),
}).superRefine((body, ctx) => {
  const seen = new Set<string>();
  body.answers.forEach((answer, index) => {
    if (seen.has(answer.entryId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['answers', index, 'entryId'],
        message: 'Each vocabulary entry can only be answered once per attempt',
      });
    }
    seen.add(answer.entryId);
  });
});

const teamCreateSchema = z.object({
  name: trimmedText(120),
  description: optionalTrimmedText(1000).default(''),
});

const teamMemberSchema = z.object({
  // Accept a stable UID or username; the server resolves it to the canonical UID.
  userId: trimmedText(100),
  role: teamRoleSchema.default('MEMBER'),
});

const courseAccessSchema = z.object({
  courseId: uuidSchema,
  stableUid: trimmedText(100),
  permission: coursePermissionSchema,
});

function normalizeAnswer(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('de-DE')
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function expectedAnswers(value: string): string[] {
  // Semicolons, pipes and slashes are intentionally treated as author-provided
  // alternative translations; commas remain valid parts of a phrase.
  return value
    .split(/\s*(?:;|\||\/)\s*/)
    .map(normalizeAnswer)
    .filter(Boolean);
}

function isCatalogCourse(course: { visibility: string; status: string }): boolean {
  return course.visibility === 'PUBLIC' && course.status === 'PUBLISHED';
}

function permissionFromGrant(permission: string | undefined): CoursePermission {
  if (permission === 'VIEW' || permission === 'EDIT' || permission === 'MANAGE') return permission;
  return 'NONE';
}

function strongestPermission(current: CoursePermission, candidate: CoursePermission): CoursePermission {
  return permissionRank[candidate] > permissionRank[current] ? candidate : current;
}

function requiresPermission(actual: CoursePermission, required: CoursePermission): boolean {
  return permissionRank[actual] >= permissionRank[required];
}

function createSlug(title: string): string {
  const normalized = title
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 150);
  return `${normalized || 'course'}-${randomUUID().slice(0, 8)}`;
}

async function isLearnAdmin(stableUid: string): Promise<boolean> {
  return (await prisma.admin.findUnique({ where: { stableUid }, select: { stableUid: true } })) !== null;
}

async function ensureLearnProfile(stableUid: string, touch = true) {
  const user = await prisma.user.findUnique({
    where: { stableUid },
    select: { stableUid: true, username: true, role: true },
  });
  if (!user) throw new NotFoundError('POKYH user not found');

  const profile = await prisma.learnProfile.upsert({
    where: { stableUid },
    create: { stableUid, lastActiveAt: touch ? new Date() : null },
    update: touch ? { lastActiveAt: new Date() } : {},
  });
  return { user, profile };
}

interface ResolvedCourseAccess {
  course: {
    id: string;
    slug: string;
    title: string;
    visibility: string;
    status: string;
    createdBy: string;
    teamId: string | null;
  };
  permission: CoursePermission;
  isAdmin: boolean;
}

async function resolveCourseAccess(courseId: string, stableUid?: string): Promise<ResolvedCourseAccess> {
  const course = await prisma.learnCourse.findUnique({
    where: { id: courseId },
    select: {
      id: true,
      slug: true,
      title: true,
      visibility: true,
      status: true,
      createdBy: true,
      teamId: true,
    },
  });
  if (!course) throw new NotFoundError('Course not found');

  if (!stableUid) {
    // Avoid leaking the existence of a private/team course to anonymous callers.
    if (!isCatalogCourse(course)) throw new NotFoundError('Course not found');
    return { course, permission: 'VIEW', isAdmin: false };
  }

  const [admin, grant, enrollment, teamMembership] = await Promise.all([
    prisma.admin.findUnique({ where: { stableUid }, select: { stableUid: true } }),
    prisma.learnCourseAccess.findUnique({
      where: { courseId_stableUid: { courseId, stableUid } },
      select: { permission: true },
    }),
    prisma.learnEnrollment.findUnique({
      where: { courseId_stableUid: { courseId, stableUid } },
      select: { status: true },
    }),
    course.teamId
      ? prisma.learnTeamMember.findUnique({
        where: { teamId_stableUid: { teamId: course.teamId, stableUid } },
        select: { role: true },
      })
      : Promise.resolve(null),
  ]);

  const isAdmin = admin !== null;
  let permission: CoursePermission = 'NONE';
  if (isAdmin || course.createdBy === stableUid) permission = 'MANAGE';
  permission = strongestPermission(permission, permissionFromGrant(grant?.permission));
  if (course.visibility === 'TEAM' && teamMembership) permission = strongestPermission(permission, 'VIEW');
  if (isCatalogCourse(course)) permission = strongestPermission(permission, 'VIEW');
  if (enrollment) permission = strongestPermission(permission, 'VIEW');

  return { course, permission, isAdmin };
}

async function requireCoursePermission(courseId: string, stableUid: string, permission: CoursePermission) {
  const access = await resolveCourseAccess(courseId, stableUid);
  if (!requiresPermission(access.permission, permission)) {
    throw new ForbiddenError('You do not have access to this course');
  }
  return access;
}

async function requireTeamManager(teamId: string, stableUid: string): Promise<void> {
  const [team, member, isAdmin] = await Promise.all([
    prisma.learnTeam.findUnique({ where: { id: teamId }, select: { id: true } }),
    prisma.learnTeamMember.findUnique({
      where: { teamId_stableUid: { teamId, stableUid } },
      select: { role: true },
    }),
    isLearnAdmin(stableUid),
  ]);
  if (!team) throw new NotFoundError('Team not found');
  if (!isAdmin && (!member || (member.role !== 'OWNER' && member.role !== 'MANAGER'))) {
    throw new ForbiddenError('Only a team owner or manager can perform this action');
  }
}

async function accessibleCourseIds(stableUid: string): Promise<string[]> {
  const isAdmin = await isLearnAdmin(stableUid);
  const where: Prisma.LearnCourseWhereInput = isAdmin
    ? {}
    : {
      OR: [
        { createdBy: stableUid },
        { accessGrants: { some: { stableUid } } },
        { enrollments: { some: { stableUid } } },
        { visibility: 'TEAM', team: { is: { members: { some: { stableUid } } } } },
      ],
    };
  const courses = await prisma.learnCourse.findMany({ where, select: { id: true } });
  return courses.map((course) => course.id);
}

function asReviewQuestion(entry: {
  id: string;
  courseId: string;
  sourceLanguage: string;
  targetLanguage: string;
  sourceText: string;
}, review?: {
  dueAt: Date;
  correctCount: number;
  incorrectCount: number;
  lastWasCorrect: boolean;
}) {
  return {
    entryId: entry.id,
    courseId: entry.courseId,
    direction: 'SOURCE_TO_TARGET' as const,
    prompt: entry.sourceText,
    sourceLanguage: entry.sourceLanguage,
    targetLanguage: entry.targetLanguage,
    review: review ? {
      dueAt: review.dueAt,
      correctCount: review.correctCount,
      incorrectCount: review.incorrectCount,
      lastWasCorrect: review.lastWasCorrect,
    } : null,
  };
}

function safeJsonValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

function safeStringArray(raw: string): string[] {
  const value = safeJsonValue(raw);
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function serializeSection<T extends { contentJson: string }>(section: T) {
  const { contentJson, ...rest } = section;
  return { ...rest, content: safeJsonValue(contentJson) };
}

function localContextSentence(language: string, sourceText: string): string {
  const normalizedLanguage = language.trim().toLocaleLowerCase('en-US');
  if (normalizedLanguage === 'it' || normalizedLanguage.startsWith('ital')) {
    return `Nella lezione di oggi usiamo “${sourceText}” in una frase italiana.`;
  }
  if (normalizedLanguage === 'en' || normalizedLanguage.startsWith('engl')) {
    return `In today's lesson, we use “${sourceText}” in an English sentence.`;
  }
  return `Heute verwenden wir „${sourceText}“ in einem passenden Satz.`;
}

function serializeVocabularyEntry<T extends {
  tagsJson: string;
  normalizedSource: string;
  normalizedTarget: string;
  sourceLanguage: string;
  sourceText: string;
  targetText: string;
}>(entry: T) {
  // Target text and normalized answer keys never leave the vocabulary-list
  // endpoint. This prevents a list view from leaking answers before a quiz.
  const {
    tagsJson,
    normalizedSource: _normalizedSource,
    normalizedTarget,
    targetText: _targetText,
    ...rest
  } = entry;
  return {
    ...rest,
    tags: safeStringArray(tagsJson),
    contextSentence: localContextSentence(entry.sourceLanguage, entry.sourceText),
    readyForQuiz: normalizedTarget.length > 0,
  };
}

function compactAttempt(attempt: {
  id: string;
  courseId: string;
  mode: string;
  totalQuestions: number;
  correctAnswers: number;
  score: number;
  createdAt: Date;
}) {
  return {
    id: attempt.id,
    courseId: attempt.courseId,
    mode: attempt.mode,
    totalQuestions: attempt.totalQuestions,
    correctAnswers: attempt.correctAnswers,
    score: attempt.score,
    createdAt: attempt.createdAt,
  };
}

function storedQuizResults(raw: string): Array<{
  entryId: string;
  direction: 'SOURCE_TO_TARGET' | 'TARGET_TO_SOURCE';
  correct: boolean;
  correctAnswer: string;
}> {
  const value = safeJsonValue(raw);
  if (!Array.isArray(value)) return [];

  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const answer = item as Record<string, unknown>;
    if (typeof answer.entryId !== 'string' || typeof answer.correct !== 'boolean' || typeof answer.correctAnswer !== 'string') return [];
    return [{
      entryId: answer.entryId,
      direction: answer.direction === 'TARGET_TO_SOURCE' ? 'TARGET_TO_SOURCE' : 'SOURCE_TO_TARGET',
      correct: answer.correct,
      correctAnswer: answer.correctAnswer,
    }];
  });
}

// GET /learn/catalog — API-key protected but intentionally JWT-optional.
// This is the read-only course catalog shown before a learner adds a course.
router.get('/catalog', readLimiter, async (_req: Request, res: Response) => {
  const courses = await prisma.learnCourse.findMany({
    where: { visibility: 'PUBLIC', status: 'PUBLISHED' },
    orderBy: [{ subject: 'asc' }, { title: 'asc' }],
    select: {
      id: true,
      slug: true,
      title: true,
      summary: true,
      subject: true,
      language: true,
      level: true,
      coverImageUrl: true,
      updatedAt: true,
      _count: { select: { sections: true, vocabulary: true, enrollments: true } },
    },
  });
  res.json({ courses });
});

// GET /learn/catalog/:slug — public detail for a catalogue card. Keep this
// separate from the ID-based access route so private/team records are never
// discoverable by slug.
router.get('/catalog/:slug', readLimiter, async (req: Request, res: Response) => {
  const slug = z.string().trim().min(1).max(191).parse(req.params['slug']);
  const course = await prisma.learnCourse.findFirst({
    where: { slug, visibility: 'PUBLIC', status: 'PUBLISHED' },
    select: {
      id: true,
      slug: true,
      title: true,
      summary: true,
      subject: true,
      language: true,
      level: true,
      visibility: true,
      status: true,
      coverImageUrl: true,
      createdAt: true,
      updatedAt: true,
      sections: {
        orderBy: { sortOrder: 'asc' },
        select: { id: true, title: true, summary: true, type: true, sortOrder: true, contentJson: true, updatedAt: true },
      },
      _count: { select: { vocabulary: true, enrollments: true } },
    },
  });
  if (!course) throw new NotFoundError('Course not found');
  const { sections, ...courseFields } = course;
  res.json({ course: { ...courseFields, sections: sections.map(serializeSection) } });
});

// GET /learn/me — creates a durable profile only after a valid POKYH JWT.
router.get('/me', readLimiter, requireAuth, async (req: Request, res: Response) => {
  const { stableUid } = req.user!;
  const [{ user, profile }, isAdmin] = await Promise.all([
    ensureLearnProfile(stableUid),
    isLearnAdmin(stableUid),
  ]);
  res.json({
    user: { stableUid: user.stableUid, username: user.username, role: user.role },
    profile,
    isAdmin,
  });
});

router.patch('/me', writeLimiter, requireAuth, async (req: Request, res: Response) => {
  const { stableUid } = req.user!;
  await ensureLearnProfile(stableUid, false);
  const body = profileSchema.parse(req.body);
  const profile = await prisma.learnProfile.update({
    where: { stableUid },
    data: {
      ...(body.dailyGoalMinutes !== undefined && { dailyGoalMinutes: body.dailyGoalMinutes }),
      ...(body.timezone !== undefined && { timezone: body.timezone }),
      lastActiveAt: new Date(),
    },
  });
  res.json(profile);
});

// GET /learn/dashboard — a compact server-side snapshot for the learner home.
router.get('/dashboard', readLimiter, requireAuth, async (req: Request, res: Response) => {
  const { stableUid } = req.user!;
  const { profile } = await ensureLearnProfile(stableUid);
  const [enrollmentCount, dueReviewCount, recentAttempts, enrollments] = await Promise.all([
    prisma.learnEnrollment.count({ where: { stableUid, status: 'ACTIVE' } }),
    prisma.learnVocabularyReview.count({ where: { stableUid, dueAt: { lte: new Date() } } }),
    prisma.learnQuizAttempt.findMany({
      where: { stableUid },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: {
        id: true,
        courseId: true,
        mode: true,
        totalQuestions: true,
        correctAnswers: true,
        score: true,
        createdAt: true,
      },
    }),
    prisma.learnEnrollment.findMany({
      where: { stableUid },
      orderBy: { lastOpenedAt: 'desc' },
      take: 8,
      select: {
        status: true,
        progressPercent: true,
        completedSections: true,
        lastOpenedAt: true,
        updatedAt: true,
        course: {
          select: {
            id: true,
            slug: true,
            title: true,
            subject: true,
            language: true,
            level: true,
            coverImageUrl: true,
          },
        },
      },
    }),
  ]);

  res.json({
    profile,
    stats: { enrollmentCount, dueReviewCount },
    recentAttempts: recentAttempts.map(compactAttempt),
    courses: enrollments,
  });
});

// GET /learn/courses — the current user's library (not the public catalog).
router.get('/courses', readLimiter, requireAuth, async (req: Request, res: Response) => {
  const { stableUid } = req.user!;
  await ensureLearnProfile(stableUid, false);
  const isAdmin = await isLearnAdmin(stableUid);
  const where: Prisma.LearnCourseWhereInput = isAdmin
    ? {}
    : {
      OR: [
        { createdBy: stableUid },
        { accessGrants: { some: { stableUid } } },
        { enrollments: { some: { stableUid } } },
        { visibility: 'TEAM', team: { is: { members: { some: { stableUid } } } } },
      ],
    };
  const courses = await prisma.learnCourse.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      slug: true,
      title: true,
      summary: true,
      subject: true,
      language: true,
      level: true,
      visibility: true,
      status: true,
      coverImageUrl: true,
      teamId: true,
      updatedAt: true,
      _count: { select: { sections: true, vocabulary: true } },
      enrollments: {
        where: { stableUid },
        select: { status: true, progressPercent: true, completedSections: true, lastOpenedAt: true },
      },
    },
  });
  res.json({ courses });
});

// POST /learn/courses — users may make a personal course, a public catalog
// course, or a team course that they manage.  The caller owns the new course.
router.post('/courses', writeLimiter, requireAuth, async (req: Request, res: Response) => {
  const { stableUid } = req.user!;
  await ensureLearnProfile(stableUid, false);
  const body = createCourseSchema.parse(req.body);

  if (body.status === 'PUBLISHED' && !await isLearnAdmin(stableUid)) {
    throw new ForbiddenError('Only a Pokyh administrator can publish a course');
  }

  if (body.teamId) await requireTeamManager(body.teamId, stableUid);

  const course = await prisma.learnCourse.create({
    data: {
      slug: body.slug ?? createSlug(body.title),
      title: body.title,
      summary: body.summary,
      subject: body.subject,
      language: body.language,
      level: body.level,
      visibility: body.visibility,
      status: body.status,
      coverImageUrl: body.coverImageUrl,
      teamId: body.teamId ?? null,
      createdBy: stableUid,
      sections: body.sections.length > 0 ? {
        create: body.sections.map((section, index) => ({
          title: section.title,
          summary: section.summary,
          type: section.type,
          sortOrder: section.sortOrder ?? index,
          contentJson: JSON.stringify(section.content),
        })),
      } : undefined,
    },
    include: { sections: { orderBy: { sortOrder: 'asc' } } },
  });
  res.status(201).json({ ...course, sections: course.sections.map(serializeSection) });
});

// GET /learn/courses/:courseId — public courses remain readable without a JWT;
// private/team courses require an existing POKYH session and appropriate access.
router.get('/courses/:courseId', readLimiter, optionalAuth, async (req: Request, res: Response) => {
  const courseId = uuidSchema.parse(req.params['courseId']);
  const stableUid = req.user?.stableUid;
  const access = await resolveCourseAccess(courseId, stableUid);
  if (!requiresPermission(access.permission, 'VIEW')) throw new NotFoundError('Course not found');

  const [course, enrollment] = await Promise.all([
    prisma.learnCourse.findUnique({
      where: { id: courseId },
      select: {
        id: true,
        slug: true,
        title: true,
        summary: true,
        subject: true,
        language: true,
        level: true,
        visibility: true,
        status: true,
        coverImageUrl: true,
        teamId: true,
        createdAt: true,
        updatedAt: true,
        sections: {
          orderBy: { sortOrder: 'asc' },
          select: { id: true, title: true, summary: true, type: true, sortOrder: true, contentJson: true, updatedAt: true },
        },
        _count: { select: { vocabulary: true, enrollments: true } },
      },
    }),
    stableUid
      ? prisma.learnEnrollment.findUnique({
        where: { courseId_stableUid: { courseId, stableUid } },
        select: { status: true, progressPercent: true, completedSections: true, lastOpenedAt: true, completedAt: true },
      })
      : Promise.resolve(null),
  ]);
  if (!course) throw new NotFoundError('Course not found');

  // Opening an enrolled course is useful progress data, but anonymous catalog
  // reads and non-enrolled previews never mutate learner state.
  if (stableUid && enrollment) {
    await prisma.learnEnrollment.update({
      where: { courseId_stableUid: { courseId, stableUid } },
      data: { lastOpenedAt: new Date() },
    });
  }

  const { sections, ...courseFields } = course;
  res.json({
    course: { ...courseFields, sections: sections.map(serializeSection) },
    enrollment,
    permissions: { canEdit: requiresPermission(access.permission, 'EDIT'), canManage: requiresPermission(access.permission, 'MANAGE') },
  });
});

// POST /learn/courses/:courseId/enroll — adding a course to the learner's list.
router.post('/courses/:courseId/enroll', writeLimiter, requireAuth, async (req: Request, res: Response) => {
  const courseId = uuidSchema.parse(req.params['courseId']);
  const { stableUid } = req.user!;
  await ensureLearnProfile(stableUid, false);
  await requireCoursePermission(courseId, stableUid, 'VIEW');

  const enrollment = await prisma.learnEnrollment.upsert({
    where: { courseId_stableUid: { courseId, stableUid } },
    create: { courseId, stableUid, status: 'ACTIVE', lastOpenedAt: new Date() },
    update: { status: 'ACTIVE', lastOpenedAt: new Date(), completedAt: null },
  });
  res.json(enrollment);
});

// PATCH /learn/courses/:courseId/progress — only the enrolled learner can
// change their own progress. Completion timestamps are server-authoritative.
router.patch('/courses/:courseId/progress', writeLimiter, requireAuth, async (req: Request, res: Response) => {
  const courseId = uuidSchema.parse(req.params['courseId']);
  const body = progressSchema.parse(req.body);
  const { stableUid } = req.user!;
  await requireCoursePermission(courseId, stableUid, 'VIEW');

  const enrollment = await prisma.learnEnrollment.findUnique({
    where: { courseId_stableUid: { courseId, stableUid } },
    select: { courseId: true },
  });
  if (!enrollment) throw new NotFoundError('Add this course before updating progress');

  const updated = await prisma.learnEnrollment.update({
    where: { courseId_stableUid: { courseId, stableUid } },
    data: {
      ...(body.status !== undefined && { status: body.status }),
      ...(body.progressPercent !== undefined && { progressPercent: body.progressPercent }),
      ...(body.completedSections !== undefined && { completedSections: body.completedSections }),
      ...(body.status === 'COMPLETED' && { completedAt: new Date(), progressPercent: 100 }),
      ...(body.status !== undefined && body.status !== 'COMPLETED' && { completedAt: null }),
      lastOpenedAt: new Date(),
    },
  });
  res.json(updated);
});

// GET /learn/vocabulary?courseId=...&sectionId=...
router.get('/vocabulary', readLimiter, requireAuth, async (req: Request, res: Response) => {
  const query = z.object({
    courseId: uuidSchema,
    sectionId: uuidSchema.optional(),
    limit: z.coerce.number().int().min(1).max(250).default(100),
  }).parse(req.query);
  const { stableUid } = req.user!;
  await requireCoursePermission(query.courseId, stableUid, 'VIEW');

  const entries = await prisma.learnVocabularyEntry.findMany({
    where: { courseId: query.courseId, ...(query.sectionId && { sectionId: query.sectionId }) },
    orderBy: [{ sourceText: 'asc' }, { createdAt: 'asc' }],
    take: query.limit,
    select: {
      id: true,
      courseId: true,
      sectionId: true,
      sourceLanguage: true,
      targetLanguage: true,
      sourceText: true,
      targetText: true,
      normalizedSource: true,
      normalizedTarget: true,
      article: true,
      partOfSpeech: true,
      notes: true,
      tagsJson: true,
      verificationStatus: true,
      verificationSource: true,
      createdBy: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  res.json({ entries: entries.map(serializeVocabularyEntry) });
});

// POST /learn/vocabulary — EDIT is enough to contribute, but ownership stays
// with the submitting user for all later changes.
router.post('/vocabulary', writeLimiter, requireAuth, async (req: Request, res: Response) => {
  const body = vocabularyCreateSchema.parse(req.body);
  const { stableUid } = req.user!;
  await ensureLearnProfile(stableUid, false);
  await requireCoursePermission(body.courseId, stableUid, 'EDIT');

  if (body.sectionId) {
    const section = await prisma.learnCourseSection.findFirst({
      where: { id: body.sectionId, courseId: body.courseId },
      select: { id: true },
    });
    if (!section) throw new NotFoundError('Vocabulary section not found in this course');
  }

  const entry = await prisma.learnVocabularyEntry.create({
    data: {
      courseId: body.courseId,
      sectionId: body.sectionId ?? null,
      sourceLanguage: body.sourceLanguage,
      targetLanguage: body.targetLanguage,
      sourceText: body.sourceText,
      targetText: body.targetText,
      normalizedSource: normalizeAnswer(body.sourceText),
      normalizedTarget: normalizeAnswer(body.targetText),
      article: body.article,
      partOfSpeech: body.partOfSpeech,
      notes: body.notes,
      tagsJson: JSON.stringify(body.tags),
      createdBy: stableUid,
    },
  });
  res.status(201).json(serializeVocabularyEntry(entry));
});

router.patch('/vocabulary/:entryId', writeLimiter, requireAuth, async (req: Request, res: Response) => {
  const entryId = uuidSchema.parse(req.params['entryId']);
  const body = vocabularyUpdateSchema.parse(req.body);
  const { stableUid } = req.user!;
  const existing = await prisma.learnVocabularyEntry.findUnique({ where: { id: entryId } });
  if (!existing) throw new NotFoundError('Vocabulary entry not found');
  const access = await requireCoursePermission(existing.courseId, stableUid, 'EDIT');
  if (existing.createdBy !== stableUid && !access.isAdmin) {
    throw new ForbiddenError('You can only edit vocabulary entries that you created');
  }

  if (body.sectionId !== undefined && body.sectionId !== null) {
    const section = await prisma.learnCourseSection.findFirst({
      where: { id: body.sectionId, courseId: existing.courseId },
      select: { id: true },
    });
    if (!section) throw new NotFoundError('Vocabulary section not found in this course');
  }

  const entry = await prisma.learnVocabularyEntry.update({
    where: { id: entryId },
    data: {
      ...(body.sectionId !== undefined && { sectionId: body.sectionId }),
      ...(body.sourceLanguage !== undefined && { sourceLanguage: body.sourceLanguage }),
      ...(body.targetLanguage !== undefined && { targetLanguage: body.targetLanguage }),
      ...(body.sourceText !== undefined && {
        sourceText: body.sourceText,
        normalizedSource: normalizeAnswer(body.sourceText),
      }),
      ...(body.targetText !== undefined && {
        targetText: body.targetText,
        normalizedTarget: normalizeAnswer(body.targetText),
      }),
      ...(body.article !== undefined && { article: body.article }),
      ...(body.partOfSpeech !== undefined && { partOfSpeech: body.partOfSpeech }),
      ...(body.notes !== undefined && { notes: body.notes }),
      ...(body.tags !== undefined && { tagsJson: JSON.stringify(body.tags) }),
    },
  });
  res.json(serializeVocabularyEntry(entry));
});

router.delete('/vocabulary/:entryId', writeLimiter, requireAuth, async (req: Request, res: Response) => {
  const entryId = uuidSchema.parse(req.params['entryId']);
  const { stableUid } = req.user!;
  const entry = await prisma.learnVocabularyEntry.findUnique({ where: { id: entryId } });
  if (!entry) throw new NotFoundError('Vocabulary entry not found');
  const access = await requireCoursePermission(entry.courseId, stableUid, 'EDIT');
  if (entry.createdBy !== stableUid && !access.isAdmin) {
    throw new ForbiddenError('You can only delete vocabulary entries that you created');
  }
  await prisma.learnVocabularyEntry.delete({ where: { id: entryId } });
  res.status(204).send();
});

// GET /learn/reviews?courseId=...&scope=DUE|WRONG|NEW
// The response deliberately contains prompts only.  Correct translations are
// fetched and compared inside POST /quiz-attempts, never accepted from a client.
router.get('/reviews', readLimiter, requireAuth, async (req: Request, res: Response) => {
  const query = z.object({
    courseId: uuidSchema.optional(),
    scope: z.enum(['DUE', 'WRONG', 'NEW']).default('DUE'),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  }).parse(req.query);
  const { stableUid } = req.user!;
  await ensureLearnProfile(stableUid, false);

  const courseIds = query.courseId
    ? [query.courseId]
    : await accessibleCourseIds(stableUid);
  if (query.courseId) await requireCoursePermission(query.courseId, stableUid, 'VIEW');
  if (courseIds.length === 0) {
    res.json({ questions: [] });
    return;
  }

  const now = new Date();
  if (query.scope === 'NEW') {
    const entries = await prisma.learnVocabularyEntry.findMany({
      where: { courseId: { in: courseIds }, normalizedTarget: { not: '' }, reviewStates: { none: { stableUid } } },
      orderBy: { createdAt: 'asc' },
      take: query.limit,
      select: { id: true, courseId: true, sourceLanguage: true, targetLanguage: true, sourceText: true },
    });
    res.json({ questions: entries.map((entry) => asReviewQuestion(entry)) });
    return;
  }

  const reviewWhere: Prisma.LearnVocabularyReviewWhereInput = {
    stableUid,
    entry: { courseId: { in: courseIds } },
    ...(query.scope === 'DUE'
      ? { dueAt: { lte: now } }
      : { lastWasCorrect: false, incorrectCount: { gt: 0 } }),
  };
  const reviews = await prisma.learnVocabularyReview.findMany({
    where: reviewWhere,
    orderBy: query.scope === 'DUE' ? { dueAt: 'asc' } : { updatedAt: 'desc' },
    take: query.limit,
    select: {
      dueAt: true,
      correctCount: true,
      incorrectCount: true,
      lastWasCorrect: true,
      entry: { select: { id: true, courseId: true, sourceLanguage: true, targetLanguage: true, sourceText: true } },
    },
  });

  // A normal due queue starts gently even for a newly added course.  A focused
  // WRONG queue contains only words the learner actually missed.
  if (query.scope === 'DUE' && reviews.length < query.limit) {
    const freshEntries = await prisma.learnVocabularyEntry.findMany({
      where: {
        courseId: { in: courseIds },
        normalizedTarget: { not: '' },
        reviewStates: { none: { stableUid } },
      },
      orderBy: { createdAt: 'asc' },
      take: query.limit - reviews.length,
      select: { id: true, courseId: true, sourceLanguage: true, targetLanguage: true, sourceText: true },
    });
    res.json({
      questions: [
        ...reviews.map((review) => asReviewQuestion(review.entry, review)),
        ...freshEntries.map((entry) => asReviewQuestion(entry)),
      ],
    });
    return;
  }

  res.json({ questions: reviews.map((review) => asReviewQuestion(review.entry, review)) });
});

// POST /learn/quiz-attempts — idempotent, server-graded quiz submission.
router.post('/quiz-attempts', writeLimiter, requireAuth, async (req: Request, res: Response) => {
  const body = quizAttemptSchema.parse(req.body);
  const headerKey = req.get('Idempotency-Key')?.trim();
  const idempotencyKey = z.string().trim().min(8).max(191).parse(headerKey || body.idempotencyKey);
  const { stableUid } = req.user!;
  await ensureLearnProfile(stableUid, false);

  const existing = await prisma.learnQuizAttempt.findUnique({
    where: { stableUid_idempotencyKey: { stableUid, idempotencyKey } },
    select: {
      id: true, courseId: true, mode: true, totalQuestions: true, correctAnswers: true, score: true, createdAt: true, answersJson: true,
    },
  });
  if (existing) {
    res.json({ attempt: compactAttempt(existing), idempotent: true, results: storedQuizResults(existing.answersJson) });
    return;
  }

  const access = await requireCoursePermission(body.courseId, stableUid, 'VIEW');
  const enrollment = await prisma.learnEnrollment.findUnique({
    where: { courseId_stableUid: { courseId: body.courseId, stableUid } },
    select: { courseId: true },
  });
  if (!enrollment && !requiresPermission(access.permission, 'EDIT')) {
    throw new ForbiddenError('Add this course before submitting a quiz attempt');
  }

  const entryIds = body.answers.map((answer) => answer.entryId);
  const entries = await prisma.learnVocabularyEntry.findMany({
    where: { id: { in: entryIds }, courseId: body.courseId },
    select: { id: true, sourceText: true, targetText: true },
  });
  if (entries.length !== body.answers.length) {
    throw new NotFoundError('One or more vocabulary entries do not belong to this course');
  }
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const now = new Date();
  const gradedAnswers = body.answers.map((answer) => {
    const entry = entriesById.get(answer.entryId)!;
    const expected = answer.direction === 'SOURCE_TO_TARGET'
      ? entry.targetText
      : entry.sourceText;
    // Grade against the original author text so semicolon-separated approved
    // alternatives remain distinct before each one is normalised.
    const correct = expectedAnswers(expected).includes(normalizeAnswer(answer.answer));
    return {
      entryId: answer.entryId,
      direction: answer.direction,
      answer: answer.answer,
      correct,
      correctAnswer: expected.split(/\s*(?:;|\||\/)\s*/)[0] || expected,
    };
  });
  const correctAnswers = gradedAnswers.filter((answer) => answer.correct).length;
  const score = Math.round((correctAnswers / gradedAnswers.length) * 10000) / 100;

  let attempt;
  try {
    attempt = await prisma.$transaction(async (tx) => {
      // Repeat the idempotency check inside the transaction to make concurrent
      // retries safe as well as ordinary network retries.
      const retry = await tx.learnQuizAttempt.findUnique({
        where: { stableUid_idempotencyKey: { stableUid, idempotencyKey } },
        select: {
          id: true, courseId: true, mode: true, totalQuestions: true, correctAnswers: true, score: true, createdAt: true, answersJson: true,
        },
      });
      if (retry) return retry;

      for (const answer of gradedAnswers) {
        const current = await tx.learnVocabularyReview.findUnique({
          where: { stableUid_entryId: { stableUid, entryId: answer.entryId } },
          select: { intervalDays: true, easeFactor: true, correctCount: true, incorrectCount: true },
        });

        const previousInterval = current?.intervalDays ?? 0;
        const previousEase = current?.easeFactor ?? 2.5;
        const nextInterval = answer.correct
          ? Math.min(90, Math.max(1, previousInterval === 0 ? 1 : Math.round(previousInterval * previousEase)))
          : 0;
        const nextEase = answer.correct
          ? Math.min(3, previousEase + 0.05)
          : Math.max(1.3, previousEase - 0.2);
        const dueAt = answer.correct
          ? new Date(now.getTime() + nextInterval * 24 * 60 * 60 * 1000)
          : now;

        await tx.learnVocabularyReview.upsert({
          where: { stableUid_entryId: { stableUid, entryId: answer.entryId } },
          create: {
            stableUid,
            entryId: answer.entryId,
            intervalDays: nextInterval,
            easeFactor: nextEase,
            dueAt,
            lastReviewedAt: now,
            correctCount: answer.correct ? 1 : 0,
            incorrectCount: answer.correct ? 0 : 1,
            lastWasCorrect: answer.correct,
          },
          update: {
            intervalDays: nextInterval,
            easeFactor: nextEase,
            dueAt,
            lastReviewedAt: now,
            correctCount: { increment: answer.correct ? 1 : 0 },
            incorrectCount: { increment: answer.correct ? 0 : 1 },
            lastWasCorrect: answer.correct,
          },
        });
      }

      return tx.learnQuizAttempt.create({
        data: {
          stableUid,
          courseId: body.courseId,
          mode: body.mode,
          idempotencyKey,
          answersJson: JSON.stringify(gradedAnswers),
          totalQuestions: gradedAnswers.length,
          correctAnswers,
          score,
        },
        select: {
          id: true, courseId: true, mode: true, totalQuestions: true, correctAnswers: true, score: true, createdAt: true,
        },
      });
    });
  } catch (error) {
    // A concurrent request can both pass the preflight check and then collide on
    // the database unique key. Return the original result rather than a 409.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const retry = await prisma.learnQuizAttempt.findUnique({
        where: { stableUid_idempotencyKey: { stableUid, idempotencyKey } },
        select: {
          id: true, courseId: true, mode: true, totalQuestions: true, correctAnswers: true, score: true, createdAt: true, answersJson: true,
        },
      });
      if (retry) {
        res.json({ attempt: compactAttempt(retry), idempotent: true, results: storedQuizResults(retry.answersJson) });
        return;
      }
    }
    throw error;
  }

  res.status(201).json({
    attempt: compactAttempt(attempt),
    idempotent: false,
    results: gradedAnswers.map(({ entryId, direction, correct, correctAnswer }) => ({ entryId, direction, correct, correctAnswer })),
  });
});

// GET /learn/teams — only teams to which the current learner belongs.
router.get('/teams', readLimiter, requireAuth, async (req: Request, res: Response) => {
  const { stableUid } = req.user!;
  await ensureLearnProfile(stableUid, false);
  const teams = await prisma.learnTeam.findMany({
    where: { members: { some: { stableUid } } },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      name: true,
      description: true,
      createdAt: true,
      updatedAt: true,
      members: { where: { stableUid }, select: { role: true, joinedAt: true } },
      _count: { select: { members: true, courses: true } },
    },
  });
  res.json({ teams });
});

router.post('/teams', writeLimiter, requireAuth, async (req: Request, res: Response) => {
  const body = teamCreateSchema.parse(req.body);
  const { stableUid } = req.user!;
  await ensureLearnProfile(stableUid, false);
  const team = await prisma.learnTeam.create({
    data: {
      name: body.name,
      description: body.description,
      createdBy: stableUid,
      members: { create: { stableUid, role: 'OWNER' } },
    },
    include: { members: { where: { stableUid }, select: { role: true, joinedAt: true } } },
  });
  res.status(201).json(team);
});

// Team owners/managers can add an existing POKYH user. There is no anonymous
// invite token in v1, which avoids creating a second unauthenticated identity.
router.post('/teams/:teamId/members', writeLimiter, requireAuth, async (req: Request, res: Response) => {
  const teamId = uuidSchema.parse(req.params['teamId']);
  const body = teamMemberSchema.parse(req.body);
  const { stableUid } = req.user!;
  await requireTeamManager(teamId, stableUid);

  const user = await prisma.user.findFirst({
    where: { OR: [{ stableUid: body.userId }, { username: body.userId }] },
    select: { stableUid: true, username: true },
  });
  if (!user) throw new NotFoundError('POKYH user not found');
  const [member] = await prisma.$transaction([
    prisma.learnTeamMember.upsert({
      where: { teamId_stableUid: { teamId, stableUid: user.stableUid } },
      create: { teamId, stableUid: user.stableUid, role: body.role },
      update: { role: body.role },
    }),
    // Membership itself is durable Learn data, so protect the invited user from
    // a future school-year cleanup even before they open the Learn dashboard.
    prisma.learnProfile.upsert({
      where: { stableUid: user.stableUid },
      create: { stableUid: user.stableUid },
      update: {},
    }),
  ]);
  res.json({ member: { ...member, username: user.username } });
});

// Minimal central-admin grant surface. It deliberately uses the regular POKYH
// JWT plus the Admin table check; no browser-held API secret is introduced.
router.post('/admin/course-access', writeLimiter, requireAuth, async (req: Request, res: Response) => {
  const body = courseAccessSchema.parse(req.body);
  const { stableUid } = req.user!;
  if (!await isLearnAdmin(stableUid)) throw new ForbiddenError('Admin access required');

  const [course, user] = await Promise.all([
    prisma.learnCourse.findUnique({ where: { id: body.courseId }, select: { id: true } }),
    prisma.user.findUnique({ where: { stableUid: body.stableUid }, select: { stableUid: true } }),
  ]);
  if (!course) throw new NotFoundError('Course not found');
  if (!user) throw new NotFoundError('POKYH user not found');

  const [, grant] = await prisma.$transaction([
    // A grant is durable Learn data just like an enrollment; provision the
    // lightweight profile atomically so the annual archiver retains the user.
    prisma.learnProfile.upsert({
      where: { stableUid: body.stableUid },
      create: { stableUid: body.stableUid },
      update: {},
    }),
    prisma.learnCourseAccess.upsert({
      where: { courseId_stableUid: { courseId: body.courseId, stableUid: body.stableUid } },
      create: { courseId: body.courseId, stableUid: body.stableUid, permission: body.permission, grantedBy: stableUid },
      update: { permission: body.permission, grantedBy: stableUid },
    }),
  ]);
  res.json(grant);
});

export { router as learnRouter };
