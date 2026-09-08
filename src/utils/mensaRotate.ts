import { prisma } from '../db';
import { logger } from './logger';

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
// Used both by the admin-triggered endpoint and opportunistically by the
// public /dishes route so consumers always see a "rolling" plan without any
// manual intervention.
export async function rotatePastWeeks(plan: 'summer' | 'winter'): Promise<number> {
  const currentMonday = currentLocalMonday();

  const dishes = await prisma.dish.findMany({
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

  let rotated = 0;
  await prisma.$transaction(async (tx) => {
    for (const monIso of pastMondays) {
      const monStart = new Date(monIso + 'T00:00:00Z');
      const monEnd = new Date(monIso + 'T00:00:00Z');
      monEnd.setUTCDate(monEnd.getUTCDate() + 7);
      const shiftDays = totalWeeks * 7;
      const n = await tx.$executeRaw`UPDATE dishes SET date = DATE_ADD(date, INTERVAL ${shiftDays} DAY) WHERE plan = ${plan} AND date >= ${monStart} AND date < ${monEnd}`;
      rotated += Number(n) || 0;
    }
  });

  if (rotated > 0) {
    logger.info('mensa rotate', { plan, rotated, pastWeeks: pastMondays.length });
  }
  return rotated;
}
