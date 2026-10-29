// Which of a menu's two plans serves a week. Free of the database so it can be
// unit-tested on its own (tests/mensaSeason.test.mjs).
//
// The seasons follow the clocks, not the calendar: summer is every week after
// the switch to summer time (last Sunday of March) up to the switch to winter
// time (last Sunday of October). Both switches fall on a Sunday, the last day
// of a week, so every week lies wholly in one season and the other plan takes
// over on the Monday after the switch.
//
// All dates are UTC midnights, because Prisma reads a DATE column as one.

export type Plan = 'summer' | 'winter';

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
export function seasonOfWeek(d: Date): Plan {
  const monday = utcMondayOf(d);
  const year = monday.getUTCFullYear();
  const t = monday.getTime();
  return t > lastSundayUtc(year, 2).getTime() && t < lastSundayUtc(year, 9).getTime() ? 'summer' : 'winter';
}

export function isInSeason(date: Date, plan: Plan): boolean {
  return seasonOfWeek(date) === plan;
}

// Snap the given Monday forward in 7-day steps until it lands inside `plan`'s
// season window. Used so past weeks never accidentally land in the other
// plan's territory when rotated. Safety-bounded to two years so a bad plan
// value can't hang the request.
export function snapForwardToSeason(monday: Date, plan: Plan): Date {
  const d = new Date(monday.getTime());
  for (let i = 0; i < 110; i++) { // ≈ two full years of weeks
    if (isInSeason(d, plan)) return d;
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return monday;
}

// The dishes of both plans that are served: for every week those of the plan
// whose season it is or, when that plan has none that week, those of the other
// plan, so a week the plans were not lined up for is not left empty. Keeps the
// order of `dishes`.
export function servedDishes<T extends { plan: string; date: Date }>(dishes: T[]): T[] {
  const weekOf = (d: T) => toUtcIso(utcMondayOf(new Date(d.date)));
  const inSeason = (d: T) => d.plan === seasonOfWeek(new Date(d.date));
  const covered = new Set<string>();
  for (const d of dishes) if (inSeason(d)) covered.add(weekOf(d));
  return dishes.filter((d) => inSeason(d) || !covered.has(weekOf(d)));
}
