// The days a menu is closed, its breaks, and what the public sees of a menu the
// server lays out by itself ("auto"; which plan week goes where is in
// ./mensaCycle). Which days are off comes from the outside as a function, so
// all of this is free of the database and tested on its own
// (tests/mensaSchedule.test.mjs).
//
// Days are YYYY-MM-DD; a week is named by its Monday.

import { suedtirolDayOff, type DayOffReason } from './schoolCalendarSuedtirol';
import { CLOCK, servedDishes, toUtcIso, utcMondayOf, type SeasonRule } from './mensaSeason';

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
  /** Why (shown in the panel only), e.g. "Betriebsausflug". */
  note?: string;
}

const MAX_NOTE = 80;
/** A note as stored: one line of plain text, at most MAX_NOTE characters. */
function cleanNote(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[\p{C}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE) : '';
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
    .map(({ start, end, open, note }) => {
      const text = cleanNote(note);
      return text ? { start, end, open, note: text } : { start, end, open };
    });
}

const DAY = 86_400_000;

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
export function isOpenWeek(monday: string, weekdays: Set<number>, dayOffOf: DayOffOf): boolean {
  for (const weekday of weekdays) {
    if (!isClosed(dayOffOf(addDays(monday, weekday - 1)))) return true;
  }
  return false;
}

const weekdayOf = (d: Date) => d.getUTCDay() || 7;

/**
 * What the public sees of a laid-out menu: every day the dishes of the plan
 * of its season (mensaSeason.servedDishes), no dishes on days off, and only as far as the weeks run on without
 * a gap. A plan's cycle is shorter than its season, so behind it lie school
 * weeks it will only roll onto later, and then the other plan's weeks months
 * ahead; those stay hidden until the plans really meet.
 */
export function publicDishes<T extends { plan: string; date: Date }>(dishes: T[], currentMonday: string, dayOffOf: DayOffOf, rule: SeasonRule = CLOCK): T[] {
  // Both plans serve on the same weekdays; a day takes the dishes of its season.
  const weekdays = new Set(dishes.map((d) => weekdayOf(new Date(d.date))));
  const isOpen = (monday: string) => weekdays.size > 0 && isOpenWeek(monday, weekdays, dayOffOf);

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
