// Pure rules behind recaps (routes/recaps.ts, services/recaps.ts): who a
// recap reaches, which parts it shows, when it can be opened, and how an
// account's figure ranks within its school. Free of database imports so
// they are unit-testable — see tests/recaps.test.mjs.

/** The parts a recap can show, in the order the story tells them. */
export const RECAP_SECTIONS = ['school', 'absences', 'grades', 'exams', 'classreg', 'pokyh'] as const;
export type RecapSection = (typeof RECAP_SECTIONS)[number];

export type RecapStatus = 'disabled' | 'scheduled' | 'active' | 'expired';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Whether "YYYY-MM-DD" is a real calendar day. */
export function isDayKey(value: string): boolean {
  if (!DAY.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m! - 1 && date.getUTCDate() === d;
}

/** The stored list ("school,grades"); empty or unknown only: every part. */
export function parseSections(stored: string): RecapSection[] {
  const known = new Set<string>(RECAP_SECTIONS);
  const chosen = new Set(stored.split(',').map((s) => s.trim()).filter((s) => known.has(s)));
  return chosen.size === 0 ? [...RECAP_SECTIONS] : RECAP_SECTIONS.filter((s) => chosen.has(s));
}

/** What is stored for a choice: "" when every part is chosen. */
export function formatSections(sections: readonly string[]): string {
  const chosen = parseSections(sections.join(','));
  return chosen.length === RECAP_SECTIONS.length ? '' : chosen.join(',');
}

export function recapStatus(r: { enabled: boolean; startsAt: Date | null; endsAt: Date | null }, now = Date.now()): RecapStatus {
  if (!r.enabled) return 'disabled';
  if (r.endsAt && r.endsAt.getTime() <= now) return 'expired';
  if (r.startsAt && r.startsAt.getTime() > now) return 'scheduled';
  return 'active';
}

export interface RecapReach {
  /** Null: every school. */
  schoolId: string | null;
  targetSchools: readonly string[];
  targetClasses: ReadonlyArray<{ schoolId: string; klasseId: number }>;
  targetUsers: readonly string[];
}

export interface RecapAccount {
  stableUid: string;
  schoolId: string | null;
  klasseId: number;
  role: string;
}

/**
 * Whether a recap is meant for an account. A recap of one school reaches only
 * that school's accounts. Without chosen recipients it reaches every student
 * in its range; with them, only the accounts that are among the chosen
 * students, or in a chosen school or class. Parents see a recap only when
 * chosen by name: the WebUntis figures would be their child's.
 */
export function recapReaches(r: RecapReach, a: RecapAccount): boolean {
  if (r.schoolId !== null && a.schoolId !== r.schoolId) return false;
  if (r.targetUsers.includes(a.stableUid)) return true;
  if (a.role === 'parent') return false;
  const chosen = r.targetSchools.length > 0 || r.targetClasses.length > 0 || r.targetUsers.length > 0;
  if (!chosen) return true;
  if (a.schoolId && r.targetSchools.includes(a.schoolId)) return true;
  return a.klasseId > 0 && r.targetClasses.some((c) => c.schoolId === a.schoolId && c.klasseId === a.klasseId);
}

/** The days of the period the figures can cover: from … the earlier of to and today; null when it has not begun. */
export function coveredPeriod(from: string, to: string, today: string): { from: string; to: string } | null {
  const end = to < today ? to : today;
  return from <= end ? { from, to: end } : null;
}

/** Fewest people a ranking is shown among, so it never singles anyone out. */
export const MIN_RANK_GROUP = 10;

/**
 * The account's place among its school as "top n %": the share of people
 * whose figure is at least as high as its own (itself included), rounded up,
 * at least 1. Null when the figure is 0 or the group is too small. `others`
 * holds everyone else's figure, people at 0 included.
 */
export function topPercent(mine: number, others: readonly number[]): number | null {
  const group = others.length + 1;
  if (mine <= 0 || group < MIN_RANK_GROUP) return null;
  const atLeast = 1 + others.filter((v) => v >= mine).length;
  return Math.max(1, Math.ceil((atLeast / group) * 100));
}

// ── A closed school year, from the archive (archived_activity) ──────────────

export interface ArchiveSummary {
  from?: unknown;
  to?: unknown;
  hours?: unknown;
  platforms?: unknown;
  days?: unknown;
}

export type ArchivedDay = [string, number, number];

export function archivedDaysOf(summary: ArchiveSummary): ArchivedDay[] {
  if (!Array.isArray(summary.days)) return [];
  return summary.days.flatMap((entry): ArchivedDay[] => (
    Array.isArray(entry) && typeof entry[0] === 'string' ? [[entry[0], Number(entry[1]) || 0, Number(entry[2]) || 0]] : []
  ));
}

export function parseArchive(json: string): ArchiveSummary | null {
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as ArchiveSummary) : null;
  } catch {
    return null;
  }
}

export interface ArchivePart {
  days: ArchivedDay[];
  /** Foreground seconds by starting hour, for the part of the archived year in the period. */
  hours: number[];
  platforms: { phone: number; desktop: number; app: number; web: number };
  found: boolean;
}

/**
 * What archived years (their summaryJson) hold of a period: the active days
 * in it — only before `cutoff`, whose live rows are gone, each day once — and
 * the hours and devices, kept for a year as a whole, taken in the share of
 * that year's time and days that lies in the period.
 */
export function archiveInPeriod(jsons: readonly string[], from: string, to: string, cutoff: string): ArchivePart {
  const part: ArchivePart = { days: [], hours: Array.from({ length: 24 }, () => 0), platforms: { phone: 0, desktop: 0, app: 0, web: 0 }, found: false };
  const seen = new Set<string>();
  for (const json of jsons) {
    const summary = parseArchive(json);
    if (!summary) continue;
    const all = archivedDaysOf(summary);
    const inside = all.filter(([day]) => day >= from && day <= to && day < cutoff && !seen.has(day));
    if (inside.length === 0) continue;
    part.found = true;
    for (const d of inside) { seen.add(d[0]); part.days.push(d); }
    const totalSeconds = all.reduce((a, d) => a + d[2], 0);
    const share = totalSeconds > 0 ? inside.reduce((a, d) => a + d[2], 0) / totalSeconds : 0;
    if (Array.isArray(summary.hours)) {
      summary.hours.forEach((v, h) => { if (h < 24) part.hours[h]! += Math.round((Number(v) || 0) * share); });
    }
    const daysShare = inside.length / all.length;
    const p = (summary.platforms ?? {}) as Record<string, unknown>;
    for (const key of ['phone', 'desktop', 'app', 'web'] as const) part.platforms[key] += Math.round((Number(p[key]) || 0) * daysShare);
  }
  return part;
}
