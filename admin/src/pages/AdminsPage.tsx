import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useHanded } from '../useHanded';
import { Crown, Globe2, KeyRound, Pencil, School, Search, ShieldCheck, ShieldOff, Trash2, UserPlus } from 'lucide-react';
import { adminApi } from '../api';
import { manageableScopes, ownPermissions, useAccess } from '../access';
import { useLive } from '../live';
import { useToast } from '../components/Toast';
import { Avatar, Dialog, Empty, IconButton, Notice, PageHeader, Section, Spinner, Tag, useTableLabels } from '../components/kit';
import { PermissionEditor } from '../components/PermissionEditor';
import { AppointAdminDialog } from '../components/AppointAdminDialog';
import { LastLogin, RequirementSwitch, SecondFactorBadge } from '../components/LoginSecurity';
import { dateTime } from '../components/format';
import type { AccessCatalog, AdminAccount, AdminGrantView, AdminUser, Permission } from '../types';

// Who administers what: every admin account with its rights per scope, and
// the editor to change them. A school's view lists the admins of that school
// (and that someone is a global admin), never their rights elsewhere.

function presetLabel(catalog: AccessCatalog | null, key: string): string {
  return catalog?.presets.find((p) => p.key === key)?.label ?? (key === 'custom' ? 'Eigene Auswahl' : key);
}

export function AdminsPage() {
  const { me, view, can } = useAccess();
  const { showToast } = useToast();
  const [admins, setAdmins] = useState<AdminAccount[] | null>(null);
  const [catalog, setCatalog] = useState<AccessCatalog | null>(null);
  const [editing, setEditing] = useState<AdminAccount | null>(null);
  const [appointing, setAppointing] = useState(false);
  const [revoking, setRevoking] = useState<AdminAccount | null>(null);
  // The search hands over an admin: their row is shown and marked.
  const focusName = useHanded<{ open: string }>().open ?? null;
  const tableRef = useRef<HTMLDivElement>(null);
  useTableLabels(tableRef);
  const scopes = useMemo(() => manageableScopes(me), [me]);
  const mayManage = can('admins.manage') || (view?.kind === 'global' && scopes.length > 0);

  const load = useCallback(async () => {
    try {
      const [list, cat] = await Promise.all([adminApi.admins(), catalog ? Promise.resolve(catalog) : adminApi.accessCatalog()]);
      setAdmins(list.admins);
      setCatalog(cat);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Admins konnten nicht geladen werden', 'error');
    }
  }, [catalog, showToast]);

  useEffect(() => { void load(); }, [load]);
  useLive(['access', 'users'], () => { void load(); });

  async function revoke(account: AdminAccount) {
    try {
      await adminApi.revokeAdmin(account.stableUid);
      showToast(`${account.username} ist kein Admin mehr`, 'success');
      setRevoking(null);
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Entziehen fehlgeschlagen', 'error');
    }
  }

  const kind = (a: AdminAccount) => {
    if (a.owner) return { label: 'Server-Owner', tone: 'violet' as const, icon: Crown };
    if (a.grants.some((g) => g.scope === 'global')) return { label: 'Global-Admin', tone: 'violet' as const, icon: Globe2 };
    if (a.grants.length > 0) return { label: a.grants.length === 1 ? 'Schul-Admin' : `Admin in ${a.grants.length} Schulen`, tone: 'sky' as const, icon: School };
    return { label: 'Ohne Rechte', tone: 'ink' as const, icon: ShieldOff };
  };

  return (
    <div>
      <PageHeader
        title="Admins & Rechte"
        subtitle={view?.kind === 'school'
          ? `Wer ${view.school.name} verwaltet und was er darf. Rechte gelten nur in dieser Schule; niemand kann mehr vergeben, als er selbst hat.`
          : 'Alle Admin-Konten und ihre Rechte — global oder pro Schule. Niemand kann mehr vergeben, als er selbst hat; Server-Owner werden in der .env verwaltet.'}
      >
        {mayManage && (
          <button type="button" className="btn btn-primary" onClick={() => setAppointing(true)}>
            <UserPlus size={16} strokeWidth={1.7} /> Admin ernennen
          </button>
        )}
      </PageHeader>

      <Section className="mt-10" title="Admin-Konten" meta={admins ? `${admins.length}` : undefined}>
        {!admins ? (
          <div className="mt-8"><Spinner /></div>
        ) : admins.length === 0 ? (
          <Empty icon={ShieldCheck}>Noch keine Admins in diesem Bereich.</Empty>
        ) : (
          <div ref={tableRef} className="tbl-scroll mt-6">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Konto</th>
                  <th>Art</th>
                  <th className="hidden lg:table-cell">Rechte</th>
                  <th>Anmeldung</th>
                  <th><span className="sr-only">Aktionen</span></th>
                </tr>
              </thead>
              <tbody>
                {admins.map((a) => {
                  const k = kind(a);
                  const self = a.username.toLowerCase() === me?.username.toLowerCase();
                  return (
                    <tr key={a.username} data-focus={a.username === focusName || undefined} ref={a.username === focusName ? (el) => el?.scrollIntoView({ block: 'center', behavior: 'smooth' }) : undefined}>
                      <td>
                        <div className="flex items-center gap-4">
                          <Avatar name={a.username} size={44} />
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 truncate font-medium">{a.username}{self && <Tag>du</Tag>}</div>
                            <div className="truncate text-[12.5px] text-ink-3">{a.schoolName ?? 'ohne Schule'}{a.pending ? ' · Einladung offen' : ''}</div>
                          </div>
                        </div>
                      </td>
                      <td><Tag tone={k.tone}><k.icon size={12} strokeWidth={2} /> {k.label}</Tag></td>
                      <td className="hidden lg:table-cell">
                        <div className="flex flex-wrap gap-1.5">
                          {a.owner && <span className="text-[13px] text-ink-3">alle Rechte (ADMIN_USERNAMES)</span>}
                          {a.grants.map((g) => (
                            <Tag key={g.scope} tone={g.scope === 'global' ? 'violet' : 'sky'}>
                              {g.scope === 'global' ? 'Alle Schulen' : g.schoolName ?? 'Schule'} · {presetLabel(catalog, g.preset)}
                            </Tag>
                          ))}
                        </div>
                      </td>
                      <td>
                        {a.security ? (
                          <div className="flex flex-col items-start gap-1.5">
                            <SecondFactorBadge security={a.security} />
                            <RequirementSwitch
                              username={a.username}
                              security={a.security}
                              self={self}
                              owner={a.owner}
                              mayManage={mayManage}
                              onChanged={() => { void load(); }}
                            />
                            <span className="text-[12.5px] text-ink-3">Zuletzt: <LastLogin iso={a.security.lastLoginAt} method={a.security.lastLoginMethod} /></span>
                          </div>
                        ) : <span className="text-ink-4">–</span>}
                      </td>
                      <td>
                        <div className="row-actions">
                          {!a.owner && !self && mayManage && (
                            <IconButton icon={Pencil} label={`Rechte von ${a.username} bearbeiten`} onClick={() => setEditing(a)} />
                          )}
                          {!a.owner && !self && mayManage && a.stableUid && (
                            <IconButton icon={Trash2} tone="rose" label={`${a.username} den Admin-Zugang entziehen`} onClick={() => setRevoking(a)} />
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {catalog && <PresetGuide catalog={catalog} />}

      {editing && catalog && (
        <EditGrantsDialog account={editing} catalog={catalog} onClose={() => setEditing(null)} onSaved={() => { void load(); }} />
      )}
      {appointing && <PickAccountDialog onClose={() => setAppointing(false)} onAppointed={() => { setAppointing(false); void load(); }} />}
      {revoking && (
        <Dialog title="Admin-Zugang entziehen" subtitle={revoking.username} onClose={() => setRevoking(null)}>
          <p className="text-[14px] leading-relaxed text-ink-2">
            {revoking.username} kann sich danach nicht mehr im Admin-Panel anmelden; alle Rechte, Passkeys und die
            Authenticator-App des Admin-Zugangs werden entfernt. Das App-Konto bleibt bestehen.
          </p>
          <div className="mt-6 flex gap-3">
            <button type="button" className="btn btn-quiet flex-1" onClick={() => setRevoking(null)}>Abbrechen</button>
            <button type="button" className="btn btn-danger flex-1" onClick={() => void revoke(revoking)}>Entziehen</button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

// The presets at a glance, so "Moderator" means the same to everyone.
function PresetGuide({ catalog }: { catalog: AccessCatalog }) {
  return (
    <Section className="mt-[52px]" title="Vorlagen">
      <div className="mt-6 grid gap-x-10 gap-y-6 sm:grid-cols-2">
        {catalog.presets.map((p) => (
          <div key={p.key} className="min-w-0">
            <div className="flex items-center gap-2 text-[15px] font-medium">
              {p.scope === 'global' ? <Globe2 size={15} strokeWidth={1.8} /> : <School size={15} strokeWidth={1.8} />}
              {p.label}
            </div>
            <p className="mt-1 text-[13.5px] text-ink-3">{p.description}</p>
            <p className="mt-1 text-[12.5px] text-ink-4">{p.permissions.length} Rechte</p>
          </div>
        ))}
      </div>
    </Section>
  );
}

// One account's rights, one scope at a time.
function EditGrantsDialog({ account, catalog, onClose, onSaved }: { account: AdminAccount; catalog: AccessCatalog; onClose: () => void; onSaved: () => void }) {
  const { me } = useAccess();
  const { showToast } = useToast();
  const scopes = useMemo(() => manageableScopes(me), [me]);
  const grantOf = (scope: string): AdminGrantView | undefined => account.grants.find((g) => g.scope === scope);
  const first = scopes.find((s) => grantOf(s.value))?.value ?? scopes[0]?.value ?? '';
  const [scope, setScope] = useState(first);
  const [permissions, setPermissions] = useState<Permission[]>(grantOf(first)?.permissions ?? []);
  const [preset, setPreset] = useState<string | undefined>(grantOf(first)?.preset);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (permissions.length === 0) await adminApi.removeGrant(account.username, scope);
      else await adminApi.setGrant(account.username, scope, permissions, preset);
      showToast(permissions.length === 0 ? 'Rechte entzogen' : 'Rechte gespeichert', 'success');
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Speichern fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="Rechte bearbeiten" subtitle={account.username} onClose={onClose} width={640}>
      {scopes.length === 0 ? (
        <Notice tone="amber">Du darfst hier keine Rechte vergeben.</Notice>
      ) : (
        <div className="flex flex-col gap-6">
          <PermissionEditor
            catalog={catalog}
            scopes={scopes.map((s) => ({ ...s, label: grantOf(s.value) ? `${s.label} ✓` : s.label }))}
            scope={scope}
            onScopeChange={(next) => { setScope(next); setPermissions(grantOf(next)?.permissions ?? []); setPreset(grantOf(next)?.preset); setError(null); }}
            value={permissions}
            onChange={(next, nextPreset) => { setPermissions(next); setPreset(nextPreset); setError(null); }}
            own={(s) => ownPermissions(me, catalog, s)}
          />
          {grantOf(scope) && <p className="text-[12.5px] text-ink-3">Zuletzt geändert {dateTime(grantOf(scope)!.updatedAt)}{grantOf(scope)!.grantedBy ? ` von ${grantOf(scope)!.grantedBy}` : ''}.</p>}
          {error && <Notice tone="rose">{error}</Notice>}
          <div className="flex gap-3">
            <button type="button" onClick={onClose} className="btn btn-quiet flex-1">Abbrechen</button>
            <button type="button" disabled={busy || (permissions.length === 0 && !grantOf(scope))} onClick={() => void save()} className={`btn flex-1 ${permissions.length === 0 ? 'btn-danger' : 'btn-primary'}`}>
              {busy ? <Spinner /> : <KeyRound size={16} strokeWidth={1.7} />}
              {permissions.length === 0 ? 'Rechte hier entziehen' : 'Speichern'}
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

// Choose the account to make an admin, then its rights.
function PickAccountDialog({ onClose, onAppointed }: { onClose: () => void; onAppointed: () => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AdminUser[]>([]);
  const [chosen, setChosen] = useState<AdminUser | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setResults([]); return; }
    let alive = true;
    setLoading(true);
    const timer = window.setTimeout(() => {
      adminApi.users(q, 1, 8)
        .then((res) => { if (alive) setResults(res.users); })
        .catch(() => { if (alive) setResults([]); })
        .finally(() => { if (alive) setLoading(false); });
    }, 250);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [query]);

  if (chosen) {
    return (
      <AppointAdminDialog
        stableUid={chosen.stableUid}
        username={chosen.username}
        schoolId={chosen.schoolId ?? null}
        needsOneTimePassword={chosen.needsOneTimePassword}
        onClose={onClose}
        onDone={onAppointed}
      />
    );
  }

  return (
    <Dialog title="Admin ernennen" subtitle="Konto suchen" onClose={onClose}>
      <label className="relative block">
        <Search size={17} strokeWidth={1.6} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-ink-3" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Benutzername" aria-label="Benutzername" className="field h-12 w-full pl-11 pr-4 text-[14.5px]" autoFocus />
      </label>
      <div className="mt-4 flex min-h-[120px] flex-col">
        {loading && <Spinner />}
        {!loading && query.trim().length >= 2 && results.length === 0 && <p className="text-[14px] text-ink-3">Kein Konto gefunden.</p>}
        {results.map((u) => (
          <button key={u.stableUid} type="button" className="view-option" disabled={u.isAdmin} onClick={() => setChosen(u)}>
            <Avatar name={u.username} size={34} />
            <span className="min-w-0 flex-1 text-left">
              <span className="block truncate text-[14px] font-medium">{u.username}</span>
              <span className="block truncate text-[12px] text-ink-3">{u.schoolName ?? ''}{u.isAdmin ? ' · ist schon Admin' : ''}</span>
            </span>
          </button>
        ))}
      </div>
    </Dialog>
  );
}
