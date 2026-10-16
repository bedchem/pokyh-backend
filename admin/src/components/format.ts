// Dates, times and numbers as the panel shows them: German, in the
// installation's own time zone (ANALYTICS_TIMEZONE, from /api/admin/me) so
// days and hours match the server's figures wherever the panel is opened.

let TZ: string | undefined;

export function setDisplayTimeZone(timezone: string | undefined): void {
  TZ = timezone || undefined;
}

// Today's day key (YYYY-MM-DD) in that time zone.
export function todayDayKey(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

// The moment a day (YYYY-MM-DD) starts in that time zone.
export function startOfDay(dayKey: string): Date {
  const [y = 1970, m = 1, d = 1] = dayKey.split('-').map(Number);
  const midnightUtc = Date.UTC(y, m - 1, d);
  let t = midnightUtc;
  // Two rounds settle the zone's offset, also across a DST change.
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(t));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    const shownAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
    t = midnightUtc - (shownAsUtc - t);
  }
  return new Date(t);
}

// The current hour (0–23) in that time zone.
export function currentHour(): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
}

export const num = (value: number, digits = 0) => value.toLocaleString('de-AT', { maximumFractionDigits: digits });

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '–';
  return new Date(iso).toLocaleString('de-AT', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function timeOnly(iso: string | null | undefined): string {
  if (!iso) return '–';
  return new Date(iso).toLocaleTimeString('de-AT', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function relative(iso: string | null | undefined): string {
  if (!iso) return '–';
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return 'gerade eben';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `vor ${mins} Min.`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `vor ${hrs} Std.`;
  const days = Math.round(hrs / 24);
  return days === 1 ? 'gestern' : `vor ${days} Tagen`;
}

// "Do, 16. Oktober 2026" from a day key (YYYY-MM-DD).
export function longDayKey(dayKey: string): string {
  return new Date(`${dayKey}T12:00:00Z`).toLocaleDateString('de-AT', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
}

export function shiftDayKey(dayKey: string, days: number): string {
  const d = new Date(`${dayKey}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function ms(value: number | null | undefined): string {
  if (value === null || value === undefined) return '–';
  return value >= 1000 ? `${num(value / 1000, 1)} s` : `${Math.round(value)} ms`;
}

// The upper bound of a response-time bucket ("≤ 50 ms"), or above the last.
export function bucketMs(value: number | null): string {
  return value === null ? '> 2,5 s' : `≤ ${ms(value)}`;
}
