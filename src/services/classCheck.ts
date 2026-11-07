import { prisma } from '../db';
import { logger } from '../utils/logger';
import { CLASS_CHECK_VERSION } from '../utils/accountClass';
import { adminRoleChoices, adminSetPasswords } from '../utils/roleChoices';
import { audit } from './audit';

// One-time jobs at start-up that put every account under the current class
// rules. Each runs once per installation (a marker in `app_migrations`), only
// ever removes classes or fixes what an admin decided, and is safe to run
// twice (another node of a cluster, a restart before the marker was written).
//
// 1. lockAdminRolesOnce: roles an admin chose stick from now on
//    (users.role_locked). Accounts an admin made parents or role-less that a
//    later sign-in turned into students (the bug this version fixes) get the
//    admin's role back, without their class.
// 2. backfillLocalOriginOnce: which POKYH-only passwords an admin set (those
//    are never taken over by a WebUntis sign-in of the same name).
// 3. recheckClassesOnce: every class assignment is checked again, once per
//    version of the class rules (CLASS_CHECK_VERSION, utils/accountClass.ts).
//    The server holds no WebUntis sign-ins, so WebUntis itself is asked at
//    each account's next sign-in or session renewal (routes/auth.ts
//    completeWebUntisLogin, which also records the version that confirmed the
//    class). Until then an account is in no class at all, so nobody stays in
//    a class WebUntis does not confirm:
//      - parent and role-less accounts lose any class and membership an
//        older deployment left behind;
//      - WebUntis accounts no sign-in has checked under the current rules
//        lose their class and their memberships. The classes themselves stay,
//        with their reminders: the next sign-in that confirms a class joins
//        it again.
//    POKYH-only accounts keep the classes an admin gave them.

async function once(id: string, work: () => Promise<string>): Promise<void> {
  if (await prisma.appMigration.findUnique({ where: { id }, select: { id: true } })) return;
  const detail = await work();
  await prisma.appMigration.upsert({ where: { id }, create: { id, detail: detail.slice(0, 500) }, update: {} });
}

const auditOf = (actions: string[]) => prisma.adminAuditEvent.findMany({
  where: { targetType: 'user', action: { in: actions } },
  select: { targetId: true, action: true, detail: true, createdAt: true },
});

export async function lockAdminRolesOnce(): Promise<void> {
  await once('role-lock-v1', async () => {
    const choices = adminRoleChoices(await auditOf(['user.role', 'user.create']));
    // "none" is only ever an admin's choice.
    const none = await prisma.user.updateMany({ where: { role: 'none', roleLocked: false }, data: { roleLocked: true } });
    let locked = 0;
    let restored = 0;
    const accounts = choices.size > 0
      ? await prisma.user.findMany({ where: { stableUid: { in: [...choices.keys()] } }, select: { stableUid: true, role: true, schoolId: true } })
      : [];
    for (const account of accounts) {
      const chosen = choices.get(account.stableUid)!;
      if (account.role === chosen) {
        await prisma.user.update({ where: { stableUid: account.stableUid }, data: { roleLocked: true } });
        locked++;
        continue;
      }
      // A sign-in overrode the admin: the admin's role comes back. A
      // parent or role-less account leaves its class right away; an
      // admin-made student gets its class at its next sign-in.
      const withoutClass = chosen !== 'student';
      await prisma.$transaction([
        prisma.user.update({
          where: { stableUid: account.stableUid },
          data: {
            role: chosen, roleLocked: true,
            ...(withoutClass
              ? { webuntisKlasseId: 0, webuntisKlasseName: '', classSource: null, classNote: chosen === 'parent' ? 'role_parent' : 'role_none' }
              : { classCheckVersion: 0, classNote: null }),
          },
        }),
        ...(withoutClass ? [prisma.classMember.deleteMany({ where: { stableUid: account.stableUid } })] : []),
      ]);
      audit(null, 'user.role.restore', { type: 'user', id: account.stableUid }, { from: account.role, to: chosen }, account.schoolId);
      restored++;
    }
    logger.info('Admin role choices locked', { action: 'role_lock', none: none.count, locked, restored });
    return `${none.count + locked} role(s) locked, ${restored} admin choice(s) restored`;
  });
}

export async function backfillLocalOriginOnce(): Promise<void> {
  await once('local-origin-v1', async () => {
    const byAdmin = [...adminSetPasswords(await auditOf(['user.password', 'user.create']))];
    const admins = await prisma.admin.findMany({ select: { stableUid: true } });
    const adminMade = await prisma.user.updateMany({
      where: { passwordHash: { not: null }, localOrigin: null, stableUid: { in: [...byAdmin, ...admins.map((a) => a.stableUid)] } },
      data: { localOrigin: 'admin' },
    });
    // Every other password from before origins were kept counts as
    // self-made: the safe side (a WebUntis sign-in of the name then owns it).
    const selfMade = await prisma.user.updateMany({
      where: { passwordHash: { not: null }, localOrigin: null, isUntisUser: false },
      data: { localOrigin: 'register' },
    });
    logger.info('Password origins recorded', { action: 'local_origin_backfill', admin: adminMade.count, register: selfMade.count });
    return `${adminMade.count} admin-set, ${selfMade.count} self-registered password(s)`;
  });
}

const hasClassFields = { OR: [{ webuntisKlasseId: { not: 0 } }, { webuntisKlasseName: { not: '' } }] };

export async function recheckClassesOnce(): Promise<void> {
  await once(`class-check-v${CLASS_CHECK_VERSION}`, async () => {
    const withoutClass = { role: { in: ['parent', 'none'] } };
    const unchecked = { isUntisUser: true, classCheckVersion: { lt: CLASS_CHECK_VERSION } };

    const memberships = await prisma.classMember.deleteMany({
      where: { user: { is: { OR: [withoutClass, unchecked] } } },
    });
    const accounts = await prisma.user.updateMany({
      where: { AND: [{ OR: [withoutClass, unchecked] }, hasClassFields] },
      data: { webuntisKlasseId: 0, webuntisKlasseName: '' },
    });
    logger.info('Class assignments reset for their check at the next sign-in', {
      action: 'class_check_reset', version: CLASS_CHECK_VERSION, accounts: accounts.count, memberships: memberships.count,
    });
    return `${accounts.count} account(s) and ${memberships.count} class membership(s) await their check at the next sign-in`;
  });
}

/** All of the above, in their order (index.ts, once the database is up). */
export async function accountMigrationsOnce(): Promise<void> {
  await lockAdminRolesOnce();
  await backfillLocalOriginOnce();
  await recheckClassesOnce();
}
