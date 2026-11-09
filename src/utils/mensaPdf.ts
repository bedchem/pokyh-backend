import { MenuSourceError, dayFromWeek, type ParsedSource, type SourceDish } from './mensaSource';

// A menu as the Gemeinde Brixen publishes it: one page, a column per week, a
// row per weekday, each row closed by a line of allergen letters. Read from
// where the text stands on the page, so wrapped lines stay in their cell. Free
// of the database so it can be tested on its own (tests/mensaPdf.test.mjs).

export interface PdfTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
}

export interface PdfMenu extends ParsedSource {
  season: 'summer' | 'winter' | null;
  vegetarian: boolean;
  /** MM-DD, when the plan says from when it applies (top right: "1. November bis 31. März"). */
  validFrom: string | null;
  /** MM-DD, when it says until when. */
  validTo: string | null;
}

const WEEKDAYS: Record<string, [number, string]> = {
  montag: [1, 'mo'], dienstag: [2, 'di'], mittwoch: [3, 'mi'], donnerstag: [4, 'do'], freitag: [5, 'fr'], samstag: [6, 'sa'], sonntag: [7, 'so'],
};

const MONTHS: Record<string, number> = {
  januar: 1, jänner: 1, februar: 2, feber: 2, märz: 3, april: 4, mai: 5, juni: 6, juli: 7, august: 8, september: 9, oktober: 10, november: 11, dezember: 12,
};

// The letters of the EU's 14 allergens as Italy and Austria use them.
const ALLERGENS: Record<string, string> = {
  A: 'Gluten', B: 'Krebstiere', C: 'Eier', D: 'Fisch', E: 'Erdnüsse', F: 'Soja', G: 'Milch', H: 'Schalenfrüchte',
  L: 'Sellerie', M: 'Senf', N: 'Sesam', O: 'Sulfite', P: 'Lupinen', R: 'Weichtiere',
};

const SIDE_DISH = /Gemüse\s*\/\s*Salat/i;
const LINE_TOLERANCE = 3;

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
const center = (i: PdfTextItem) => i.x + i.width / 2;

// The items of a cell as lines, top to bottom.
function linesOf(items: PdfTextItem[]): string[] {
  const lines: Array<{ y: number; items: PdfTextItem[] }> = [];
  for (const item of [...items].sort((a, b) => a.y - b.y)) {
    const line = lines.find((l) => Math.abs(l.y - item.y) <= LINE_TOLERANCE);
    if (line) line.items.push(item);
    else lines.push({ y: item.y, items: [item] });
  }
  return lines.map((l) => clean(l.items.sort((a, b) => a.x - b.x).map((i) => i.str).join(' '))).filter(Boolean);
}

// "Farfalle mit Lachssauce / Gemüse / Salat / Fruchtjogurt" as name and the rest.
function splitCell(lines: string[]): { name: string; description: string } {
  // A word split at the end of a line: "Linsen-" "Gemüsesauce".
  const text = lines.join('\n').replace(/(\p{L})-\n(?=\p{L})/gu, '$1-');
  const side = text.match(SIDE_DISH);
  if (!side || side.index === undefined) return { name: clean(text), description: '' };
  const after = text.slice(side.index + side[0].length).split('\n').map(clean);
  const sides = clean(`${clean(side[0]).replace(/\s*\/\s*/, ' / ')} ${after[0] ?? ''}`);
  return { name: clean(text.slice(0, side.index)), description: [sides, ...after.slice(1).filter(Boolean)].join(' · ') };
}

function allergensOf(text: string): string {
  const letters = [...new Set(text.toUpperCase().match(/\b[A-Z]\b/g) ?? [])];
  return JSON.stringify(letters.map((l) => ALLERGENS[l] ?? l));
}

// "31. März": 03-31, when it is a day of the year.
function monthDay(day: string, month: string): string | null {
  const m = MONTHS[month.toLowerCase()];
  const d = Number(day);
  if (!m || !Number.isInteger(d) || d < 1 || d > DAYS_IN_MONTH[m - 1]!) return null;
  return `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

// "1. November bis 31. März", as the plans say in their top right corner.
function validityOf(text: string): { from: string | null; to: string | null } {
  const m = text.normalize('NFC').match(/(\d{1,2})\.\s*([A-Za-zÄÖÜäöü]+)\s+bis\s+(\d{1,2})\.\s*([A-Za-zÄÖÜäöü]+)/);
  if (!m) return { from: null, to: null };
  const from = monthDay(m[1]!, m[2]!);
  return { from, to: from ? monthDay(m[3]!, m[4]!) : null };
}

/** The day after a day of the year (MM-DD); the day after 28 or 29 February is 1 March. */
export function dayAfter(md: string): string {
  if (md === '02-28' || md === '02-29') return '03-01';
  const t = Date.UTC(2001, Number(md.slice(0, 2)) - 1, Number(md.slice(3)) + 1);
  return new Date(t).toISOString().slice(5, 10);
}

const dayMonth = (md: string) => `${Number(md.slice(3))}.${Number(md.slice(0, 2))}.`;

/** "MM-DD/MM-DD" as a source keeps what its PDF says, from and to; "" when it says nothing. */
export function validityText(menu: { validFrom: string | null; validTo: string | null }): string {
  return menu.validFrom ? `${menu.validFrom}/${menu.validTo ?? ''}` : '';
}

/**
 * Whether the dates the plans name fit together: the summer plan ends the day
 * before the winter plan begins, and the other way round, and a vegetarian
 * menu runs as long as its plan. What does not, in words; null when all fits
 * or too little is known. Each `validity` is a validityText (anything else
 * counts as not known).
 */
export function seasonDatesProblem(validity: { summer: string; winter: string; summerVeg?: string; winterVeg?: string }): string | null {
  const split = (v: string | undefined) => {
    const m = (v ?? '').match(/^(\d{2}-\d{2})\/((?:\d{2}-\d{2})?)$/);
    return { from: m?.[1] ?? '', to: m?.[2] ?? '' };
  };
  const summer = split(validity.summer);
  const winter = split(validity.winter);
  const problems: string[] = [];
  if (summer.to && winter.from && dayAfter(summer.to) !== winter.from) problems.push(`Der Sommerplan gilt bis ${dayMonth(summer.to)}, der Winterplan ab ${dayMonth(winter.from)}`);
  if (winter.to && summer.from && dayAfter(winter.to) !== summer.from) problems.push(`Der Winterplan gilt bis ${dayMonth(winter.to)}, der Sommerplan ab ${dayMonth(summer.from)}`);
  for (const [name, own, veg] of [['Sommer', summer, split(validity.summerVeg)], ['Winter', winter, split(validity.winterVeg)]] as const) {
    if (own.from && veg.from && (own.from !== veg.from || (own.to && veg.to && own.to !== veg.to))) {
      problems.push(`Das vegetarische Menü ${name} gilt ${dayMonth(veg.from)}–${veg.to ? dayMonth(veg.to) : '?'}, das Menü ${name} ${dayMonth(own.from)}–${own.to ? dayMonth(own.to) : '?'}`);
    }
  }
  return problems.length > 0 ? problems.map((p, i) => (i === 0 ? p : p[0]!.toLowerCase() + p.slice(1))).join('; ') : null;
}

/** Reads a plan from the text of its PDF. Refuses what has no such grid. */
export function parseMenuPdf(pages: PdfTextItem[][]): PdfMenu {
  const items = pages.find((page) => page.some((i) => /^\d+\.\s*Woche$/i.test(clean(i.str)))) ?? [];
  const weeks = items
    .map((i) => ({ item: i, m: clean(i.str).match(/^(\d+)\.\s*Woche$/i) }))
    .filter((w) => w.m)
    .map((w) => ({ week: Number(w.m![1]), x: center(w.item), y: w.item.y }))
    .sort((a, b) => a.x - b.x);
  const rows = items
    .filter((i) => WEEKDAYS[clean(i.str).toLowerCase()] && weeks.length > 0 && center(i) < weeks[0]!.x)
    .map((i) => ({ label: clean(i.str).toLowerCase(), y: i.y }))
    .sort((a, b) => a.y - b.y);
  if (weeks.length === 0 || rows.length === 0) throw new MenuSourceError('Im PDF wurde kein Wochenplan gefunden');

  const step = weeks.length > 1 ? (weeks[weeks.length - 1]!.x - weeks[0]!.x) / (weeks.length - 1) : 120;
  const columnOf = (x: number) => {
    const i = weeks.findIndex((w) => Math.abs(x - w.x) <= step / 2);
    return i < 0 ? null : weeks[i]!;
  };

  const marks = items.filter((i) => /^allergene$/i.test(clean(i.str))).map((i) => i.y).sort((a, b) => a - b);
  // The line each row ends with; without those lines, half way to the next row.
  const ends = rows.map((row, r) => marks.find((y) => y > row.y) ?? (rows[r + 1] ? (row.y + rows[r + 1]!.y) / 2 : Infinity));

  const heading = clean(items.filter((i) => i.y < weeks[0]!.y - LINE_TOLERANCE).sort((a, b) => a.y - b.y || a.x - b.x).map((i) => i.str).join(' '));
  const season = /sommer/i.test(heading) ? 'summer' : /winter/i.test(heading) ? 'winter' : null;
  const vegetarian = /vegetarisch/i.test(heading);

  const dishes: SourceDish[] = [];
  let skipped = 0;
  rows.forEach((row, r) => {
    const top = r === 0 ? weeks[0]!.y + LINE_TOLERANCE : ends[r - 1]! + LINE_TOLERANCE;
    const bottom = ends[r]! - LINE_TOLERANCE;
    const [weekday, code] = WEEKDAYS[row.label]!;
    for (const week of weeks) {
      const inColumn = items.filter((i) => columnOf(center(i)) === week);
      const { name, description } = splitCell(linesOf(inColumn.filter((i) => i.y > top && i.y < bottom)));
      const date = dayFromWeek(week.week, weekday);
      if (!name || !date) { skipped++; continue; }
      const allergens = inColumn.filter((i) => Math.abs(i.y - ends[r]!) <= LINE_TOLERANCE).map((i) => i.str).join(' ');
      dishes.push({
        sourceId: `w${week.week}_${code}`,
        nameDe: name.slice(0, 500),
        nameIt: name.slice(0, 500),
        nameEn: name.slice(0, 500),
        descDe: description.slice(0, 2000),
        descIt: description.slice(0, 2000),
        descEn: description.slice(0, 2000),
        imageUrl: '',
        category: '',
        tags: '[]',
        allergens: allergensOf(allergens),
        prepTime: 0,
        calories: 0,
        price: 0,
        protein: 0,
        fat: 0,
        isVegetarian: vegetarian,
        isVegan: false,
        date,
        weekOrdinal: week.week,
        partial: true,
        undated: true,
      });
    }
  });
  const validity = validityOf(heading);
  return { dishes, skipped, season, vegetarian, validFrom: validity.from, validTo: validity.to };
}

// Words of a file name, without what every plan's name has.
const wordsOf = (s: string) => s.toLowerCase().normalize('NFC').replace(/ß/g, 'ss').split(/[^a-zà-ÿ0-9]+/).filter((w) => w.length > 0);
const GENERIC = new Set(['mensa', 'menü', 'menu', 'menue', 'menueplan', 'menüplan', 'pdf', 'plan', 'sommer', 'winter', 'vegetarisch', 'vegetarian', 'dt', 'de', 'deutsch']);
// The Italian edition of the same plan: its dish names are not the ones kept here.
const ITALIAN = new Set(['it', 'ita', 'italiano', 'italienisch', 'vegetariano', 'sezione', 'sezioni', 'distaccata', 'distaccate']);
// Another menu of the same kitchen (the plan for its branch schools, packed
// lunches): never taken for the canteen's own, unless the canteen named is it.
const OTHER_MENU = new Set(['aussenstellen', 'aussenstelle', 'lunchpakete', 'lunchpaket', 'lunchpakets']);

/**
 * The plan's PDF among the links of an overview page, so a source goes on
 * working when the file is renamed or uploaded anew. `hint` names the canteen
 * ("Mensa St. Michael"): the file name with most of its telling words wins,
 * then a plan for this season before one for the whole year (the canteens had
 * one plan a year until 2024/25), then the one with the fewest other words
 * (not "St. Michael Außenstellen"), then the newest year. Italian editions,
 * another menu of the same kitchen (its branch schools, packed lunches) and
 * links to other hosts never count: with the canteen's own file gone from the
 * page, the line fails rather than taking another menu's dishes.
 */
export function pickPlanLink(html: string, pageUrl: string, hint: string, plan: 'summer' | 'winter', vegetarian: boolean): string | null {
  const page = new URL(pageUrl);
  const hintWords = wordsOf(hint);
  const needed = hintWords.filter((w) => !GENERIC.has(w));
  if (needed.length === 0) return null;
  const season = plan === 'summer' ? 'sommer' : 'winter';
  const otherSeason = plan === 'summer' ? 'winter' : 'sommer';
  const candidates: Array<{ url: string; year: number; others: number; matched: number; seasonal: boolean }> = [];
  for (const m of html.matchAll(/href\s*=\s*["']([^"'#]+\.pdf)["']/gi)) {
    let url: URL;
    let name: string;
    try {
      url = new URL(m[1]!.replace(/&amp;/g, '&'), page);
      name = decodeURIComponent(url.pathname.split('/').pop() ?? '').replace(/\.pdf$/i, '');
    } catch {
      continue;
    }
    if (url.host !== page.host || url.protocol !== page.protocol) continue;
    const words = wordsOf(name);
    if (words.includes(otherSeason) || words.includes('vegetarisch') !== vegetarian || words.some((w) => ITALIAN.has(w))) continue;
    if (words.some((w) => OTHER_MENU.has(w) && !hintWords.includes(w))) continue;
    const matched = needed.filter((w) => words.includes(w)).length;
    if (matched === 0) continue;
    const year = Number(name.match(/(?:^|\D)(20\d\d)(?:\D|$)/)?.[1] ?? 0);
    const others = words.filter((w) => !hintWords.includes(w) && !GENERIC.has(w) && !/^\d+$/.test(w)).length;
    candidates.push({ url: url.href, year, others, matched, seasonal: words.includes(season) });
  }
  candidates.sort((a, b) => b.matched - a.matched || Number(b.seasonal) - Number(a.seasonal) || a.others - b.others || b.year - a.year);
  return candidates[0]?.url ?? null;
}
