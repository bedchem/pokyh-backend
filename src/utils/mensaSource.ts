import { createHash } from 'node:crypto';

// A menu pulled from a source (a mensa.json): read strictly into dishes, then
// compared with what the plan holds. Nothing from a source is trusted: it may
// be broken, half empty or hostile, and the next pull runs with nobody
// watching. Free of the database so it can be tested on its own
// (tests/mensaSource.test.mjs).
//
// What a pull must never do: move a week (the plan's position in its cycle),
// replace an uploaded picture, undo an administrator's edit while the source
// has not changed that dish, or empty a plan because a file came out wrong.

export class MenuSourceError extends Error {}

export interface SourceDish {
  sourceId: string;
  nameDe: string;
  nameIt: string;
  nameEn: string;
  descDe: string;
  descIt: string;
  descEn: string;
  imageUrl: string;
  category: string;
  tags: string;
  allergens: string;
  prepTime: number;
  calories: number;
  price: number;
  protein: number;
  fat: number;
  isVegetarian: boolean;
  isVegan: boolean;
  /** YYYY-MM-DD */
  date: string;
  weekOrdinal: number;
  /** A source that only knows part of a dish (a PDF: no pictures, no nutrition). */
  partial?: boolean;
  /** Knows the week and the weekday only: `date` is a placeholder for the order. */
  undated?: boolean;
}

export interface ParsedSource {
  dishes: SourceDish[];
  /** Entries that could not be read, or were there twice. */
  skipped: number;
}

// The sizes of the columns these go into (prisma/schema.prisma).
const MAX_NAME = 500;
const MAX_DESC = 2000;
const MAX_URL = 1000;
const MAX_CATEGORY = 200;
const MAX_LIST_JSON = 2000;
const MAX_SOURCE_ID = 200;
const MAX_NUMBER = 1_000_000;
// Far more than any menu; a bigger file is not a menu.
const MAX_DISHES = 2000;

const DAY = 86_400_000;
const WEEKDAYS: Record<string, number> = {
  mo: 1, montag: 1, monday: 1, lunedi: 1, lun: 1,
  di: 2, dienstag: 2, tuesday: 2, tue: 2, martedi: 2, mar: 2,
  mi: 3, mittwoch: 3, wednesday: 3, wed: 3, mercoledi: 3, mer: 3,
  do: 4, donnerstag: 4, thursday: 4, thu: 4, giovedi: 4, gio: 4,
  fr: 5, freitag: 5, friday: 5, fri: 5, venerdi: 5, ven: 5,
  sa: 6, samstag: 6, saturday: 6, sat: 6, sabato: 6, sab: 6,
  so: 7, sonntag: 7, sunday: 7, sun: 7, domenica: 7, dom: 7,
};

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

/** The dish's name as its stable key: the same as utils/dishKey's slugifyDishName. */
export function dishSlug(name: string): string {
  return fold(name).replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 180);
}

// Text without control characters, in the size its column holds.
function text(v: unknown, max: number): string {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  // eslint-disable-next-line no-control-regex
  return String(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
}

function localized(v: unknown, max: number): { de: string; it: string; en: string } {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const m = v as Record<string, unknown>;
    const first = Object.values(m).map((x) => text(x, max)).find(Boolean) ?? '';
    const de = text(m['de'], max) || text(m['it'], max) || text(m['en'], max) || first;
    return { de, it: text(m['it'], max) || de, en: text(m['en'], max) || de };
  }
  const s = text(v, max);
  return { de: s, it: s, en: s };
}

function amount(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(',', '.')) : 0;
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_NUMBER) : 0;
}

// As JSON, as many entries as fit the column.
function list(v: unknown): string {
  if (!Array.isArray(v)) return '[]';
  const kept: string[] = [];
  for (const item of v) {
    const s = text(item, 100);
    if (!s || kept.includes(s)) continue;
    if (JSON.stringify([...kept, s]).length > MAX_LIST_JSON) break;
    kept.push(s);
  }
  return JSON.stringify(kept);
}

// A plain web address, or nothing: the clients load it as a picture.
function webUrl(v: unknown): string {
  const s = text(v, MAX_URL + 1);
  if (!s || s.length > MAX_URL) return '';
  try {
    const u = new URL(s);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password ? s : '';
  } catch {
    return '';
  }
}

function dayOf(v: unknown): string | null {
  const s = text(v, 40);
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const dotted = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  const [y, m, d] = iso ? [iso[1], iso[2], iso[3]] : dotted ? [dotted[3], dotted[2], dotted[1]] : [];
  if (!y || !m || !d) return null;
  const t = Date.UTC(Number(y), Number(m) - 1, Number(d));
  const day = new Date(t).toISOString().slice(0, 10);
  // 2026-02-31 would roll on to March.
  const wanted = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  // Up to the last day a DATE column holds: a source may run for a long time.
  return day === wanted && day >= '2000-01-01' && day <= '9999-12-31' ? day : null;
}

// "w6_mo": week 6, Monday.
function fromSourceId(id: string): { week: number; weekday: number } {
  const m = id.match(/^w(\d{1,3})[_-]([a-z]+)/i);
  return m ? { week: Number(m[1]), weekday: WEEKDAYS[fold(m[2]!)] ?? 0 } : { week: 0, weekday: 0 };
}

// A week and a weekday without a date: placed from a fixed Monday. Only the
// order counts, the plan's own layout gives the real dates.
const REFERENCE_MONDAY = Date.UTC(2001, 0, 1);

export function dayFromWeek(week: number, weekday: number): string | null {
  return week > 0 && week < 1000 && weekday > 0
    ? new Date(REFERENCE_MONDAY + ((week - 1) * 7 + weekday - 1) * DAY).toISOString().slice(0, 10)
    : null;
}

function mondayOf(day: string): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  const weekday = new Date(t).getUTCDay() || 7;
  return new Date(t - (weekday - 1) * DAY).toISOString().slice(0, 10);
}

/**
 * Reads a source for one plan. Accepts `{ menu: { dishes } }`, `{ dishes }`,
 * `{ data }` or a plain list; an entry naming another plan belongs to that
 * one, so one file can hold both. Refuses what is not a menu at all.
 */
export function parseMenuSource(raw: string, plan: string): ParsedSource {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MenuSourceError('Die Quelle liefert kein gültiges JSON');
  }
  const r = (parsed ?? {}) as Record<string, unknown>;
  const fromMenu = (r['menu'] as Record<string, unknown> | undefined)?.['dishes'];
  const entries = Array.isArray(parsed) ? parsed : fromMenu ?? r['dishes'] ?? r['data'];
  if (!Array.isArray(entries)) throw new MenuSourceError('In der Quelle steht keine Liste von Gerichten');
  if (entries.length > MAX_DISHES) throw new MenuSourceError(`Die Quelle enthält mehr als ${MAX_DISHES} Einträge`);

  const dishes: SourceDish[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { skipped++; continue; }
    const d = entry as Record<string, unknown>;
    if (typeof d['plan'] === 'string' && d['plan'] !== plan) continue;

    const name = localized(d['name'] ?? d['title'], MAX_NAME);
    const id = text(d['id'] ?? d['sourceId'], MAX_SOURCE_ID);
    const parts = fromSourceId(id);
    const week = Number.isInteger(d['week']) ? (d['week'] as number) : parts.week;
    const weekday = WEEKDAYS[fold(text(d['day'], 20))] ?? parts.weekday;
    const date = dayOf(d['date']) ?? dayFromWeek(week, weekday);
    if (!name.de || !date) { skipped++; continue; }

    // Without an id of its own a dish is known by its day and name.
    const sourceId = id || `auto:${date}:${dishSlug(name.de)}`.slice(0, MAX_SOURCE_ID);
    if (seen.has(sourceId)) { skipped++; continue; }
    seen.add(sourceId);

    const desc = localized(d['description'] ?? d['desc'], MAX_DESC);
    dishes.push({
      sourceId,
      nameDe: name.de,
      nameIt: name.it,
      nameEn: name.en,
      descDe: desc.de,
      descIt: desc.it,
      descEn: desc.en,
      imageUrl: webUrl(d['imageUrl'] ?? d['image']),
      category: text(d['category'], MAX_CATEGORY),
      tags: list(d['tags']),
      allergens: list(d['allergens']),
      prepTime: Math.round(amount(d['prepTime'])),
      calories: Math.round(amount(d['calories'])),
      price: amount(d['price']),
      protein: amount(d['protein']),
      fat: amount(d['fat']),
      isVegetarian: d['isVegetarian'] === true,
      isVegan: d['isVegan'] === true,
      date,
      weekOrdinal: week,
    });
  }

  // A dish that names no week gets its place among the file's Mondays.
  const mondays = [...new Set(dishes.map((d) => mondayOf(d.date)))].sort();
  for (const d of dishes) if (!d.weekOrdinal) d.weekOrdinal = mondays.indexOf(mondayOf(d.date)) + 1;
  return { dishes, skipped };
}

/** What a source says about a dish, for telling later whether it changed it. */
export function dishFingerprint(d: SourceDish): string {
  const { date: _date, weekOrdinal: _weekOrdinal, partial: _partial, undated: _undated, ...content } = d;
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

export interface PlanDish {
  id: string;
  nameDe: string;
  descDe?: string;
  sourceId: string | null;
  sourceHash: string;
  /** YYYY-MM-DD */
  date: string;
  weekOrdinal: number;
  /** Has a picture an administrator uploaded: the source's never replaces it. */
  hasUpload: boolean;
  /**
   * The link its kept picture was taken from (services/dishPictures.ts), or
   * null: while the source names that link the copy stays, a new link
   * replaces it.
   */
  adoptedFrom?: string | null;
}

const FILLERS = new Set(['mit', 'und', 'oder', 'auf', 'in', 'im', 'an', 'am', 'der', 'die', 'das', 'dem', 'den', 'von', 'vom', 'zu', 'zum', 'gebacken', 'gebraten', 'gebratene', 'gebratener']);

// The words that tell a dish apart. A hyphen joins ("Spinat-Ravioli"), so
// spelling it differently is the same word; plain plurals count as one too.
function dishWords(name: string): string[] {
  return fold(name).replace(/ß/g, 'ss').replace(/-/g, '').split(/[^a-z0-9]+/)
    .filter((w) => w && !FILLERS.has(w))
    .map((w) => w.replace(/(en|e|n|s)$/, ''));
}

/**
 * Whether two names mean the same dish: the shorter name's telling words are
 * nearly all in the longer one ("Truthahnbraten mit Reis" and "Truthahnbraten
 * Reis"), which "Kräuterknödel mit Pilzsauce" and "… mit Lauchsauce" are not.
 */
export function sameDishName(a: string, b: string): boolean {
  const wa = new Set(dishWords(a));
  const wb = new Set(dishWords(b));
  if (wa.size === 0 || wb.size === 0) return false;
  const [small, large] = wa.size <= wb.size ? [wa, wb] : [wb, wa];
  const shared = [...small].filter((w) => [...large].some((v) => sameWord(w, v))).length;
  return shared / small.size >= 0.75;
}

// A typo or an ending apart ("frites" and "frittes", "pasticciat" and
// "pasticciata"), not two words ("pilz" and "lauch").
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  // A word and its compound ("linsen" and "linsenragout").
  if (short.length >= 4 && long.startsWith(short)) return true;
  if (short.length < 5) return false;
  // Another ending of the same word ("mozzarella" and "mozzarelline").
  let prefix = 0;
  while (prefix < short.length && short[prefix] === long[prefix]) prefix++;
  if (prefix >= 6 && prefix >= short.length * 0.8) return true;
  if (long.length - short.length > 1) return false;
  // At most one letter changed, added or left out.
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  const rest = (x: string, y: string) => x === y;
  return rest(a.slice(i + 1), b.slice(i + 1)) || rest(a.slice(i), b.slice(i + 1)) || rest(a.slice(i + 1), b.slice(i));
}

export interface PullPlan {
  /** New dishes, with the day they get. */
  create: Array<{ dish: SourceDish; date: string; hash: string }>;
  /**
   * Dishes the source has changed. `date` only when the dates are the source's
   * to set. `curated`: a source that knows only part of a dish, about the same
   * dish: what was made of it here (name, picture, nutrition, ratings) stays.
   * `dropImage`: it is another dish now, its picture would be wrong.
   */
  update: Array<{ id: string; dish: SourceDish; hash: string; date: string | null; keepImage: boolean; curated: boolean; dropImage: boolean; fillDescription: boolean }>;
  /** Seen in this source for the first time: left as they are, known from now on. */
  adopt: Array<{ id: string; hash: string }>;
  /** Seen for the first time and named differently there: left until someone decides. */
  differs: string[];
  /** Gone from the source. */
  remove: string[];
  /** Why this should not happen without an administrator saying so. */
  held: string | null;
}

export interface PullOptions {
  /** An administrator asked for exactly this: the source wins everywhere. */
  force: boolean;
  /** A menu laid out by the server keeps its dates. */
  keepDates: boolean;
  /** Whether dishes the source no longer has go too. */
  removeMissing: boolean;
}

/**
 * What a pull does to one plan. Compares with the fingerprint of the last pull,
 * so only what the source itself has changed since then is touched.
 */
export function planPull(existing: PlanDish[], source: ParsedSource, options: PullOptions, weeks: Array<Pick<PlanDish, 'date' | 'weekOrdinal'>> = existing): PullPlan {
  const { force, keepDates, removeMissing } = options;
  const plan: PullPlan = { create: [], update: [], adopt: [], differs: [], remove: [], held: null };
  const bySource = new Map<string, PlanDish>();
  for (const d of existing) {
    // Rows from before source ids carried it as their id.
    const key = d.sourceId ?? d.id;
    if (!bySource.has(key)) bySource.set(key, d);
  }
  const mondayOfWeek = new Map<number, string>();
  // Where each week of the plan lies now: a new dish goes into its week.
  for (const d of weeks) if (d.weekOrdinal > 0 && !mondayOfWeek.has(d.weekOrdinal)) mondayOfWeek.set(d.weekOrdinal, mondayOf(d.date));

  let matched = 0;
  const inSource = new Set<string>();
  for (const dish of source.dishes) {
    inSource.add(dish.sourceId);
    const hash = dishFingerprint(dish);
    const have = bySource.get(dish.sourceId);
    if (!have) {
      // Into the week of the plan it belongs to, wherever that lies right now.
      const monday = keepDates || dish.undated ? mondayOfWeek.get(dish.weekOrdinal) : undefined;
      const weekday = (new Date(`${dish.date}T00:00:00Z`).getUTCDay() || 7) - 1;
      const date = monday ? new Date(Date.parse(`${monday}T00:00:00Z`) + weekday * DAY).toISOString().slice(0, 10) : dish.date;
      plan.create.push({ dish, date, hash });
      continue;
    }
    matched++;
    const sourceDate = keepDates || dish.undated ? null : dish.date;
    const same = sameDishName(have.nameDe, dish.nameDe);
    const adopted = have.adoptedFrom ?? null;
    // A copy of the source's own link stays while the source names it (a
    // source that knows only part of a dish names none: while it is the same dish).
    const keepAdopted = adopted !== null && (dish.partial ? same : dish.imageUrl === adopted);
    const change = (date: string | null) => plan.update.push({
      id: have.id,
      dish,
      hash,
      date,
      keepImage: (have.hasUpload && (same || !dish.partial)) || keepAdopted,
      curated: Boolean(dish.partial) && same,
      dropImage: (Boolean(dish.partial) && !same && (have.hasUpload || adopted !== null)) || (adopted !== null && !keepAdopted),
      fillDescription: !have.descDe,
    });
    if (!force && !have.sourceHash) {
      if (same || !dish.partial) plan.adopt.push({ id: have.id, hash });
      else plan.differs.push(have.id);
    } else if (force || have.sourceHash !== hash) {
      change(sourceDate);
    } else if (sourceDate && have.date !== sourceDate) {
      change(sourceDate);
    }
  }

  // What this source once gave and no longer has; never a dish added by hand,
  // and on first contact nothing: it may simply have come from elsewhere.
  if (removeMissing) {
    for (const d of existing) {
      if (d.sourceId && !inSource.has(d.sourceId) && (force || d.sourceHash)) plan.remove.push(d.id);
    }
  }

  if (force) return plan;

  const total = source.dishes.length + source.skipped;
  const known = existing.filter((d) => d.sourceId && d.sourceHash).length;
  if (source.dishes.length === 0) {
    plan.held = 'Die Quelle enthält keine lesbaren Gerichte für diesen Plan';
  } else if (source.skipped / total > 0.2) {
    plan.held = `${source.skipped} von ${total} Einträgen der Quelle sind nicht lesbar`;
  } else if (known >= 3 && plan.remove.length / known > 0.5) {
    plan.held = `Die Quelle würde ${plan.remove.length} von ${known} Gerichten entfernen`;
  } else if (existing.length > 0 && matched === 0) {
    plan.held = 'Kein Gericht der Quelle passt zu diesem Plan, sie würden nur dazukommen';
  } else if (plan.differs.length > 0) {
    plan.held = `${plan.differs.length} ${plan.differs.length === 1 ? 'Gericht heißt' : 'Gerichte heißen'} in der Quelle anders als hier`;
  }
  return plan;
}

/** A source address an administrator may store: a plain web address, nothing to log in with. */
export function sourceUrlProblem(url: string): string | null {
  if (url.length > MAX_URL) return 'Die Adresse ist zu lang';
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'Das ist keine gültige Adresse';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'Nur http- und https-Adressen sind möglich';
  if (u.username || u.password) return 'Die Adresse darf keine Zugangsdaten enthalten';
  return null;
}
