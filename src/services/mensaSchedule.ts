import { prisma } from '../db';
import { logger } from '../utils/logger';
import { currentWeekMondayIso, layoutMenu, previewLayout, rotatePastWeeks } from '../utils/mensaRotate';
import { anchorsBeside, countedWeek, hasBothPlans, mondayOfDay, parseWeekCount, planWeekOn, servedWeek, settledAnchors, weekAnchorsFrom, weekAnchorsJson, withAnchor, type WeekAnchor, type WeekCount } from '../utils/mensaCycle';
import { isInSeason, seasonRuleOf, type Plan, type SeasonRule } from '../utils/mensaSeason';
import { ValidationError } from '../utils/errors';
import { dayOverridesFrom, menuDayOff, parseCalendar, parseMode, type DayOffOf, type DayOverride, type MenuCalendar, type MenuMode } from '../utils/mensaSchedule';
import { storableHolidays, type Holiday } from '../webuntis/holidays';
import { rpc, untisSchool, type UntisSession } from '../webuntis/client';
import { menuOfSchool, schoolByWebuntis, schoolsOfMenu } from './schools';

// How a menu's plans move along the calendar: by themselves ("auto", the
// default), each plan week on the week the canteen serves it (one rotation for
// both plans, counted as in utils/mensaCycle.ts; each day takes the dishes of
// its season) and no dishes on the days off of the official calendar and of
// its schools' WebUntis, or as an administrator sets them ("manual").

export interface SchoolHolidaysOnRecord {
  schoolId: string;
  holidays: Holiday[];
  fetchedAt: Date;
}

export interface MenuSchedule {
  mode: MenuMode;
  season: SeasonRule;
  calendar: MenuCalendar;
  overrides: DayOverride[];
  dayOffOf: DayOffOf;
  schools: SchoolHolidaysOnRecord[];
  /** How the plan weeks go on (utils/mensaCycle.ts). */
  count: WeekCount;
  /**
   * Where the count goes from: the anchor in force (the server's own first
   * one when none is on record yet) and the ones ahead.
   */
  anchors: WeekAnchor[];
  /** The anchors as on record, for writing them only when they change. */
  storedAnchors: string;
}

/** What utils/mensaRotate.layoutMenu needs of a schedule. */
const layoutOf = (schedule: MenuSchedule) => ({ dayOffOf: schedule.dayOffOf, rule: schedule.season, count: schedule.count, anchors: schedule.anchors, storedAnchors: schedule.storedAnchors });

function holidaysFrom(json: string): Holiday[] {
  try {
    const list = JSON.parse(json) as Holiday[];
    return Array.isArray(list) ? list.filter((h) => typeof h?.start === 'string' && typeof h?.end === 'string') : [];
  } catch {
    return [];
  }
}

export async function menuSchedule(menuId: string): Promise<MenuSchedule> {
  const [menu, schoolIds] = await Promise.all([
    prisma.mensaMenu.findUnique({ where: { id: menuId }, select: { mode: true, calendar: true, dayOverrides: true, seasonRule: true, summerFrom: true, winterFrom: true, weekCount: true, weekAnchors: true } }),
    schoolsOfMenu(menuId),
  ]);
  const rows = schoolIds.length > 0 ? await prisma.schoolHolidays.findMany({ where: { schoolId: { in: schoolIds } } }) : [];
  const schools = rows.map((r) => ({ schoolId: r.schoolId, holidays: holidaysFrom(r.holidays), fetchedAt: r.fetchedAt }));
  const calendar = parseCalendar(menu?.calendar);
  const overrides = dayOverridesFrom(menu?.dayOverrides);
  const season = seasonRuleOf(menu?.seasonRule, menu?.summerFrom, menu?.winterFrom);
  return {
    mode: parseMode(menu?.mode),
    season,
    calendar,
    overrides,
    dayOffOf: menuDayOff(calendar, schools.map((s) => s.holidays), overrides),
    schools,
    count: parseWeekCount(menu?.weekCount),
    anchors: settledAnchors(weekAnchorsFrom(menu?.weekAnchors), currentWeekMondayIso(), season),
    storedAnchors: menu?.weekAnchors ?? '[]',
  };
}

/**
 * Brings a menu up to date, how far depends on its mode: lays out both plans,
 * or only rolls past weeks to the end of their plan. Cheap and without any
 * write once everything is in place. Returns how many dishes moved.
 */
export async function arrangeMenu(menuId: string, schedule: MenuSchedule): Promise<number> {
  const moved = schedule.mode === 'auto'
    ? await layoutMenu(menuId, layoutOf(schedule))
    : (await rotatePastWeeks(menuId, 'summer', undefined, schedule.season)) + (await rotatePastWeeks(menuId, 'winter', undefined, schedule.season));
  // Recorded for the panel; a failure here never undoes the move.
  if (moved > 0) {
    await prisma.mensaMenu.update({ where: { id: menuId }, data: { arrangedAt: new Date(), arrangedMoved: moved } }).catch(() => undefined);
  }
  return moved;
}

/**
 * The schedule the menu would have with these settings (nothing stored):
 * what the panel previews before a change is applied.
 */
export interface ScheduleChange {
  mode: MenuMode;
  calendar: MenuCalendar;
  overrides?: DayOverride[];
  seasonRule?: 'dates' | 'clock';
  weekCount?: WeekCount;
  /** Back to the plain count: the corrections go, week 1 in the week the season under way began. */
  resetAnchors?: boolean;
}

export async function proposedSchedule(menuId: string, change: ScheduleChange): Promise<MenuSchedule> {
  const current = await menuSchedule(menuId);
  const menu = await prisma.mensaMenu.findUnique({ where: { id: menuId }, select: { seasonRule: true, summerFrom: true, winterFrom: true } });
  const overrides = change.overrides ?? current.overrides;
  const season = seasonRuleOf(change.seasonRule ?? menu?.seasonRule, menu?.summerFrom, menu?.winterFrom);
  return {
    ...current,
    mode: change.mode,
    calendar: change.calendar,
    overrides,
    season,
    dayOffOf: menuDayOff(change.calendar, current.schools.map((s) => s.holidays), overrides),
    count: change.weekCount ?? current.count,
    anchors: settledAnchors(change.resetAnchors ? [] : current.anchors, currentWeekMondayIso(), season),
  };
}

/** How many dishes a change to `schedule` would move; null in manual mode (nothing is laid out there). */
export async function previewArrange(menuId: string, schedule: MenuSchedule): Promise<number | null> {
  return schedule.mode === 'auto' ? previewLayout(menuId, layoutOf(schedule)) : null;
}

/** Lays out a menu set to "auto" with `schedule` inside a transaction of the caller. */
export async function layoutInTransaction(menuId: string, schedule: MenuSchedule, tx: Parameters<typeof layoutMenu>[2]): Promise<number> {
  return schedule.mode === 'auto' ? layoutMenu(menuId, layoutOf(schedule), tx) : 0;
}

// ─── An administrator's correction of the count ──────────────────────────────

// How far ahead a correction may be set: into the next season of the plan;
// and how far back (it is meant for the week the canteen serves now).
const ANCHOR_AHEAD_DAYS = 400;
const ANCHOR_BACK_DAYS = 28;

export interface AnchorResult {
  plan: Plan;
  /** The plan week the dishes of the chosen week are. */
  week: number;
  /** The Monday from which it is counted on. */
  monday: string;
  /** False when the count gives that week there anyway: nothing to correct. */
  anchored: boolean;
  laidOut: number;
}

const DAY_MS = 86_400_000;
const planName = (plan: Plan) => (plan === 'summer' ? 'Sommerplan' : 'Winterplan');

/**
 * "The week of `chosenMonday` is the one the canteen serves in the week of
 * `targetMonday`": stored as an anchor of the count (none when the count says
 * so anyway), kept from then on, the menu laid out anew. For a menu set to
 * "auto".
 */
export async function anchorPlanWeek(menuId: string, plan: Plan, chosenMonday: string, targetMonday: string): Promise<AnchorResult> {
  const schedule = await menuSchedule(menuId);
  const currentMonday = currentWeekMondayIso();
  const target = mondayOfDay(targetMonday);
  const dishes = await prisma.dish.findMany({ where: { menuId }, select: { id: true, plan: true, date: true, weekOrdinal: true } });
  const week = planWeekOn(dishes, plan, mondayOfDay(chosenMonday), currentMonday);
  if (week === null) throw new ValidationError(`In dieser Woche liegt kein Gericht des ${planName(plan)}s`);
  if (hasBothPlans(dishes) && !isInSeason(new Date(`${target}T00:00:00Z`), plan, schedule.season)) {
    throw new ValidationError(`In dieser Woche gilt der ${planName(plan === 'summer' ? 'winter' : 'summer')}`);
  }
  const ahead = Date.parse(`${target}T00:00:00Z`) - Date.parse(`${currentMonday}T00:00:00Z`);
  if (ahead < -ANCHOR_BACK_DAYS * DAY_MS) throw new ValidationError('Diese Woche liegt zu weit zurück');
  if (ahead > ANCHOR_AHEAD_DAYS * DAY_MS) throw new ValidationError('Diese Woche liegt zu weit in der Zukunft');

  const beside = anchorsBeside(schedule.anchors, target, currentMonday, schedule.season);
  const plain = countedWeek(dishes, plan, target, schedule.dayOffOf, { rule: schedule.season, count: schedule.count, anchors: beside }, currentMonday);
  const anchors = settledAnchors(withAnchor(beside, { plan, monday: target, week }, plain ?? 0, currentMonday), currentMonday, schedule.season);
  const stored = weekAnchorsJson(anchors);
  const next: MenuSchedule = { ...schedule, anchors, storedAnchors: stored };
  const laidOut = await prisma.$transaction(async (tx) => {
    await tx.mensaMenu.update({ where: { id: menuId }, data: { weekAnchors: stored } });
    return schedule.mode === 'auto' ? layoutMenu(menuId, layoutOf(next), tx) : 0;
  });
  if (laidOut > 0) {
    await prisma.mensaMenu.update({ where: { id: menuId }, data: { arrangedAt: new Date(), arrangedMoved: laidOut } }).catch(() => undefined);
  }
  return { plan, week, monday: target, anchored: plain !== week, laidOut };
}

/** What the menu serves this week by the count: for the panel. */
export async function thisWeek(menuId: string, schedule: MenuSchedule) {
  if (schedule.mode !== 'auto') return null;
  const dishes = await prisma.dish.findMany({ where: { menuId }, select: { id: true, plan: true, date: true, weekOrdinal: true } });
  return servedWeek(dishes, currentWeekMondayIso(), schedule.dayOffOf, { rule: schedule.season, count: schedule.count, anchors: schedule.anchors });
}

// ─── A school's holidays from WebUntis ───────────────────────────────────────
// WebUntis only answers a signed-in session, so the holidays are asked for on
// the way when someone of that school uses the app. Twice a day is plenty, per
// school and across the nodes of a cluster: they are in the shared table.

const REFRESH_MS = 12 * 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;
const KEEP_PAST_MS = 31 * 24 * 60 * 60 * 1000;

const nextTry = new Map<string, number>();

async function refresh(session: UntisSession, name: string): Promise<void> {
  const school = await schoolByWebuntis(name);
  if (!school || !(await menuOfSchool(school.id))) return;

  const row = await prisma.schoolHolidays.findUnique({ where: { schoolId: school.id }, select: { fetchedAt: true } });
  if (row && Date.now() - row.fetchedAt.getTime() < REFRESH_MS) return;

  const r = await rpc<unknown>(session, 'getHolidays');
  if (!r.ok) {
    // This session may just be an old one; the next person's can try soon.
    nextTry.set(name, Date.now() + RETRY_MS);
    return;
  }
  const from = new Date(Date.now() - KEEP_PAST_MS).toISOString().slice(0, 10);
  const holidays = storableHolidays(r.result, from);
  // Nothing listed tells nothing: keep what is on record.
  if (holidays.length === 0) return;
  const data = { holidays: JSON.stringify(holidays), fetchedAt: new Date() };
  await prisma.schoolHolidays.upsert({ where: { schoolId: school.id }, create: { schoolId: school.id, ...data }, update: data });
  logger.info('school holidays refreshed', { schoolId: school.id, breaks: holidays.length });
}

/** Keeps the holidays of the session's school fresh; never delays or fails the request it runs beside. */
export function refreshSchoolHolidays(session: UntisSession): void {
  const name = untisSchool(session).toLowerCase();
  if (Date.now() < (nextTry.get(name) ?? 0)) return;
  nextTry.set(name, Date.now() + REFRESH_MS);
  refresh(session, name).catch((err) => {
    nextTry.set(name, Date.now() + RETRY_MS);
    logger.warn('school holidays refresh failed', { error: err instanceof Error ? err.message : String(err) });
  });
}
