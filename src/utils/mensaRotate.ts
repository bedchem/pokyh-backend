import { prisma } from '../db';
import { logger } from './logger';
import type { Prisma } from '@prisma/client';

// A minimal Prisma client interface — either the root `prisma` or a `tx`
// handle handed to us by an enclosing `$transaction`. Kept as a shared alias so
// helper composition is uniform.
type PrismaLike = Prisma.TransactionClient | typeof prisma;

// Compute the Monday (local midnight) of the current calendar week.
function currentLocalMonday(): Date {
  const today = new Date();
  const dow = today.getDay() || 7;
  return new Date(today.getFullYear(), today.getMonth(), today.getDate() - dow + 1);
}

function pad(n: number): string { return n < 10 ? '0' + n : String(n); }
function toLocalIso(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Push every week whose Monday is before this week's Monday to the END of the
// plan, preserving their relative order. Idempotent — cheap when there is
// nothing to rotate (single indexed SELECT then early return).
//
// Pass a `tx` to compose this inside a larger transaction (e.g. anchor-week);
// otherwise the helper opens its own.
export async function rotatePastWeeks(plan: 'summer' | 'winter', tx?: PrismaLike): Promise<number> {
  const currentMonday = currentLocalMonday();
  const db: PrismaLike = tx ?? prisma;

  const dishes = await db.dish.findMany({
    where: { plan },
    select: { date: true },
  });
  if (dishes.length === 0) return 0;

  const mondaySet = new Set<string>();
  for (const d of dishes) {
    const t = new Date(d.date);
    const wd = t.getDay() || 7;
    const mon = new Date(t.getFullYear(), t.getMonth(), t.getDate() - wd + 1);
    mondaySet.add(toLocalIso(mon));
  }
  const mondays = [...mondaySet].sort();
  const totalWeeks = mondays.length;
  const pastMondays = mondays.filter((m) => new Date(m + 'T00:00:00') < currentMonday);
  if (pastMondays.length === 0) return 0;

  async function runShifts(client: PrismaLike): Promise<number> {
    let n = 0;
    for (const monIso of pastMondays) {
      const monStart = new Date(monIso + 'T00:00:00Z');
      const monEnd = new Date(monIso + 'T00:00:00Z');
      monEnd.setUTCDate(monEnd.getUTCDate() + 7);
      const shiftDays = totalWeeks * 7;
      const r = await client.$executeRaw`UPDATE dishes SET date = DATE_ADD(date, INTERVAL ${shiftDays} DAY) WHERE plan = ${plan} AND date >= ${monStart} AND date < ${monEnd}`;
      n += Number(r) || 0;
    }
    return n;
  }

  const rotated = tx
    ? await runShifts(tx)
    : await prisma.$transaction((inner) => runShifts(inner));

  if (rotated > 0) {
    logger.info('mensa rotate', { plan, rotated, pastWeeks: pastMondays.length });
  }
  return rotated;
}
