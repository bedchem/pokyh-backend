import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { adminApi, setMenuContext, setSchoolContext } from './api';
import { setDisplayTimeZone } from './components/format';
import { recordSchoolPick } from './schoolPicks';
import { subscribeLive } from './live';
import type { AccessCatalog, AdminMe, MeSchool, Permission } from './types';

// Who is signed in, what they may do, and which school the panel is looking
// at. The server decides everything again on every request; this only shapes
// the navigation and pages so nobody is offered what they cannot do.
//
// The view is either "global" (every school at once — global rights only) or
// one school. It is remembered per admin, and every request carries it
// (api.ts, X-Pokyh-School).

export type View = { kind: 'global' } | { kind: 'school'; school: MeSchool };

interface AccessValue {
  me: AdminMe | null;
  view: View | null;
  // Stable per view; pages are keyed by it so switching school reloads them.
  viewKey: string;
  setView: (next: View) => void;
  // In the current view.
  can: (permission: Permission) => boolean;
  canAny: (permissions: Permission[]) => boolean;
  // Across every school (global grant).
  canGlobal: (permission: Permission) => boolean;
  refresh: () => Promise<void>;
  error: string | null;
}

const AccessContext = createContext<AccessValue | null>(null);

const storageKey = (username: string) => `pokyh_admin_view:${username}`;

function remembered(username: string): string | null {
  try {
    return localStorage.getItem(storageKey(username));
  } catch {
    return null;
  }
}

function remember(username: string, value: string): void {
  try {
    localStorage.setItem(storageKey(username), value);
  } catch {
    // private mode: the choice just isn't kept
  }
}

// The view to start in: the remembered one if still allowed, else the
// global view for who has one, else the first school.
function initialView(me: AdminMe): View | null {
  const saved = remembered(me.username);
  if (saved === 'global' && me.globalView) return { kind: 'global' };
  const savedSchool = me.schools.find((s) => s.id === saved);
  if (savedSchool) return { kind: 'school', school: savedSchool };
  if (me.globalView) return { kind: 'global' };
  return me.schools[0] ? { kind: 'school', school: me.schools[0] } : null;
}

export function AccessProvider({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const [me, setMe] = useState<AdminMe | null>(null);
  const [view, setViewState] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await adminApi.me();
      setDisplayTimeZone(next.timezone);
      setMe(next);
      setError(null);
      setViewState((current) => {
        // Keep the current view while it is still allowed (rights can change
        // under an open panel); otherwise fall back.
        let resolved: View | null;
        if (current?.kind === 'global' && next.globalView) resolved = { kind: 'global' };
        else if (current?.kind === 'school') {
          const school = next.schools.find((s) => s.id === current.school.id);
          resolved = school ? { kind: 'school', school } : initialView(next);
        } else resolved = initialView(next);
        setSchoolContext(resolved?.kind === 'school' ? resolved.school.id : null);
        return resolved;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rechte konnten nicht geladen werden');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // A changed permission (anyone's) reloads the own rights.
  useEffect(() => subscribeLive(['access', 'schools'], () => { void load(); }), [load]);

  const setView = useCallback((next: View) => {
    setSchoolContext(next.kind === 'school' ? next.school.id : null);
    setMenuContext(null);
    setViewState(next);
    if (me) {
      remember(me.username, next.kind === 'global' ? 'global' : next.school.id);
      if (next.kind === 'school') recordSchoolPick(me.username, next.school.id);
    }
  }, [me]);

  const value = useMemo<AccessValue>(() => {
    const globalSet = new Set(me?.global ?? []);
    const owner = me?.owner ?? false;
    const inView = view?.kind === 'school' ? new Set(view.school.permissions) : globalSet;
    const can = (p: Permission) => owner || inView.has(p);
    return {
      me,
      view,
      viewKey: view ? (view.kind === 'global' ? 'global' : view.school.id) : 'none',
      setView,
      can,
      canAny: (ps) => ps.some(can),
      canGlobal: (p) => owner || globalSet.has(p),
      refresh: load,
      error,
    };
  }, [me, view, setView, load, error]);

  if (!me) return <>{error ? <AccessError message={error} onRetry={() => void load()} /> : fallback}</>;
  return <AccessContext.Provider value={value}>{children}</AccessContext.Provider>;
}

function AccessError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-canvas px-6 text-center">
      <p className="text-[15px] text-ink-2">{message}</p>
      <button type="button" className="btn" onClick={onRetry}>Nochmal versuchen</button>
    </div>
  );
}

export function useAccess(): AccessValue {
  const value = useContext(AccessContext);
  if (!value) throw new Error('useAccess outside AccessProvider');
  return value;
}

// The name the panel shows for the current view.
export function viewLabel(view: View | null): string {
  if (!view) return '—';
  return view.kind === 'global' ? 'Alle Schulen' : view.school.name;
}

// The scopes the admin may hand rights out in: "global" with the right to
// manage global admins, and every school where they manage admins.
export function manageableScopes(me: AdminMe | null): Array<{ value: string; label: string; kind: 'global' | 'school' }> {
  if (!me) return [];
  const out: Array<{ value: string; label: string; kind: 'global' | 'school' }> = [];
  if (me.owner || me.global.includes('admins.global.manage')) out.push({ value: 'global', label: 'Alle Schulen (global)', kind: 'global' });
  for (const school of me.schools) {
    if (me.owner || school.permissions.includes('admins.manage')) out.push({ value: school.id, label: school.name, kind: 'school' });
  }
  return out;
}

// What the admin holds in a scope — the most they can grant there.
export function ownPermissions(me: AdminMe | null, catalog: AccessCatalog | null, scope: string): Set<Permission> {
  if (!me || !catalog) return new Set();
  if (me.owner) return new Set(catalog.permissions.filter((p) => scope === 'global' || p.scope === 'school').map((p) => p.key));
  if (scope === 'global') return new Set(me.global);
  return new Set(me.schools.find((s) => s.id === scope)?.permissions ?? []);
}
