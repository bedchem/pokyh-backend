import { prisma } from '../db';
import { ForbiddenError } from '../utils/errors';
import { logger } from '../utils/logger';
import { revokeUserTokens } from '../utils/revokedTokens';
import { dropPendingLogsOf } from '../middleware/requestLogger';
import { isOwner, grantsOf } from './adminAccess';
import { forgetUserSchool } from './schools';
import { revokeSessions } from './sessions';

// An account deleting itself (DELETE /users/me, Art. 17 GDPR, App Store 5.1.1(v)).
// What goes is what the data export names (services/dataExport.ts). Tables tied
// to the user row go with it by their foreign keys; the rest is listed here, and
// tests/accountDeletion.test.mjs fails when a new table holding an account is
// in neither place.
//
// Reminders and classes belong to the whole class, other people's comments hang
// on them, so they stay and only lose their author's name.

export const DELETED_ACCOUNT_NAME = 'Gelöschtes Konto';

/** Rows of an account, by id and by name: the id changes when the user row is recreated at a rollover. */
const byAccount = (stableUid: string, username: string) => ({ OR: [{ stableUid }, { username }] });

/** The archived comments of a reminder without this account's. */
export function withoutCommentsOf(commentsJson: string, stableUid: string, username: string): string {
  let comments: unknown;
  try {
    comments = JSON.parse(commentsJson);
  } catch {
    return commentsJson;
  }
  if (!Array.isArray(comments)) return commentsJson;
  return JSON.stringify(comments.filter((c: { stableUid?: unknown; username?: unknown } | null) =>
    c?.stableUid !== stableUid && c?.username !== username));
}

/**
 * Admin rights are taken away by another admin (services/adminAccess.ts), so an
 * admin can't delete themselves out of the panel, or lock a school out of it.
 */
async function assertNotAdmin(stableUid: string, username: string): Promise<void> {
  const [admin, grants] = await Promise.all([
    prisma.admin.findUnique({ where: { stableUid }, select: { stableUid: true } }),
    grantsOf(username),
  ]);
  if (isOwner(username) || admin || grants.length > 0) {
    throw new ForbiddenError('Admin-Konten können sich nicht selbst löschen. Lass dir zuerst die Admin-Rechte entziehen.');
  }
}

/** Returns the deleted account's school, or null when it was gone already. */
export async function deleteOwnAccount(stableUid: string, username: string): Promise<{ schoolId: string | null } | null> {
  const user = await prisma.user.findUnique({ where: { stableUid }, select: { schoolId: true } });
  if (!user) return null;
  await assertNotAdmin(stableUid, username);

  // Every device out first: this needs the session rows the delete takes away.
  await revokeSessions(stableUid);
  revokeUserTokens(stableUid);

  const unnamed = { createdBy: '', createdByName: DELETED_ACCOUNT_NAME };
  const archivedWithComments = await prisma.archivedReminder.findMany({
    where: { OR: [{ commentsJson: { contains: stableUid } }, { commentsJson: { contains: username } }] },
    select: { id: true, commentsJson: true },
  });
  await prisma.$transaction([
    prisma.qrLogin.deleteMany({ where: { stableUid } }),
    prisma.comment.deleteMany({ where: { stableUid } }),
    prisma.dishComment.deleteMany({ where: { stableUid } }),
    prisma.dishRating.deleteMany({ where: byAccount(stableUid, username) }),
    prisma.requestAccountDay.deleteMany({ where: { stableUid } }),
    prisma.archivedTodo.deleteMany({ where: byAccount(stableUid, username) }),
    prisma.archivedUser.deleteMany({ where: byAccount(stableUid, username) }),
    prisma.archivedActivity.deleteMany({ where: byAccount(stableUid, username) }),
    prisma.reminder.updateMany({ where: { createdBy: stableUid }, data: { ...unnamed, createdByUsername: '' } }),
    prisma.archivedReminder.updateMany({ where: { createdBy: stableUid }, data: { ...unnamed, createdByUsername: '' } }),
    prisma.class.updateMany({ where: { createdBy: stableUid }, data: unnamed }),
    prisma.archivedClass.updateMany({ where: { createdBy: stableUid }, data: unnamed }),
    ...archivedWithComments.map(({ id, commentsJson }) => prisma.archivedReminder.update({
      where: { id },
      data: { commentsJson: withoutCommentsOf(commentsJson, stableUid, username) },
    })),
    prisma.user.delete({ where: { stableUid } }),
  ]);
  forgetUserSchool(stableUid);
  // The account's request-log rows still waiting to be written go first.
  dropPendingLogsOf(stableUid, username);

  // The logs run out by themselves soon, so a failure here doesn't undo the deletion.
  await Promise.all([
    prisma.requestLog.deleteMany({ where: byAccount(stableUid, username) }),
    prisma.frontendActivityLog.deleteMany({ where: byAccount(stableUid, username) }),
  ]).catch((err) => {
    logger.warn('Logs of a deleted account not removed', { message: err instanceof Error ? err.message.split('\n')[0] : String(err) });
  });
  return { schoolId: user.schoolId };
}
