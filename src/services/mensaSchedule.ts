import { prisma } from '../db';
import { logger } from '../utils/logger';
import { layoutMenu, rotatePastWeeks } from '../utils/mensaRotate';
import { seasonRuleOf, type SeasonRule } from '../utils/mensaSeason';
import { dayOverridesFrom, menuDayOff, parseCalendar, parseMode, type DayOffOf, type DayOverride, type MenuCalendar, type MenuMode } from '../utils/mensaSchedule';
import { storableHolidays, type Holiday } from '../webuntis/holidays';
import { rpc, untisSchool, type UntisSession } from '../webuntis/client';
import { menuOfSchool, schoolByWebuntis, schoolsOfMenu } from './schools';

// How a menu's plans move along the calendar: by themselves ("auto", the
// default), waiting out the holidays of the official calendar and of its
// schools' WebUntis, or as an administrator sets them ("manual").

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
}

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
    prisma.mensaMenu.findUnique({ where: { id: menuId }, select: { mode: true, calendar: true, dayOverrides: true, seasonRule: true, summerFrom: true, winterFrom: true } }),
    schoolsOfMenu(menuId),
  ]);
  const rows = schoolIds.length > 0 ? await prisma.schoolHolidays.findMany({ where: { schoolId: { in: schoolIds } } }) : [];
  const schools = rows.map((r) => ({ schoolId: r.schoolId, holidays: holidaysFrom(r.holidays), fetchedAt: r.fetchedAt }));
  const calendar = parseCalendar(menu?.calendar);
  const overrides = dayOverridesFrom(menu?.dayOverrides);
  return {
    mode: parseMode(menu?.mode),
    season: seasonRuleOf(menu?.seasonRule, menu?.summerFrom, menu?.winterFrom),
    calendar,
    overrides,
    dayOffOf: menuDayOff(calendar, schools.map((s) => s.holidays), overrides),
    schools,
  };
}

/**
 * Brings a menu up to date, how far depends on its mode: lays out both plans,
 * or only rolls past weeks to the end of their plan. Cheap and without any
 * write once everything is in place. Returns how many dishes moved.
 */
export async function arrangeMenu(menuId: string, schedule: MenuSchedule): Promise<number> {
  if (schedule.mode === 'auto') return layoutMenu(menuId, schedule.dayOffOf, undefined, schedule.season);
  return (await rotatePastWeeks(menuId, 'summer', undefined, schedule.season)) + (await rotatePastWeeks(menuId, 'winter', undefined, schedule.season));
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
