import { prisma } from '../db';
import { logger } from '../utils/logger';
import { CLASS_CHECK_VERSION } from '../utils/accountClass';

// Checking every class assignment again, once per version of the class rules
// (CLASS_CHECK_VERSION, utils/accountClass.ts). The server holds no WebUntis
// sign-ins, so WebUntis itself is asked at each account's next sign-in or
// session renewal (routes/auth.ts completeWebUntisLogin, which also records
// the version that confirmed the class). Until then an account is in no
// class at all, so nobody stays in a class WebUntis does not confirm:
//
//   1. Parent and role-less accounts lose any class and membership an older
//      deployment left behind.
//   2. WebUntis accounts no sign-in has checked under the current rules lose
//      their class and their memberships. The classes themselves stay, with
//      their reminders: the next sign-in that confirms a class joins it again.
//
// POKYH-only accounts keep the classes an admin gave them. It only ever
// removes, so a second run (another node of a cluster, a restart before the
// record was written) changes nothing a sign-in confirmed meanwhile.

const migrationId = () => `class-check-v${CLASS_CHECK_VERSION}`;

const hasClassFields = { OR: [{ webuntisKlasseId: { not: 0 } }, { webuntisKlasseName: { not: '' } }] };

export async function recheckClassesOnce(): Promise<void> {
  const id = migrationId();
  if (await prisma.appMigration.findUnique({ where: { id }, select: { id: true } })) return;

  const withoutClass = { role: { in: ['parent', 'none'] } };
  const unchecked = { isUntisUser: true, classCheckVersion: { lt: CLASS_CHECK_VERSION } };

  const memberships = await prisma.classMember.deleteMany({
    where: { user: { is: { OR: [withoutClass, unchecked] } } },
  });
  const accounts = await prisma.user.updateMany({
    where: { AND: [{ OR: [withoutClass, unchecked] }, hasClassFields] },
    data: { webuntisKlasseId: 0, webuntisKlasseName: '' },
  });

  const detail = `${accounts.count} account(s) and ${memberships.count} class membership(s) await their check at the next sign-in`;
  await prisma.appMigration.upsert({ where: { id }, create: { id, detail }, update: {} });
  logger.info('Class assignments reset for their check at the next sign-in', {
    action: 'class_check_reset', version: CLASS_CHECK_VERSION, accounts: accounts.count, memberships: memberships.count,
  });
}
