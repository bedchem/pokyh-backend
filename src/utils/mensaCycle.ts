// Which week of its plans a menu serves in a given week, worked out from the
// calendar alone: how the server lays a menu out by itself ("auto"). Free of
// the database so it can be tested on its own (tests/mensaCycle.test.mjs).
//
// A canteen runs one rotation of plan weeks, 1 to 6 and again, and never
// starts it over when its plans change: the summer and the winter plan are the
// same six weeks with some dishes swapped for the season (8 of 30 at the Mensa
// St. Michael), and the season of a day only says from which of the two plans
// its dishes come (./mensaSeason, by the dates in the plans' top right corner).
// The Mensa St. Michael of the Gemeinde Brixen counts every calendar week,
// holidays too: week 1 in the week of 30 March 2026 (as the owner's mensa.json
// has it), so week 6 in the week of 19 October and week 1 again in the week of
// 26 October, still with summer dishes, week 2 in the Allerheiligenferien, and
// on 9 November 2026, the first day back and the first school day of the
// winter plan, week 3 (Nudeln pasticciata mit Erbsen, as served that day).
// Counting only the weeks the canteen is open is the other setting ("school").
//
// The count goes from an anchor: "in the week of `monday` the canteen serves
// `week`". The server sets the first one by itself, week 1 in the week the
// season under way began, and keeps it, so the count runs on across every
// change of plan. An administrator's correction is a newer anchor; the count
// goes on from there. Nothing here depends on where the dishes lie now: a week
// always gets the same plan week, so a menu cannot drift, however long it runs.
//
// Days are YYYY-MM-DD; a week is named by its Monday.

import { isClosed, isOpenWeek, type DayOffOf } from './mensaSchedule';
import { seasonBeganOn, seasonOfDay, seasonOfWeek, toUtcIso, utcMondayOf, type Plan, type SeasonRule } from './mensaSeason';

/** How the plan weeks go on: every calendar week, or only weeks with the Mensa open. */
export type WeekCount = 'calendar' | 'school';

export const parseWeekCount = (v: unknown): WeekCount => (v === 'school' ? 'school' : 'calendar');

/**
 * "In the week of `monday` the canteen serves week `week`", of both plans
 * alike; `plan` is the one whose dishes were meant. `auto`: set by the server
 * itself, not by an administrator.
 */
export interface WeekAnchor {
  plan: Plan;
  monday: string;
  week: number;
  auto?: boolean;
}

export interface CycleSettings {
  rule: SeasonRule;
  count: WeekCount;
  anchors: WeekAnchor[];
}

/** A plan week the server can place: the canteen's plans have six. */
export const MAX_PLAN_WEEK = 60;
/** The anchor in force and the ones ahead: what is kept (the column holds 400 characters). */
export const MAX_ANCHORS = 6;

const DAY = 86_400_000;
// Far enough for every week of a plan to come round again, whatever the calendar.
const MAX_WEEKS_AHEAD = 160;
// Counting open weeks one by one is for anchors of the last years, not of centuries.
const MAX_COUNTED_WEEKS = 2_000;
// "school": the anchor moves up to the current week once it is this old, so
// the count never rests on holidays a school's WebUntis no longer lists
// (services/mensaSchedule keeps those 31 days).
const REBASE_AFTER_DAYS = 21;

const parse = (day: string) => Date.parse(`${day}T00:00:00Z`);
const addDays = (day: string, days: number) => toUtcIso(new Date(parse(day) + days * DAY));
const weekdayOf = (d: Date) => d.getUTCDay() || 7;
const isMonday = (day: string) => new Date(parse(day)).getUTCDay() === 1;
const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && !Number.isNaN(parse(v)) && toUtcIso(new Date(parse(v))) === v;
const mod = (n: number, m: number) => ((n % m) + m) % m;
const byMonday = (a: WeekAnchor, b: WeekAnchor) => a.monday.localeCompare(b.monday);

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

/** The stored anchors in the order of their weeks, one per week; whatever is not one left out. */
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
    const { plan, monday, week, auto } = a as Record<string, unknown>;
    if (plan !== 'summer' && plan !== 'winter') continue;
    if (!isDay(monday) || !isMonday(monday) || monday < '2000-01-01' || monday > '2199-12-31') continue;
    if (!Number.isInteger(week) || (week as number) < 1 || (week as number) > MAX_PLAN_WEEK) continue;
    if (anchors.some((x) => x.monday === monday)) continue;
    anchors.push(auto === true ? { plan, monday, week: week as number, auto: true } : { plan, monday, week: week as number });
  }
  return anchors.sort(byMonday);
}

/** The anchors as stored: in the order of their weeks. */
export const weekAnchorsJson = (anchors: WeekAnchor[]): string => JSON.stringify([...anchors].sort(byMonday));

/** The Monday of the week the season under way at the end of the week of `monday` began in. */
export function seasonStartOf(monday: string, rule: SeasonRule): string {
  return toUtcIso(utcMondayOf(seasonBeganOn(new Date(parse(addDays(monday, 6))), rule)));
}

/** Where the server starts counting when nothing is on record: week 1 in the week the season under way began. */
export function defaultAnchor(currentMonday: string, rule: SeasonRule): WeekAnchor {
  const began = seasonBeganOn(new Date(parse(addDays(currentMonday, 6))), rule);
  return { plan: seasonOfDay(began, rule), monday: toUtcIso(utcMondayOf(began)), week: 1, auto: true };
}

/** The anchor in force in the week of `currentMonday` and the ones ahead, at most MAX_ANCHORS: the rest no longer counts. */
export function activeAnchors(anchors: WeekAnchor[], currentMonday: string): WeekAnchor[] {
  const sorted = [...anchors].sort(byMonday);
  const past = sorted.filter((a) => a.monday <= currentMonday);
  const ahead = sorted.filter((a) => a.monday > currentMonday);
  return [...past.slice(-1), ...ahead].slice(0, MAX_ANCHORS);
}

/** The active anchors with one in force this week: the server's own first one when there is none yet. */
export function settledAnchors(anchors: WeekAnchor[], currentMonday: string, rule: SeasonRule): WeekAnchor[] {
  const active = activeAnchors(anchors, currentMonday);
  if (active.some((a) => a.monday <= currentMonday)) return active;
  return activeAnchors([defaultAnchor(currentMonday, rule), ...active], currentMonday);
}

/** The anchor the count of the week of `monday` goes from: the latest on or before it, else the first, counted back. */
export function referenceOf(monday: string, anchors: WeekAnchor[]): WeekAnchor | null {
  let ref: WeekAnchor | null = null;
  for (const a of [...anchors].sort(byMonday)) {
    if (a.monday <= monday) ref = a;
    else return ref ?? a;
  }
  return ref;
}

// Weeks from `from` to `to` (negative backwards): all of them, or those with
// the Mensa open ("school").
function stepsBetween(from: string, to: string, count: WeekCount, isOpen: (monday: string) => boolean): number {
  const weeks = Math.round((parse(to) - parse(from)) / (7 * DAY));
  if (count === 'calendar' || Math.abs(weeks) > MAX_COUNTED_WEEKS) return weeks;
  let steps = 0;
  if (weeks >= 0) for (let m = from; m < to; m = addDays(m, 7)) { if (isOpen(m)) steps++; }
  else for (let m = to; m < from; m = addDays(m, 7)) { if (isOpen(m)) steps--; }
  return steps;
}

/**
 * The plan week (1 to `length`) served in the week of `monday`: the anchor's
 * week from its Monday on, then one more each week (each week with the Mensa
 * open, when counting "school" weeks). `isOpen` tells whether the Mensa is
 * open in a week; `currentMonday` is the week it is now.
 */
export function planWeekAt(monday: string, length: number, settings: CycleSettings, isOpen: (monday: string) => boolean, currentMonday = monday): number {
  const ref = referenceOf(monday, settledAnchors(settings.anchors, currentMonday, settings.rule))!;
  return mod(ref.week - 1 + stepsBetween(ref.monday, monday, settings.count, isOpen), Math.max(1, length)) + 1;
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
    const byWeek = new Map<string, CycleDish[]>();
    for (const d of own) {
      const monday = toUtcIso(utcMondayOf(new Date(d.date)));
      byWeek.set(monday, [...(byWeek.get(monday) ?? []), d]);
    }
    let highest = 0;
    for (const d of own) if (knownWeek(d.weekOrdinal)) highest = Math.max(highest, d.weekOrdinal);
    const unnamed: string[] = [];
    for (const [monday, rows] of byWeek) {
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
      for (const d of byWeek.get(monday)!) weeks.set(d.id, Math.min(highest + i + 1, MAX_PLAN_WEEK));
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

/** Whether the Mensa is open in a week: a day of its plans' weekdays that is no day off. Remembers each week. */
export function openWeeks(dishes: CycleDish[], dayOffOf: DayOffOf): (monday: string) => boolean {
  const weekdays = new Set(dishes.map((d) => weekdayOf(new Date(d.date))));
  const open = new Map<string, boolean>();
  return (monday) => {
    let v = open.get(monday);
    if (v === undefined) open.set(monday, (v = isOpenWeek(monday, weekdays, dayOffOf)));
    return v;
  };
}

// Whether `plan` serves in the week of `monday`: on one of its weekdays that
// is in its season (any, for a menu with only this plan) and no day off.
function servesIn(monday: string, plan: Plan, weekdays: Set<number>, dayOffOf: DayOffOf, rule: SeasonRule | null): boolean {
  for (const weekday of weekdays) {
    const day = addDays(monday, weekday - 1);
    if (rule && seasonOfDay(new Date(parse(day)), rule) !== plan) continue;
    if (!isClosed(dayOffOf(day))) return true;
  }
  return false;
}

/**
 * Where each plan week goes: on the next week from `currentMonday` on that is
 * that plan week by the count and has a day the plan serves (in its season,
 * no day off). In a week the plans change, both plans' week lies there and
 * each day takes the dishes of its own season (mensaSeason.servedDishes). A
 * plan week that has no such week in years is left where it is. Gives no
 * moves once everything is in place.
 */
export function cycleMoves(dishes: CycleDish[], currentMonday: string, dayOffOf: DayOffOf, settings: CycleSettings): WeekMove[] {
  const weeks = planWeeksOf(dishes, currentMonday);
  const isOpen = openWeeks(dishes, dayOffOf);
  const counted = { ...settings, anchors: settledAnchors(settings.anchors, currentMonday, settings.rule) };
  const moves: WeekMove[] = [];
  for (const { plan, length, single } of planLengths(dishes, weeks)) {
    const own = dishes.filter((d) => d.plan === plan);
    const weekdays = new Set(own.map((d) => weekdayOf(new Date(d.date))));

    const wanted = new Set(own.map((d) => weeks.get(d.id)!));
    const target = new Map<number, string>();
    for (let i = 0; i <= MAX_WEEKS_AHEAD && target.size < wanted.size; i++) {
      const monday = addDays(currentMonday, i * 7);
      if (!servesIn(monday, plan, weekdays, dayOffOf, single ? null : settings.rule)) continue;
      const week = planWeekAt(monday, length, counted, isOpen, currentMonday);
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
  return planWeekAt(monday, entry.length, settings, openWeeks(dishes, dayOffOf), currentMonday);
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

export interface ServedWeek {
  /** The plan of most of the week's school days. */
  plan: Plan;
  week: number;
  /** How many weeks the plan's round has. */
  length: number;
  /** The anchor the count goes from: in the week of `from` week `fromWeek`. */
  from: string;
  fromWeek: number;
  /** Whether that anchor is an administrator's correction. */
  anchored: boolean;
}

/** What the count says for the week of `monday`: its plan and plan week, or null without dishes. */
export function servedWeek(dishes: CycleDish[], monday: string, dayOffOf: DayOffOf, settings: CycleSettings, currentMonday = monday): ServedWeek | null {
  const season = seasonOfWeek(new Date(parse(monday)), settings.rule);
  const plan: Plan | null = dishes.some((d) => d.plan === season) ? season : dishes.length > 0 && !hasBothPlans(dishes) ? (dishes[0]!.plan as Plan) : null;
  if (!plan) return null;
  const entry = planLengths(dishes, planWeeksOf(dishes, currentMonday)).find((l) => l.plan === plan);
  if (!entry) return null;
  const week = planWeekAt(monday, entry.length, settings, openWeeks(dishes, dayOffOf), currentMonday);
  const ref = referenceOf(monday, settledAnchors(settings.anchors, currentMonday, settings.rule))!;
  return { plan, week, length: entry.length, from: ref.monday, fromWeek: ref.week, anchored: ref.auto !== true };
}

/**
 * The anchors a correction for the week of `monday` stands beside: the ones in
 * force without those it overrides (one for the same week, and the ones
 * between it and now: the newest word counts), with the server's own first
 * one when none is left in force.
 */
export function anchorsBeside(anchors: WeekAnchor[], monday: string, currentMonday: string, rule: SeasonRule): WeekAnchor[] {
  const left = settledAnchors(anchors, currentMonday, rule).filter((a) => a.monday !== monday && !(a.monday > monday && a.monday <= currentMonday));
  return settledAnchors(left, currentMonday, rule);
}

/**
 * The anchors after an administrator says that the canteen serves `anchor.week`
 * in the week of `anchor.monday`: `beside` (anchorsBeside) and that one, unless
 * the count from `beside` gives that week there anyway (`plainWeek`).
 */
export function withAnchor(beside: WeekAnchor[], anchor: WeekAnchor, plainWeek: number, currentMonday: string): WeekAnchor[] {
  const { auto: _auto, ...own } = anchor;
  const next = plainWeek === anchor.week ? beside : [...beside, own];
  // The one in force goes first when there are too many.
  return activeAnchors(next, currentMonday);
}

/**
 * The anchors as the server keeps them: the ones in force with its own first
 * one, and, when counting "school" weeks, the one in force moved up to this
 * week once it is old, with the week the count gives there (the longest plan's
 * cycle). Equal to `anchors` when nothing is to change.
 */
export function keptAnchors(dishes: CycleDish[], currentMonday: string, dayOffOf: DayOffOf, settings: CycleSettings): WeekAnchor[] {
  const settled = settledAnchors(settings.anchors, currentMonday, settings.rule);
  const ref = referenceOf(currentMonday, settled)!;
  if (settings.count !== 'school' || parse(currentMonday) - parse(ref.monday) < REBASE_AFTER_DAYS * DAY) return settled;
  const lengths = planLengths(dishes, planWeeksOf(dishes, currentMonday));
  if (lengths.length === 0 || lengths.some((l) => l.length !== lengths[0]!.length)) return settled;
  const week = planWeekAt(currentMonday, lengths[0]!.length, { ...settings, anchors: settled }, openWeeks(dishes, dayOffOf), currentMonday);
  const moved: WeekAnchor = { plan: seasonOfWeek(new Date(parse(currentMonday)), settings.rule), monday: currentMonday, week, ...(ref.auto ? { auto: true } : {}) };
  return activeAnchors([...settled.filter((a) => a !== ref), moved], currentMonday);
}
