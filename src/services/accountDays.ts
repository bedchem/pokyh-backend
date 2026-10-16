import { prisma } from '../db';
import { config } from '../config';
import { logger } from '../utils/logger';
import { addDays, classifyUserAgent, dayAxis, localDayAndHour, startOfLocalDay } from './usageAnalytics';

// request_account_days: which accounts used Pokyh on which local day, on which
// kind of device and client — what the Analytics page needs from the request
// logs, without scanning every request (a month of logs is hundreds of
// thousands of rows; this is a few thousand). See prisma/schema.prisma.

// Written once per account, day and device kind, then refreshed at most this
// often so "last seen" stays roughly current.
const REFRESH_MS = 10 * 60 * 1000;
const written = new Map<string, number>();

export function noteAccountDay(stableUid: string, userAgent: string | undefined, schoolId: string | null, now = new Date()): void {
  const kind = classifyUserAgent(userAgent);
  if (!kind) return;
  const { dayKey } = localDayAndHour(now, config.usageAnalytics.timezone);
  const key = `${dayKey}|${stableUid}|${kind.device}|${kind.client}`;
  const last = written.get(key);
  if (last !== undefined && now.getTime() - last < REFRESH_MS) return;
  if (written.size > 50_000) written.clear();
  written.set(key, now.getTime());
  const id = { dayKey, stableUid: stableUid.slice(0, 64), device: kind.device, client: kind.client };
  prisma.requestAccountDay.upsert({
    where: { dayKey_stableUid_device_client: id },
    create: { ...id, schoolId, lastAt: now },
    update: { lastAt: now, schoolId },
  }).catch(() => {
    written.delete(key);
  });
}

// Fills the table from the request logs once (the first start with it, or a
// node whose table is empty): day by day, so no single query has to group a
// month of logs.
export async function backfillAccountDays(): Promise<number> {
  if ((await prisma.requestAccountDay.count()) > 0) return 0;
  const tz = config.usageAnalytics.timezone;
  let total = 0;
  for (const dayKey of dayAxis(config.requestLogRetentionDays + 1, tz)) {
    const since = startOfLocalDay(dayKey, tz);
    const until = startOfLocalDay(addDays(dayKey, 1), tz);
    const rows = await prisma.$queryRaw<Array<{ uid: string; ua: string; schoolId: string | null; lastAt: Date }>>`
      SELECT stable_uid AS uid, user_agent AS ua, MAX(school_id) AS schoolId, MAX(created_at) AS lastAt
      FROM request_logs
      WHERE created_at >= ${since} AND created_at < ${until} AND stable_uid IS NOT NULL AND user_agent IS NOT NULL
      GROUP BY stable_uid, user_agent`;
    const merged = new Map<string, { dayKey: string; stableUid: string; device: string; client: string; schoolId: string | null; lastAt: Date }>();
    for (const row of rows) {
      const kind = classifyUserAgent(row.ua);
      if (!kind) continue;
      const key = `${row.uid}|${kind.device}|${kind.client}`;
      const lastAt = new Date(row.lastAt);
      const known = merged.get(key);
      if (!known || lastAt > known.lastAt) {
        merged.set(key, { dayKey, stableUid: row.uid.slice(0, 64), device: kind.device, client: kind.client, schoolId: row.schoolId, lastAt });
      }
    }
    if (merged.size > 0) {
      const { count } = await prisma.requestAccountDay.createMany({ data: [...merged.values()], skipDuplicates: true });
      total += count;
    }
  }
  if (total > 0) logger.info('Request account days filled from the request logs', { action: 'account_days_backfill', rows: total });
  return total;
}
