import { prisma } from '../db';
import { getLearnAiConfig } from './learnAiConfig';

// Read-only, strictly per-user context, assembled fresh on every chat
// request. This is the one place personal learning data (progress, due
// reviews) enters an assistant prompt — it must only ever read the
// requesting user's own rows, is never cached, and is never written into the
// shared knowledge base (learnAiKnowledgeBase.ts, a later phase). Keep this
// short: it is added on top of the conversation history inside a bounded
// context window (see LearnAiConfig.contextTokens).
export async function buildPersonalizedContext(stableUid: string): Promise<string | null> {
  const aiCfg = await getLearnAiConfig();
  if (!aiCfg.personalizedContextEnabled) return null;

  const [profile, dueReviewCount, activeEnrollments] = await Promise.all([
    prisma.learnProfile.findUnique({
      where: { stableUid },
      select: { dailyStreak: true, dailyGoalMinutes: true },
    }),
    prisma.learnVocabularyReview.count({
      where: { stableUid, dueAt: { lte: new Date() } },
    }),
    prisma.learnEnrollment.findMany({
      where: { stableUid, status: 'ACTIVE' },
      orderBy: { lastOpenedAt: 'desc' },
      take: 5,
      select: { progressPercent: true, course: { select: { title: true, language: true } } },
    }),
  ]);

  const lines: string[] = [];
  if (profile) {
    lines.push(`Current streak: ${profile.dailyStreak} day(s); daily goal ${profile.dailyGoalMinutes} minutes.`);
  }
  lines.push(`Vocabulary items due for review right now: ${dueReviewCount}.`);
  if (activeEnrollments.length > 0) {
    const courseLines = activeEnrollments
      .map((enrollment) => {
        const language = enrollment.course.language ? ` (${enrollment.course.language})` : '';
        return `${enrollment.course.title}${language} — ${Math.round(enrollment.progressPercent)}% complete`;
      })
      .join('; ');
    lines.push(`Active courses: ${courseLines}.`);
  } else {
    lines.push('No active course enrollments yet.');
  }

  return lines.join('\n');
}
