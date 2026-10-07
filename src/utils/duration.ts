// Converts a token lifetime as accepted by `jsonwebtoken` into milliseconds.
// That library treats a number as seconds, a bare numeric string as
// milliseconds, and otherwise a "<value><unit>" span such as "15m", "1h" or
// "7 days". Anything unparseable yields `fallbackMs`, which callers choose
// conservatively.
const UNIT_MS: Record<string, number> = {
  ms: 1, msec: 1, msecs: 1, millisecond: 1, milliseconds: 1,
  s: 1_000, sec: 1_000, secs: 1_000, second: 1_000, seconds: 1_000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
  w: 604_800_000, week: 604_800_000, weeks: 604_800_000,
  y: 31_557_600_000, yr: 31_557_600_000, yrs: 31_557_600_000, year: 31_557_600_000, years: 31_557_600_000,
};

export function tokenLifetimeMs(value: string | number, fallbackMs: number): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value * 1_000 : fallbackMs;
  }
  const text = value.trim().toLowerCase();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const ms = Number(text);
    return ms > 0 ? ms : fallbackMs;
  }
  const match = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/.exec(text);
  if (!match) return fallbackMs;
  const unit = UNIT_MS[match[2]!];
  if (!unit) return fallbackMs;
  const ms = Number(match[1]) * unit;
  return ms > 0 ? ms : fallbackMs;
}

// Parses a pagination-style query value. Missing, non-numeric, fractional or
// out-of-range input falls back to `fallback` / is clamped, so a malformed
// query string can never reach the database as NaN.
export function intQueryParam(value: unknown, fallback: number, min: number, max: number): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(parsed)) return Math.max(min, Math.min(max, fallback));
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}
