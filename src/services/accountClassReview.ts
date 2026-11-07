import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { CLASS_CHECK_VERSION } from '../utils/accountClass';

// What the admin panel shows about accounts and their classes
// (routes/admin.ts GET /users, /users/summary): which pupils have no class
// and why, which still wait for their check at the next sign-in, and which
// accounts sign in on the same pupil's WebUntis record — a pupil and a
// parent's login on the child's record, which only an admin can tell apart.

/** Notes that ask an admin to look (utils/accountClass.ts ClassNote). */
export const REVIEW_NOTES = ['shared_person', 'student_record_on_parent'] as const;

/** The first day of the current school year (the archive rolls over on August 1). */
export function schoolYearStart(now = new Date()): Date {
  return new Date(now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1, 7, 1);
}

/** Pupils WebUntis checked under the current rules and named no class for. */
export const withoutClassWhere: Prisma.UserWhereInput = {
  role: 'student', isUntisUser: true, classCheckVersion: CLASS_CHECK_VERSION, webuntisKlasseId: 0,
};

/** Pupils whose class waits for their next sign-in (a new version of the rules, or WebUntis did not answer). */
export const pendingWhere: Prisma.UserWhereInput = {
  role: 'student', isUntisUser: true, classCheckVersion: { lt: CLASS_CHECK_VERSION },
};

export interface SharedRecord {
  /** The other accounts on the record (username, role). */
  others: Array<{ username: string; role: string }>;
  /** Two or more of them are students: one is a parent's login, an admin has to say which. */
  needsReview: boolean;
}

/**
 * Accounts of a school that signed in on the same pupil's record this school
 * year, by account. `schoolId` null: every school.
 */
export async function sharedRecords(schoolId: string | null): Promise<Map<string, SharedRecord>> {
  const since = schoolYearStart();
  const groups = await prisma.user.groupBy({
    by: ['schoolId', 'webuntisPersonId'],
    where: { webuntisPersonId: { not: null }, classCheckedAt: { gte: since }, ...(schoolId ? { schoolId } : {}) },
    having: { webuntisPersonId: { _count: { gt: 1 } } },
  });
  const result = new Map<string, SharedRecord>();
  if (groups.length === 0) return result;
  const members = await prisma.user.findMany({
    where: {
      classCheckedAt: { gte: since },
      OR: groups.map((g) => ({ schoolId: g.schoolId, webuntisPersonId: g.webuntisPersonId })),
    },
    select: { stableUid: true, username: true, role: true, schoolId: true, webuntisPersonId: true },
  });
  const byRecord = new Map<string, typeof members>();
  for (const m of members) {
    const key = `${m.schoolId ?? ''}|${m.webuntisPersonId}`;
    byRecord.set(key, [...(byRecord.get(key) ?? []), m]);
  }
  for (const group of byRecord.values()) {
    if (group.length < 2) continue;
    const needsReview = group.filter((m) => m.role === 'student').length >= 2;
    for (const m of group) {
      result.set(m.stableUid, {
        others: group.filter((o) => o.stableUid !== m.stableUid).map((o) => ({ username: o.username, role: o.role })),
        needsReview,
      });
    }
  }
  return result;
}

/** Accounts an admin should look at: a note asks for it, or a shared record not yet told apart. */
export function reviewWhere(shared: Map<string, SharedRecord>): Prisma.UserWhereInput {
  const uids = [...shared.entries()].filter(([, s]) => s.needsReview).map(([uid]) => uid);
  return { OR: [{ classNote: { in: [...REVIEW_NOTES] } }, ...(uids.length ? [{ stableUid: { in: uids } }] : [])] };
}

export interface ClassSummary {
  total: number;
  students: number;
  parents: number;
  /** Role-less accounts that are no admins either. */
  noRole: number;
  withClass: number;
  withoutClass: number;
  pending: number;
  review: number;
}

/** The figures above the panel's account list, in one go. */
export async function classSummary(schoolId: string | null, adminUids: string[]): Promise<ClassSummary> {
  const scope: Prisma.UserWhereInput = schoolId ? { schoolId } : {};
  const shared = await sharedRecords(schoolId);
  const [total, roles, noRole, withClass, withoutClass, pending, review] = await Promise.all([
    prisma.user.count({ where: scope }),
    prisma.user.groupBy({ by: ['role'], where: scope, _count: { _all: true } }),
    prisma.user.count({ where: { ...scope, role: 'none', ...(adminUids.length ? { stableUid: { notIn: adminUids } } : {}) } }),
    prisma.user.count({ where: { ...scope, role: 'student', webuntisKlasseId: { gt: 0 } } }),
    prisma.user.count({ where: { ...scope, ...withoutClassWhere } }),
    prisma.user.count({ where: { ...scope, ...pendingWhere } }),
    prisma.user.count({ where: { AND: [scope, reviewWhere(shared)] } }),
  ]);
  const byRole = new Map(roles.map((r) => [r.role, r._count._all]));
  return {
    total,
    students: byRole.get('student') ?? 0,
    parents: byRole.get('parent') ?? 0,
    noRole,
    withClass,
    withoutClass,
    pending,
    review,
  };
}
