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
  /** MM-DD, when the plan says from when it applies. */
  validFrom: string | null;
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

// "1. November bis 31. März": 11-01.
function validFromOf(text: string): string | null {
  const m = text.match(/(\d{1,2})\.\s*([A-Za-zÄÖÜäöü]+)\s+bis\s+\d{1,2}\.\s*[A-Za-zÄÖÜäöü]+/);
  const month = m ? MONTHS[m[2]!.toLowerCase()] : undefined;
  const day = m ? Number(m[1]) : 0;
  return month && day >= 1 && day <= 31 ? `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : null;
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
  return { dishes, skipped, season, vegetarian, validFrom: validFromOf(heading) };
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
