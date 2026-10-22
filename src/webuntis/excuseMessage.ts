// Excusing a past absence. WebUntis lets students of age and guardians report
// an absence ahead ("Abwesenheit melden"), but refuses the edit that would add
// a reason to one that is already over. So the excuse goes to the class
// teachers as a MessageCenter message, written here.
//
// The subject names the absence in a fixed form (a prefix, the dates, the
// times), and that is how the absences page finds the message again in the
// account's "Gesendet" folder: POKYH stores nothing about it.

export type ExcuseLocale = 'de' | 'it' | 'en';

export function excuseLocale(value: unknown): ExcuseLocale {
  return value === 'it' || value === 'en' ? value : 'de';
}

/** One absence as the classic API has it: dates as YYYYMMDD, times as HHMM. */
export interface ExcuseAbsence {
  startDate: number;
  startTime: number;
  endDate: number;
  endTime: number;
}

export interface ExcuseInput {
  absences: ExcuseAbsence[];
  locale: ExcuseLocale;
  reasonName?: string;
  note?: string;
  /** The guardian's child; absent when the student writes for themself. */
  childName?: string;
  /** The student's name under the text; a guardian's message is signed by WebUntis' sender line. */
  signature?: string;
}

interface Wording {
  prefix: string;
  sep: string;
  weekdays: string[];
  hello: string;
  one: (when: string) => string;
  many: string;
  oneChild: (child: string, when: string) => string;
  manyChild: (child: string) => string;
  /** One day: "am Mittwoch, 17.12.2025, von 07:50 bis 13:05". */
  onDay: (day: string, from?: string, to?: string) => string;
  /** A day and a time: "Montag, 15.12.2025, 07:50". */
  at: (day: string, time: string) => string;
  /** Over several days. */
  range: (from: string, to: string) => string;
  reason: string;
  note: string;
  bye: string;
}

const TEXT: Record<ExcuseLocale, Wording> = {
  de: {
    prefix: 'Entschuldigung',
    sep: '.',
    weekdays: ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'],
    hello: 'Guten Tag,',
    one: (when) => `hiermit entschuldige ich meine Abwesenheit ${when}.`,
    many: 'hiermit entschuldige ich meine folgenden Abwesenheiten:',
    oneChild: (child, when) => `hiermit entschuldige ich die Abwesenheit meines Kindes ${child} ${when}.`,
    manyChild: (child) => `hiermit entschuldige ich die folgenden Abwesenheiten meines Kindes ${child}:`,
    onDay: (day, from, to) => (from && to ? `am ${day}, von ${from} bis ${to}` : `am ${day} (ganztägig)`),
    at: (day, time) => `${day}, ${time}`,
    range: (from, to) => `vom ${from} bis ${to}`,
    reason: 'Grund',
    note: 'Bemerkung',
    bye: 'Mit freundlichen Grüßen',
  },
  it: {
    prefix: 'Giustificazione',
    sep: '/',
    weekdays: ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'],
    hello: 'Buongiorno,',
    one: (when) => `con la presente giustifico la mia assenza ${when}.`,
    many: 'con la presente giustifico le mie seguenti assenze:',
    oneChild: (child, when) => `con la presente giustifico l’assenza di mio/a figlio/a ${child} ${when}.`,
    manyChild: (child) => `con la presente giustifico le seguenti assenze di mio/a figlio/a ${child}:`,
    onDay: (day, from, to) => (from && to ? `di ${day} dalle ${from} alle ${to}` : `di ${day} (tutto il giorno)`),
    at: (day, time) => `${day} ore ${time}`,
    range: (from, to) => `dal ${from} al ${to}`,
    reason: 'Motivo',
    note: 'Nota',
    bye: 'Cordiali saluti',
  },
  en: {
    prefix: 'Absence excuse',
    sep: '/',
    weekdays: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    hello: 'Hello,',
    one: (when) => `I am writing to excuse my absence ${when}.`,
    many: 'I am writing to excuse my following absences:',
    oneChild: (child, when) => `I am writing to excuse the absence of my child ${child} ${when}.`,
    manyChild: (child) => `I am writing to excuse the following absences of my child ${child}:`,
    onDay: (day, from, to) => (from && to ? `on ${day}, from ${from} to ${to}` : `on ${day} (all day)`),
    at: (day, time) => `${day}, ${time}`,
    range: (from, to) => `from ${from} to ${to}`,
    reason: 'Reason',
    note: 'Note',
    bye: 'Kind regards',
  },
};

/** HHMM (750) or minutes of the day (470), as the classic API mixes them → minutes of the day. */
function minutesOf(t: number): number {
  if (!t || t < 0) return 0;
  if (t > 2359 || t % 100 > 59) return t;
  return Math.floor(t / 100) * 60 + (t % 100);
}

const pad = (n: number) => String(n).padStart(2, '0');

function clock(t: number): string {
  const m = minutesOf(t);
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

function date(d: number, locale: ExcuseLocale): string {
  const { sep } = TEXT[locale];
  return `${pad(d % 100)}${sep}${pad(Math.floor(d / 100) % 100)}${sep}${Math.floor(d / 10000)}`;
}

/** "Mittwoch, 17.12.2025" / "mercoledì 17/12/2025". */
function day(d: number, locale: ExcuseLocale): string {
  const weekday = TEXT[locale].weekdays[new Date(Math.floor(d / 10000), (Math.floor(d / 100) % 100) - 1, d % 100).getDay()];
  return locale === 'it' ? `${weekday} ${date(d, locale)}` : `${weekday}, ${date(d, locale)}`;
}

const hasTimes = (a: ExcuseAbsence) => a.startTime > 0 || a.endTime > 0;

/** Start and end of an absence as YYYYMMDDHHMM, the numbers ExcuseSpan uses. */
export function absenceSpan(a: ExcuseAbsence): ExcuseSpan {
  const s = minutesOf(a.startTime);
  const e = hasTimes(a) ? minutesOf(a.endTime) : 23 * 60 + 59;
  return {
    start: a.startDate * 10_000 + Math.floor(s / 60) * 100 + (s % 60),
    end: a.endDate * 10_000 + Math.floor(e / 60) * 100 + (e % 60),
  };
}

/** One absence in words, for the body. */
function when(a: ExcuseAbsence, locale: ExcuseLocale): string {
  const t = TEXT[locale];
  if (a.startDate === a.endDate) {
    return hasTimes(a) ? t.onDay(day(a.startDate, locale), clock(a.startTime), clock(a.endTime)) : t.onDay(day(a.startDate, locale));
  }
  return hasTimes(a)
    ? t.range(t.at(day(a.startDate, locale), clock(a.startTime)), t.at(day(a.endDate, locale), clock(a.endTime)))
    : t.range(day(a.startDate, locale), day(a.endDate, locale));
}

/**
 * The span in the subject, what parseExcuseSubject reads back:
 * "17.12.2025, 07:50-13:05" or "15.12.2025, 07:50 - 17.12.2025, 13:05".
 */
function subjectSpan(first: ExcuseAbsence, last: ExcuseAbsence, locale: ExcuseLocale): string {
  const times = hasTimes(first) || hasTimes(last);
  if (first.startDate === last.endDate) {
    return times ? `${date(first.startDate, locale)}, ${clock(first.startTime)}-${clock(last.endTime)}` : date(first.startDate, locale);
  }
  return times
    ? `${date(first.startDate, locale)}, ${clock(first.startTime)} - ${date(last.endDate, locale)}, ${clock(last.endTime)}`
    : `${date(first.startDate, locale)} - ${date(last.endDate, locale)}`;
}

/** Subject and plain-text body of the excuse (the body becomes HTML when it is sent). */
export function composeExcuse(input: ExcuseInput): { subject: string; text: string } {
  const t = TEXT[input.locale];
  const absences = [...input.absences].sort((a, b) => absenceSpan(a).start - absenceSpan(b).start);
  const first = absences[0];
  const last = absences.reduce((max, a) => (absenceSpan(a).end > absenceSpan(max).end ? a : max), first);
  const subject = `${t.prefix}: ${subjectSpan(first, last, input.locale)}`;

  const child = input.childName?.trim();
  const lines: string[] = [t.hello, ''];
  if (absences.length === 1) {
    const w = when(first, input.locale);
    lines.push(child ? t.oneChild(child, w) : t.one(w));
  } else {
    lines.push(child ? t.manyChild(child) : t.many);
    for (const a of absences) lines.push(`- ${when(a, input.locale)}`);
  }
  const reason = input.reasonName?.trim();
  const note = input.note?.trim();
  if (reason || note) {
    lines.push('');
    if (reason) lines.push(`${t.reason}: ${reason}`);
    if (note) lines.push(`${t.note}: ${note}`);
  }
  lines.push('', t.bye);
  const signature = input.signature?.trim();
  if (signature) lines.push(signature);
  return { subject, text: lines.join('\n') };
}

/** A time span as YYYYMMDDHHMM numbers (202512170750). */
export interface ExcuseSpan {
  start: number;
  end: number;
}

const PREFIXES = Object.values(TEXT).map((t) => `${t.prefix.toLowerCase()}:`);

/** The span an excuse subject names, in any of the languages; null for any other subject. */
export function parseExcuseSubject(subject: unknown): ExcuseSpan | null {
  const s = String(subject ?? '').trim();
  const lower = s.toLowerCase();
  if (!PREFIXES.some((p) => lower.startsWith(p))) return null;
  const dates = [...s.matchAll(/(\d{1,2})[./](\d{1,2})[./](\d{4})/g)].map((m) => Number(m[3]) * 10_000 + Number(m[2]) * 100 + Number(m[1]));
  if (dates.length === 0) return null;
  const times = [...s.matchAll(/(?<![\d.:/])(\d{1,2}):(\d{2})(?![\d.:/])/g)]
    .map((m) => Number(m[1]) * 100 + Number(m[2]))
    .filter((t) => Math.floor(t / 100) < 24 && t % 100 < 60);
  const startTime = times.length >= 2 ? times[0] : 0;
  const endTime = times.length >= 2 ? times[times.length - 1] : 2359;
  const start = dates[0] * 10_000 + startTime;
  const end = dates[dates.length - 1] * 10_000 + endTime;
  return end > start ? { start, end } : null;
}
