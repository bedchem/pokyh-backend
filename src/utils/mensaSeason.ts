// Which of a menu's two plans serves a week. Free of the database so it can be
// unit-tested on its own (tests/mensaSeason.test.mjs).
//
// With the clocks (SeasonRule 'clock'), summer is every week after the switch
// to summer time (last Sunday of March) up to the switch to winter time (last
// Sunday of October). Both switches fall on a Sunday, the last day of a week,
// so every week lies wholly in one season and the other plan takes over on the
// Monday after the switch. By dates, the week of its Monday's date.
//
// All dates are UTC midnights, because Prisma reads a DATE column as one.

export type Plan = 'summer' | 'winter';

/**
 * When a menu's plans change: on the dates its canteen names ("1. April bis 31.
 * Oktober", MM-DD) or with the clocks. Either way a week goes by its Monday.
 */
export interface SeasonRule {
  kind: 'dates' | 'clock';
  summerFrom: string;
  winterFrom: string;
}

export const CLOCK: SeasonRule = { kind: 'clock', summerFrom: '', winterFrom: '' };

const MONTH_DAY = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** A menu's stored rule; whatever is not one gives the canteens' usual 1 April and 1 November. */
export function seasonRuleOf(kind: unknown, summerFrom: unknown, winterFrom: unknown): SeasonRule {
  if (kind === 'clock') return CLOCK;
  const summer = typeof summerFrom === 'string' && MONTH_DAY.test(summerFrom) ? summerFrom : '04-01';
  const winter = typeof winterFrom === 'string' && MONTH_DAY.test(winterFrom) && winterFrom !== summer ? winterFrom : summer === '11-01' ? '04-01' : '11-01';
  return { kind: 'dates', summerFrom: summer, winterFrom: winter };
}

export function utcMondayOf(d: Date): Date {
  const wd = d.getUTCDay() || 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - wd + 1));
}

export function toUtcIso(d: Date): string { return d.toISOString().split('T')[0]!; }

/** The last Sunday of `month` (0-based) in `year`: the day the EU changes its clocks. */
export function lastSundayUtc(year: number, month: number): Date {
  const last = new Date(Date.UTC(year, month + 1, 0));
  return new Date(Date.UTC(year, month, last.getUTCDate() - last.getUTCDay()));
}

/** The plan whose season the week `d` is in. */
export function seasonOfWeek(d: Date, rule: SeasonRule = CLOCK): Plan {
  const monday = utcMondayOf(d);
  if (rule.kind === 'dates') {
    const day = toUtcIso(monday).slice(5);
    const { summerFrom: from, winterFrom: to } = rule;
    return (from < to ? day >= from && day < to : day >= from || day < to) ? 'summer' : 'winter';
  }
  const year = monday.getUTCFullYear();
  const t = monday.getTime();
  return t > lastSundayUtc(year, 2).getTime() && t < lastSundayUtc(year, 9).getTime() ? 'summer' : 'winter';
}

export function isInSeason(date: Date, plan: Plan, rule: SeasonRule = CLOCK): boolean {
  return seasonOfWeek(date, rule) === plan;
}

// Snap the given Monday forward in 7-day steps until it lands inside `plan`'s
// season window. Used so past weeks never accidentally land in the other
// plan's territory when rotated. Safety-bounded to two years so a bad plan
// value can't hang the request.
export function snapForwardToSeason(monday: Date, plan: Plan, rule: SeasonRule = CLOCK): Date {
  const d = new Date(monday.getTime());
  for (let i = 0; i < 110; i++) { // ≈ two full years of weeks
    if (isInSeason(d, plan, rule)) return d;
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return monday;
}

// The dishes of both plans that are served: for every week those of the plan
// whose season it is or, when that plan has none that week, those of the other
// plan, so a week the plans were not lined up for is not left empty. Keeps the
// order of `dishes`.
export function servedDishes<T extends { plan: string; date: Date }>(dishes: T[], rule: SeasonRule = CLOCK): T[] {
  const weekOf = (d: T) => toUtcIso(utcMondayOf(new Date(d.date)));
  const inSeason = (d: T) => d.plan === seasonOfWeek(new Date(d.date), rule);
  const covered = new Set<string>();
  for (const d of dishes) if (inSeason(d)) covered.add(weekOf(d));
  return dishes.filter((d) => inSeason(d) || !covered.has(weekOf(d)));
}
