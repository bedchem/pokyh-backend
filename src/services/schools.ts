import { createHash } from 'crypto';
import type { Request } from 'express';
import { Prisma, type School } from '@prisma/client';
import { prisma } from '../db';
import { config } from '../config';
import { TtlCache } from '../utils/cache';

// Schools, the school an account belongs to, and the menu a school shows.
//
// Lookups here are on hot paths (every rating, comment and menu request), so
// they are cached briefly per node. Every write in this process invalidates
// the affected entry at once; another node's write is seen within the TTL.
// Nothing security-relevant for the admin panel is cached here: admin
// permissions are read fresh on every request (services/adminAccess.ts).

const TTL_MS = 30_000;

// A uuid-shaped id derived from a seed: the same on every node of a cluster,
// so two nodes creating "the default school" create one row, not two.
export function deterministicId(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export function defaultSchoolId(): string {
  return deterministicId(`pokyh:school:${(config.webuntisSchool || 'default').trim().toLowerCase()}`);
}

// The menu every dish that existed before menus were introduced belongs to.
export const DEFAULT_MENU_ID = deterministicId('pokyh:mensa-menu:default');

export function slugifySchool(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export const SCHOOL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ─── Schools ─────────────────────────────────────────────────────────────────

let schoolsCache: { at: number; rows: School[] } | null = null;

export async function listSchools(): Promise<School[]> {
  if (schoolsCache && Date.now() - schoolsCache.at < TTL_MS) return schoolsCache.rows;
  const rows = await prisma.school.findMany({ orderBy: { name: 'asc' } });
  schoolsCache = { at: Date.now(), rows };
  return rows;
}

export function invalidateSchools(): void {
  schoolsCache = null;
}

export async function schoolById(id: string): Promise<School | null> {
  if (!SCHOOL_ID_PATTERN.test(id)) return null;
  return (await listSchools()).find((s) => s.id === id) ?? null;
}

// An id or a slug, as the public endpoints accept it (?school=…).
export async function schoolByRef(ref: string): Promise<School | null> {
  const value = ref.trim().toLowerCase();
  if (!value || value.length > 64) return null;
  return (await listSchools()).find((s) => s.id === value || s.slug === value) ?? null;
}

export async function schoolByWebuntis(name: string): Promise<School | null> {
  const value = name.trim().toLowerCase();
  if (!value) return null;
  return (await listSchools()).find((s) => (s.webuntisSchool ?? '').toLowerCase() === value) ?? null;
}

// Creates the default school on first start; never changes an existing one
// (its name and settings belong to the panel from then on).
export async function ensureDefaultSchool(): Promise<School> {
  const id = defaultSchoolId();
  const existing = await prisma.school.findUnique({ where: { id } });
  if (existing) return existing;
  const webuntisSchool = config.webuntisSchool.trim() || null;
  const name = (config.defaultSchoolName.trim() || webuntisSchool || 'Standardschule').slice(0, 160);
  const baseSlug = slugifySchool(webuntisSchool ?? name) || 'default';
  // A school someone already created under that slug or WebUntis name keeps
  // it; the default school then takes a free one.
  const [slugTaken, webuntisTaken] = await Promise.all([
    prisma.school.findUnique({ where: { slug: baseSlug }, select: { id: true } }),
    webuntisSchool ? prisma.school.findUnique({ where: { webuntisSchool }, select: { id: true } }) : null,
  ]);
  const school = await prisma.school.upsert({
    where: { id },
    create: {
      id,
      slug: slugTaken ? `${baseSlug}-${id.slice(0, 6)}` : baseSlug,
      name,
      shortName: '',
      webuntisSchool: webuntisTaken ? null : webuntisSchool,
      webuntisBase: config.webuntisBase,
      createdBy: 'system',
    },
    update: {},
  });
  invalidateSchools();
  return school;
}

// ─── Schools that join by signing in ─────────────────────────────────────────
// Pokyh works with any school on WebUntis, and a school is added the first
// time one of its accounts signs in. Only the trusted login caller reaches
// this (X-Server-Key, after WebUntis accepted the credentials at that
// school), so nobody can invent schools from outside. From then on its
// display name, status and menu belong to the panel; a school a global admin
// deactivated stays refused.

// A WebUntis login name ("lbs-brixen", "IT-Schule Stuttgart"), lower case.
export const WEBUNTIS_SCHOOL_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._+&'()-]{0,99}$/u;

export class SchoolLimitError extends Error {}

// The base URL of a WebUntis server a login names, or '' when it is not one
// of the configured WebUntis hosts (WEBUNTIS_HOST_SUFFIXES).
export function webuntisBaseFor(server: string | undefined): string {
  const host = (server ?? '').trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/.*$/, '');
  if (!host || host.length > 253) return '';
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) return '';
  const allowed = config.webuntisHostSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  return allowed ? `https://${host}/WebUntis` : '';
}

function displayName(value: string | undefined, fallback: string): string {
  const clean = (value ?? '').replace(/[\p{C}]/gu, ' ').replace(/\s+/g, ' ').trim();
  return (clean || fallback).slice(0, 160);
}

export interface WebUntisSchoolRef {
  // The WebUntis login name of the school.
  loginName: string;
  // Its name as WebUntis shows it ("LBS Brixen"), optional.
  name?: string;
  // Its WebUntis server ("xyz.webuntis.com"), optional.
  server?: string;
}

// The school a WebUntis login belongs to — added on its first sign-in. Null
// when the name is not a WebUntis login name or adding schools is turned off.
export async function schoolForLogin(ref: WebUntisSchoolRef): Promise<{ school: School; created: boolean } | null> {
  const loginName = ref.loginName.trim().toLowerCase();
  if (!WEBUNTIS_SCHOOL_PATTERN.test(loginName)) return null;
  const known = (await schoolByWebuntis(loginName)) ?? (await prisma.school.findUnique({ where: { webuntisSchool: loginName } }));
  if (known) {
    // A school added before its server was known learns it once.
    const base = known.webuntisBase ? '' : webuntisBaseFor(ref.server);
    if (base) {
      await prisma.school.update({ where: { id: known.id }, data: { webuntisBase: base } }).catch(() => undefined);
      invalidateSchools();
    }
    return { school: known, created: false };
  }
  if (!config.schoolsAutoCreate) return null;
  if ((await prisma.school.count()) >= config.schoolsMax) throw new SchoolLimitError('school limit reached');

  // The same id on every node: two first sign-ins at once add one school.
  const id = deterministicId(`pokyh:school:${loginName}`);
  const existing = await prisma.school.findUnique({ where: { id } });
  if (existing) {
    invalidateSchools();
    return { school: existing, created: false };
  }
  const baseSlug = slugifySchool(loginName) || 'schule';
  const slugTaken = await prisma.school.findUnique({ where: { slug: baseSlug }, select: { id: true } });
  try {
    const school = await prisma.school.create({
      data: {
        id,
        slug: slugTaken ? `${baseSlug.slice(0, 52)}-${id.slice(0, 6)}` : baseSlug,
        name: displayName(ref.name, loginName),
        shortName: '',
        webuntisSchool: loginName,
        webuntisBase: webuntisBaseFor(ref.server),
        active: true,
        createdBy: 'webuntis',
      },
    });
    invalidateSchools();
    return { school, created: true };
  } catch (err) {
    // Another node added it a moment ago.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      invalidateSchools();
      const raced = await prisma.school.findFirst({ where: { OR: [{ id }, { webuntisSchool: loginName }] } });
      if (raced) return { school: raced, created: false };
    }
    throw err;
  }
}

// ─── Accounts ────────────────────────────────────────────────────────────────

const userSchoolCache = new TtlCache<string | null>(TTL_MS);

// The school of an account; the default school for an account that has
// none (written by an older node during a rolling update).
export async function schoolOfUser(stableUid: string): Promise<string> {
  const cached = userSchoolCache.get(stableUid);
  if (cached !== undefined) return cached ?? defaultSchoolId();
  const row = await prisma.user.findUnique({ where: { stableUid }, select: { schoolId: true } });
  userSchoolCache.set(stableUid, row?.schoolId ?? null);
  return row?.schoolId ?? defaultSchoolId();
}

export function forgetUserSchool(stableUid: string): void {
  userSchoolCache.delete(stableUid);
}

// ─── Menus ───────────────────────────────────────────────────────────────────

const menuOfSchoolCache = new TtlCache<string | null>(TTL_MS);

export async function menuOfSchool(schoolId: string): Promise<string | null> {
  const cached = menuOfSchoolCache.get(schoolId);
  if (cached !== undefined) return cached;
  const row = await prisma.mensaMenuSchool.findUnique({ where: { schoolId }, select: { menuId: true } });
  menuOfSchoolCache.set(schoolId, row?.menuId ?? null);
  return row?.menuId ?? null;
}

export async function schoolsOfMenu(menuId: string): Promise<string[]> {
  const rows = await prisma.mensaMenuSchool.findMany({ where: { menuId }, select: { schoolId: true } });
  return rows.map((r) => r.schoolId);
}

export function invalidateMenus(): void {
  menuOfSchoolCache.clear();
}

export interface MenuContext {
  schoolId: string | null;
  menuId: string | null;
}

// Which school and menu an app request is about. A signed-in account always
// gets its own school — `?school=` cannot show it another school's comments
// or votes. A guest may name a school (the menu itself is public); without
// one, the default school, as every client did before schools existed. An
// unknown or inactive school, or one without a menu, has no menu.
export async function menuContext(req: Request): Promise<MenuContext> {
  let schoolId: string | null;
  if (req.user) {
    schoolId = await schoolOfUser(req.user.stableUid);
  } else {
    const ref = typeof req.query['school'] === 'string' ? req.query['school'] : '';
    const school = ref ? await schoolByRef(ref) : await schoolById(defaultSchoolId());
    schoolId = school && school.active ? school.id : null;
  }
  const menuId = schoolId ? await menuOfSchool(schoolId) : null;
  return { schoolId, menuId };
}
