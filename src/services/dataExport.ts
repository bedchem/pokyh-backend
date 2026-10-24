import { prisma } from '../db';
import { config } from '../config';
import { NotFoundError } from '../utils/errors';
import { listSessions, loginHistory } from './sessions';

// "Daten anfordern": everything POKYH keeps about an account, as one JSON file
// the account downloads itself (GET /users/me/export, Art. 15 and 20 GDPR).
// Left out is only what would be a key rather than information about the
// person: the password hash, refresh token hashes, the push subscriptions'
// keys and the WebUntis session they carry.
//
// WebUntis data (timetable, grades, absences, messages) is not stored by POKYH
// — it is read from WebUntis when shown — so it is not part of this export;
// the note in the file says so.

const LOG_ROWS = 2000;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export async function exportAccountData(stableUid: string) {
  const user = await prisma.user.findUnique({ where: { stableUid } });
  if (!user) throw new NotFoundError('User not found');

  const [
    school, admin, memberships, todos, archivedTodos, reminders, comments, dishRatings, dishComments,
    push, consent, bellMarks, accountDays, usageSessions, webVisits, requestLogs, pageLogs,
    archivedUsers, archivedActivity, popups, learnProfile, learnEnrollments, learnCompletions,
    learnAttempts, learnReviews, learnEntries, learnActivity, learnTeams, sessions, logins,
  ] = await Promise.all([
    user.schoolId ? prisma.school.findUnique({ where: { id: user.schoolId }, select: { name: true, webuntisSchool: true } }) : null,
    prisma.admin.findUnique({ where: { stableUid } }),
    prisma.classMember.findMany({ where: { stableUid }, include: { class: { select: { name: true } } } }),
    prisma.todo.findMany({ where: { stableUid }, orderBy: { createdAt: 'asc' } }),
    prisma.archivedTodo.findMany({ where: { stableUid }, orderBy: { createdAt: 'asc' } }),
    prisma.reminder.findMany({ where: { createdBy: stableUid }, orderBy: { createdAt: 'asc' } }),
    prisma.comment.findMany({ where: { stableUid }, orderBy: { createdAt: 'asc' } }),
    prisma.dishRating.findMany({ where: { stableUid }, orderBy: { createdAt: 'asc' } }),
    prisma.dishComment.findMany({ where: { stableUid }, orderBy: { createdAt: 'asc' } }),
    prisma.pushSubscription.findMany({ where: { stableUid }, select: { endpoint: true, createdAt: true, updatedAt: true } }),
    prisma.privacyConsent.findUnique({ where: { stableUid } }),
    prisma.bellMark.findMany({ where: { stableUid } }),
    prisma.requestAccountDay.findMany({ where: { stableUid }, orderBy: { dayKey: 'asc' } }),
    prisma.usageSession.findMany({ where: { stableUid }, orderBy: { startedAt: 'desc' }, take: LOG_ROWS }),
    prisma.webVisit.findMany({ where: { stableUid }, orderBy: { createdAt: 'desc' }, take: LOG_ROWS }),
    prisma.requestLog.findMany({ where: { stableUid }, orderBy: { createdAt: 'desc' }, take: LOG_ROWS }),
    prisma.frontendActivityLog.findMany({ where: { stableUid }, orderBy: { createdAt: 'desc' }, take: LOG_ROWS }),
    prisma.archivedUser.findMany({ where: { stableUid } }),
    prisma.archivedActivity.findMany({ where: { stableUid } }),
    prisma.popupTargetUser.findMany({ where: { stableUid }, select: { popupId: true } }),
    prisma.learnProfile.findUnique({ where: { stableUid } }),
    prisma.learnEnrollment.findMany({ where: { stableUid } }),
    prisma.learnSectionCompletion.findMany({ where: { stableUid } }),
    prisma.learnQuizAttempt.findMany({ where: { stableUid }, orderBy: { createdAt: 'asc' } }),
    prisma.learnVocabularyReview.findMany({ where: { stableUid } }),
    prisma.learnVocabularyEntry.findMany({ where: { createdBy: stableUid } }),
    prisma.learnActivityDaily.findMany({ where: { stableUid } }),
    prisma.learnTeamMember.findMany({ where: { stableUid } }),
    listSessions(stableUid),
    loginHistory(stableUid, 1000),
  ]);

  return {
    about: {
      generatedAt: new Date().toISOString(),
      service: 'POKYH',
      note: 'Alles, was POKYH zu deinem Konto speichert. Stundenplan, Noten, Abwesenheiten und Nachrichten speichert POKYH nicht: Sie werden beim Anzeigen direkt aus WebUntis geladen. Passwörter und Schlüssel sind nicht enthalten.',
      retention: {
        loginHistoryDays: config.loginHistoryDays,
        unusedDevicesDays: config.sessionIdleDays,
        requestLogDays: config.requestLogRetentionDays,
      },
    },
    account: {
      username: user.username,
      stableUid: user.stableUid,
      role: user.role,
      webuntisAccount: user.isUntisUser,
      hasPokyhPassword: Boolean(user.passwordHash),
      className: user.webuntisKlasseName,
      school: school ? { name: school.name, webuntis: school.webuntisSchool } : null,
      isAdmin: admin !== null,
      createdAt: iso(user.createdAt),
      updatedAt: iso(user.updatedAt),
    },
    signIn: {
      devices: sessions,
      loginHistory: logins,
    },
    privacy: consent,
    classes: memberships.map((m) => ({ classId: m.classId, className: m.class.name, role: m.role, joinedAt: iso(m.joinedAt) })),
    todos,
    archivedTodos,
    reminders,
    comments,
    mensa: { ratings: dishRatings, comments: dishComments },
    notifications: {
      pushSubscriptions: push.map((p) => ({ service: hostOf(p.endpoint), createdAt: iso(p.createdAt), updatedAt: iso(p.updatedAt) })),
      bellMarks,
      popupsShownTo: popups.map((p) => p.popupId),
    },
    activity: {
      activeDays: accountDays,
      usageSessions,
      appAndWebsiteVisits: webVisits,
      requests: requestLogs,
      websitePages: pageLogs,
    },
    previousSchoolYears: { accounts: archivedUsers, activity: archivedActivity },
    learn: learnProfile || learnEnrollments.length || learnAttempts.length ? {
      profile: learnProfile,
      enrollments: learnEnrollments,
      sectionsCompleted: learnCompletions,
      quizAttempts: learnAttempts,
      vocabularyReviews: learnReviews,
      vocabularyCreated: learnEntries,
      activityDays: learnActivity,
      teams: learnTeams,
    } : null,
  };
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return '';
  }
}
