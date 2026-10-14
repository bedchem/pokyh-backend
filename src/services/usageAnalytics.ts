// Pure helpers behind the usage analytics (POST /usage/ping and the admin
// Analytics page). Deliberately free of imports so they are unit-testable
// without a database — see tests/usageAnalytics.test.mjs.

export const USAGE_DEVICES = ['ios', 'android', 'desktop', 'other'] as const;
export type UsageDevice = typeof USAGE_DEVICES[number];

// "app" is a native app, "pwa" the website installed to the home screen,
// "browser" the website in a browser tab.
export const USAGE_CLIENTS = ['app', 'pwa', 'browser'] as const;
export type UsageClient = typeof USAGE_CLIENTS[number];

// A single ping never adds more foreground time than this, whatever the
// client claims; clients ping about once a minute.
export const MAX_PING_SECONDS = 300;
// A visit that has been running for longer than this stops growing. Nobody
// keeps a school app in the foreground for half a day; a client that says so
// is broken or lying.
export const MAX_SESSION_SECONDS = 12 * 60 * 60;
// A visit whose last ping is younger than this counts as "online now".
export const ONLINE_WINDOW_MS = 150 * 1000;

export interface UaClass {
  device: UsageDevice;
  // From a user-agent alone an installed website and a browser tab look the
  // same, so the web side is only ever "web" here.
  client: 'app' | 'web';
}

/**
 * Sorts a request's User-Agent into a device family. Returns null for callers
 * that are not a person's device (the website's own server, scripts, bots).
 */
export function classifyUserAgent(userAgent: string | null | undefined): UaClass | null {
  const ua = (userAgent ?? '').trim();
  if (!ua) return null;
  if (/^(node|undici|node-fetch|axios|got|curl|wget|python|go-http-client|java\/|next\.js|vercel)/i.test(ua)) return null;
  // "Googlebot/2.1", "AhrefsBot/7.0" … — but not a phone model such as "CUBOT X30".
  if (/bot\/|crawler|spider|headless|lighthouse|uptime/i.test(ua)) return null;

  const browser = /Mozilla\//.test(ua);
  // The Android app talks through OkHttp without its own user-agent.
  if (/^okhttp\//i.test(ua)) return { device: 'android', client: 'app' };
  // The iOS app talks through URLSession: "POKYH/… CFNetwork/… Darwin/…".
  if (!browser && /CFNetwork\/|Darwin\//.test(ua)) return { device: 'ios', client: 'app' };
  if (!browser && /^pokyh/i.test(ua)) {
    if (/iPhone|iPad|iOS/i.test(ua)) return { device: 'ios', client: 'app' };
    if (/Android/i.test(ua)) return { device: 'android', client: 'app' };
    return { device: 'other', client: 'app' };
  }
  // The retired Flutter app; its user-agent does not name the platform.
  if (/^Dart\//.test(ua)) return { device: 'other', client: 'app' };

  if (/iPhone|iPad|iPod/.test(ua)) return { device: 'ios', client: 'web' };
  if (/Android/.test(ua)) return { device: 'android', client: 'web' };
  if (/Windows|Macintosh|Mac OS X|CrOS|X11|Linux/.test(ua)) return { device: 'desktop', client: 'web' };
  return { device: 'other', client: 'web' };
}

// How the admin page groups visits: each native app on its own, and everything
// in a browser — phone or computer, tab or installed (PWA) — as "web".
export const USAGE_PLATFORMS = ['ios', 'android', 'web', 'other'] as const;
export type UsagePlatform = typeof USAGE_PLATFORMS[number];

export function platformOf(device: string, client: string): UsagePlatform {
  if (client !== 'app') return 'web';
  return device === 'ios' || device === 'android' ? device : 'other';
}

export function isUsageDevice(value: unknown): value is UsageDevice {
  return typeof value === 'string' && (USAGE_DEVICES as readonly string[]).includes(value);
}

export function isUsageClient(value: unknown): value is UsageClient {
  return typeof value === 'string' && (USAGE_CLIENTS as readonly string[]).includes(value);
}

/**
 * How many seconds one ping may add to a visit: what the client reports,
 * but never more than the wall-clock time since the last ping (plus a little
 * slack for network delay), never more than MAX_PING_SECONDS, and never past
 * MAX_SESSION_SECONDS in total.
 */
export function creditedSeconds(reported: number, sinceLastPingMs: number, alreadyCredited: number): number {
  if (!Number.isFinite(reported) || reported <= 0) return 0;
  const wallClock = Math.max(0, sinceLastPingMs) / 1000 + 5;
  const room = Math.max(0, MAX_SESSION_SECONDS - Math.max(0, alreadyCredited));
  return Math.floor(Math.min(reported, wallClock, MAX_PING_SECONDS, room));
}

// Building a formatter is far slower than using one, and the analytics view
// formats thousands of dates per request.
const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(timezone: string): Intl.DateTimeFormat | null {
  const zone = timezone || 'UTC';
  if (!formatters.has(zone)) {
    try {
      formatters.set(zone, new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }));
    } catch {
      // An unknown timezone name.
      formatters.set(zone, null);
    }
  }
  return formatters.get(zone) ?? null;
}

function zonedParts(date: Date, timezone: string): Record<string, string> | null {
  const formatter = formatterFor(timezone);
  if (!formatter || Number.isNaN(date.getTime())) return null;
  const parts = formatter.formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}

/** The local calendar day ("YYYY-MM-DD") and hour (0–23) of `date` in `timezone`. */
export function localDayAndHour(date: Date, timezone: string): { dayKey: string; hour: number } {
  const parts = zonedParts(date, timezone) ?? zonedParts(date, 'UTC');
  if (!parts?.year || !parts.month || !parts.day) {
    return { dayKey: date.toISOString().slice(0, 10), hour: date.getUTCHours() };
  }
  const hour = Number(parts.hour);
  return {
    dayKey: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number.isFinite(hour) ? hour % 24 : 0,
  };
}

/** The moment local midnight begins `dayKey` ("YYYY-MM-DD") in `timezone`. */
export function startOfLocalDay(dayKey: string, timezone: string): Date {
  const [y, m, d] = dayKey.split('-').map(Number);
  const utcMidnight = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  // The zone's offset at a moment: its wall clock read as if it were UTC,
  // minus the moment itself.
  const offsetAt = (ms: number): number => {
    const p = zonedParts(new Date(ms), timezone);
    if (!p) return 0;
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute)) - ms;
  };
  const guess = utcMidnight - offsetAt(utcMidnight);
  // Checked once more at the guess, in case a DST change lies in between.
  return new Date(utcMidnight - offsetAt(guess));
}

/** The last `days` local calendar days, oldest first, ending with today. */
export function dayAxis(days: number, timezone: string, now = new Date()): string[] {
  const count = Math.max(1, Math.min(366, Math.round(days)));
  const keys = new Set<string>();
  // Stepping back in whole UTC days can land twice on one local day around a
  // DST change, so collect until there are enough distinct days.
  for (let offset = 0; keys.size < count && offset < count + 3; offset += 1) {
    keys.add(localDayAndHour(new Date(now.getTime() - offset * 24 * 60 * 60 * 1000), timezone).dayKey);
  }
  return [...keys].sort().slice(-count);
}

/** Monday = 0 … Sunday = 6 for a "YYYY-MM-DD" calendar day. */
export function weekdayOf(dayKey: string): number {
  const [y, m, d] = dayKey.split('-').map(Number);
  const utc = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  return (utc.getUTCDay() + 6) % 7;
}

// Session-length bands for the distribution chart, upper bounds in seconds.
export const LENGTH_BANDS: Array<{ label: string; maxSeconds: number }> = [
  { label: '< 1 Min.', maxSeconds: 60 },
  { label: '1–5 Min.', maxSeconds: 5 * 60 },
  { label: '5–15 Min.', maxSeconds: 15 * 60 },
  { label: '15–30 Min.', maxSeconds: 30 * 60 },
  { label: '> 30 Min.', maxSeconds: Number.POSITIVE_INFINITY },
];

export function lengthBandOf(seconds: number): number {
  const index = LENGTH_BANDS.findIndex((band) => seconds < band.maxSeconds);
  return index === -1 ? LENGTH_BANDS.length - 1 : index;
}
