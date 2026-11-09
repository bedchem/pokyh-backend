import { createHash, randomUUID } from 'node:crypto';
import { config } from '../config';
import { prisma } from '../db';
import { ownsClusterWork } from '../cluster/hooks';
import { invalidateDishesCache } from '../utils/cache';
import { slugifyDishName } from '../utils/dishKey';
import { logger } from '../utils/logger';
import { parseMenuPdf, pickPlanLink, validityText } from '../utils/mensaPdf';
import type { Plan } from '../utils/mensaSeason';
import { MenuSourceError, parseMenuSource, planPull, type ParsedSource, type SourceDish } from '../utils/mensaSource';
import { pdfTextItems } from '../utils/pdfText';
import { BlockedAddressError, fetchBytes, fetchUrl, isInternalUrl } from '../utils/safeFetch';
import { arrangeMenu, menuSchedule } from './mensaSchedule';
import { DEFAULT_MENU_ID } from './schools';
import { audit } from './audit';

// Pulling a menu's plans from their sources: regularly by itself or when an
// administrator asks. A source is a mensa.json, the plan's PDF, or a page that
// links the canteen's PDFs (the Gemeinde Brixen's), where the current files are
// looked up at every pull. Whatever goes wrong, the plan stays as it is: a bad
// file changes nothing and is reported on the Mensa page.
//
// A menu has four lines: the summer and the winter plan, and each one's
// vegetarian menu, a second dish a day. Those dishes are known by "veg:" in
// front of their source id, so the lines never touch each other's dishes.

export const PLANS: readonly Plan[] = ['summer', 'winter'];

export type PullLine = 'summer' | 'winter' | 'summer-veg' | 'winter-veg';
export const PULL_LINES: readonly PullLine[] = ['summer', 'winter', 'summer-veg', 'winter-veg'];

const planOf = (line: PullLine): Plan => (line.startsWith('summer') ? 'summer' : 'winter');
const isVegetarianLine = (line: PullLine) => line.endsWith('-veg');
const VEG = 'veg:';

export type PullStatus = 'ok' | 'held' | 'error' | 'none';

export interface PullResult {
  plan: PullLine;
  status: PullStatus;
  message: string;
  created: number;
  updated: number;
  adopted: number;
  removed: number;
}

export interface PullOptions {
  /** An administrator's decision: the source wins, whatever it looks like. */
  force?: boolean;
  /** A one-off address instead of the plan's own source; nothing is recorded for it. */
  url?: string;
  /** Whether dishes gone from the source go here too. */
  removeMissing?: boolean;
  /** May this pull reach the internal network? Decided by whoever asks for it. */
  mayReachInternal?: boolean;
}

/** The operator's own source serves the default menu until it has its own. */
export function effectiveSourceUrl(menuId: string, stored: string | null | undefined): string {
  return stored || (menuId === DEFAULT_MENU_ID ? config.mensaImportUrl : '');
}

// Only the operator's own MENSA_IMPORT_URL is trusted with the internal network.
const isOperatorSource = (url: string) => config.mensaImportUrl !== '' && url === config.mensaImportUrl;

function sameHost(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.protocol === y.protocol && x.host === y.host;
  } catch {
    return false;
  }
}

// What may be shown about a failed pull: not addresses from inside the server.
export function failureText(err: unknown): string {
  if (err instanceof BlockedAddressError || err instanceof MenuSourceError) return err.message;
  const text = err instanceof Error ? err.message : '';
  const status = text.match(/^unexpected HTTP status (\d{3})$/);
  if (status) return `Die Quelle antwortet mit Fehler ${status[1]}`;
  if (text === 'fetch timeout') return 'Die Quelle antwortet nicht rechtzeitig';
  if (text === 'response too large') return 'Die Datei der Quelle ist zu groß';
  if (text === 'invalid URL' || text === 'unsupported URL scheme') return 'Die Adresse der Quelle ist ungültig';
  if (text === 'pdf timeout' || text.startsWith('pdf') || /Invalid PDF|PDF/i.test(text)) return 'Das PDF der Quelle konnte nicht gelesen werden';
  return 'Die Quelle konnte nicht geladen werden';
}

const content = (d: SourceDish) => ({
  nameDe: d.nameDe,
  nameIt: d.nameIt,
  nameEn: d.nameEn,
  descDe: d.descDe,
  descIt: d.descIt,
  descEn: d.descEn,
  category: d.category,
  tags: d.tags,
  allergens: d.allergens,
  prepTime: d.prepTime,
  calories: d.calories,
  price: d.price,
  protein: d.protein,
  fat: d.fat,
  isVegetarian: d.isVegetarian,
  isVegan: d.isVegan,
  weekOrdinal: d.weekOrdinal,
  stableKey: slugifyDishName(d.nameDe),
});

const utcDay = (day: string) => new Date(`${day}T00:00:00Z`);

// Builds the public URL a client uses to load a dish image (absolute when
// PUBLIC_BASE_URL is set, otherwise relative). Cache-busted on every upload.
export function dishImageUrl(dishId: string): string {
  return `${config.publicBaseUrl}/dishes/${encodeURIComponent(dishId)}/image?v=${Date.now()}`;
}

async function record(menuId: string, line: PullLine, data: { status: string; message: string; lastHash?: string; changedAt?: Date; validity?: string }): Promise<void> {
  const row = { ...data, message: data.message.slice(0, 300), checkedAt: new Date() };
  await prisma.mensaMenuSource.upsert({ where: { menuId_plan: { menuId, plan: line } }, create: { menuId, plan: line, ...row }, update: row });
}

interface Fetched {
  bytes: Buffer;
  /** The file's name, for the report. */
  file: string;
}

// The file a line comes from: the address given, the plan's own, or the PDF
// the canteen's page links now. Null when the line has none.
export async function sourceFile(menuId: string, line: PullLine, stored: string, options: PullOptions): Promise<Fetched | null> {
  const fileName = (url: string) => {
    try {
      return decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '') || url;
    } catch {
      return url;
    }
  };
  if (options.url !== undefined) {
    const bytes = await fetchBytes(options.url, { publicOnly: !(options.mayReachInternal || isOperatorSource(options.url)) });
    return { bytes, file: fileName(options.url) };
  }
  const menu = await prisma.mensaMenu.findUnique({ where: { id: menuId }, select: { sourcePage: true, sourceCanteen: true } });
  if (menu?.sourcePage && menu.sourceCanteen) {
    const trusted = isOperatorSource(menu.sourcePage);
    const html = await fetchUrl(menu.sourcePage, { publicOnly: !trusted });
    const link = pickPlanLink(html, menu.sourcePage, menu.sourceCanteen, planOf(line), isVegetarianLine(line));
    if (!link) {
      if (isVegetarianLine(line)) return null;
      throw new MenuSourceError(`Auf der Seite steht kein ${planOf(line) === 'summer' ? 'Sommer' : 'Winter'}plan für „${menu.sourceCanteen}“`);
    }
    // A link found on the page is the page's say, not the operator's: into the
    // internal network only from the operator's own page, and only to that
    // page's own host (never somewhere else the page points to).
    const internalAllowed = isOperatorSource(link) || (trusted && sameHost(link, menu.sourcePage));
    return { bytes: await fetchBytes(link, { publicOnly: !internalAllowed }), file: fileName(link) };
  }
  if (isVegetarianLine(line)) return null;
  const url = effectiveSourceUrl(menuId, stored);
  if (!url) return null;
  return { bytes: await fetchBytes(url, { publicOnly: !isOperatorSource(url) }), file: fileName(url) };
}

const isPdf = (bytes: Buffer) => bytes.subarray(0, 5).toString('latin1') === '%PDF-';

export interface ReadSource extends ParsedSource {
  /** What a PDF says in its top right corner, as validityText ("-": nothing); "" for a mensa.json. */
  validity: string;
  /** Whether that changed the day the menu's plan begins. */
  seasonChanged: boolean;
}

// A PDF plan, or a mensa.json. A PDF's date in its top right corner ("1.
// November bis 31. März") is the day its plan begins from then on.
export async function readSource(menuId: string, line: PullLine, bytes: Buffer): Promise<ReadSource> {
  const plan = planOf(line);
  if (!isPdf(bytes)) {
    if (isVegetarianLine(line)) throw new MenuSourceError('Ein vegetarisches Menü wird nur aus dem PDF der Mensa gelesen');
    return { ...parseMenuSource(bytes.toString('utf8'), plan), validity: '', seasonChanged: false };
  }
  const pdf = parseMenuPdf(await pdfTextItems(bytes));
  if (pdf.season && pdf.season !== plan) throw new MenuSourceError(`Das PDF ist ein ${pdf.season === 'summer' ? 'Sommer' : 'Winter'}plan`);
  if (pdf.vegetarian !== isVegetarianLine(line)) throw new MenuSourceError(pdf.vegetarian ? 'Das PDF ist das vegetarische Menü' : 'Das PDF ist nicht das vegetarische Menü');
  let seasonChanged = false;
  if (pdf.validFrom) {
    const field = plan === 'summer' ? 'summerFrom' : 'winterFrom';
    const { count } = await prisma.mensaMenu.updateMany({ where: { id: menuId, NOT: { [field]: pdf.validFrom } }, data: { [field]: pdf.validFrom } });
    seasonChanged = count > 0;
    if (seasonChanged) logger.info('mensa season date from the plan', { menuId, plan, from: pdf.validFrom });
  }
  const read = { ...pdf, validity: validityText(pdf) || '-', seasonChanged };
  if (!isVegetarianLine(line)) return read;
  return { ...read, dishes: pdf.dishes.map((d) => ({ ...d, sourceId: `${VEG}${d.sourceId}`, isVegetarian: true })) };
}

/** The dishes of one line within its plan. */
export function lineFilter(line: PullLine) {
  return isVegetarianLine(line)
    ? { sourceId: { startsWith: VEG } }
    : { OR: [{ sourceId: null }, { NOT: { sourceId: { startsWith: VEG } } }] };
}

/** One pull of one line. Never rejects: how it went is in the result (and on record). */
export async function pullPlan(menuId: string, line: PullLine, options: PullOptions = {}): Promise<PullResult> {
  const result: PullResult = { plan: line, status: 'none', message: '', created: 0, updated: 0, adopted: 0, removed: 0 };
  const force = options.force === true;
  const oneOff = options.url !== undefined;
  const plan = planOf(line);
  try {
    const row = await prisma.mensaMenuSource.findUnique({ where: { menuId_plan: { menuId, plan: line } } });
    const fetched = await sourceFile(menuId, line, row?.url ?? '', options);
    if (!fetched) {
      result.message = isVegetarianLine(line) ? 'Kein vegetarisches Menü in der Quelle' : 'Für diesen Plan ist keine Quelle eingetragen';
      return result;
    }

    const fileHash = createHash('sha256').update(fetched.bytes).digest('hex');
    // A PDF taken over before its dates were kept is read once more for them.
    const datesMissing = isPdf(fetched.bytes) && !row?.validity;
    if (!force && !oneOff && row?.status === 'ok' && row.lastHash === fileHash && !datesMissing) {
      await record(menuId, line, { status: 'ok', message: row.message || 'Unverändert' });
      result.status = 'ok';
      result.message = 'Unverändert';
      return result;
    }

    const source = await readSource(menuId, line, fetched.bytes);
    const schedule = await menuSchedule(menuId);
    const lineWhere = lineFilter(line);
    const select = { id: true, nameDe: true, descDe: true, sourceId: true, sourceHash: true, date: true, weekOrdinal: true } as const;
    const [all, existing] = await Promise.all([
      prisma.dish.findMany({ where: { menuId, plan }, select }),
      prisma.dish.findMany({ where: { menuId, plan, ...lineWhere }, select }),
    ]);
    const uploads = new Set((await prisma.dishImage.findMany({ where: { dishId: { in: existing.map((d) => d.id) } }, select: { dishId: true } })).map((i) => i.dishId));
    const asRow = (d: (typeof all)[number]) => ({ ...d, date: d.date.toISOString().slice(0, 10), hasUpload: uploads.has(d.id) });
    const pull = planPull(
      existing.map(asRow),
      source,
      { force, keepDates: schedule.mode === 'auto', removeMissing: options.removeMissing ?? !oneOff },
      // A new dish goes into the week the plan has its week in now, whichever line it is.
      all.map(asRow),
    );

    if (pull.held) {
      result.status = 'held';
      result.message = pull.held;
      if (!oneOff) await record(menuId, line, { status: 'held', message: pull.held });
      logger.warn('mensa pull held back', { menuId, plan: line, reason: pull.held });
      return result;
    }

    await prisma.$transaction(async (tx) => {
      // A dish that is already on the menu elsewhere brings its uploaded
      // picture along: it goes with the name (see the upload route).
      const keys = [...new Set(pull.create.map(({ dish }) => slugifyDishName(dish.nameDe)))];
      const sameDishes = keys.length > 0 ? await tx.dish.findMany({ where: { menuId, stableKey: { in: keys } }, select: { id: true, stableKey: true } }) : [];
      const pictures = sameDishes.length > 0 ? await tx.dishImage.findMany({ where: { dishId: { in: sameDishes.map((d) => d.id) } } }) : [];
      const pictureOf = new Map(pictures.map((p) => [sameDishes.find((d) => d.id === p.dishId)!.stableKey, p]));
      for (const { dish, date, hash } of pull.create) {
        const id = randomUUID();
        const picture = pictureOf.get(slugifyDishName(dish.nameDe));
        await tx.dish.create({
          data: { id, menuId, plan, sourceId: dish.sourceId, sourceHash: hash, imageUrl: picture ? dishImageUrl(id) : dish.imageUrl, date: utcDay(date), ...content(dish) },
        });
        if (picture) await tx.dishImage.create({ data: { dishId: id, data: picture.data, mimeType: picture.mimeType } });
      }
      for (const u of pull.update) {
        const when = u.date ? { date: utcDay(u.date) } : {};
        if (u.curated) {
          // The same dish from a source that knows only part of it (a PDF):
          // what was made of it here stays, the canteen's allergens count.
          const description = u.fillDescription ? { descDe: u.dish.descDe, descIt: u.dish.descIt, descEn: u.dish.descEn } : {};
          await tx.dish.update({ where: { id: u.id }, data: { sourceId: u.dish.sourceId, sourceHash: u.hash, weekOrdinal: u.dish.weekOrdinal, allergens: u.dish.allergens, ...description, ...when } });
          continue;
        }
        await tx.dish.update({
          where: { id: u.id },
          data: { sourceId: u.dish.sourceId, sourceHash: u.hash, ...content(u.dish), ...(u.keepImage ? {} : { imageUrl: u.dish.imageUrl }), ...when },
        });
        // Another dish now: the picture of the old one would be wrong.
        if (u.dropImage) await tx.dishImage.deleteMany({ where: { dishId: u.id } });
      }
      for (const { id, hash } of pull.adopt) await tx.dish.update({ where: { id }, data: { sourceHash: hash } });
      if (pull.remove.length > 0) {
        await tx.dish.deleteMany({ where: { id: { in: pull.remove } } });
        await tx.dishImage.deleteMany({ where: { dishId: { in: pull.remove } } });
      }
    });

    result.status = 'ok';
    result.created = pull.create.length;
    result.updated = pull.update.length;
    result.adopted = pull.adopt.length;
    result.removed = pull.remove.length;
    const changed = result.created + result.updated + result.removed > 0;
    result.message = changed ? `${result.created} neu, ${result.updated} geändert, ${result.removed} entfernt` : 'Unverändert';
    if (!oneOff) await record(menuId, line, { status: 'ok', message: `${fetched.file}: ${result.message}`, lastHash: fileHash, validity: source.validity, ...(changed ? { changedAt: new Date() } : {}) });

    // New dates in the plan's corner move its weeks as much as new dishes do.
    if (changed || source.seasonChanged) {
      invalidateDishesCache();
      // The new weeks go where they belong right away, not at the next visitor.
      await arrangeMenu(menuId, await menuSchedule(menuId)).catch((err) => {
        logger.warn('mensa arrangement after a pull failed', { menuId, error: err instanceof Error ? err.message : String(err) });
      });
      logger.info('mensa pull', { menuId, plan: line, file: fetched.file, created: result.created, updated: result.updated, removed: result.removed });
    }
    return result;
  } catch (err) {
    result.status = 'error';
    result.message = failureText(err);
    logger.warn('mensa pull failed', { menuId, plan: line, error: err instanceof Error ? err.message : String(err) });
    if (!oneOff) await record(menuId, line, { status: 'error', message: result.message }).catch(() => {});
    return result;
  }
}

/** A page to look plans up on, stored for pulls with nobody watching: the public side only. */
export function storedPageProblem(url: string): string | null {
  if (!url || isOperatorSource(url)) return null;
  try {
    if (isInternalUrl(new URL(url))) return 'Diese Adresse zeigt ins interne Netz und ist als Quelle nicht erlaubt';
  } catch {
    return 'Das ist keine gültige Adresse';
  }
  return null;
}

// ─── By itself ───────────────────────────────────────────────────────────────

let running = false;

// A source that failed is asked again sooner: most failures are short.
const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;

/**
 * When a menu's line is next pulled by itself: null when it is not (pulling
 * by hand only, switched off on this installation, no source for the line).
 * A line never looked at goes with the next round.
 */
export function nextPullAt(
  menu: { id: string; pullMode: string; sourcePage: string },
  line: PullLine,
  row: { url?: string | null; status?: string | null; checkedAt?: Date | null } | undefined,
  now = Date.now(),
): Date | null {
  const interval = config.mensaPullIntervalHours * 60 * 60 * 1000;
  if (interval <= 0 || menu.pullMode === 'manual') return null;
  const hasSource = menu.sourcePage !== '' || (!isVegetarianLine(line) && effectiveSourceUrl(menu.id, row?.url ?? '') !== '');
  if (!hasSource) return null;
  if (!row?.checkedAt) return new Date(now + config.mensaPullCheckIntervalMs);
  const every = row.status === 'error' ? Math.min(interval, RETRY_AFTER_FAILURE_MS) : interval;
  return new Date(Math.max(row.checkedAt.getTime() + every, now));
}

async function pullDueMenus(): Promise<void> {
  const menus = await prisma.mensaMenu.findMany({ where: { pullMode: 'auto' }, select: { id: true, pullMode: true, sourcePage: true, sources: true } });
  for (const menu of menus) {
    for (const line of PULL_LINES) {
      const row = menu.sources.find((s) => s.plan === line);
      const due = nextPullAt(menu, line, row);
      if (!due || (row?.checkedAt && due.getTime() - Date.now() > 60_000)) continue;
      const result = await pullPlan(menu.id, line);
      // Into the audit trail when the pull changed something or went wrong;
      // an unchanged file every few hours is no event.
      if (result.created + result.updated + result.removed > 0 || result.status === 'error' || result.status === 'held') {
        audit(null, 'mensa.pull', { type: 'menu', id: menu.id }, {
          auto: true, plan: line, status: result.status, created: result.created, updated: result.updated, removed: result.removed,
        });
      }
    }
  }
}

export function startMensaPull(): void {
  // MENSA_PULL_INTERVAL_HOURS=0: no pulling by itself on this installation.
  if (config.mensaPullIntervalHours <= 0) return;
  const run = () => {
    if (running || !ownsClusterWork('job:mensa-pull')) return;
    running = true;
    pullDueMenus()
      .catch((err) => logger.warn('mensa pull round failed', { error: err instanceof Error ? err.message : String(err) }))
      .finally(() => { running = false; });
  };
  setTimeout(run, config.mensaPullStartDelayMs);
  setInterval(run, config.mensaPullCheckIntervalMs);
}
