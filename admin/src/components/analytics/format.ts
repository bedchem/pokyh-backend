import type { Theme } from '../../theme';
import type { AnalyticsRange, UsagePlatform, VisitSource } from '../../types';

// The vocabulary and number formats every part of the Analytics page shares:
// the page itself, the inspector and the visitor map.

// iPhone and Android are the native apps only. Everything in a browser — on a
// phone or a computer, in a tab or installed to the home screen — is "Web".
export const PLATFORM_ORDER: UsagePlatform[] = ['ios', 'android', 'web', 'other'];
export const PLATFORM_LABEL: Record<UsagePlatform, string> = { ios: 'iPhone-App', android: 'Android-App', web: 'Web', other: 'Andere App' };

// Where people come from, on the website, in the apps, or both. The website
// counts visitors and page views, the apps their users and openings — only
// signed in — and both together people and accesses.
export const SOURCE_TITLE: Record<VisitSource, string> = { all: 'Herkunft', web: 'Website-Besucher', app: 'App-Nutzer' };
export const SOURCE_PEOPLE: Record<VisitSource, string> = { all: 'Personen', web: 'Besucher', app: 'Nutzer' };

export function viewWord(source: VisitSource, n: number): string {
  if (source === 'app') return n === 1 ? 'Öffnung' : 'Öffnungen';
  if (source === 'all') return n === 1 ? 'Zugriff' : 'Zugriffe';
  return n === 1 ? 'Aufruf' : 'Aufrufe';
}

// What a mix of website page views and app openings is called.
export function sourceOfViews(views: number, appViews: number): VisitSource {
  return appViews <= 0 ? 'web' : appViews >= views ? 'app' : 'all';
}

// One colour per platform, the same in every chart on the page. Checked for
// colour-vision deficiencies and contrast on both sheets; dark mode has its
// own, darker steps rather than the light ones.
export const PLATFORM_COLOR: Record<Theme, Record<UsagePlatform, string>> = {
  light: { ios: '#4f96dc', android: '#3fae86', web: '#e0892f', other: '#9b7ad6' },
  dark:  { ios: '#4a8fd6', android: '#2f9a73', web: '#c9782a', other: '#9f80db' },
};
// The colour of a single series.
export const NEUTRAL = '#4f96dc';

export const WEEKDAYS = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
export const WEEKDAYS_SHORT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

export const de = (value: number, digits = 0) => value.toLocaleString('de-AT', { maximumFractionDigits: digits });

export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} Sek.`;
  if (s < 600) return `${de(s / 60, 1)} Min.`;
  if (s < 3600) return `${Math.round(s / 60)} Min.`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m > 0 ? `${h} Std. ${m} Min.` : `${h} Std.`;
}

export function hours(seconds: number): string {
  const h = seconds / 3600;
  return `${de(h, h < 10 ? 1 : 0)} Std.`;
}

export function percent(part: number, whole: number): string {
  if (whole <= 0) return '–';
  const value = part / whole;
  return `${de(value * 100, value < 0.1 ? 1 : 0)} %`;
}

export function dayDate(dayKey: string): Date {
  return new Date(`${dayKey}T12:00:00`);
}

export function longDay(dayKey: string): string {
  return dayDate(dayKey).toLocaleDateString('de-AT', { weekday: 'short', day: 'numeric', month: 'long' });
}

export function shortDate(dayKey: string): string {
  return dayDate(dayKey).toLocaleDateString('de-AT', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function hourSpan(hour: number): string {
  return `${String(hour).padStart(2, '0')}–${String((hour + 1) % 24).padStart(2, '0')} Uhr`;
}

// "gerade eben", "vor 12 Min.", "heute, 14:05", "gestern", "vor 3 Tagen", "4. Okt."
export function lastSeen(iso: string): string {
  const then = new Date(iso);
  const minutes = Math.floor((Date.now() - then.getTime()) / 60000);
  if (minutes < 3) return 'gerade eben';
  if (minutes < 60) return `vor ${minutes} Min.`;
  if (then.toDateString() === new Date().toDateString()) return `heute, ${then.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' })}`;
  const days = Math.floor(minutes / 1440);
  if (days <= 1) return 'gestern';
  if (days < 30) return `vor ${days} Tagen`;
  return then.toLocaleDateString('de-AT', { day: 'numeric', month: 'short' });
}

// Like lastSeen, but with the time of day for anything in the last two days.
export function when(iso: string | null): string {
  if (!iso) return '–';
  const then = new Date(iso);
  const minutes = Math.floor((Date.now() - then.getTime()) / 60000);
  if (minutes < 2) return 'gerade eben';
  if (minutes < 60) return `vor ${minutes} Min.`;
  const time = then.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' });
  if (then.toDateString() === new Date().toDateString()) return `heute, ${time}`;
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (then.toDateString() === yesterday.toDateString()) return `gestern, ${time}`;
  return `${then.toLocaleDateString('de-AT', { day: 'numeric', month: 'short' })}, ${time}`;
}

export function periodText(range: AnalyticsRange): string {
  if (range === 'all') return 'Alltime';
  if (range === '365') return 'letzte 12 Monate';
  if (/^\d{4}$/.test(range)) return `Jahr ${range}`;
  return `letzte ${range} Tage`;
}

export const capitalised = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
