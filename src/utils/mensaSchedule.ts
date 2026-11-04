// Where a menu's weeks go when the server lays them out by itself ("auto"):
// one plan week on every school week of its season, holidays waited out, the
// next week after them. Which days are off comes from the outside as a
// function, so all of this is free of the database and tested on its own
// (tests/mensaSchedule.test.mjs).
//
// Days are YYYY-MM-DD; a week is named by its Monday.

import { suedtirolDayOff, type DayOffReason } from './schoolCalendarSuedtirol';
import { CLOCK, isInSeason, seasonOfWeek, servedDishes, toUtcIso, utcMondayOf, type Plan, type SeasonRule } from './mensaSeason';

export type MenuMode = 'auto' | 'manual';
export type MenuCalendar = 'suedtirol' | 'webuntis';

export const parseMode = (v: unknown): MenuMode => (v === 'manual' ? 'manual' : 'auto');
export const parseCalendar = (v: unknown): MenuCalendar => (v === 'webuntis' ? 'webuntis' : 'suedtirol');

/** 'school': a day off only the school's WebUntis knows about; 'closed': the menu's own correction. */
export type DayOff = DayOffReason | 'school' | 'closed';
export type DayOffOf = (day: string) => DayOff | null;

export interface HolidayRange {
  start: string;
  end: string;
}

/** A menu's own correction: closed although it is school, or open although it is not. */
export interface DayOverride extends HolidayRange {
  open: boolean;
}

const MAX_OVERRIDES = 60;
const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

/** The stored corrections, whatever is not one left out. */
export function dayOverridesFrom(json: string | null | undefined): DayOverride[] {
  let list: unknown;
  try {
    list = JSON.parse(json ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list
    .filter((o): o is DayOverride => isDay(o?.start) && isDay(o?.end) && o.end >= o.start && typeof o.open === 'boolean')
    .slice(0, MAX_OVERRIDES)
    .map(({ start, end, open }) => ({ start, end, open }));
}

const DAY = 86_400_000;
// Far enough for a plan to wait for its next season, whatever the calendar.
const MAX_WEEKS_AHEAD = 160;

const parse = (day: string) => Date.parse(`${day}T00:00:00Z`);
const addDays = (day: string, days: number) => toUtcIso(new Date(parse(day) + days * DAY));
const mondayOf = (d: Date) => toUtcIso(utcMondayOf(d));

/** No Mensa that day: a break or a holiday, not an ordinary weekend. */
export const isClosed = (reason: DayOff | null) => reason !== null && reason !== 'weekend';

/**
 * The days off of a menu: the official calendar (when it is the chosen one)
 * and the WebUntis holidays of its schools. Holidays of one school alone do
 * not close a shared canteen, so those count when every school that has
 * holidays on record is off; a school without any tells nothing yet.
 */
export function menuDayOff(calendar: MenuCalendar, schools: HolidayRange[][], overrides: DayOverride[] = []): DayOffOf {
  const known = schools.filter((list) => list.length > 0);
  return (day) => {
    const override = overrides.find((o) => o.start <= day && day <= o.end);
    if (override) return override.open ? null : 'closed';
    const official = calendar === 'suedtirol' ? suedtirolDayOff(day) : null;
    if (isClosed(official)) return official;
    if (known.length > 0 && known.every((list) => list.some((h) => h.start <= day && day <= h.end))) return 'school';
    if (official) return official;
    const weekday = new Date(parse(day)).getUTCDay();
    return weekday === 0 || weekday === 6 ? 'weekend' : null;
  };
}

// Whether a plan that serves on `weekdays` (1 = Monday … 7 = Sunday) has a day
// open in the week of `monday`. A week with a single school day counts: that
// day needs a menu too.
function isOpenWeek(monday: string, weekdays: Set<number>, dayOffOf: DayOffOf): boolean {
  for (const weekday of weekdays) {
    if (!isClosed(dayOffOf(addDays(monday, weekday - 1)))) return true;
  }
  return false;
}

export interface MenuDishRow {
  id: string;
  plan: string;
  date: Date;
}

export interface WeekMove {
  plan: Plan;
  from: string;
  to: string;
  shiftDays: number;
  ids: string[];
}

const weekdayOf = (d: Date) => d.getUTCDay() || 7;

/**
 * The moves that put both plans of a menu where they belong. Each plan keeps
 * the order of its weeks, past ones behind the others, and gets one week on
 * each school week of its season from now on. A menu with only one plan runs
 * all year. Gives no moves once everything is in place.
 *
 * This week is special, because people may already have read or eaten from
 * it: a week that is being served stays, even outside its season, as long as
 * the other plan has nothing for it, and a plan only takes this week over
 * when nothing else is on it.
 */
export function planMoves(dishes: MenuDishRow[], currentMonday: string, dayOffOf: DayOffOf, rule: SeasonRule = CLOCK): WeekMove[] {
  const moves: WeekMove[] = [];
  const rowsOf = (plan: Plan) => dishes.filter((d) => d.plan === plan);

  for (const plan of ['summer', 'winter'] as const) {
    const own = rowsOf(plan);
    if (own.length === 0) continue;
    const other = rowsOf(plan === 'summer' ? 'winter' : 'summer');

    const weeks = new Map<string, string[]>();
    const weekdays = new Set<number>();
    for (const d of own) {
      const date = new Date(d.date);
      const monday = mondayOf(date);
      weeks.set(monday, [...(weeks.get(monday) ?? []), d.id]);
      weekdays.add(weekdayOf(date));
    }

    const inSeason = (monday: string) => other.length === 0 || isInSeason(new Date(parse(monday)), plan, rule);
    const isSlot = (monday: string) => inSeason(monday) && isOpenWeek(monday, weekdays, dayOffOf);

    const hasThisWeek = weeks.has(currentMonday);
    const otherHasThisWeek = other.some((d) => mondayOf(new Date(d.date)) === currentMonday);
    const takesThisWeek = isOpenWeek(currentMonday, weekdays, dayOffOf)
      && (inSeason(currentMonday) ? hasThisWeek || !otherHasThisWeek : hasThisWeek && !otherHasThisWeek);

    const mondays = [...weeks.keys()].sort();
    const order = [...mondays.filter((m) => m >= currentMonday), ...mondays.filter((m) => m < currentMonday)];

    const slots: string[] = takesThisWeek ? [currentMonday] : [];
    for (let i = 1; slots.length < order.length && i <= MAX_WEEKS_AHEAD; i++) {
      const monday = addDays(currentMonday, i * 7);
      if (isSlot(monday)) slots.push(monday);
    }
    // No room at all (a calendar that is closed for years): leave the plan be.
    if (slots.length < order.length) continue;

    order.forEach((from, i) => {
      const to = slots[i]!;
      if (from !== to) moves.push({ plan, from, to, shiftDays: Math.round((parse(to) - parse(from)) / DAY), ids: weeks.get(from)! });
    });
  }
  return moves;
}

/**
 * What the public sees of a laid-out menu: every week from the plan of its
 * season, no dishes on days off, and only as far as the weeks run on without
 * a gap. A plan's cycle is shorter than its season, so behind it lie school
 * weeks it will only roll onto later, and then the other plan's weeks months
 * ahead; those stay hidden until the plans really meet.
 */
export function publicDishes<T extends { plan: string; date: Date }>(dishes: T[], currentMonday: string, dayOffOf: DayOffOf, rule: SeasonRule = CLOCK): T[] {
  const weekdaysOf = new Map<string, Set<number>>();
  for (const d of dishes) {
    const set = weekdaysOf.get(d.plan) ?? new Set<number>();
    set.add(weekdayOf(new Date(d.date)));
    weekdaysOf.set(d.plan, set);
  }
  const isOpen = (monday: string) => {
    const season = seasonOfWeek(new Date(parse(monday)), rule);
    const weekdays = weekdaysOf.get(season) ?? weekdaysOf.get(season === 'summer' ? 'winter' : 'summer');
    return weekdays ? isOpenWeek(monday, weekdays, dayOffOf) : false;
  };

  const served = servedDishes(dishes, rule);
  const weeks = [...new Set(served.map((d) => mondayOf(new Date(d.date))))].filter((m) => m >= currentMonday).sort();
  let lastShown = weeks[0] ?? currentMonday;
  for (const week of weeks) {
    let gap = false;
    for (let m = addDays(lastShown, 7); m < week && !gap; m = addDays(m, 7)) gap = isOpen(m);
    if (gap) break;
    lastShown = week;
  }

  return served.filter((d) => {
    const date = new Date(d.date);
    return mondayOf(date) <= lastShown && !isClosed(dayOffOf(toUtcIso(date)));
  });
}

export type BreakReason = Exclude<DayOff, 'weekend'>;

export interface MenuBreak {
  /** First day off (YYYY-MM-DD), the weekend before it included. */
  start: string;
  /** Last day off, the weekend after it included. */
  end: string;
  reason: BreakReason;
}

const WEIGHT: Record<DayOff, number> = { weekend: 0, bridge: 1, school: 2, closed: 2, holiday: 3, allSaints: 4, winter: 4, easter: 4, christmas: 5, summer: 6 };

// However long a break runs on past the edge of the range asked for.
const MAX_BREAK_DAYS = 130;

/** The breaks that touch `from`..`to`: runs of days off with more than a weekend in them. */
export function menuBreaks(dayOffOf: DayOffOf, from: string, to: string): MenuBreak[] {
  const breaks: MenuBreak[] = [];
  let run: { start: string; end: string; reason: DayOff } | null = null;
  const last = addDays(to, MAX_BREAK_DAYS);
  for (let day = addDays(from, -MAX_BREAK_DAYS); day <= last; day = addDays(day, 1)) {
    const reason = dayOffOf(day);
    if (!reason) {
      if (run && run.reason !== 'weekend') breaks.push({ start: run.start, end: run.end, reason: run.reason });
      run = null;
      continue;
    }
    if (!run) run = { start: day, end: day, reason };
    run.end = day;
    if (WEIGHT[reason] > WEIGHT[run.reason]) run.reason = reason;
  }
  return breaks.filter((b) => b.end >= from && b.start <= to);
}
