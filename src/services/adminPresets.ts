import type { Request } from 'express';
import { prisma } from '../db';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../utils/errors';
import {
  GLOBAL_SCOPE,
  PRESETS,
  customPresetKey,
  isBuiltInPreset,
  isPermission,
  managesAdminsIn,
  normalizePreset,
  permissionsIn,
  presetFor,
  type Permission,
  type Preset,
  type PresetInput,
} from '../security/permissions';
import { audit } from './audit';
import { announceChange } from './adminLive';

/**
 * Presets ("Vorlagen") for admin rights: the built-in ones plus those admins
 * made themselves (admin_presets). Making, changing and removing them takes
 * the right to manage global admins, and a preset only ever holds rights its
 * author has (security/permissions.ts normalizePreset). Grants keep their own
 * permission list, so a changed or removed preset never changes anyone's
 * rights; only the name shown next to a grant follows it.
 */

// Not taken from adminAccess.ts, which uses this module (no import cycle).
function actorOf(req: Request) {
  return { username: req.adminUser!.username, access: req.adminAccess! };
}

function parsePermissionList(text: string): string[] {
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

// Every node reads the list from the database; a node that changed it reloads
// at once, the others within this time.
const CACHE_MS = 15_000;
let cached: { at: number; presets: Preset[] } | null = null;

function toPreset(row: { key: string; label: string; description: string; scope: string; permissions: string; createdBy: string; updatedAt: Date }): Preset | null {
  if (row.scope !== 'school' && row.scope !== 'global') return null;
  return {
    key: row.key,
    label: row.label,
    description: row.description,
    scope: row.scope,
    // Unknown keys (from a newer version) are left out.
    permissions: parsePermissionList(row.permissions).filter(isPermission),
    custom: true,
    createdBy: row.createdBy,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Built-in presets first, then the own ones by name. */
export async function listPresets(): Promise<Preset[]> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.presets;
  const rows = await prisma.adminPreset.findMany({ orderBy: { label: 'asc' } });
  const presets = [...PRESETS, ...rows.map(toPreset).filter((p): p is Preset => p !== null)];
  cached = { at: Date.now(), presets };
  return presets;
}

function forget(): void {
  cached = null;
}

function assertMayManagePresets(req: Request): void {
  if (!managesAdminsIn(actorOf(req).access, GLOBAL_SCOPE)) {
    throw new ForbiddenError('Vorlagen verwaltet, wer globale Admins verwalten darf');
  }
}

function checked(req: Request, input: PresetInput) {
  const own = permissionsIn(actorOf(req).access, GLOBAL_SCOPE);
  const result = normalizePreset(input, own);
  if (!result.ok) throw result.status === 400 ? new ValidationError(result.error) : new ForbiddenError(result.error);
  return result;
}

// Grants made from a preset whose rights no longer match it show as "own
// selection" (or as the preset they now match).
async function relabelGrants(key: string, presets: readonly Preset[], keepIf?: readonly Permission[]): Promise<void> {
  const grants = await prisma.adminGrant.findMany({ where: { preset: key }, select: { id: true, scope: true, permissions: true } });
  for (const grant of grants) {
    const permissions = parsePermissionList(grant.permissions).filter(isPermission);
    if (keepIf && keepIf.length === permissions.length && keepIf.every((p) => permissions.includes(p))) continue;
    await prisma.adminGrant.update({ where: { id: grant.id }, data: { preset: presetFor(grant.scope, permissions, presets.filter((p) => p.key !== key)) } });
  }
}

export async function createPreset(req: Request, input: PresetInput): Promise<Preset> {
  assertMayManagePresets(req);
  const value = checked(req, input);
  const presets = await listPresets();
  if (presets.some((p) => p.label.toLowerCase() === value.label.toLowerCase())) throw new ConflictError('Eine Vorlage mit diesem Namen gibt es schon');
  const actor = actorOf(req).username;
  const key = customPresetKey(value.label, new Set(presets.map((p) => p.key)));
  const row = await prisma.adminPreset.create({
    data: { key, label: value.label, description: value.description, scope: value.scope, permissions: JSON.stringify(value.permissions), createdBy: actor, updatedBy: actor },
  });
  forget();
  audit(req, 'admin.preset.create', { type: 'preset', id: key }, { label: value.label, scope: value.scope, permissions: value.permissions }, null);
  announceChange(['access']);
  return toPreset(row)!;
}

export async function updatePreset(req: Request, key: string, input: PresetInput): Promise<Preset> {
  assertMayManagePresets(req);
  if (isBuiltInPreset(key)) throw new ForbiddenError('Eingebaute Vorlagen lassen sich nicht ändern; lege eine eigene an');
  const before = await prisma.adminPreset.findUnique({ where: { key } });
  if (!before) throw new NotFoundError('Vorlage nicht gefunden');
  const value = checked(req, input);
  const presets = await listPresets();
  if (presets.some((p) => p.key !== key && p.label.toLowerCase() === value.label.toLowerCase())) throw new ConflictError('Eine Vorlage mit diesem Namen gibt es schon');
  const row = await prisma.adminPreset.update({
    where: { key },
    data: { label: value.label, description: value.description, scope: value.scope, permissions: JSON.stringify(value.permissions), updatedBy: actorOf(req).username },
  });
  forget();
  // Grants made from it keep their rights; those that no longer match it lose the name.
  await relabelGrants(key, await listPresets(), before.scope === value.scope ? value.permissions : []);
  audit(req, 'admin.preset.update', { type: 'preset', id: key }, {
    label: value.label,
    scope: value.scope,
    added: value.permissions.filter((p) => !parsePermissionList(before.permissions).includes(p)),
    removed: parsePermissionList(before.permissions).filter((p) => !(value.permissions as string[]).includes(p)),
  }, null);
  announceChange(['access']);
  return toPreset(row)!;
}

export async function deletePreset(req: Request, key: string): Promise<void> {
  assertMayManagePresets(req);
  if (isBuiltInPreset(key)) throw new ForbiddenError('Eingebaute Vorlagen lassen sich nicht löschen');
  const row = await prisma.adminPreset.findUnique({ where: { key } });
  if (!row) throw new NotFoundError('Vorlage nicht gefunden');
  await prisma.adminPreset.delete({ where: { key } });
  forget();
  await relabelGrants(key, await listPresets());
  audit(req, 'admin.preset.delete', { type: 'preset', id: key }, { label: row.label }, null);
  announceChange(['access']);
}
