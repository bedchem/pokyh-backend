import { prisma } from '../db';
import { config } from '../config';
import { logger } from './logger';
import { Prisma } from '@prisma/client';
import { CLOCK, snapForwardToSeason, toUtcIso, utcMondayOf, type Plan, type SeasonRule } from './mensaSeason';
import { cycleMoves, dayInZone, keptAnchors, mondayOfDay, planWeeksOf, weekAnchorsJson, type CycleSettings } from './mensaCycle';
import type { DayOffOf } from './mensaSchedule';

type PrismaLike = Prisma.TransactionClient | typeof prisma;

// ─── date helpers (UTC, because Prisma reads DATE as UTC-midnight) ───────────
// The season of a week and the Monday helpers live in ./mensaSeason.

function utcDow(d: Date): number { return d.getUTCDay() || 7; }
function addDays(d: Date, days: number): Date {
  const r = new Date(d.getTime());
  r.setUTCDate(r.getUTCDate() + days);
  return r;
}

/**
 * Today (YYYY-MM-DD) where the Mensa is (MENSA_TIMEZONE, Europe/Rome unless
 * set): a server running on UTC would otherwise still see Sunday for the first
 * hours of a Monday.
 */
export function mensaTodayIso(now = new Date()): string {
  return dayInZone(now, config.mensaTimezone);
}

// This week's Monday as a UTC midnight, comparable with Prisma's DATE values.
function currentLocalMonday(): Date {
  return new Date(`${mondayOfDay(mensaTodayIso())}T00:00:00Z`);
}

// This week's Monday (YYYY-MM-DD): the week the public menu is served for.
export function currentWeekMondayIso(): string { return toUtcIso(currentLocalMonday()); }

// ─── plan queries ────────────────────────────────────────────────────────────
// Every operation works on one menu's summer or winter plan: menus of
// different schools never move each other's weeks.

async function planMondays(db: PrismaLike, menuId: string, plan: Plan): Promise<string[]> {
  const dishes = await db.dish.findMany({ where: { menuId, plan }, select: { date: true } });
  const set = new Set<string>();
  for (const d of dishes) set.add(toUtcIso(utcMondayOf(new Date(d.date))));
  return [...set].sort();
}

// Return the last Monday of `plan` that is on or after this week's Monday.
// Used to compute "where does plan X end" for the cross-plan handoff.
export async function lastFutureMondayIso(db: PrismaLike, menuId: string, plan: Plan): Promise<string | null> {
  const today = currentLocalMonday();
  const mondays = await planMondays(db, menuId, plan);
  const future = mondays.filter((m) => new Date(m + 'T00:00:00Z') >= today);
  return future.length > 0 ? future[future.length - 1] : null;
}

// Return the first Monday recorded for `plan`, regardless of past/future.
export async function firstMondayIso(db: PrismaLike, menuId: string, plan: Plan): Promise<string | null> {
  const mondays = await planMondays(db, menuId, plan);
  return mondays.length > 0 ? mondays[0] : null;
}

// ─── core operations ────────────────────────────────────────────────────────

// Reassign every dish so that the week the user chose lands on `target`, every
// other week is exactly (idx - anchorIdx) * 7 days from `target`, and each
// dish keeps its weekday. Idempotent (no-op when nothing changes).
export async function normalizePlanAroundAnchor(
  db: PrismaLike, menuId: string, plan: Plan, chosenMondayIso: string, targetMondayIso: string,
): Promise<number> {
  const dishes = await db.dish.findMany({ where: { menuId, plan }, select: { id: true, date: true } });
  if (dishes.length === 0) return 0;

  const mondaySet = new Set<string>();
  for (const d of dishes) mondaySet.add(toUtcIso(utcMondayOf(new Date(d.date))));
  const mondays = [...mondaySet].sort();
  const anchorIdx = mondays.indexOf(chosenMondayIso);
  if (anchorIdx === -1) return 0;

  const target = new Date(targetMondayIso + 'T00:00:00Z');
  let n = 0;
  for (const d of dishes) {
    const dt = new Date(d.date);
    const wd = utcDow(dt);
    const oldMonIso = toUtcIso(utcMondayOf(dt));
    const idx = mondays.indexOf(oldMonIso);
    const newMon = addDays(target, (idx - anchorIdx) * 7);
    const newDate = addDays(newMon, wd - 1);
    if (newDate.getTime() === dt.getTime()) continue;
    await db.dish.update({ where: { id: d.id }, data: { date: newDate } });
    n++;
  }
  return n;
}

// Push every past week to the end of the plan, preserving relative order,
// and snapping each landing Monday into the plan's season window. Robust
// against weeks that are far in the past (multi-cycle) — each past Monday
// lands right after the current latest one.
export async function rotatePastWeeks(menuId: string, plan: Plan, tx?: PrismaLike, rule: SeasonRule = CLOCK): Promise<number> {
  const db: PrismaLike = tx ?? prisma;
  const currentMonday = currentLocalMonday();

  const mondays = await planMondays(db, menuId, plan);
  if (mondays.length === 0) return 0;

  const past = mondays.filter((m) => new Date(m + 'T00:00:00Z') < currentMonday);
  if (past.length === 0) return 0;

  // Anchor for the "next slot" starts at the latest future Monday. If nothing
  // is in the future, start one week before "this week" so the first past
  // week lands on this week.
  const future = mondays.filter((m) => new Date(m + 'T00:00:00Z') >= currentMonday);
  let lastAnchor: Date = future.length > 0
    ? new Date(future[future.length - 1] + 'T00:00:00Z')
    : addDays(currentMonday, -7);

  async function run(client: PrismaLike): Promise<number> {
    let n = 0;
    for (const monIso of past) {
      const monStart = new Date(monIso + 'T00:00:00Z');
      const monEnd = addDays(monStart, 7);
      // Next available slot in this plan's season.
      const rawNext = addDays(lastAnchor, 7);
      const newMon = snapForwardToSeason(rawNext, plan, rule);
      const shiftDays = Math.round((newMon.getTime() - monStart.getTime()) / 86400000);
      if (shiftDays === 0) { lastAnchor = newMon; continue; }
      const r = await client.$executeRaw`UPDATE dishes SET date = DATE_ADD(date, INTERVAL ${shiftDays} DAY) WHERE menu_id = ${menuId} AND plan = ${plan} AND date >= ${monStart} AND date < ${monEnd}`;
      n += Number(r) || 0;
      lastAnchor = newMon;
    }
    return n;
  }

  const rotated = tx ? await run(tx) : await prisma.$transaction((inner) => run(inner));
  if (rotated > 0) logger.info('mensa rotate', { menuId, plan, rotated, pastWeeks: past.length });
  return rotated;
}

export interface LayoutSettings extends CycleSettings {
  dayOffOf: DayOffOf;
  /**
   * The menu's anchors as on record: when given, the ones the count goes from
   * are written in their place whenever they differ (the server's own first
   * one, an old one moved up), in the same transaction as the move.
   */
  storedAnchors?: string;
}

// Gives every dish of a menu its plan week once: dishes added by hand have
// none (mensaCycle.planWeeksOf names them), and the count needs one to keep
// a week in its place.
async function nameWeeks(db: PrismaLike, dishes: Array<{ id: string; weekOrdinal: number }>, weeks: Map<string, number>): Promise<void> {
  const unnamed = new Map<number, string[]>();
  for (const d of dishes) {
    const week = weeks.get(d.id);
    if (week && week !== d.weekOrdinal) unnamed.set(week, [...(unnamed.get(week) ?? []), d.id]);
  }
  for (const [week, ids] of unnamed) await db.dish.updateMany({ where: { id: { in: ids } }, data: { weekOrdinal: week } });
}

// Puts both plans of a menu where the count says (utils/mensaCycle.ts), in one
// transaction. The dates are written as they should be, not shifted from
// where they are, so two nodes of a cluster laying out the same menu at once
// come to the same result; so are the anchors, and only over what was read.
export async function layoutMenu(menuId: string, settings: LayoutSettings, tx?: PrismaLike): Promise<number> {
  const db: PrismaLike = tx ?? prisma;
  const currentMonday = currentWeekMondayIso();
  const dishes = await db.dish.findMany({ where: { menuId }, select: { id: true, plan: true, date: true, weekOrdinal: true } });
  // Without dishes there is nothing to count yet: the first anchor waits for them.
  const anchors = dishes.length > 0 && settings.storedAnchors !== undefined ? keptAnchors(dishes, currentMonday, settings.dayOffOf, settings) : null;
  const anchorsJson = anchors ? weekAnchorsJson(anchors) : null;
  const newAnchors = anchorsJson !== null && anchorsJson !== settings.storedAnchors;
  const counted = anchors ? { ...settings, anchors } : settings;
  const moves = cycleMoves(dishes, currentMonday, settings.dayOffOf, counted);
  const weeks = planWeeksOf(dishes, currentMonday);
  const needsNames = dishes.some((d) => weeks.get(d.id) !== d.weekOrdinal);
  if (moves.length === 0 && !needsNames && !newAnchors) return 0;

  async function run(client: PrismaLike): Promise<number> {
    if (newAnchors) {
      await client.mensaMenu.updateMany({ where: { id: menuId, weekAnchors: settings.storedAnchors }, data: { weekAnchors: anchorsJson! } });
      logger.info('mensa week count anchored', { menuId, anchors: anchorsJson });
    }
    if (needsNames) await nameWeeks(client, dishes, weeks);
    let n = 0;
    for (const move of moves) {
      // Each dish keeps its weekday (WEEKDAY: 0 = Monday).
      const r = await client.$executeRaw`UPDATE dishes SET date = DATE_ADD(CAST(${move.to} AS DATE), INTERVAL WEEKDAY(date) DAY) WHERE menu_id = ${menuId} AND id IN (${Prisma.join(move.ids)})`;
      n += Number(r) || 0;
    }
    return n;
  }

  const moved = tx ? await run(tx) : await prisma.$transaction((inner) => run(inner));
  if (moved > 0) logger.info('mensa layout', { menuId, moved, weeks: moves.length, count: settings.count });
  return moved;
}

/** How many dishes layoutMenu would move now, without moving any. */
export async function previewLayout(menuId: string, settings: LayoutSettings): Promise<number> {
  const dishes = await prisma.dish.findMany({ where: { menuId }, select: { id: true, plan: true, date: true, weekOrdinal: true } });
  return cycleMoves(dishes, currentWeekMondayIso(), settings.dayOffOf, settings).reduce((n, move) => n + move.ids.length, 0);
}

export function otherPlan(p: Plan): Plan { return p === 'summer' ? 'winter' : 'summer'; }
export function isoAddDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return toUtcIso(d);
}
