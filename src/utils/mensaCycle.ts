// Which week of its plan a menu serves in a given week, worked out from the
// calendar alone: how the server lays a menu out by itself ("auto"). Free of
// the database so it can be tested on its own (tests/mensaCycle.test.mjs).
//
// A canteen begins each plan with its week 1 in the first week of the plan's
// season and goes on one plan week a week. The Mensa St. Michael of the
// Gemeinde Brixen goes by the calendar: its winter plan of 2026 began with
// week 1 in the Allerheiligenferien (2 November), and on 9 November, the first
// day back, it served week 2. The menu lay like that until 4 November 2026,
// when weeks still rolled on with the calendar; waiting out the holidays then
// put it a week behind the canteen. So by default every calendar week counts,
// holiday weeks too ("calendar"); a canteen that only counts the weeks it is
// open is the other setting ("school").
//
// Nothing here depends on where the dishes lie now: a week always gets the
// same plan week, so a menu cannot drift, however long it runs. Where a
// canteen counts differently after all, an administrator says which plan week
// it serves in one week (an anchor); the count goes on from there until the
// plan's season ends, and the next season starts with week 1 again.
//
// Days are YYYY-MM-DD; a week is named by its Monday.

import { isOpenWeek, type DayOffOf } from './mensaSchedule';
import { seasonOfWeek, toUtcIso, utcMondayOf, type Plan, type SeasonRule } from './mensaSeason';

/** How the plan weeks go on: every calendar week, or only weeks with the Mensa open. */
export type WeekCount = 'calendar' | 'school';

export const parseWeekCount = (v: unknown): WeekCount => (v === 'school' ? 'school' : 'calendar');

/** "In the week of `monday` the canteen serves week `week` of `plan`." */
export interface WeekAnchor {
  plan: Plan;
  monday: string;
  week: number;
}

export interface CycleSettings {
  rule: SeasonRule;
  count: WeekCount;
  anchors: WeekAnchor[];
}

/** A plan week the server can place: the canteen's plans have six. */
export const MAX_PLAN_WEEK = 60;

const DAY = 86_400_000;
// Far enough for every week of a plan to come round again, whatever the calendar.
const MAX_WEEKS_AHEAD = 160;
// No season rule gives a season this long (the two dates always differ).
const MAX_SEASON_WEEKS = 54;

const parse = (day: string) => Date.parse(`${day}T00:00:00Z`);
const addDays = (day: string, days: number) => toUtcIso(new Date(parse(day) + days * DAY));
const seasonOf = (monday: string, rule: SeasonRule): Plan => seasonOfWeek(new Date(parse(monday)), rule);
const weekdayOf = (d: Date) => d.getUTCDay() || 7;
const isMonday = (day: string) => new Date(parse(day)).getUTCDay() === 1;
const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && !Number.isNaN(parse(v)) && toUtcIso(new Date(parse(v))) === v;

export const mondayOfDay = (day: string): string => toUtcIso(utcMondayOf(new Date(parse(day))));

/** The day (YYYY-MM-DD) it is at `now` in `timeZone`; the machine's own day when that is no zone. */
export function dayInZone(now: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    const day = `${part('year')}-${part('month')}-${part('day')}`;
    if (isDay(day)) return day;
  } catch { /* not a zone */ }
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** The stored anchors, one per plan; whatever is not one left out. */
export function weekAnchorsFrom(json: string | null | undefined): WeekAnchor[] {
  let list: unknown;
  try {
    list = JSON.parse(json || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const anchors: WeekAnchor[] = [];
  for (const a of list) {
    if (!a || typeof a !== 'object') continue;
    const { plan, monday, week } = a as Record<string, unknown>;
    if (plan !== 'summer' && plan !== 'winter') continue;
    if (!isDay(monday) || !isMonday(monday)) continue;
    if (!Number.isInteger(week) || (week as number) < 1 || (week as number) > MAX_PLAN_WEEK) continue;
    if (anchors.some((x) => x.plan === plan)) continue;
    anchors.push({ plan, monday, week: week as number });
  }
  return anchors;
}

/** The Monday the season of the week of `monday` began: where its plan has week 1. */
export function seasonStartOf(monday: string, rule: SeasonRule): string {
  const season = seasonOf(monday, rule);
  let start = monday;
  for (let i = 0; i < MAX_SEASON_WEEKS; i++) {
    const before = addDays(start, -7);
    if (seasonOf(before, rule) !== season) return start;
    start = before;
  }
  return start;
}

/**
 * The plan week (1 to `length`) `plan` serves in the week of `monday`: week 1
 * in the first week of the season, or the anchor's week from its Monday on,
 * then one more each week (each week with the Mensa open, when counting
 * "school" weeks). `isOpen` tells whether a week has a day the plan serves on.
 */
export function planWeekAt(plan: Plan, monday: string, length: number, settings: CycleSettings, isOpen: (monday: string) => boolean): number {
  const start = seasonStartOf(monday, settings.rule);
  // An anchor counts from its week to the end of that season.
  const anchor = settings.anchors.find((a) => a.plan === plan && a.monday >= start && a.monday <= monday);
  const from = anchor?.monday ?? start;
  let steps = 0;
  if (settings.count === 'calendar') {
    steps = Math.round((parse(monday) - parse(from)) / (7 * DAY));
  } else {
    for (let m = from; m < monday; m = addDays(m, 7)) if (isOpen(m)) steps++;
  }
  const first = (anchor?.week ?? 1) - 1;
  return ((first + steps) % length + length) % length + 1;
}

export interface CycleDish {
  id: string;
  plan: string;
  date: Date;
  weekOrdinal: number;
}

const knownWeek = (n: number) => Number.isInteger(n) && n >= 1 && n <= MAX_PLAN_WEEK;

/**
 * The plan week of each dish: its own number, else the number of the week it
 * lies in. Weeks that have none at all (added by hand) come after the
 * highest, in the order they come next from `currentMonday`, so they are
 * named once and keep their place in the cycle.
 */
export function planWeeksOf(dishes: CycleDish[], currentMonday: string): Map<string, number> {
  const weeks = new Map<string, number>();
  for (const plan of ['summer', 'winter']) {
    const own = dishes.filter((d) => d.plan === plan);
    const byMonday = new Map<string, CycleDish[]>();
    for (const d of own) {
      const monday = toUtcIso(utcMondayOf(new Date(d.date)));
      byMonday.set(monday, [...(byMonday.get(monday) ?? []), d]);
    }
    let highest = 0;
    for (const d of own) if (knownWeek(d.weekOrdinal)) highest = Math.max(highest, d.weekOrdinal);
    const unnamed: string[] = [];
    for (const [monday, rows] of byMonday) {
      const counts = new Map<number, number>();
      for (const d of rows) if (knownWeek(d.weekOrdinal)) counts.set(d.weekOrdinal, (counts.get(d.weekOrdinal) ?? 0) + 1);
      // The week's number is what most of its dishes say.
      const named = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
      for (const d of rows) {
        if (knownWeek(d.weekOrdinal)) weeks.set(d.id, d.weekOrdinal);
        else if (named) weeks.set(d.id, named);
      }
      if (!named) unnamed.push(monday);
    }
    const order = [...unnamed.filter((m) => m >= currentMonday).sort(), ...unnamed.filter((m) => m < currentMonday).sort()];
    order.forEach((monday, i) => {
      for (const d of byMonday.get(monday)!) weeks.set(d.id, Math.min(highest + i + 1, MAX_PLAN_WEEK));
    });
  }
  return weeks;
}

export interface WeekMove {
  plan: Plan;
  /** The plan week these dishes are. */
  week: number;
  /** The Monday they lie on now. */
  from: string;
  /** The Monday they go to. */
  to: string;
  shiftDays: number;
  ids: string[];
}

export interface PlanLength {
  plan: Plan;
  /** The highest plan week: the length of the cycle. */
  length: number;
  /** Whether the menu has only this plan (it then runs all year). */
  single: boolean;
}

/** How long each plan's cycle is: the canteen's highest week number, missing weeks included. */
export function planLengths(dishes: CycleDish[], weeks: Map<string, number>): PlanLength[] {
  const lengths: PlanLength[] = [];
  for (const plan of ['summer', 'winter'] as const) {
    const own = dishes.filter((d) => d.plan === plan);
    if (own.length === 0) continue;
    const length = Math.max(1, ...own.map((d) => weeks.get(d.id) ?? 0));
    lengths.push({ plan, length, single: !dishes.some((d) => d.plan === (plan === 'summer' ? 'winter' : 'summer')) });
  }
  return lengths;
}

/**
 * Where each plan week goes: on the next week from `currentMonday` on that is
 * in the plan's season, has a day open and is that plan week by the count.
 * A plan week that has no such week in years is left where it is. Gives no
 * moves once everything is in place.
 */
export function cycleMoves(dishes: CycleDish[], currentMonday: string, dayOffOf: DayOffOf, settings: CycleSettings): WeekMove[] {
  const weeks = planWeeksOf(dishes, currentMonday);
  const moves: WeekMove[] = [];
  for (const { plan, length, single } of planLengths(dishes, weeks)) {
    const own = dishes.filter((d) => d.plan === plan);
    const weekdays = new Set(own.map((d) => weekdayOf(new Date(d.date))));
    const open = new Map<string, boolean>();
    const isOpen = (monday: string) => {
      let v = open.get(monday);
      if (v === undefined) open.set(monday, (v = isOpenWeek(monday, weekdays, dayOffOf)));
      return v;
    };

    const wanted = new Set(own.map((d) => weeks.get(d.id)!));
    const target = new Map<number, string>();
    for (let i = 0; i <= MAX_WEEKS_AHEAD && target.size < wanted.size; i++) {
      const monday = addDays(currentMonday, i * 7);
      if (!single && seasonOf(monday, settings.rule) !== plan) continue;
      if (!isOpen(monday)) continue;
      const week = planWeekAt(plan, monday, length, settings, isOpen);
      if (wanted.has(week) && !target.has(week)) target.set(week, monday);
    }

    const grouped = new Map<string, WeekMove>();
    for (const d of own) {
      const week = weeks.get(d.id)!;
      const to = target.get(week);
      const from = toUtcIso(utcMondayOf(new Date(d.date)));
      if (!to || to === from) continue;
      const key = `${week}|${from}`;
      const move = grouped.get(key) ?? { plan, week, from, to, shiftDays: Math.round((parse(to) - parse(from)) / DAY), ids: [] };
      move.ids.push(d.id);
      grouped.set(key, move);
    }
    moves.push(...[...grouped.values()].sort((a, b) => a.week - b.week || a.from.localeCompare(b.from)));
  }
  return moves;
}

/**
 * The plan week the count gives `plan` in the week of `monday` (whether or
 * not the Mensa is open then), or null when the plan has no dishes.
 */
export function countedWeek(dishes: CycleDish[], plan: Plan, monday: string, dayOffOf: DayOffOf, settings: CycleSettings, currentMonday = monday): number | null {
  const entry = planLengths(dishes, planWeeksOf(dishes, currentMonday)).find((l) => l.plan === plan);
  if (!entry) return null;
  const weekdays = new Set(dishes.filter((d) => d.plan === plan).map((d) => weekdayOf(new Date(d.date))));
  return planWeekAt(plan, monday, entry.length, settings, (m) => isOpenWeek(m, weekdays, dayOffOf));
}

/** The plan week the dishes of `plan` lying in the week of `monday` are, or null when none lie there. */
export function planWeekOn(dishes: CycleDish[], plan: Plan, monday: string, currentMonday = monday): number | null {
  const weeks = planWeeksOf(dishes, currentMonday);
  const counts = new Map<number, number>();
  for (const d of dishes) {
    if (d.plan !== plan || toUtcIso(utcMondayOf(new Date(d.date))) !== monday) continue;
    const week = weeks.get(d.id);
    if (week) counts.set(week, (counts.get(week) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? null;
}

/** Whether the menu has both plans: then each serves only in its own season. */
export const hasBothPlans = (dishes: CycleDish[]) => dishes.some((d) => d.plan === 'summer') && dishes.some((d) => d.plan === 'winter');

/** What the count says for the week of `monday`: the plan of its season and its plan week, or null without dishes. */
export function servedWeek(dishes: CycleDish[], monday: string, dayOffOf: DayOffOf, settings: CycleSettings): { plan: Plan; week: number; seasonStart: string; anchored: boolean } | null {
  const season = seasonOf(monday, settings.rule);
  const plan: Plan | null = dishes.some((d) => d.plan === season) ? season : dishes.length > 0 && !hasBothPlans(dishes) ? (dishes[0]!.plan as Plan) : null;
  if (!plan) return null;
  const week = countedWeek(dishes, plan, monday, dayOffOf, settings);
  if (week === null) return null;
  const seasonStart = seasonStartOf(monday, settings.rule);
  const anchored = settings.anchors.some((a) => a.plan === plan && a.monday >= seasonStart && a.monday <= monday);
  return { plan, week, seasonStart, anchored };
}

/**
 * The anchors after an administrator says that `plan` serves `week` in the
 * week of `monday`: that one in place of the plan's earlier one, none at all
 * when the count gives that week anyway. Anchors of seasons that are over
 * by `currentMonday` go.
 */
export function withAnchor(anchors: WeekAnchor[], anchor: WeekAnchor, plainWeek: number, currentMonday: string, rule: SeasonRule): WeekAnchor[] {
  const since = seasonStartOf(currentMonday, rule);
  const kept = anchors.filter((a) => a.plan !== anchor.plan && a.monday >= since);
  return plainWeek === anchor.week ? kept : [...kept, anchor];
}

/** The anchors of the season under way and the ones ahead: the rest no longer counts. */
export function activeAnchors(anchors: WeekAnchor[], currentMonday: string, rule: SeasonRule): WeekAnchor[] {
  const since = seasonStartOf(currentMonday, rule);
  return anchors.filter((a) => a.monday >= since);
}
