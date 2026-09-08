import { prisma } from '../db';
import { logger } from './logger';
import type { Prisma } from '@prisma/client';

type PrismaLike = Prisma.TransactionClient | typeof prisma;
type Plan = 'summer' | 'winter';

// ─── date helpers (UTC, because Prisma reads DATE as UTC-midnight) ───────────

function utcMondayOf(d: Date): Date {
  const wd = d.getUTCDay() || 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - wd + 1));
}
function utcDow(d: Date): number { return d.getUTCDay() || 7; }
function toUtcIso(d: Date): string { return d.toISOString().split('T')[0]!; }
function addDays(d: Date, days: number): Date {
  const r = new Date(d.getTime());
  r.setUTCDate(r.getUTCDate() + days);
  return r;
}

// Season definition mirrors utils/cache.currentSeason: summer = April..October.
export function isInSeason(date: Date, plan: Plan): boolean {
  const m = date.getUTCMonth() + 1;
  const summer = m >= 4 && m <= 10;
  return plan === 'summer' ? summer : !summer;
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

function currentLocalMonday(): Date {
  const today = new Date();
  const wd = today.getDay() || 7;
  // Local wall-clock Monday, then re-express as UTC midnight so it can be
  // compared with Prisma-returned DATE values without timezone drift.
  const local = new Date(today.getFullYear(), today.getMonth(), today.getDate() - wd + 1);
  return new Date(Date.UTC(local.getFullYear(), local.getMonth(), local.getDate()));
}

// ─── plan queries ────────────────────────────────────────────────────────────

async function planMondays(db: PrismaLike, plan: Plan): Promise<string[]> {
  const dishes = await db.dish.findMany({ where: { plan }, select: { date: true } });
  const set = new Set<string>();
  for (const d of dishes) set.add(toUtcIso(utcMondayOf(new Date(d.date))));
  return [...set].sort();
}

// Return the last Monday of `plan` that is on or after this week's Monday.
// Used to compute "where does plan X end" for the cross-plan handoff.
export async function lastFutureMondayIso(db: PrismaLike, plan: Plan): Promise<string | null> {
  const today = currentLocalMonday();
  const mondays = await planMondays(db, plan);
  const future = mondays.filter((m) => new Date(m + 'T00:00:00Z') >= today);
  return future.length > 0 ? future[future.length - 1] : null;
}

// Return the first Monday recorded for `plan`, regardless of past/future.
export async function firstMondayIso(db: PrismaLike, plan: Plan): Promise<string | null> {
  const mondays = await planMondays(db, plan);
  return mondays.length > 0 ? mondays[0] : null;
}

// ─── core operations ────────────────────────────────────────────────────────

// Reassign every dish so that the week the user chose lands on `target`, every
// other week is exactly (idx - anchorIdx) * 7 days from `target`, and each
// dish keeps its weekday. Idempotent (no-op when nothing changes).
export async function normalizePlanAroundAnchor(
  db: PrismaLike, plan: Plan, chosenMondayIso: string, targetMondayIso: string,
): Promise<number> {
  const dishes = await db.dish.findMany({ where: { plan }, select: { id: true, date: true } });
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
export async function rotatePastWeeks(plan: Plan, tx?: PrismaLike): Promise<number> {
  const db: PrismaLike = tx ?? prisma;
  const currentMonday = currentLocalMonday();

  const mondays = await planMondays(db, plan);
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
      const newMon = snapForwardToSeason(rawNext, plan);
      const shiftDays = Math.round((newMon.getTime() - monStart.getTime()) / 86400000);
      if (shiftDays === 0) { lastAnchor = newMon; continue; }
      const r = await client.$executeRaw`UPDATE dishes SET date = DATE_ADD(date, INTERVAL ${shiftDays} DAY) WHERE plan = ${plan} AND date >= ${monStart} AND date < ${monEnd}`;
      n += Number(r) || 0;
      lastAnchor = newMon;
    }
    return n;
  }

  const rotated = tx ? await run(tx) : await prisma.$transaction((inner) => run(inner));
  if (rotated > 0) logger.info('mensa rotate', { plan, rotated, pastWeeks: past.length });
  return rotated;
}

export function otherPlan(p: Plan): Plan { return p === 'summer' ? 'winter' : 'summer'; }
export function isoAddDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return toUtcIso(d);
}
