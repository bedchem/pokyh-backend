import { prisma } from '../db';

// The bell in the website's top bar (pokyh-frontend components/app/Bell.tsx):
// which of its notifications an account has seen or cleared away, kept with
// the account so a phone shows what the computer already cleared. Only the
// notifications' identifiers are stored (prisma/schema.prisma BellMark).

/** How long a mark is kept. The bell reaches back 14 days; stated in the privacy notice. */
export const BELL_MARK_RETENTION_DAYS = 30;
/** Most identifiers one request may mark. */
export const BELL_MARK_BATCH = 400;
/** Most marks an answer holds, the newest. */
const BELL_MARK_READ_LIMIT = 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

export function bellMarkCutoff(now = Date.now()): Date {
  return new Date(now - BELL_MARK_RETENTION_DAYS * DAY_MS);
}

export interface BellMarks {
  /** Everything seen, the cleared included. */
  seen: string[];
  cleared: string[];
}

export async function bellMarksOf(stableUid: string): Promise<BellMarks> {
  const rows = await prisma.bellMark.findMany({
    where: { stableUid, createdAt: { gte: bellMarkCutoff() } },
    orderBy: { createdAt: 'desc' },
    take: BELL_MARK_READ_LIMIT,
    select: { key: true, cleared: true },
  });
  return { seen: rows.map((r) => r.key), cleared: rows.filter((r) => r.cleared).map((r) => r.key) };
}

// What was seen stays seen; clearing also turns a seen mark into a cleared one.
export async function addBellMarks(stableUid: string, seen: string[], cleared: string[]): Promise<void> {
  const clearedKeys = [...new Set(cleared)];
  const seenKeys = [...new Set(seen)].filter((k) => !clearedKeys.includes(k));
  if (clearedKeys.length === 0 && seenKeys.length === 0) return;
  await prisma.$transaction([
    ...(clearedKeys.length
      ? [prisma.bellMark.updateMany({ where: { stableUid, key: { in: clearedKeys }, cleared: false }, data: { cleared: true } })]
      : []),
    prisma.bellMark.createMany({
      data: [...clearedKeys.map((key) => ({ stableUid, key, cleared: true })), ...seenKeys.map((key) => ({ stableUid, key }))],
      skipDuplicates: true,
    }),
  ]);
}

export async function deleteExpiredBellMarks(): Promise<number> {
  const { count } = await prisma.bellMark.deleteMany({ where: { createdAt: { lt: bellMarkCutoff() } } });
  return count;
}
