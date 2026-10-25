// Pure helpers behind an account's own activity (GET /users/me/activity,
// services/accountActivity.ts). Free of database imports so they are
// unit-testable — see tests/accountActivity.test.mjs.

import { weekdayOf } from './usageAnalytics';

export interface ActivityDay {
  date: string;
  active: boolean;
  logins: number;
  activeSeconds: number;
  visits: number;
  screens: number;
}

export interface ActivityInput {
  /** Every day of the window, oldest first, ending with today. */
  days: string[];
  /** request_account_days rows: device "ios" | "android" | "desktop" | "other", client "app" | "web". */
  accountDays: Array<{ dayKey: string; device: string; client: string }>;
  /** usage_sessions rows (only present with the account's consent). */
  sessions: Array<{ dayKey: string; startHour: number; activeSeconds: number; screens: number }>;
  /** The local day of each successful sign-in. */
  signIns: string[];
  /**
   * Active days of a year already archived (archived_activity, see
   * archiveSummary): [day, sign-ins, foreground seconds]. Only for days whose
   * rows are gone; they count as active, without devices or hours.
   */
  archived?: ReadonlyArray<readonly [string, number, number]>;
}

export interface ActivitySummary {
  days: ActivityDay[];
  totals: {
    activeDays: number;
    logins: number;
    activeSeconds: number;
    visits: number;
    screens: number;
    currentStreak: number;
    longestStreak: number;
  };
  /** Active days per weekday, Monday first. */
  weekdays: number[];
  /** Foreground seconds by the hour a visit started in. */
  hours: number[];
  /** Days used on a phone, a computer, in a native app, in a browser. */
  platforms: { phone: number; desktop: number; app: number; web: number };
}

/** Turns the stored rows into the profile's figures. */
export function summarizeActivity(input: ActivityInput): ActivitySummary {
  const byDay = new Map<string, ActivityDay>();
  for (const date of input.days) {
    byDay.set(date, { date, active: false, logins: 0, activeSeconds: 0, visits: 0, screens: 0 });
  }

  const phoneDays = new Set<string>();
  const desktopDays = new Set<string>();
  const appDays = new Set<string>();
  const webDays = new Set<string>();
  for (const row of input.accountDays) {
    const day = byDay.get(row.dayKey);
    if (!day) continue;
    day.active = true;
    if (row.device === 'ios' || row.device === 'android') phoneDays.add(row.dayKey);
    if (row.device === 'desktop') desktopDays.add(row.dayKey);
    if (row.client === 'app') appDays.add(row.dayKey);
    else webDays.add(row.dayKey);
  }

  const hours = Array.from({ length: 24 }, () => 0);
  for (const s of input.sessions) {
    const day = byDay.get(s.dayKey);
    if (!day) continue;
    const seconds = Math.max(0, s.activeSeconds);
    day.visits += 1;
    day.activeSeconds += seconds;
    day.screens += Math.max(0, s.screens);
    if (seconds > 0) day.active = true;
    if (s.startHour >= 0 && s.startHour < 24) hours[s.startHour]! += seconds;
  }

  for (const dayKey of input.signIns) {
    const day = byDay.get(dayKey);
    if (!day) continue;
    day.logins += 1;
    day.active = true;
  }

  for (const [dayKey, logins, seconds] of input.archived ?? []) {
    const day = byDay.get(dayKey);
    if (!day) continue;
    day.active = true;
    day.logins += Math.max(0, Math.round(logins));
    day.activeSeconds += Math.max(0, Math.round(seconds));
  }

  const days = [...byDay.values()];
  const weekdays = Array.from({ length: 7 }, () => 0);
  let longest = 0;
  let run = 0;
  for (const day of days) {
    if (day.active) {
      weekdays[weekdayOf(day.date)]! += 1;
      run += 1;
      longest = Math.max(longest, run);
    } else {
      run = 0;
    }
  }

  // A quiet today doesn't end the streak yet: the day isn't over.
  let current = 0;
  for (let i = days.length - 1; i >= 0; i -= 1) {
    if (days[i]!.active) current += 1;
    else if (i === days.length - 1) continue;
    else break;
  }

  return {
    days,
    totals: {
      activeDays: days.filter((d) => d.active).length,
      logins: days.reduce((a, d) => a + d.logins, 0),
      activeSeconds: days.reduce((a, d) => a + d.activeSeconds, 0),
      visits: days.reduce((a, d) => a + d.visits, 0),
      screens: days.reduce((a, d) => a + d.screens, 0),
      currentStreak: current,
      longestStreak: longest,
    },
    weekdays,
    hours,
    platforms: { phone: phoneDays.size, desktop: desktopDays.size, app: appDays.size, web: webDays.size },
  };
}

/**
 * The day ("YYYY-MM-DD") on which the school year that `todayKey` lies in
 * began: the rollover day, by default 1 August (SCHOOL_YEAR_ROLLOVER_*).
 */
export function schoolYearStartKey(todayKey: string, month: number, day: number): string {
  const [y, m, d] = todayKey.split('-').map(Number);
  const started = (m ?? 1) > month || ((m ?? 1) === month && (d ?? 1) >= day);
  const startYear = started ? (y ?? 1970) : (y ?? 1970) - 1;
  return `${startYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** One day key per sign-in, from request_account_days rows that count them. */
export function signInDays(rows: Array<{ dayKey: string; signIns?: number | null }>): string[] {
  const out: string[] = [];
  for (const row of rows) {
    const n = Math.min(500, Math.max(0, Math.round(row.signIns ?? 0)));
    for (let i = 0; i < n; i += 1) out.push(row.dayKey);
  }
  return out;
}

/** What the school-year archive keeps of an account's year: the figures and its active days, nothing else. */
export function archiveSummary(summary: ActivitySummary, from: string, to: string) {
  return {
    from,
    to,
    totals: summary.totals,
    weekdays: summary.weekdays,
    hours: summary.hours,
    platforms: summary.platforms,
    // [day, sign-ins, foreground seconds] for each active day.
    days: summary.days.filter((d) => d.active).map((d) => [d.date, d.logins, d.activeSeconds] as const),
  };
}

/** The website's most opened screens, from "/de/grades/" style paths, locale left out. */
export function topPages(paths: Array<string | null>, limit = 5): Array<{ page: string; views: number }> {
  const counts = new Map<string, number>();
  for (const raw of paths) {
    if (!raw) continue;
    const parts = raw.split(/[?#]/)[0]!.split('/').filter(Boolean);
    if (parts[0] && /^(de|it|en|lld)$/.test(parts[0])) parts.shift();
    const page = parts[0] ? `/${parts[0]}` : '/';
    counts.set(page, (counts.get(page) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([page, views]) => ({ page, views }));
}
