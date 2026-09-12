import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { prisma } from '../db';
import { optionalAuth, requireAuth } from '../middleware/auth';
import { learnReadLimiter, learnWriteLimiter, readLimiter } from '../middleware/rateLimiter';
import { getDictionarySuggestion } from '../services/learnDictionary';
import { getLearnConfig } from '../services/learnConfig';
import { ForbiddenError, NotFoundError, ValidationError } from '../utils/errors';
import { logger } from '../utils/logger';

const router = Router();

// Structured, DB-independent audit trail for sensitive Learn actions. Never
// pass answer text, vocabulary text, or other learner-authored content here —
// only IDs, counts, and outcomes (see CLAUDE.md's privacy rules).
function learnAudit(req: Request, action: string, details: Record<string, unknown> = {}): void {
  logger.info('learn.audit', {
    action,
    actorStableUid: req.user?.stableUid ?? null,
    requestId: req.id,
    scope: 'learn',
    ...details,
  });
}

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
const courseSlugSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(191);

const courseSectionSchema = z.object({
  title: trimmedText(200),
  summary: optionalTrimmedText(2000).default(''),
  type: sectionTypeSchema.default('LESSON'),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
  content: z.record(z.unknown()).default({}),
});

const createCourseSchema = z.object({
  title: trimmedText(160),
  slug: courseSlugSchema.optional(),
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

const updateCourseSchema = z.object({
  title: trimmedText(160).optional(),
  slug: courseSlugSchema.optional(),
  summary: optionalTrimmedText(2000),
  subject: optionalTrimmedText(120),
  language: optionalTrimmedText(80),
  level: optionalTrimmedText(50),
  visibility: courseVisibilitySchema.optional(),
  status: courseStatusSchema.optional(),
  coverImageUrl: z.string().trim().url().max(1000).or(z.literal('')).optional(),
  teamId: uuidSchema.nullable().optional(),
}).refine((body) => Object.keys(body).length > 0, {
  message: 'At least one course field is required',
});

const sectionCreateSchema = z.object({
  title: trimmedText(200),
  summary: optionalTrimmedText(2000).default(''),
  type: sectionTypeSchema.default('LESSON'),
  content: z.record(z.unknown()).default({}),
});

const sectionUpdateSchema = z.object({
  title: trimmedText(200).optional(),
  summary: optionalTrimmedText(2000),
  type: sectionTypeSchema.optional(),
  content: z.record(z.unknown()).optional(),
}).refine((body) => Object.keys(body).length > 0, {
  message: 'At least one section field is required',
});

const sectionOrderSchema = z.object({
  sectionIds: z.array(uuidSchema).min(1).max(100),
}).superRefine((body, ctx) => {
  if (new Set(body.sectionIds).size !== body.sectionIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sectionIds'], message: 'Section IDs must be unique' });
  }
});

const profileSchema = z.object({
  dailyGoalMinutes: z.number().int().min(1).max(24 * 60).optional(),
  timezone: z.string().trim().max(80).optional(),
  locale: z.enum(['de', 'en', 'it']).optional(),
  theme: z.enum(['light', 'dark', 'system']).optional(),
}).refine((body) => Object.keys(body).length > 0, {
  message: 'At least one profile field is required',
});

const progressSchema = z.object({
  // Completion itself is recorded through an explicit section endpoint below.
  // Keep this route only for the learner-controlled pause/continue state.
  status: z.enum(['ACTIVE', 'PAUSED']).optional(),
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

const vocabularyLookupSchema = z.object({
  courseId: uuidSchema,
  sourceLanguage: trimmedText(20),
  targetLanguage: trimmedText(20),
  sourceText: trimmedText(500),
});

const adminCourseDeleteSchema = z.object({
  confirmation: trimmedText(191),
});

const personalImportReviewSchema = z.object({
  intervalDays: z.number().int().min(0).max(90),
  easeFactor: z.number().min(1.3).max(3),
  dueAt: z.coerce.date(),
  correctCount: z.number().int().min(0).max(1_000_000),
  incorrectCount: z.number().int().min(0).max(1_000_000),
  lastWasCorrect: z.boolean(),
}).strict();

const personalImportVocabularySchema = z.object({
  sourceRef: uuidSchema,
  sectionRef: uuidSchema.nullable().optional().default(null),
  sourceLanguage: trimmedText(20),
  targetLanguage: z.string().trim().max(20).default(''),
  sourceText: trimmedText(500),
  targetText: z.string().trim().max(500).default(''),
  article: z.string().trim().max(40).default(''),
  partOfSpeech: z.string().trim().max(80).default(''),
  notes: z.string().trim().max(2000).default(''),
  tags: z.array(z.string().trim().min(1).max(80)).max(25).default([]),
  review: personalImportReviewSchema.nullable().optional().default(null),
}).strict();

const personalImportSectionSchema = z.object({
  sourceRef: uuidSchema,
  title: trimmedText(200),
  summary: z.string().trim().max(2000).default(''),
  type: sectionTypeSchema.default('LESSON'),
  content: z.record(z.unknown()).default({}),
}).strict();

const personalImportEnrollmentSchema = z.object({
  status: z.enum(['ACTIVE', 'PAUSED', 'COMPLETED']).default('ACTIVE'),
  progressPercent: z.number().min(0).max(100).default(0),
  completedSections: z.number().int().min(0).max(100_000).default(0),
}).strict();

// Parameterized on the live import limits (admin-editable via
// /api/admin/learn-config, see src/services/learnConfig.ts) so a schema built
// per-request always enforces whatever an admin has configured right now.
function buildPersonalImportCourseSchema(limits: { maxSectionsPerCourse: number; maxVocabularyPerCourse: number }) {
  return z.object({
    sourceRef: uuidSchema,
    title: trimmedText(160),
    summary: z.string().trim().max(2000).default(''),
    subject: z.string().trim().max(120).default(''),
    language: z.string().trim().max(80).default(''),
    level: z.string().trim().max(50).default(''),
    coverImageUrl: z.string().trim().url().max(1000).or(z.literal('')).default(''),
    sections: z.array(personalImportSectionSchema).max(limits.maxSectionsPerCourse).default([]),
    completedSectionRefs: z.array(uuidSchema).max(limits.maxSectionsPerCourse).default([]),
    vocabulary: z.array(personalImportVocabularySchema).max(limits.maxVocabularyPerCourse).default([]),
    enrollment: personalImportEnrollmentSchema.nullable().optional().default(null),
  }).strict();
}

function buildPersonalImportSchema(limits: { maxCourses: number; maxSectionsPerCourse: number; maxVocabularyPerCourse: number }) {
  return z.object({
    kind: z.literal('pokyh-learn-personal-export'),
    version: z.literal(1),
    exportedAt: z.string().trim().max(64).optional(),
    profile: z.object({
      dailyGoalMinutes: z.number().int().min(1).max(24 * 60),
      timezone: z.string().trim().max(80),
      locale: z.enum(['de', 'en', 'it']).optional(),
      theme: z.enum(['light', 'dark', 'system']).optional(),
    }).strict().optional(),
    courses: z.array(buildPersonalImportCourseSchema(limits)).max(limits.maxCourses),
  }).strict();
}

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
  // Administrators may use the visible POKYH username or the canonical stable
  // UID. The server resolves either input before writing an access record.
  userId: trimmedText(100),
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

async function requireLearnAdmin(stableUid: string): Promise<void> {
  await ensureLearnProfile(stableUid, false);
  if (!await isLearnAdmin(stableUid)) throw new ForbiddenError('Admin access required');
}

async function ensureLearnProfile(stableUid: string, touch = true) {
  const user = await prisma.user.findUnique({
    where: { stableUid },
    select: { stableUid: true, username: true, role: true, isUntisUser: true },
  });
  if (!user) throw new NotFoundError('POKYH user not found');
  // Learn intentionally shares only verified WebUntis-backed POKYH identities.
  // Local fallback accounts may keep using existing POKYH features but cannot
  // create a second identity universe or access learning records.
  if (!user.isUntisUser) {
    throw new ForbiddenError('Pokyh Learn requires a verified WebUntis account');
  }

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
  await ensureLearnProfile(stableUid, false);
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

function completionProgress(totalSections: number, completedSections: number) {
  const completed = Math.min(Math.max(0, completedSections), totalSections);
  return {
    completedSections: completed,
    progressPercent: totalSections > 0 ? Math.round((completed / totalSections) * 100) : 0,
    isComplete: totalSections > 0 && completed >= totalSections,
  };
}

async function refreshEnrollmentProgress(
  tx: Prisma.TransactionClient,
  courseId: string,
  stableUid: string,
  requestedStatus?: 'ACTIVE' | 'PAUSED',
) {
  const [enrollment, totalSections, completedSections] = await Promise.all([
    tx.learnEnrollment.findUnique({
      where: { courseId_stableUid: { courseId, stableUid } },
      select: { courseId: true, status: true, completedAt: true },
    }),
    tx.learnCourseSection.count({ where: { courseId } }),
    tx.learnSectionCompletion.count({ where: { courseId, stableUid } }),
  ]);
  if (!enrollment) throw new NotFoundError('Add this course before updating progress');
  const progress = completionProgress(totalSections, completedSections);
  const status = progress.isComplete
    ? 'COMPLETED'
    : requestedStatus === 'PAUSED'
      ? 'PAUSED'
      : 'ACTIVE';
  return tx.learnEnrollment.update({
    where: { courseId_stableUid: { courseId, stableUid } },
    data: {
      status,
      progressPercent: progress.progressPercent,
      completedSections: progress.completedSections,
      completedAt: status === 'COMPLETED' ? enrollment.completedAt ?? new Date() : null,
      lastOpenedAt: new Date(),
    },
  });
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

// Import/export only accepts a JSON object for authored section content. Older
// records may contain another valid JSON shape, so normalize them at the
// boundary instead of generating an export that cannot be imported again.
function safeContentObject(raw: string): Record<string, unknown> {
  const value = safeJsonValue(raw);
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
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
  createdBy?: string;
}>(entry: T) {
  // Target text and normalized answer keys never leave the vocabulary-list
  // endpoint. This prevents a list view from leaking answers before a quiz.
  const {
    tagsJson,
    normalizedSource: _normalizedSource,
    normalizedTarget,
    targetText: _targetText,
    createdBy: _createdBy,
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
router.get('/me', requireAuth, learnReadLimiter, async (req: Request, res: Response) => {
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

router.patch('/me', requireAuth, learnWriteLimiter, async (req: Request, res: Response) => {
  const { stableUid } = req.user!;
  await ensureLearnProfile(stableUid, false);
  const body = profileSchema.parse(req.body);
  const profile = await prisma.learnProfile.update({
    where: { stableUid },
    data: {
      ...(body.dailyGoalMinutes !== undefined && { dailyGoalMinutes: body.dailyGoalMinutes }),
      ...(body.timezone !== undefined && { timezone: body.timezone }),
      ...(body.locale !== undefined && { locale: body.locale }),
      ...(body.theme !== undefined && { theme: body.theme }),
      lastActiveAt: new Date(),
    },
  });
  res.json(profile);
});

// GET /learn/dashboard — a compact server-side snapshot for the learner home.
router.get('/dashboard', requireAuth, learnReadLimiter, async (req: Request, res: Response) => {
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
router.get('/courses', requireAuth, learnReadLimiter, async (req: Request, res: Response) => {
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
      createdBy: true,
      updatedAt: true,
      _count: { select: { sections: true, vocabulary: true } },
      accessGrants: {
        where: { stableUid },
        select: { permission: true },
      },
      team: {
        select: {
          members: {
            where: { stableUid },
            select: { role: true },
          },
        },
      },
      enrollments: {
        where: { stableUid },
        select: { status: true, progressPercent: true, completedSections: true, lastOpenedAt: true },
      },
    },
  });
  res.json({
    courses: courses.map(({ accessGrants, team, createdBy, ...course }) => {
      let permission: CoursePermission = isAdmin || createdBy === stableUid ? 'MANAGE' : 'NONE';
      permission = strongestPermission(permission, permissionFromGrant(accessGrants[0]?.permission));
      if (team?.members[0]) permission = strongestPermission(permission, 'VIEW');
      if (course.enrollments.length > 0) permission = strongestPermission(permission, 'VIEW');
      return {
        ...course,
        permissions: {
          canEdit: requiresPermission(permission, 'EDIT'),
          canManage: requiresPermission(permission, 'MANAGE'),
        },
      };
    }),
  });
});

// POST /learn/courses — users may make a personal course, a public catalog
// course, or a team course that they manage.  The caller owns the new course.
router.post('/courses', requireAuth, learnWriteLimiter, async (req: Request, res: Response) => {
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
  learnAudit(req, 'course_created', { courseId: course.id, status: course.status, visibility: course.visibility });
  res.status(201).json({ ...course, sections: course.sections.map(serializeSection) });
});

// PATCH /learn/courses/:courseId — course managers can maintain their own
// content lifecycle. Publishing a draft remains an explicit platform-admin
// decision; an already published course can still receive authored updates.
router.patch('/courses/:courseId', requireAuth, learnWriteLimiter, async (req: Request, res: Response) => {
  const courseId = uuidSchema.parse(req.params['courseId']);
  const body = updateCourseSchema.parse(req.body);
  const { stableUid } = req.user!;
  const access = await requireCoursePermission(courseId, stableUid, 'MANAGE');
  const existing = await prisma.learnCourse.findUnique({
    where: { id: courseId },
    select: { id: true, visibility: true, status: true, teamId: true },
  });
  if (!existing) throw new NotFoundError('Course not found');

  const visibility = body.visibility ?? existing.visibility;
  let teamId = body.teamId !== undefined ? body.teamId : existing.teamId;
  if (visibility === 'TEAM') {
    if (!teamId) throw new ValidationError('A TEAM course requires a teamId');
    await requireTeamManager(teamId, stableUid);
  } else {
    // A non-team course cannot retain a stale team relation.
    teamId = null;
  }

  if (body.status === 'PUBLISHED' && existing.status !== 'PUBLISHED' && !access.isAdmin) {
    throw new ForbiddenError('Only a Pokyh administrator can publish a course');
  }

  const course = await prisma.learnCourse.update({
    where: { id: courseId },
    data: {
      ...(body.title !== undefined && { title: body.title }),
      ...(body.slug !== undefined && { slug: body.slug }),
      ...(body.summary !== undefined && { summary: body.summary }),
      ...(body.subject !== undefined && { subject: body.subject }),
      ...(body.language !== undefined && { language: body.language }),
      ...(body.level !== undefined && { level: body.level }),
      ...(body.coverImageUrl !== undefined && { coverImageUrl: body.coverImageUrl }),
      ...(body.status !== undefined && { status: body.status }),
      visibility,
      teamId,
    },
    include: { sections: { orderBy: { sortOrder: 'asc' } } },
  });
  if (body.status === 'PUBLISHED' && existing.status !== 'PUBLISHED') {
    learnAudit(req, 'course_published', { courseId: course.id });
  }
  learnAudit(req, 'course_updated', { courseId: course.id, status: course.status, visibility: course.visibility });
  res.json({ ...course, sections: course.sections.map(serializeSection) });
});

// Course editors can create and maintain authored sections. A concise
// structured JSON document is kept server-side and rendered as safe text by
// the web client; arbitrary HTML is never executed.
router.post('/courses/:courseId/sections', requireAuth, learnWriteLimiter, async (req: Request, res: Response) => {
  const courseId = uuidSchema.parse(req.params['courseId']);
  const body = sectionCreateSchema.parse(req.body);
  const { stableUid } = req.user!;
  await requireCoursePermission(courseId, stableUid, 'EDIT');

  const [sectionCount, lastSection] = await Promise.all([
    prisma.learnCourseSection.count({ where: { courseId } }),
    prisma.learnCourseSection.findFirst({
      where: { courseId },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    }),
  ]);
  if (sectionCount >= 100) throw new ValidationError('A course can contain at most 100 sections');

  const section = await prisma.learnCourseSection.create({
    data: {
      courseId,
      title: body.title,
      summary: body.summary,
      type: body.type,
      sortOrder: (lastSection?.sortOrder ?? -1) + 1,
      contentJson: JSON.stringify(body.content),
    },
  });
  res.status(201).json(serializeSection(section));
});

router.patch('/courses/:courseId/sections/:sectionId', requireAuth, learnWriteLimiter, async (req: Request, res: Response) => {
  const courseId = uuidSchema.parse(req.params['courseId']);
  const sectionId = uuidSchema.parse(req.params['sectionId']);
  const body = sectionUpdateSchema.parse(req.body);
  const { stableUid } = req.user!;
  await requireCoursePermission(courseId, stableUid, 'EDIT');

  const existing = await prisma.learnCourseSection.findFirst({
    where: { id: sectionId, courseId },
    select: { id: true },
  });
  if (!existing) throw new NotFoundError('Course section not found');

  const section = await prisma.learnCourseSection.update({
    where: { id: sectionId },
    data: {
      ...(body.title !== undefined && { title: body.title }),
      ...(body.summary !== undefined && { summary: body.summary }),
      ...(body.type !== undefined && { type: body.type }),
      ...(body.content !== undefined && { contentJson: JSON.stringify(body.content) }),
    },
  });
  res.json(serializeSection(section));
});

// Reordering accepts the complete section set. We temporarily move every
// record out of the unique [courseId, sortOrder] range before assigning the
// new compact order, so the operation remains atomic and collision-free.
router.post('/courses/:courseId/sections/reorder', requireAuth, learnWriteLimiter, async (req: Request, res: Response) => {
  const courseId = uuidSchema.parse(req.params['courseId']);
  const body = sectionOrderSchema.parse(req.body);
  const { stableUid } = req.user!;
  await requireCoursePermission(courseId, stableUid, 'EDIT');

  const sections = await prisma.learnCourseSection.findMany({
    where: { courseId },
    select: { id: true },
  });
  const knownIds = new Set(sections.map((section) => section.id));
  if (sections.length !== body.sectionIds.length || body.sectionIds.some((id) => !knownIds.has(id))) {
    throw new ValidationError('Section order must contain every section in this course exactly once');
  }

  const reordered = await prisma.$transaction(async (tx) => {
    await tx.learnCourseSection.updateMany({
      where: { courseId },
      data: { sortOrder: { increment: 1_000_000 } },
    });
    await Promise.all(body.sectionIds.map((id, sortOrder) => tx.learnCourseSection.update({
      where: { id },
      data: { sortOrder },
    })));
    return tx.learnCourseSection.findMany({
      where: { courseId },
      orderBy: { sortOrder: 'asc' },
    });
  });
  res.json({ sections: reordered.map(serializeSection) });
});

// Removing course material also removes its direct content link. Associated
// vocabulary remains retained with a null section reference, so an author
// cannot accidentally erase learning history by reshaping the course path.
router.delete('/courses/:courseId/sections/:sectionId', requireAuth, learnWriteLimiter, async (req: Request, res: Response) => {
  const courseId = uuidSchema.parse(req.params['courseId']);
  const sectionId = uuidSchema.parse(req.params['sectionId']);
  const { stableUid } = req.user!;
  await requireCoursePermission(courseId, stableUid, 'MANAGE');

  const section = await prisma.learnCourseSection.findFirst({
    where: { id: sectionId, courseId },
    select: { id: true },
  });
  if (!section) throw new NotFoundError('Course section not found');
  await prisma.learnCourseSection.delete({ where: { id: sectionId } });
  res.status(204).send();
});

// A personal export is intentionally narrower than the legacy database backup:
// it contains only the caller's own courses, own vocabulary, and own review
// state. It cannot disclose team membership, grants, credentials, or another
// person's contributions.
router.get('/library/export', requireAuth, learnReadLimiter, async (req: Request, res: Response) => {
  const { stableUid } = req.user!;
  const { profile } = await ensureLearnProfile(stableUid, false);
  const courses = await prisma.learnCourse.findMany({
    where: { createdBy: stableUid },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      title: true,
      summary: true,
      subject: true,
      language: true,
      level: true,
      coverImageUrl: true,
      sections: {
        orderBy: { sortOrder: 'asc' },
        select: { id: true, title: true, summary: true, type: true, contentJson: true },
      },
      vocabulary: {
        where: { createdBy: stableUid },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          sectionId: true,
          sourceLanguage: true,
          targetLanguage: true,
          sourceText: true,
          targetText: true,
          article: true,
          partOfSpeech: true,
          notes: true,
          tagsJson: true,
          reviewStates: {
            where: { stableUid },
            select: { intervalDays: true, easeFactor: true, dueAt: true, correctCount: true, incorrectCount: true, lastWasCorrect: true },
          },
        },
      },
      enrollments: {
        where: { stableUid },
        select: { status: true, progressPercent: true, completedSections: true },
      },
      sectionCompletions: {
        where: { stableUid },
        select: { sectionId: true },
      },
    },
  });

  res.setHeader('Cache-Control', 'private, no-store');
  res.json({
    kind: 'pokyh-learn-personal-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    profile: {
      dailyGoalMinutes: profile.dailyGoalMinutes,
      timezone: profile.timezone,
      locale: profile.locale,
      theme: profile.theme,
    },
    courses: courses.map((course) => ({
      sourceRef: course.id,
      title: course.title,
      summary: course.summary,
      subject: course.subject,
      language: course.language,
      level: course.level,
      coverImageUrl: course.coverImageUrl,
      sections: course.sections.map((section) => ({
        sourceRef: section.id,
        title: section.title,
        summary: section.summary,
        type: section.type,
        content: safeContentObject(section.contentJson),
      })),
      completedSectionRefs: course.sectionCompletions.map((completion) => completion.sectionId),
      vocabulary: course.vocabulary.map((entry) => ({
        sourceRef: entry.id,
        sectionRef: entry.sectionId,
        sourceLanguage: entry.sourceLanguage,
        targetLanguage: entry.targetLanguage,
        sourceText: entry.sourceText,
        targetText: entry.targetText,
        article: entry.article,
        partOfSpeech: entry.partOfSpeech,
        notes: entry.notes,
        tags: safeStringArray(entry.tagsJson),
        review: entry.reviewStates[0] ?? null,
      })),
      enrollment: course.enrollments[0] ?? null,
    })),
  });
});

// Import never overwrites records. It recreates a private draft owned by the
// caller, remaps every identifier, and intentionally excludes publication,
// teams, grants, roles, credentials, and arbitrary user references.
router.post('/library/import', requireAuth, learnWriteLimiter, async (req: Request, res: Response) => {
  const learnCfg = await getLearnConfig();
  const body = buildPersonalImportSchema({
    maxCourses: learnCfg.importMaxCourses,
    maxSectionsPerCourse: learnCfg.importMaxSectionsPerCourse,
    maxVocabularyPerCourse: learnCfg.importMaxVocabularyPerCourse,
  }).parse(req.body);
  const { stableUid } = req.user!;
  await ensureLearnProfile(stableUid, false);

  const courseRefs = new Set<string>();
  for (const course of body.courses) {
    if (courseRefs.has(course.sourceRef)) throw new ValidationError('Imported course references must be unique');
    courseRefs.add(course.sourceRef);
    const sectionRefs = new Set<string>();
    const vocabularyRefs = new Set<string>();
    for (const section of course.sections) {
      if (sectionRefs.has(section.sourceRef)) throw new ValidationError('Imported section references must be unique per course');
      sectionRefs.add(section.sourceRef);
    }
    if (new Set(course.completedSectionRefs).size !== course.completedSectionRefs.length
      || course.completedSectionRefs.some((sectionRef) => !sectionRefs.has(sectionRef))) {
      throw new ValidationError('Imported completed-section references must match this course');
    }
    for (const entry of course.vocabulary) {
      if (vocabularyRefs.has(entry.sourceRef)) throw new ValidationError('Imported vocabulary references must be unique per course');
      vocabularyRefs.add(entry.sourceRef);
      if (entry.sectionRef && !sectionRefs.has(entry.sectionRef)) {
        throw new ValidationError('Imported vocabulary references an unknown section');
      }
    }
  }

  const result = await prisma.$transaction(async (tx) => {
    if (body.profile) {
      await tx.learnProfile.update({
        where: { stableUid },
        data: {
          dailyGoalMinutes: body.profile.dailyGoalMinutes,
          timezone: body.profile.timezone,
          ...(body.profile.locale !== undefined && { locale: body.profile.locale }),
          ...(body.profile.theme !== undefined && { theme: body.profile.theme }),
          lastActiveAt: new Date(),
        },
      });
    }

    let sectionCount = 0;
    let vocabularyCount = 0;
    const courses = [] as Array<{ id: string; slug: string; title: string }>;
    for (const sourceCourse of body.courses) {
      const course = await tx.learnCourse.create({
        data: {
          slug: createSlug(sourceCourse.title),
          title: sourceCourse.title,
          summary: sourceCourse.summary,
          subject: sourceCourse.subject,
          language: sourceCourse.language,
          level: sourceCourse.level,
          coverImageUrl: sourceCourse.coverImageUrl,
          visibility: 'PRIVATE',
          status: 'DRAFT',
          createdBy: stableUid,
        },
        select: { id: true, slug: true, title: true },
      });
      courses.push(course);

      const sectionIds = new Map<string, string>();
      for (const [sortOrder, sourceSection] of sourceCourse.sections.entries()) {
        const section = await tx.learnCourseSection.create({
          data: {
            courseId: course.id,
            title: sourceSection.title,
            summary: sourceSection.summary,
            type: sourceSection.type,
            sortOrder,
            contentJson: JSON.stringify(sourceSection.content),
          },
          select: { id: true },
        });
        sectionIds.set(sourceSection.sourceRef, section.id);
        sectionCount++;
      }

      for (const sourceSectionRef of sourceCourse.completedSectionRefs) {
        const sectionId = sectionIds.get(sourceSectionRef);
        if (!sectionId) throw new ValidationError('Imported completed-section reference could not be resolved');
        await tx.learnSectionCompletion.create({ data: { stableUid, courseId: course.id, sectionId } });
      }

      for (const sourceEntry of sourceCourse.vocabulary) {
        const entry = await tx.learnVocabularyEntry.create({
          data: {
            courseId: course.id,
            sectionId: sourceEntry.sectionRef ? sectionIds.get(sourceEntry.sectionRef) ?? null : null,
            sourceLanguage: sourceEntry.sourceLanguage,
            targetLanguage: sourceEntry.targetLanguage,
            sourceText: sourceEntry.sourceText,
            targetText: sourceEntry.targetText,
            normalizedSource: normalizeAnswer(sourceEntry.sourceText),
            normalizedTarget: normalizeAnswer(sourceEntry.targetText),
            article: sourceEntry.article,
            partOfSpeech: sourceEntry.partOfSpeech,
            notes: sourceEntry.notes,
            tagsJson: JSON.stringify(sourceEntry.tags),
            verificationStatus: 'UNVERIFIED',
            verificationSource: 'personal-import',
            createdBy: stableUid,
          },
          select: { id: true },
        });
        vocabularyCount++;
        if (sourceEntry.review) {
          await tx.learnVocabularyReview.create({
            data: {
              stableUid,
              entryId: entry.id,
              intervalDays: sourceEntry.review.intervalDays,
              easeFactor: sourceEntry.review.easeFactor,
              dueAt: sourceEntry.review.dueAt,
              correctCount: sourceEntry.review.correctCount,
              incorrectCount: sourceEntry.review.incorrectCount,
              lastWasCorrect: sourceEntry.review.lastWasCorrect,
              lastReviewedAt: new Date(),
            },
          });
        }
      }

      if (sourceCourse.enrollment) {
        const importedProgress = completionProgress(sourceCourse.sections.length, sourceCourse.completedSectionRefs.length);
        await tx.learnEnrollment.create({
          data: {
            courseId: course.id,
            stableUid,
            status: importedProgress.isComplete ? 'COMPLETED' : sourceCourse.enrollment.status === 'PAUSED' ? 'PAUSED' : 'ACTIVE',
            progressPercent: importedProgress.progressPercent,
            completedSections: importedProgress.completedSections,
            completedAt: importedProgress.isComplete ? new Date() : null,
            lastOpenedAt: new Date(),
          },
        });
      }
    }
    return { courses, sectionCount, vocabularyCount };
  });
  learnAudit(req, 'library_imported', {
    courseCount: result.courses.length,
    sectionCount: result.sectionCount,
    vocabularyCount: result.vocabularyCount,
  });
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(201).json({ imported: result });
});

// GET /learn/courses/:courseId — public courses remain readable without a JWT;
// private/team courses require an existing POKYH session and appropriate access.
router.get('/courses/:courseId', readLimiter, optionalAuth, async (req: Request, res: Response) => {
  const courseId = uuidSchema.parse(req.params['courseId']);
  const stableUid = req.user?.stableUid;
  if (stableUid) await ensureLearnProfile(stableUid, false);
  const access = await resolveCourseAccess(courseId, stableUid);
  if (!requiresPermission(access.permission, 'VIEW')) throw new NotFoundError('Course not found');

  const [course, enrollment, completionCount] = await Promise.all([
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
    stableUid
      ? prisma.learnSectionCompletion.count({ where: { courseId, stableUid } })
      : Promise.resolve(0),
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
  const derivedProgress = enrollment ? completionProgress(sections.length, completionCount) : null;
  const resolvedEnrollment = enrollment && derivedProgress
    ? {
      ...enrollment,
      completedSections: derivedProgress.completedSections,
      progressPercent: derivedProgress.progressPercent,
      status: derivedProgress.isComplete ? 'COMPLETED' : enrollment.status === 'PAUSED' ? 'PAUSED' : 'ACTIVE',
    }
    : enrollment;
  res.json({
    course: { ...courseFields, sections: sections.map(serializeSection) },
    enrollment: resolvedEnrollment,
    permissions: { canEdit: requiresPermission(access.permission, 'EDIT'), canManage: requiresPermission(access.permission, 'MANAGE') },
  });
});

// POST /learn/courses/:courseId/enroll — adding a course to the learner's list.
router.post('/courses/:courseId/enroll', requireAuth, learnWriteLimiter, async (req: Request, res: Response) => {
  const courseId = uuidSchema.parse(req.params['courseId']);
  const { stableUid } = req.user!;
  await ensureLearnProfile(stableUid, false);
  const access = await requireCoursePermission(courseId, stableUid, 'VIEW');
  if (access.course.status === 'ARCHIVED') {
    throw new ForbiddenError('Archived courses cannot accept enrollments');
  }

  const enrollment = await prisma.learnEnrollment.upsert({
    where: { courseId_stableUid: { courseId, stableUid } },
    create: { courseId, stableUid, status: 'ACTIVE', lastOpenedAt: new Date() },
    update: { status: 'ACTIVE', lastOpenedAt: new Date(), completedAt: null },
  });
  learnAudit(req, 'course_enrolled', { courseId });
  res.json(enrollment);
});

// PATCH /learn/courses/:courseId/progress — retained for pause/continue only.
// Completion percentage is derived from explicit server-side section records.
router.patch('/courses/:courseId/progress', requireAuth, learnWriteLimiter, async (req: Request, res: Response) => {
  const courseId = uuidSchema.parse(req.params['courseId']);
  const body = progressSchema.parse(req.body);
  const { stableUid } = req.user!;
  await requireCoursePermission(courseId, stableUid, 'VIEW');
  const updated = await prisma.$transaction((tx) => refreshEnrollmentProgress(tx, courseId, stableUid, body.status));
  res.json(updated);
});

// A learner explicitly marks a real section as complete. The unique
// [stableUid, sectionId] record makes retries idempotent and the enrollment
// roll-up stays wholly server-derived.
router.post('/courses/:courseId/sections/:sectionId/complete', requireAuth, learnWriteLimiter, async (req: Request, res: Response) => {
  const courseId = uuidSchema.parse(req.params['courseId']);
  const sectionId = uuidSchema.parse(req.params['sectionId']);
  const { stableUid } = req.user!;
  await requireCoursePermission(courseId, stableUid, 'VIEW');

  const updated = await prisma.$transaction(async (tx) => {
    const section = await tx.learnCourseSection.findFirst({
      where: { id: sectionId, courseId },
      select: { id: true },
    });
    if (!section) throw new NotFoundError('Course section not found');
    await tx.learnSectionCompletion.upsert({
      where: { stableUid_sectionId: { stableUid, sectionId } },
      create: { stableUid, courseId, sectionId },
      update: {},
    });
    return refreshEnrollmentProgress(tx, courseId, stableUid);
  });
  res.json(updated);
});

// GET /learn/vocabulary?courseId=...&sectionId=...
router.get('/vocabulary', requireAuth, learnReadLimiter, async (req: Request, res: Response) => {
  const query = z.object({
    courseId: uuidSchema,
    sectionId: uuidSchema.optional(),
    limit: z.coerce.number().int().min(1).max(250).default(100),
  }).parse(req.query);
  const { stableUid } = req.user!;
  const access = await requireCoursePermission(query.courseId, stableUid, 'VIEW');

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
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({
    entries: entries.map((entry) => ({
      ...serializeVocabularyEntry(entry),
      canEdit: entry.createdBy === stableUid || access.isAdmin || requiresPermission(access.permission, 'MANAGE'),
    })),
  });
});

// POST /learn/vocabulary — EDIT is enough to contribute, but ownership stays
// with the submitting user for all later changes.
router.post('/vocabulary', requireAuth, learnWriteLimiter, async (req: Request, res: Response) => {
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
  learnAudit(req, 'vocabulary_created', { entryId: entry.id, courseId: entry.courseId });
  res.status(201).json(serializeVocabularyEntry(entry));
});

// An editor explicitly asks the configured provider for a suggestion. This is
// not called in the background, never exposes provider credentials, and never
// turns an external response into a quiz answer without an author's save.
router.post('/vocabulary/lookup', requireAuth, learnWriteLimiter, async (req: Request, res: Response) => {
  const body = vocabularyLookupSchema.parse(req.body);
  const { stableUid } = req.user!;
  await requireCoursePermission(body.courseId, stableUid, 'EDIT');
  const suggestion = await getDictionarySuggestion(body);
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ suggestion });
});

// Verifying compares a saved editorial answer with an optional configured
// dictionary suggestion. The author answer remains the only grading authority.
router.post('/vocabulary/:entryId/verify', requireAuth, learnWriteLimiter, async (req: Request, res: Response) => {
  const entryId = uuidSchema.parse(req.params['entryId']);
  const { stableUid } = req.user!;
  const existing = await prisma.learnVocabularyEntry.findUnique({ where: { id: entryId } });
  if (!existing) throw new NotFoundError('Vocabulary entry not found');
  const access = await requireCoursePermission(existing.courseId, stableUid, 'EDIT');
  if (existing.createdBy !== stableUid && !access.isAdmin && !requiresPermission(access.permission, 'MANAGE')) {
    throw new ForbiddenError('You can only verify vocabulary entries that you can manage');
  }
  if (!existing.normalizedTarget) {
    throw new ValidationError('Add an editorial quiz answer before requesting verification');
  }

  const suggestion = await getDictionarySuggestion({
    sourceText: existing.sourceText,
    sourceLanguage: existing.sourceLanguage,
    targetLanguage: existing.targetLanguage,
  });
  const matches = expectedAnswers(existing.targetText).includes(normalizeAnswer(suggestion.translation));
  const entry = await prisma.learnVocabularyEntry.update({
    where: { id: entryId },
    data: {
      verificationStatus: matches ? 'VERIFIED' : 'FLAGGED',
      verificationSource: suggestion.provider,
    },
  });
  learnAudit(req, 'vocabulary_verified', { entryId: entry.id, courseId: entry.courseId, matches, provider: suggestion.provider });
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ entry: serializeVocabularyEntry(entry), verification: { matches, suggestion } });
});

router.patch('/vocabulary/:entryId', requireAuth, learnWriteLimiter, async (req: Request, res: Response) => {
  const entryId = uuidSchema.parse(req.params['entryId']);
  const body = vocabularyUpdateSchema.parse(req.body);
  const { stableUid } = req.user!;
  const existing = await prisma.learnVocabularyEntry.findUnique({ where: { id: entryId } });
  if (!existing) throw new NotFoundError('Vocabulary entry not found');
  const access = await requireCoursePermission(existing.courseId, stableUid, 'EDIT');
  if (existing.createdBy !== stableUid && !access.isAdmin && !requiresPermission(access.permission, 'MANAGE')) {
    throw new ForbiddenError('You can only edit vocabulary entries that you created or manage');
  }

  if (body.sectionId !== undefined && body.sectionId !== null) {
    const section = await prisma.learnCourseSection.findFirst({
      where: { id: body.sectionId, courseId: existing.courseId },
      select: { id: true },
    });
    if (!section) throw new NotFoundError('Vocabulary section not found in this course');
  }

  const answerInputsChanged = body.sourceLanguage !== undefined
    || body.targetLanguage !== undefined
    || body.sourceText !== undefined
    || body.targetText !== undefined;

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
      ...(answerInputsChanged && { verificationStatus: 'UNVERIFIED', verificationSource: '' }),
    },
  });
  learnAudit(req, 'vocabulary_updated', { entryId: entry.id, courseId: entry.courseId });
  res.json(serializeVocabularyEntry(entry));
});

router.delete('/vocabulary/:entryId', requireAuth, learnWriteLimiter, async (req: Request, res: Response) => {
  const entryId = uuidSchema.parse(req.params['entryId']);
  const { stableUid } = req.user!;
  const entry = await prisma.learnVocabularyEntry.findUnique({ where: { id: entryId } });
  if (!entry) throw new NotFoundError('Vocabulary entry not found');
  const access = await requireCoursePermission(entry.courseId, stableUid, 'EDIT');
  if (entry.createdBy !== stableUid && !access.isAdmin && !requiresPermission(access.permission, 'MANAGE')) {
    throw new ForbiddenError('You can only delete vocabulary entries that you created or manage');
  }
  await prisma.learnVocabularyEntry.delete({ where: { id: entryId } });
  learnAudit(req, 'vocabulary_deleted', { entryId, courseId: entry.courseId });
  res.status(204).send();
});

// GET /learn/reviews?courseId=...&scope=DUE|WRONG|NEW
// The response deliberately contains prompts only.  Correct translations are
// fetched and compared inside POST /quiz-attempts, never accepted from a client.
router.get('/reviews', requireAuth, learnReadLimiter, async (req: Request, res: Response) => {
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
    entry: { courseId: { in: courseIds }, normalizedTarget: { not: '' } },
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
router.post('/quiz-attempts', requireAuth, learnWriteLimiter, async (req: Request, res: Response) => {
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
    select: { id: true, sourceText: true, targetText: true, normalizedTarget: true },
  });
  if (entries.length !== body.answers.length) {
    throw new NotFoundError('One or more vocabulary entries do not belong to this course');
  }
  if (entries.some((entry) => !entry.normalizedTarget)) {
    throw new ValidationError('Every quiz entry needs an approved target answer');
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

  learnAudit(req, 'quiz_attempt_submitted', {
    courseId: body.courseId,
    mode: body.mode,
    totalQuestions: gradedAnswers.length,
    correctAnswers,
  });
  res.status(201).json({
    attempt: compactAttempt(attempt),
    idempotent: false,
    results: gradedAnswers.map(({ entryId, direction, correct, correctAnswer }) => ({ entryId, direction, correct, correctAnswer })),
  });
});

// GET /learn/teams — only teams to which the current learner belongs.
router.get('/teams', requireAuth, learnReadLimiter, async (req: Request, res: Response) => {
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

router.post('/teams', requireAuth, learnWriteLimiter, async (req: Request, res: Response) => {
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
  learnAudit(req, 'team_created', { teamId: team.id });
  res.status(201).json(team);
});

// Team owners/managers can add an existing POKYH user. There is no anonymous
// invite token in v1, which avoids creating a second unauthenticated identity.
router.post('/teams/:teamId/members', requireAuth, learnWriteLimiter, async (req: Request, res: Response) => {
  const teamId = uuidSchema.parse(req.params['teamId']);
  const body = teamMemberSchema.parse(req.body);
  const { stableUid } = req.user!;
  await ensureLearnProfile(stableUid, false);
  const [team, actor, isAdmin] = await Promise.all([
    prisma.learnTeam.findUnique({ where: { id: teamId }, select: { id: true } }),
    prisma.learnTeamMember.findUnique({
      where: { teamId_stableUid: { teamId, stableUid } },
      select: { role: true },
    }),
    isLearnAdmin(stableUid),
  ]);
  if (!team) throw new NotFoundError('Team not found');
  if (!isAdmin && (!actor || (actor.role !== 'OWNER' && actor.role !== 'MANAGER'))) {
    throw new ForbiddenError('Only a team owner or manager can add a member');
  }

  const user = await prisma.user.findFirst({
    where: { OR: [{ stableUid: body.userId }, { username: body.userId }] },
    select: { stableUid: true, username: true, isUntisUser: true },
  });
  if (!user) throw new NotFoundError('POKYH user not found');
  if (!user.isUntisUser) throw new ValidationError('Only verified WebUntis users can join a Learn team');
  const existingMember = await prisma.learnTeamMember.findUnique({
    where: { teamId_stableUid: { teamId, stableUid: user.stableUid } },
    select: { role: true },
  });
  // Managers may invite a new ordinary member but cannot change somebody's
  // role or create another manager. Ownership and role changes stay with an
  // owner (or a platform administrator), preventing privilege escalation.
  if (!isAdmin && actor?.role !== 'OWNER' && (existingMember || body.role !== 'MEMBER')) {
    throw new ForbiddenError('Only a team owner can change member roles');
  }
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
  learnAudit(req, 'team_member_added', { teamId, targetStableUid: user.stableUid, role: body.role });
  res.json({ member: { ...member, username: user.username } });
});

// ─── Learn administration ───────────────────────────────────────────────────
// This is deliberately a separate /learn/admin surface. It uses the existing
// Pokyh administrator record but neither exposes nor changes the unrelated
// school-app administration data or credentials.

router.get('/admin/overview', requireAuth, learnReadLimiter, async (req: Request, res: Response) => {
  const { stableUid } = req.user!;
  await requireLearnAdmin(stableUid);
  const [courseCount, draftCount, publishedCount, enrollmentCount, vocabularyCount, courses] = await Promise.all([
    prisma.learnCourse.count(),
    prisma.learnCourse.count({ where: { status: 'DRAFT' } }),
    prisma.learnCourse.count({ where: { status: 'PUBLISHED' } }),
    prisma.learnEnrollment.count(),
    prisma.learnVocabularyEntry.count(),
    prisma.learnCourse.findMany({
      orderBy: { updatedAt: 'desc' },
      take: 50,
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
        createdBy: true,
        createdAt: true,
        updatedAt: true,
        creator: { select: { username: true } },
        team: { select: { id: true, name: true } },
        _count: { select: { sections: true, vocabulary: true, enrollments: true, accessGrants: true } },
        accessGrants: {
          orderBy: { updatedAt: 'desc' },
          select: {
            stableUid: true,
            permission: true,
            updatedAt: true,
            user: { select: { username: true, isUntisUser: true } },
          },
        },
      },
    }),
  ]);
  const learnCfg = await getLearnConfig();
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({
    stats: { courseCount, draftCount, publishedCount, enrollmentCount, vocabularyCount },
    runtime: {
      webUntisOnly: true,
      dictionary: {
        enabled: learnCfg.dictionaryEnabled,
        provider: learnCfg.dictionaryProvider,
        allowedPairs: learnCfg.dictionaryAllowedPairs,
      },
      legalGate: {
        enabled: learnCfg.legalGateEnabled,
        ready: learnCfg.legalGateReady,
        privacyNoticeVersion: learnCfg.privacyNoticeVersion || null,
      },
    },
    courses,
  });
});

router.get('/admin/courses/:courseId/access', requireAuth, learnReadLimiter, async (req: Request, res: Response) => {
  const courseId = uuidSchema.parse(req.params['courseId']);
  const { stableUid } = req.user!;
  await requireLearnAdmin(stableUid);
  const course = await prisma.learnCourse.findUnique({
    where: { id: courseId },
    select: {
      id: true,
      slug: true,
      title: true,
      createdBy: true,
      creator: { select: { username: true } },
      accessGrants: {
        orderBy: { updatedAt: 'desc' },
        select: {
          stableUid: true,
          permission: true,
          createdAt: true,
          updatedAt: true,
          user: { select: { username: true, isUntisUser: true } },
        },
      },
      team: {
        select: {
          id: true,
          name: true,
          members: {
            orderBy: { joinedAt: 'asc' },
            select: { stableUid: true, role: true, user: { select: { username: true, isUntisUser: true } } },
          },
        },
      },
    },
  });
  if (!course) throw new NotFoundError('Course not found');
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ course });
});

// Permanent deletion is deliberately narrow: it is platform-admin-only and
// requires the exact stable course slug in the request body. Course owners can
// use the ordinary lifecycle endpoint to archive instead.
router.delete('/admin/courses/:courseId', requireAuth, learnWriteLimiter, async (req: Request, res: Response) => {
  const courseId = uuidSchema.parse(req.params['courseId']);
  const body = adminCourseDeleteSchema.parse(req.body);
  const { stableUid } = req.user!;
  await requireLearnAdmin(stableUid);
  const course = await prisma.learnCourse.findUnique({
    where: { id: courseId },
    select: { id: true, slug: true },
  });
  if (!course) throw new NotFoundError('Course not found');
  if (body.confirmation !== course.slug) {
    throw new ValidationError('Type the exact course slug to confirm permanent deletion');
  }
  await prisma.learnCourse.delete({ where: { id: courseId } });
  learnAudit(req, 'course_deleted', { courseId });
  res.json({ deletedCourseId: courseId });
});

// Minimal central-admin grant surface. It deliberately uses the regular POKYH
// JWT plus the Admin table check; no browser-held API secret is introduced.
router.post('/admin/course-access', requireAuth, learnWriteLimiter, async (req: Request, res: Response) => {
  const body = courseAccessSchema.parse(req.body);
  const { stableUid } = req.user!;
  await requireLearnAdmin(stableUid);

  const [course, user] = await Promise.all([
    prisma.learnCourse.findUnique({ where: { id: body.courseId }, select: { id: true } }),
    prisma.user.findFirst({
      where: { OR: [{ stableUid: body.userId }, { username: body.userId }] },
      select: { stableUid: true, isUntisUser: true },
    }),
  ]);
  if (!course) throw new NotFoundError('Course not found');
  if (!user) throw new NotFoundError('POKYH user not found');
  if (!user.isUntisUser) throw new ValidationError('Only verified WebUntis users can receive Learn access');

  const [, grant] = await prisma.$transaction([
    // A grant is durable Learn data just like an enrollment; provision the
    // lightweight profile atomically so the annual archiver retains the user.
    prisma.learnProfile.upsert({
      where: { stableUid: user.stableUid },
      create: { stableUid: user.stableUid },
      update: {},
    }),
    prisma.learnCourseAccess.upsert({
      where: { courseId_stableUid: { courseId: body.courseId, stableUid: user.stableUid } },
      create: { courseId: body.courseId, stableUid: user.stableUid, permission: body.permission, grantedBy: stableUid },
      update: { permission: body.permission, grantedBy: stableUid },
    }),
  ]);
  learnAudit(req, 'course_access_granted', { courseId: body.courseId, targetStableUid: user.stableUid, permission: body.permission });
  res.json(grant);
});

router.delete('/admin/course-access/:courseId/:stableUid', requireAuth, learnWriteLimiter, async (req: Request, res: Response) => {
  const courseId = uuidSchema.parse(req.params['courseId']);
  const targetStableUid = trimmedText(100).parse(req.params['stableUid']);
  const { stableUid } = req.user!;
  await requireLearnAdmin(stableUid);
  const deleted = await prisma.learnCourseAccess.deleteMany({
    where: { courseId, stableUid: targetStableUid },
  });
  if (deleted.count === 0) throw new NotFoundError('Course access grant not found');
  learnAudit(req, 'course_access_revoked', { courseId, targetStableUid });
  res.status(204).send();
});

export { router as learnRouter };
