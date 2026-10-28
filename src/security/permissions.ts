// The admin panel's permission model: what an administrator may do, and in
// which school. Pure — no database, no Express — so every rule below is
// tested on its own (tests/permissions.test.mjs) and the API, the panel and
// the grant editor all read the same catalog.
//
//   - A permission is either school-scoped (it acts on one school's data) or
//     global-only (it acts on the whole installation: other schools, the
//     cluster, backups, system logs …).
//   - An administrator holds grants: one per scope. The scope is "global" or
//     a school id. A school grant can carry school-scoped permissions only. A
//     global grant can carry both; its school-scoped permissions then apply to
//     every school.
//   - Everything not granted is denied. There is no implicit permission, with
//     one exception: an operator configured in ADMIN_USERNAMES (the "owner")
//     controls the server itself and holds every permission. Owners cannot be
//     edited through the panel.
//   - A grant can only be given by someone who holds every permission in it,
//     in that scope, plus the right to manage administrators there — so nobody
//     can hand out more than they have, and a school admin can never create a
//     global admin.

export type PermissionScope = 'school' | 'global';
export type PermissionAction = 'read' | 'create' | 'update' | 'delete' | 'admin';

export const PERMISSION_GROUPS = [
  { key: 'overview', label: 'Übersicht' },
  { key: 'users', label: 'Nutzer & Sitzungen' },
  { key: 'classes', label: 'Klassen & Aufgaben' },
  { key: 'moderation', label: 'Kommentare & Bewertungen' },
  { key: 'mensa', label: 'Mensa' },
  { key: 'communication', label: 'Popups & Recaps' },
  { key: 'logs', label: 'Anfragen & Logs' },
  { key: 'school', label: 'Schule & Admins' },
  { key: 'global', label: 'Global' },
  { key: 'system', label: 'System' },
] as const;

export type PermissionGroup = typeof PERMISSION_GROUPS[number]['key'];

interface PermissionSpec {
  group: PermissionGroup;
  scope: PermissionScope;
  action: PermissionAction;
  label: string;
  description: string;
}

// The catalog. Keys are part of the stored grants: never rename one, only add.
const SPECS = {
  'dashboard.view': { group: 'overview', scope: 'school', action: 'read', label: 'Dashboard ansehen', description: 'Kennzahlen und letzte Aktivität der Schule.' },
  'analytics.view': { group: 'overview', scope: 'school', action: 'read', label: 'Analytics ansehen', description: 'Nutzungsstatistiken der Schule; Namen nur von Konten mit Einwilligung.' },

  'users.view': { group: 'users', scope: 'school', action: 'read', label: 'Nutzer ansehen', description: 'Konten, Rollen, Klassen und Todos der Schule.' },
  'users.create': { group: 'users', scope: 'school', action: 'create', label: 'Nutzer anlegen', description: 'Neue lokale Konten in der Schule.' },
  'users.update': { group: 'users', scope: 'school', action: 'update', label: 'Nutzer bearbeiten', description: 'Rolle, Passwort, Klassen und Todos eines Kontos ändern.' },
  'users.delete': { group: 'users', scope: 'school', action: 'delete', label: 'Nutzer löschen', description: 'Konten samt ihrer Daten endgültig entfernen.' },
  'sessions.view': { group: 'users', scope: 'school', action: 'read', label: 'Sitzungen ansehen', description: 'Angemeldete Geräte der Konten.' },
  'sessions.revoke': { group: 'users', scope: 'school', action: 'delete', label: 'Sitzungen beenden', description: 'Konten auf allen Geräten abmelden.' },

  'classes.view': { group: 'classes', scope: 'school', action: 'read', label: 'Klassen ansehen', description: 'Klassen, Mitglieder und Erinnerungen.' },
  'classes.manage': { group: 'classes', scope: 'school', action: 'update', label: 'Klassen verwalten', description: 'Klassen anlegen und löschen, Mitglieder und Erinnerungen ändern.' },
  'todos.view': { group: 'classes', scope: 'school', action: 'read', label: 'Todos & Erinnerungen ansehen', description: 'Alle Todos und Erinnerungen, auch archivierte.' },
  'todos.manage': { group: 'classes', scope: 'school', action: 'update', label: 'Todos & Erinnerungen bearbeiten', description: 'Todos und Erinnerungen anlegen, ändern und löschen.' },

  'comments.view': { group: 'moderation', scope: 'school', action: 'read', label: 'Kommentare ansehen', description: 'Kommentare zu Gerichten und Erinnerungen, Bewertungen.' },
  'comments.moderate': { group: 'moderation', scope: 'school', action: 'delete', label: 'Kommentare moderieren', description: 'Kommentare löschen, Bewertungen ändern oder entfernen.' },

  'mensa.view': { group: 'mensa', scope: 'school', action: 'read', label: 'Speiseplan ansehen', description: 'Den Mensaplan der Schule.' },
  'mensa.manage': { group: 'mensa', scope: 'school', action: 'update', label: 'Speiseplan verwalten', description: 'Gerichte, Bilder, Import und Wochen. Gilt für einen Plan nur, wenn das Recht in jeder Schule besteht, die ihn nutzt.' },

  'popups.view': { group: 'communication', scope: 'school', action: 'read', label: 'Popups ansehen', description: 'Ankündigungen an die Schule.' },
  'popups.manage': { group: 'communication', scope: 'school', action: 'update', label: 'Popups verwalten', description: 'Ankündigungen an die Schule erstellen, ändern und löschen.' },
  'recaps.view': { group: 'communication', scope: 'school', action: 'read', label: 'Recaps ansehen', description: 'Jahresrückblicke der Schule, wen sie erreichen und wie viele sie geöffnet haben.' },
  'recaps.manage': { group: 'communication', scope: 'school', action: 'update', label: 'Recaps verwalten', description: 'Jahresrückblicke erstellen, Zeitraum und Empfänger festlegen, löschen.' },

  'requests.view': { group: 'logs', scope: 'school', action: 'read', label: 'Anfragen ansehen', description: 'API-Anfragen der Konten der Schule (Pfad, Status, Dauer).' },
  'logs.frontend.view': { group: 'logs', scope: 'school', action: 'read', label: 'Frontend-Logs ansehen', description: 'Seitenaufrufe, Anmeldungen und App-Fehler der Schule.' },

  'school.settings.view': { group: 'school', scope: 'school', action: 'read', label: 'Schuleinstellungen ansehen', description: 'Name, Status und Mensaplan der Schule.' },
  'school.settings.manage': { group: 'school', scope: 'school', action: 'update', label: 'Schuleinstellungen ändern', description: 'Anzeigename der Schule ändern.' },
  'admins.view': { group: 'school', scope: 'school', action: 'read', label: 'Admins ansehen', description: 'Wer die Schule verwaltet und mit welchen Rechten.' },
  'admins.manage': { group: 'school', scope: 'school', action: 'admin', label: 'Admins verwalten', description: 'Admins der Schule ernennen und ihre Rechte festlegen — nie mehr als die eigenen.' },
  'audit.view': { group: 'school', scope: 'school', action: 'read', label: 'Admin-Protokoll ansehen', description: 'Wer wann was in der Schule geändert hat.' },

  'global.dashboard': { group: 'global', scope: 'global', action: 'read', label: 'Globales Dashboard', description: 'Übersicht über alle Schulen und schulübergreifende Zahlen.' },
  'schools.view': { group: 'global', scope: 'global', action: 'read', label: 'Schulen ansehen', description: 'Alle registrierten Schulen.' },
  'schools.manage': { group: 'global', scope: 'global', action: 'admin', label: 'Schulen verwalten', description: 'Schulen anlegen, ändern, deaktivieren; Mensapläne zuweisen.' },
  'admins.global.manage': { group: 'global', scope: 'global', action: 'admin', label: 'Globale Admins verwalten', description: 'Globale Rechte vergeben und entziehen.' },
  'privacy.view': { group: 'global', scope: 'global', action: 'read', label: 'Datenschutz-Übersicht', description: 'Welche Daten wie lange gespeichert werden, Einwilligungen.' },
  'subjectimages.manage': { group: 'global', scope: 'global', action: 'update', label: 'Fachbilder verwalten', description: 'Bilder der Fächer (für alle Schulen gleich).' },

  'system.logs.view': { group: 'system', scope: 'global', action: 'read', label: 'Backend-Logs ansehen', description: 'Server-Fehler, Ereignisse und Logdateien.' },
  'system.monitoring.view': { group: 'system', scope: 'global', action: 'read', label: 'System & Performance', description: 'Systemzustand und Antwortzeiten der API.' },
  'apikeys.manage': { group: 'system', scope: 'global', action: 'admin', label: 'API-Keys verwalten', description: 'Integrationsschlüssel ausstellen und widerrufen.' },
  'backups.manage': { group: 'system', scope: 'global', action: 'admin', label: 'Backups verwalten', description: 'Backups erstellen, herunterladen und einspielen.' },
  'cluster.manage': { group: 'system', scope: 'global', action: 'admin', label: 'Cluster verwalten', description: 'Nodes, Wege, Relays und Updates.' },
  'schoolyears.manage': { group: 'system', scope: 'global', action: 'admin', label: 'Schuljahre verwalten', description: 'Archiv ansehen, Rollover und Rollback.' },
} as const satisfies Record<string, PermissionSpec>;

export type Permission = keyof typeof SPECS;

export interface PermissionDef extends PermissionSpec {
  key: Permission;
}

export const PERMISSIONS: readonly PermissionDef[] = Object.entries(SPECS).map(([key, spec]) => ({ key: key as Permission, ...spec }));
const BY_KEY = new Map<string, PermissionDef>(PERMISSIONS.map((p) => [p.key, p]));

export const SCHOOL_PERMISSIONS: readonly Permission[] = PERMISSIONS.filter((p) => p.scope === 'school').map((p) => p.key);
export const GLOBAL_ONLY_PERMISSIONS: readonly Permission[] = PERMISSIONS.filter((p) => p.scope === 'global').map((p) => p.key);
export const ALL_PERMISSIONS: readonly Permission[] = PERMISSIONS.map((p) => p.key);

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && BY_KEY.has(value);
}

export function isGlobalOnly(permission: Permission): boolean {
  return BY_KEY.get(permission)?.scope === 'global';
}

// ─── Presets ─────────────────────────────────────────────────────────────────
// Starting points in the grant editor. A stored grant keeps the preset it was
// made from for display only; the permission list is what counts. Besides the
// built-in ones, admins make their own (services/adminPresets.ts); the
// functions below take the full list, the built-in one by default.

export const GLOBAL_SCOPE = 'global';

export interface Preset {
  key: string;
  label: string;
  description: string;
  scope: PermissionScope;
  permissions: readonly Permission[];
  // Made in the panel (can be changed and removed there), not built in.
  custom?: boolean;
  createdBy?: string | null;
  updatedAt?: string | null;
}

export const PRESETS: readonly Preset[] = [
  {
    key: 'viewer',
    label: 'Viewer',
    description: 'Nur lesen: Dashboard, Analytics, Nutzer, Klassen, Kommentare und Speiseplan.',
    scope: 'school',
    permissions: ['dashboard.view', 'analytics.view', 'users.view', 'classes.view', 'todos.view', 'comments.view', 'mensa.view', 'popups.view', 'recaps.view'],
  },
  {
    key: 'moderator',
    label: 'Moderator',
    description: 'Kommentare und Bewertungen lesen und moderieren.',
    scope: 'school',
    permissions: ['dashboard.view', 'users.view', 'comments.view', 'comments.moderate'],
  },
  {
    key: 'mensa_manager',
    label: 'Mensa-Manager',
    description: 'Speiseplan pflegen, Rückmeldungen dazu lesen.',
    scope: 'school',
    permissions: ['dashboard.view', 'mensa.view', 'mensa.manage', 'comments.view'],
  },
  {
    key: 'school_admin',
    label: 'School-Admin',
    description: 'Alles innerhalb der Schule, einschließlich ihrer Admins.',
    scope: 'school',
    permissions: SCHOOL_PERMISSIONS,
  },
  {
    key: 'global_admin',
    label: 'Global-Admin',
    description: 'Alle Rechte in allen Schulen und im System.',
    scope: 'global',
    permissions: ALL_PERMISSIONS,
  },
];

export function presetByKey(key: string, presets: readonly Preset[] = PRESETS): Preset | undefined {
  return presets.find((p) => p.key === key);
}

// ─── Own presets ─────────────────────────────────────────────────────────────

export const PRESET_LABEL_MAX = 60;
export const PRESET_DESCRIPTION_MAX = 300;
// Grants store the preset key in 40 characters.
export const PRESET_KEY_MAX = 40;
const CUSTOM_PREFIX = 'custom_';

export type PresetInput = { label: unknown; description?: unknown; scope: unknown; permissions: readonly unknown[] };
export type PresetCheck =
  | { ok: true; label: string; description: string; scope: PermissionScope; permissions: Permission[] }
  | { ok: false; status: 400 | 403; error: string };

/**
 * Validates an own preset: a name, a scope ("school" or "global"), known
 * rights that exist in that scope, at least one, and only rights the author
 * holds there (`own`) — a preset never offers more than its author has.
 */
export function normalizePreset(input: PresetInput, own: ReadonlySet<Permission>): PresetCheck {
  const label = typeof input.label === 'string' ? input.label.replace(/\s+/g, ' ').trim() : '';
  if (!label) return { ok: false, status: 400, error: 'Die Vorlage braucht einen Namen' };
  if (label.length > PRESET_LABEL_MAX) return { ok: false, status: 400, error: `Der Name darf höchstens ${PRESET_LABEL_MAX} Zeichen haben` };
  const description = typeof input.description === 'string' ? input.description.replace(/\s+/g, ' ').trim() : '';
  if (description.length > PRESET_DESCRIPTION_MAX) return { ok: false, status: 400, error: `Die Beschreibung darf höchstens ${PRESET_DESCRIPTION_MAX} Zeichen haben` };
  if (input.scope !== 'school' && input.scope !== 'global') return { ok: false, status: 400, error: 'Eine Vorlage gilt für eine Schule oder global' };
  const normalized = normalizeGrant(input.scope === 'global' ? GLOBAL_SCOPE : 'school', input.permissions);
  if (!normalized.ok) return normalized;
  if (normalized.permissions.length === 0) return { ok: false, status: 400, error: 'Die Vorlage braucht mindestens ein Recht' };
  const beyond = normalized.permissions.filter((p) => !own.has(p));
  if (beyond.length > 0) {
    return { ok: false, status: 403, error: `Eine Vorlage kann nur Rechte enthalten, die du selbst hast: ${beyond.map((p) => BY_KEY.get(p)!.label).join(', ')}` };
  }
  return { ok: true, label, description, scope: input.scope, permissions: normalized.permissions };
}

/** A key for a new own preset from its name: never a built-in one, never one in `taken`. */
export function customPresetKey(label: string, taken: ReadonlySet<string>): string {
  const slug = label
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    .slice(0, PRESET_KEY_MAX - CUSTOM_PREFIX.length - 4) || 'vorlage';
  const base = `${CUSTOM_PREFIX}${slug}`;
  const builtIn = new Set(PRESETS.map((p) => p.key));
  for (let n = 1; n < 1000; n++) {
    const key = n === 1 ? base : `${base}_${n}`;
    if (!taken.has(key) && !builtIn.has(key)) return key;
  }
  return `${CUSTOM_PREFIX}${Date.now().toString(36)}`.slice(0, PRESET_KEY_MAX);
}

export function isBuiltInPreset(key: string): boolean {
  return PRESETS.some((p) => p.key === key);
}

// ─── Access ──────────────────────────────────────────────────────────────────

export interface GrantInput {
  scope: string;
  permissions: readonly string[];
}

export interface Access {
  owner: boolean;
  // Permissions of the global grant.
  global: ReadonlySet<Permission>;
  // Permissions per school grant (school-scoped ones only).
  schools: ReadonlyMap<string, ReadonlySet<Permission>>;
}

export const NO_ACCESS: Access = { owner: false, global: new Set(), schools: new Map() };

// Unknown keys (from a newer version, or tampered rows) are dropped; a school
// grant never yields a global-only permission.
export function accessFrom(owner: boolean, grants: readonly GrantInput[]): Access {
  const global = new Set<Permission>();
  const schools = new Map<string, Set<Permission>>();
  for (const grant of grants) {
    const isGlobal = grant.scope === GLOBAL_SCOPE;
    for (const raw of grant.permissions) {
      if (!isPermission(raw)) continue;
      if (isGlobal) {
        global.add(raw);
      } else if (!isGlobalOnly(raw)) {
        let set = schools.get(grant.scope);
        if (!set) {
          set = new Set();
          schools.set(grant.scope, set);
        }
        set.add(raw);
      }
    }
  }
  return { owner, global, schools };
}

// May the holder of `access` use `permission` — in one school (`schoolId`),
// or with `null` across the whole installation (every school at once)?
export function can(access: Access, permission: Permission, schoolId: string | null): boolean {
  if (access.owner) return true;
  if (access.global.has(permission)) return true;
  if (schoolId === null || isGlobalOnly(permission)) return false;
  return access.schools.get(schoolId)?.has(permission) ?? false;
}

// The permissions that hold in one scope ("global" or a school id).
export function permissionsIn(access: Access, scope: string): Set<Permission> {
  if (access.owner) return new Set(scope === GLOBAL_SCOPE ? ALL_PERMISSIONS : SCHOOL_PERMISSIONS);
  if (scope === GLOBAL_SCOPE) return new Set(access.global);
  const out = new Set<Permission>();
  for (const p of SCHOOL_PERMISSIONS) if (can(access, p, scope)) out.add(p);
  return out;
}

// Which schools the holder may open at all: every school, or these.
export function accessibleSchools(access: Access): 'all' | string[] {
  if (access.owner) return 'all';
  if (SCHOOL_PERMISSIONS.some((p) => access.global.has(p))) return 'all';
  return [...access.schools.entries()].filter(([, set]) => set.size > 0).map(([id]) => id);
}

export function hasAnyPermission(access: Access): boolean {
  return access.owner || access.global.size > 0 || [...access.schools.values()].some((set) => set.size > 0);
}

// ─── Granting ────────────────────────────────────────────────────────────────

export type GrantCheck = { ok: true; permissions: Permission[] } | { ok: false; status: 400 | 403; error: string };

// Validates a requested permission list for a scope: known keys only, no
// global-only permission in a school grant, no duplicates.
export function normalizeGrant(scope: string, requested: readonly unknown[]): GrantCheck {
  const isGlobal = scope === GLOBAL_SCOPE;
  const out = new Set<Permission>();
  for (const raw of requested) {
    if (!isPermission(raw)) return { ok: false, status: 400, error: `Unbekannte Berechtigung: ${String(raw).slice(0, 60)}` };
    if (!isGlobal && isGlobalOnly(raw)) return { ok: false, status: 400, error: `„${BY_KEY.get(raw)!.label}“ gibt es nur global, nicht für eine Schule` };
    out.add(raw);
  }
  // Catalog order, so equal grants compare and display alike.
  return { ok: true, permissions: ALL_PERMISSIONS.filter((p) => out.has(p)) };
}

// The right to manage administrators in a scope.
export function managesAdminsIn(access: Access, scope: string): boolean {
  return scope === GLOBAL_SCOPE ? can(access, 'admins.global.manage', null) : can(access, 'admins.manage', scope);
}

// May `actor` give exactly `permissions` (already normalized) in `scope`?
// Every one of them must be the actor's own there.
export function mayGrant(actor: Access, scope: string, permissions: readonly Permission[]): GrantCheck {
  if (!managesAdminsIn(actor, scope)) {
    return { ok: false, status: 403, error: scope === GLOBAL_SCOPE ? 'Keine Berechtigung, globale Admins zu verwalten' : 'Keine Berechtigung, Admins dieser Schule zu verwalten' };
  }
  const own = permissionsIn(actor, scope);
  const beyond = permissions.filter((p) => !own.has(p));
  if (beyond.length > 0) {
    return { ok: false, status: 403, error: `Du kannst nur Rechte vergeben, die du selbst hast: ${beyond.map((p) => BY_KEY.get(p)!.label).join(', ')}` };
  }
  return { ok: true, permissions: [...permissions] };
}

// May `actor` change or remove what `target` holds in `scope`? Only when the
// actor holds everything the target holds there — a school admin cannot
// strip a global admin of anything — and never for an owner.
export function mayManageTarget(actor: Access, target: Access, scope: string): { ok: true } | { ok: false; error: string } {
  if (target.owner) return { ok: false, error: 'Server-Admins (ADMIN_USERNAMES) werden in der .env verwaltet, nicht im Panel' };
  if (!managesAdminsIn(actor, scope)) return { ok: false, error: 'Keine Berechtigung, Admins hier zu verwalten' };
  const own = permissionsIn(actor, scope);
  const theirs = scope === GLOBAL_SCOPE ? target.global : (target.schools.get(scope) ?? new Set<Permission>());
  for (const p of theirs) {
    if (!own.has(p)) return { ok: false, error: 'Dieser Admin hat hier Rechte, die du selbst nicht hast' };
  }
  return { ok: true };
}

// Removing an administrator altogether touches every grant they hold.
export function mayRemoveAdmin(actor: Access, target: Access, targetScopes: readonly string[]): { ok: true } | { ok: false; error: string } {
  if (target.owner) return { ok: false, error: 'Server-Admins (ADMIN_USERNAMES) werden in der .env verwaltet, nicht im Panel' };
  for (const scope of targetScopes) {
    const check = mayManageTarget(actor, target, scope);
    if (!check.ok) return check;
  }
  // Without any grant the account is checked against the right to manage
  // admins somewhere — callers pass the target's school for that.
  return { ok: true };
}

export function presetFor(scope: string, permissions: readonly Permission[], presets: readonly Preset[] = PRESETS): string {
  const set = new Set(permissions);
  for (const preset of presets) {
    if ((preset.scope === 'global') !== (scope === GLOBAL_SCOPE)) continue;
    if (preset.permissions.length === set.size && preset.permissions.every((p) => set.has(p))) return preset.key;
  }
  return 'custom';
}
