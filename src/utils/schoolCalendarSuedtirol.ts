// The school calendar of South Tyrol, computed for any year. Beschluss der
// Landesregierung vom 23. Jänner 2012, Nr. 75 (changed by Nr. 8 vom 14.
// Jänner 2025) sets it for kindergartens, schools and the schools of the
// Berufsbildung (LBS) alike; the Deutsche Bildungsdirektion prints each year
// from it. Checked day by day against the printed calendars from 2015/16 to
// 2034/35 (for 2024/25 only a table could be found), where they differ only by
// misprints and by calendars printed before a change of the law. Free of the
// database so it can be tested on its own.
//
// Days are YYYY-MM-DD, worked on as UTC midnights.

export type DayOffReason =
  | 'weekend'
  | 'summer'        // Sommerferien: after the last day of lessons (16 June or the Friday before)
  | 'allSaints'     // Allerheiligenferien: the whole week of 1 November
  | 'christmas'     // Weihnachtsferien: 24 December to 6 January
  | 'winter'        // Winter-/Faschingsferien: the whole week of Ash Wednesday
  | 'easter'        // Osterferien: Maundy Thursday to Easter Tuesday
  | 'holiday'       // a public holiday
  | 'bridge';       // Fenstertag: a single school day next to a holiday, see suedtirolDayOff

const DAY = 86_400_000;

const utc = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const parse = (s: string) => Date.parse(`${s}T00:00:00Z`);
const dow = (t: number) => new Date(t).getUTCDay(); // 0 = Sunday

/** Easter Sunday (Gregorian, anonymous algorithm). */
export function easterSunday(year: number): number {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utc(year, month, day);
}

/** Monday of the week (Monday to Sunday) `t` is in. */
const mondayOf = (t: number) => t - ((dow(t) + 6) % 7) * DAY;

/**
 * The lessons of the school year that starts in `year`: from 5 September
 * when that is a Monday to Thursday, else the Monday after; to 16 June when
 * that is a Tuesday to Friday, else the Friday before (Art. 2).
 */
export function lessonsOf(year: number): { first: string; last: string } {
  const sep5 = utc(year, 9, 5);
  const first = dow(sep5) >= 1 && dow(sep5) <= 4 ? sep5 : sep5 + ((8 - dow(sep5)) % 7) * DAY;
  const jun16 = utc(year + 1, 6, 16);
  const last = dow(jun16) >= 2 && dow(jun16) <= 5 ? jun16 : jun16 - ((dow(jun16) + 2) % 7) * DAY;
  return { first: iso(first), last: iso(last) };
}

// Public holidays in Italy and South Tyrol (Pfingstmontag instead of a
// patron saint's day); 4 October since 2026 (Legge 8 ottobre 2025, n. 151).
function isPublicHoliday(t: number): boolean {
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const md = (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
  if ([101, 106, 425, 501, 602, 815, 1101, 1208, 1225, 1226].includes(md)) return true;
  if (md === 1004 && y >= 2026) return true;
  const easter = easterSunday(y);
  return t === easter || t === easter + DAY || t === easter + 49 * DAY || t === easter + 50 * DAY;
}

// Why `t` is off before the bridge days are added, or null for a school day.
function baseReason(t: number): DayOffReason | null {
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const startYear = d.getUTCMonth() + 1 >= 9 ? y : y - 1;
  const lessons = lessonsOf(startYear);
  if (t < parse(lessons.first) || t > parse(lessons.last)) return 'summer';

  // The whole week 1 November falls in; the week after when it is a Sunday.
  const nov1 = utc(startYear, 11, 1);
  const allSaints = dow(nov1) === 0 ? nov1 + DAY : mondayOf(nov1);
  if (t >= allSaints && t < allSaints + 7 * DAY) return 'allSaints';

  // 24 December to 6 January when that is a Monday to Thursday, else to the
  // Sunday after.
  const jan6 = utc(startYear + 1, 1, 6);
  const christmasEnd = dow(jan6) >= 1 && dow(jan6) <= 4 ? jan6 : jan6 + ((7 - dow(jan6)) % 7) * DAY;
  if (t >= utc(startYear, 12, 24) && t <= christmasEnd) return 'christmas';

  const easter = easterSunday(startYear + 1);
  const ashWednesday = mondayOf(easter - 46 * DAY);
  if (t >= ashWednesday && t < ashWednesday + 7 * DAY) return 'winter';
  if (t >= easter - 3 * DAY && t <= easter + 2 * DAY) return 'easter';

  if (isPublicHoliday(t)) return 'holiday';
  return dow(t) === 0 || dow(t) === 6 ? 'weekend' : null;
}

// Art. 3 since Nr. 8/2025: "In den Schulen ist der Montag unterrichtsfrei, wenn
// der darauffolgende Dienstag ein freier Tag ist." Before, it was a school day
// (2015, 2017, 2018, 2020, 2023), and no such Monday fell between the decision
// and this school year.
const MONDAY_BRIDGES_FROM = utc(2025, 9, 1);

/**
 * Why there are no lessons on `day` (YYYY-MM-DD) in South Tyrol, or null on
 * a school day. Only what follows from the rules: a day freed by a single
 * decision comes from the schools' WebUntis or a menu's own corrections.
 */
export function suedtirolDayOff(day: string): DayOffReason | null {
  const t = parse(day);
  const base = baseReason(t);
  if (base) return base;
  // Fenstertage: the Friday after a public holiday on Thursday (Art. 3) and
  // the Monday before a free Tuesday (a holiday, or 24 December).
  if (dow(t) === 5 && isPublicHoliday(t - DAY)) return 'bridge';
  if (dow(t) === 1 && t >= MONDAY_BRIDGES_FROM && baseReason(t + DAY)) return 'bridge';
  return null;
}
