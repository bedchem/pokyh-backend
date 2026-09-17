import { randomUUID } from 'crypto';
import { prisma } from '../db';

// Every team gets an Italian and an English vocabulary course (TEAM-
// visibility, DRAFT status — visible and usable by team members immediately
// per resolveCourseAccess in routes/learn.ts, just not catalog-listed).
// Vocabulary lives on a course, and course access is already correctly
// scoped to the owning team's members, so this gives each team its own
// isolated starter vocabulary with no separate scoping mechanism needed.
export const STARTER_VOCAB_COURSES = [
  { language: 'Italienisch', title: 'Italienisch – Teamvokabular' },
  { language: 'Englisch', title: 'Englisch – Teamvokabular' },
] as const;

function slugify(title: string): string {
  const normalized = title
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 150);
  return `${normalized || 'course'}-${randomUUID().slice(0, 8)}`;
}

type PrismaLike = Omit<typeof prisma, '$transaction' | '$connect' | '$disconnect' | '$on' | '$use' | '$extends'>;

// Idempotent: only creates the starter courses a team doesn't already have,
// keyed by (teamId, language) — safe to call again for a team created
// before this existed. Returns how many were newly created (0 on a no-op
// re-run).
export async function seedStarterVocabCourses(
  tx: PrismaLike,
  teamId: string,
  teamName: string,
  createdBy: string,
): Promise<number> {
  const existing = await tx.learnCourse.findMany({
    where: { teamId, language: { in: STARTER_VOCAB_COURSES.map((s) => s.language) } },
    select: { language: true },
  });
  const existingLanguages = new Set(existing.map((c) => c.language));
  const missing = STARTER_VOCAB_COURSES.filter((s) => !existingLanguages.has(s.language));
  for (const starter of missing) {
    await tx.learnCourse.create({
      data: {
        slug: slugify(starter.title),
        title: starter.title,
        summary: `Gemeinsames ${starter.language}-Vokabular für „${teamName}“ — von allen Teammitgliedern erweiterbar.`,
        language: starter.language,
        visibility: 'TEAM',
        status: 'DRAFT',
        createdBy,
        teamId,
      },
    });
  }
  return missing.length;
}

// Grants one team member full working access to their team's starter vocab
// courses: an EDIT course-access row (so POST /vocabulary and quiz-attempts'
// enrollment-or-EDIT check both succeed — team membership alone only ever
// grants VIEW, see resolveCourseAccess in routes/learn.ts) and an ACTIVE
// enrollment row (so the course appears in "Meine Kurse", which reads
// LearnEnrollment directly and has no other way to learn about team access).
// Neither record implies the other in this codebase — both are required.
// Idempotent upserts; safe to call repeatedly (e.g. on every backfill run)
// without disturbing a member's real lastOpenedAt/progress if they already
// have an enrollment row from actually using the course.
export async function ensureTeamMemberVocabAccess(
  tx: PrismaLike,
  teamId: string,
  stableUid: string,
): Promise<void> {
  const courses = await tx.learnCourse.findMany({
    where: { teamId, language: { in: STARTER_VOCAB_COURSES.map((s) => s.language) } },
    select: { id: true },
  });
  await Promise.all(courses.map(async (course) => {
    await tx.learnCourseAccess.upsert({
      where: { courseId_stableUid: { courseId: course.id, stableUid } },
      create: { courseId: course.id, stableUid, permission: 'EDIT', grantedBy: 'system:starter-vocab' },
      update: { permission: 'EDIT' },
    });
    await tx.learnEnrollment.upsert({
      where: { courseId_stableUid: { courseId: course.id, stableUid } },
      // lastOpenedAt is deliberately left unset here (and never touched on
      // update) — this keeps a repeated idempotent backfill run a true
      // no-op for members who never actually opened the course themselves.
      create: { courseId: course.id, stableUid, status: 'ACTIVE' },
      update: { status: 'ACTIVE' },
    });
  }));
}

// Grants every current member of a team access to its starter vocab
// courses. Used by both the team-creation path and the idempotent admin
// backfill action — batched, not sequential, since a team's roster can be
// a full class.
export async function ensureAllTeamMembersVocabAccess(tx: PrismaLike, teamId: string): Promise<void> {
  const members = await tx.learnTeamMember.findMany({ where: { teamId }, select: { stableUid: true } });
  await Promise.all(members.map((member) => ensureTeamMemberVocabAccess(tx, teamId, member.stableUid)));
}
