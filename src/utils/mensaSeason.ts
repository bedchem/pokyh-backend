// Which of a menu's two plans serves a day. Free of the database so it can be
// unit-tested on its own (tests/mensaSeason.test.mjs).
//
// By dates (SeasonRule 'dates'), a day goes by its date, as the canteen's plans
// say in their top right corner ("1. April bis 31. Oktober", "1. November bis
// 31. März"): in the week of 1 November 2026, a Sunday, Monday to Saturday are
// still the summer plan's. A week the date falls in has days of both.
//
// With the clocks ('clock'), summer is every week after the switch to summer
// time (last Sunday of March) up to the switch to winter time (last Sunday of
// October). Both switches fall on a Sunday, the last day of a week, so every
// week lies wholly in one season and the other plan takes over on the Monday
// after the switch.
//
// Which plan week is served is the same for both plans (./mensaCycle): the
// season only says from which plan the dishes of a day come.
//
// All dates are UTC midnights, because Prisma reads a DATE column as one.

export type Plan = 'summer' | 'winter';

/**
 * When a menu's plans change: on the dates its canteen names (MM-DD, read from
 * its plans), or with the clocks.
 */
export interface SeasonRule {
  kind: 'dates' | 'clock';
  summerFrom: string;
  winterFrom: string;
}

export const CLOCK: SeasonRule = { kind: 'clock', summerFrom: '', winterFrom: '' };

const DAY = 86_400_000;
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

/** The plan whose season the day `d` is in. */
export function seasonOfDay(d: Date, rule: SeasonRule = CLOCK): Plan {
  if (rule.kind === 'dates') {
    const day = toUtcIso(d).slice(5);
    const { summerFrom: from, winterFrom: to } = rule;
    return (from < to ? day >= from && day < to : day >= from || day < to) ? 'summer' : 'winter';
  }
  const monday = utcMondayOf(d);
  const year = monday.getUTCFullYear();
  const t = monday.getTime();
  return t > lastSundayUtc(year, 2).getTime() && t < lastSundayUtc(year, 9).getTime() ? 'summer' : 'winter';
}

// Monday to Friday of the week `d` is in.
function schoolDaysOf(d: Date): Date[] {
  const monday = utcMondayOf(d).getTime();
  return [0, 1, 2, 3, 4].map((i) => new Date(monday + i * DAY));
}

/** The plan of most of the school days (Monday to Friday) of the week `d` is in. */
export function seasonOfWeek(d: Date, rule: SeasonRule = CLOCK): Plan {
  const summer = schoolDaysOf(d).filter((day) => seasonOfDay(day, rule) === 'summer').length;
  return summer >= 3 ? 'summer' : 'winter';
}

/** Whether `plan` serves on a school day of the week `d` is in. */
export function isInSeason(d: Date, plan: Plan, rule: SeasonRule = CLOCK): boolean {
  return schoolDaysOf(d).some((day) => seasonOfDay(day, rule) === plan);
}

/** The first day of the season the day `d` is in: the canteen's date, or the Monday after the clocks changed. */
export function seasonBeganOn(d: Date, rule: SeasonRule = CLOCK): Date {
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const year = d.getUTCFullYear();
  const starts: number[] = [];
  for (const y of [year - 1, year]) {
    if (rule.kind === 'dates') {
      for (const md of [rule.summerFrom, rule.winterFrom]) starts.push(Date.UTC(y, Number(md.slice(0, 2)) - 1, Number(md.slice(3))));
    } else {
      starts.push(lastSundayUtc(y, 2).getTime() + DAY, lastSundayUtc(y, 9).getTime() + DAY);
    }
  }
  return new Date(Math.max(...starts.filter((s) => s <= t)));
}

// Snap the given Monday forward in 7-day steps until it lands in a week
// `plan` serves in. Used so past weeks never land wholly in the other plan's
// territory when rotated. Safety-bounded to two years so a bad plan value
// can't hang the request.
export function snapForwardToSeason(monday: Date, plan: Plan, rule: SeasonRule = CLOCK): Date {
  const d = new Date(monday.getTime());
  for (let i = 0; i < 110; i++) { // ≈ two full years of weeks
    if (isInSeason(d, plan, rule)) return d;
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return monday;
}

// The dishes of both plans that are served: for every day those of the plan
// whose season it is or, when that plan has none that day, those of the other
// plan, so a day the plans were not lined up for is not left empty. Keeps the
// order of `dishes`.
export function servedDishes<T extends { plan: string; date: Date }>(dishes: T[], rule: SeasonRule = CLOCK): T[] {
  const dayOf = (d: T) => toUtcIso(new Date(d.date));
  const inSeason = (d: T) => d.plan === seasonOfDay(new Date(d.date), rule);
  const covered = new Set<string>();
  for (const d of dishes) if (inSeason(d)) covered.add(dayOf(d));
  return dishes.filter((d) => inSeason(d) || !covered.has(dayOf(d)));
}
