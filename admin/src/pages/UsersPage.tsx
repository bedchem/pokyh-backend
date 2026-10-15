import { useEffect, useState, useCallback, useRef } from 'react';
import { Shield, ScrollText, Users, RefreshCw, UserPlus, Trash2, Download, Upload, GraduationCap, UserCog, ShieldCheck, Wand2, KeyRound } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { adminApi } from '../api';
import { useToast } from '../components/Toast';
import { useAutoRefresh } from '../hooks/useAutoRefresh';
import { useLive } from '../live';
import { UserDetailDrawer } from '../components/UserDetailDrawer';
import { Avatar, Checkbox, Delta, Dialog, Empty, FieldLabel, Figures, IconButton, PageHeader, Pager, SearchField, Section, Segmented, Spinner, Status, Tag } from '../components/kit';
import { Bars, SplitBar } from '../components/charts';
import { AdminCountdown, clockOffset } from '../components/AdminCountdown';
import { GrantAdminDialog, OneTimePasswordDialog } from '../components/GrantAdminDialog';
import { PasswordInput, randomPassword } from '../components/PasswordInput';
import { ROLE_OPTIONS, roleLabel, roleTone } from '../roles';
import type { AccountRole, AdminUser } from '../types';

function relativeDate(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(diff / 86400000);
  if (days <= 0) return 'Heute';
  if (days === 1) return 'Gestern';
  if (days < 30) return `vor ${days} Tagen`;
  const months = Math.floor(days / 30);
  return months === 1 ? 'vor 1 Monat' : `vor ${months} Monaten`;
}

type FilterTab = 'all' | 'students' | 'parents' | 'none' | 'admins';

// Tabs that map to a server-side role filter (Schüler/Eltern/ohne Rolle).
// 'admins' is filtered client-side on the already-fetched page (admin is a
// separate flag).
function roleForFilter(filter: FilterTab): AccountRole | undefined {
  if (filter === 'students') return 'student';
  if (filter === 'parents') return 'parent';
  if (filter === 'none') return 'none';
  return undefined;
}

// Totals for the figures and diagrams above the list. They come from their own
// requests, so the list still works if one of them fails.
interface Summary {
  total: number;
  admins: number;
  students: number;
  parents: number;
  noRole: number;
  // Accounts made since Monday 00:00 (server time).
  newThisWeek: number;
  byDay: Array<{ date: string; count: number }>;
}

const TABS: Array<{ value: FilterTab; label: string }> = [
  { value: 'all',      label: 'Alle' },
  { value: 'students', label: 'Schüler' },
  { value: 'parents',  label: 'Eltern' },
  { value: 'none',     label: 'Ohne Rolle' },
  { value: 'admins',   label: 'Admin' },
];

const EMPTY_FORM = {
  username: '',
  password: '',
  webuntisKlasseId: '',
  webuntisKlasseName: '',
  role: 'student' as AccountRole,
  isAdmin: false,
  // Only for an admin without a password (a WebUntis account).
  adminPassword: '',
};

// Choosing a role: three options, each with what it means.
function RoleDialog({ user, onPick, onClose }: { user: AdminUser; onPick: (role: AccountRole) => void; onClose: () => void }) {
  return (
    <Dialog title="Rolle ändern" subtitle={user.username} onClose={onClose}>
      <div className="flex flex-col gap-2">
        {ROLE_OPTIONS.map((option) => {
          const current = option.value === user.role;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => onPick(option.value)}
              aria-pressed={current}
              className="flex items-start gap-3.5 rounded-[18px] px-[18px] py-3.5 text-left transition-colors"
              style={{ background: current ? 'var(--sky-wash)' : 'var(--well)' }}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[14.5px] font-medium" style={{ color: current ? 'var(--sky-deep)' : 'var(--ink)' }}>{option.label}</span>
                <span className="mt-0.5 block text-[13px] leading-relaxed text-ink-3">{option.hint}</span>
              </span>
              {current && <span className="mt-0.5 text-[12.5px] text-sky-deep">aktuell</span>}
            </button>
          );
        })}
      </div>
      {user.isAdmin && (
        <p className="mt-4 text-[12.5px] leading-relaxed text-ink-3">Die Admin-Rechte bleiben bei jeder Rolle unverändert.</p>
      )}
    </Dialog>
  );
}

function SkeletonRow() {
  return (
    <tr>
      <td><div className="flex items-center gap-4"><div className="shimmer h-11 w-11 rounded-full" /><div className="shimmer h-3.5 w-32 rounded-full" /></div></td>
      <td className="hidden md:table-cell"><div className="shimmer h-3.5 w-20 rounded-full" /></td>
      <td className="hidden lg:table-cell"><div className="shimmer h-3.5 w-8 rounded-full" /></td>
      <td><div className="shimmer h-3.5 w-24 rounded-full" /></td>
      <td className="hidden sm:table-cell"><div className="shimmer h-3.5 w-20 rounded-full" /></td>
      <td><div className="shimmer ml-auto h-9 w-36 rounded-full" /></td>
    </tr>
  );
}

export function UsersPage() {
  const { showToast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  // The dashboard's jump field hands over a search term.
  const handedSearch = (location.state as { search?: string } | null)?.search ?? '';
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState(handedSearch);
  const [debouncedSearch, setDebouncedSearch] = useState(handedSearch);
  const [filter, setFilter] = useState<FilterTab>('all');
  const [loading, setLoading] = useState(true);
  const [pendingAdmin, setPendingAdmin] = useState<string | null>(null);
  const [deletingUid, setDeletingUid] = useState<string | null>(null);
  const [confirmDeleteUid, setConfirmDeleteUid] = useState<string | null>(null);
  const [selectedUid, setSelectedUid] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createForm, setCreateForm] = useState(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [pendingRole, setPendingRole] = useState<string | null>(null);
  const [roleDialogUser, setRoleDialogUser] = useState<AdminUser | null>(null);
  const [grantUser, setGrantUser] = useState<AdminUser | null>(null);
  // The one-time password of a pending grant, shown again (or right after
  // creating an admin account, with the password just typed).
  const [otpView, setOtpView] = useState<{ user: AdminUser; known?: { password: string; expiresAt: string; offset: number } } | null>(null);
  // Server clock minus local clock, for the admin countdowns.
  const [offset, setOffset] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const limit = 20;

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => { setDebouncedSearch(search); setPage(1); }, 300);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [search]);

  const fetchSummary = useCallback(() => {
    Promise.all([
      adminApi.stats(),
      adminApi.users(undefined, 1, 1, 'student'),
      adminApi.users(undefined, 1, 1, 'parent'),
      adminApi.users(undefined, 1, 1, 'none'),
    ]).then(([stats, students, parents, noRole]) => {
      setSummary({
        total: stats.totalUsers,
        admins: stats.totalAdmins,
        students: students.total,
        parents: parents.total,
        noRole: noRole.total,
        newThisWeek: stats.newUsersThisWeek ?? 0,
        byDay: stats.usersByDay ?? [],
      });
    }).catch(() => { /* the list below does not depend on the summary */ });
  }, []);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminApi.users(debouncedSearch || undefined, page, limit, roleForFilter(filter));
      setUsers(res.users);
      setTotal(res.total);
      setOffset(clockOffset(res.serverTime));
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Laden fehlgeschlagen', 'error');
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, page, filter, showToast]);

  // Reset to page 1 whenever the active filter changes.
  useEffect(() => { setPage(1); }, [filter]);

  useEffect(() => { void fetchUsers(); }, [fetchUsers]);
  useEffect(() => { fetchSummary(); }, [fetchSummary]);

  const refreshAll = useCallback(async () => {
    fetchSummary();
    await fetchUsers();
  }, [fetchSummary, fetchUsers]);

  const { refresh, refreshing } = useAutoRefresh(refreshAll, 30000);
  useLive(['users'], () => { void refreshAll(); });

  // 'admins' narrows the fetched page client-side; role tabs filter server-side.
  const filteredUsers = filter === 'admins' ? users.filter((u) => u.isAdmin) : users;

  const totalPages = Math.ceil(total / limit);

  // A countdown ran out: the server has removed the grant by now.
  const handleGrantLapsed = useCallback(() => {
    setTimeout(() => { void refreshAll(); }, 1500);
  }, [refreshAll]);

  // The popup stays open on the password; the row shows the countdown.
  function handleGranted(user: AdminUser, adminSetupExpiresAt: string | null) {
    setUsers((prev) => prev.map((u) => u.stableUid === user.stableUid
      ? { ...u, isAdmin: true, adminSetupExpiresAt, canViewOneTimePassword: adminSetupExpiresAt !== null }
      : u));
    fetchSummary();
  }

  async function handleToggleAdmin(user: AdminUser) {
    // Not an admin, WebUntis account: the one-time password popup.
    if (!user.isAdmin && user.needsOneTimePassword) {
      setGrantUser(user);
      return;
    }
    setPendingAdmin(user.stableUid);
    if (user.isAdmin) {
      // Revoking also ends a pending grant: its one-time password is gone,
      // and the next "Admin vergeben" starts over with a new one.
      setUsers((prev) => prev.map((u) => u.stableUid === user.stableUid
        ? { ...u, isAdmin: false, adminSetupExpiresAt: null, canViewOneTimePassword: false }
        : u));
      setOtpView((v) => (v?.user.stableUid === user.stableUid ? null : v));
    } else {
      setUsers((prev) => prev.map((u) => u.stableUid === user.stableUid ? { ...u, isAdmin: true } : u));
    }
    try {
      if (user.isAdmin) {
        await adminApi.revokeAdmin(user.stableUid);
        showToast(`Admin-Rechte von ${user.username} entzogen`, 'success');
      } else {
        await adminApi.grantAdmin(user.stableUid);
        showToast(`Admin-Rechte an ${user.username} vergeben`, 'success');
      }
      fetchSummary();
    } catch (err) {
      setUsers((prev) => prev.map((u) => u.stableUid === user.stableUid ? user : u));
      showToast(err instanceof Error ? err.message : 'Aktion fehlgeschlagen', 'error');
    } finally {
      setPendingAdmin(null);
    }
  }

  async function handleDelete(user: AdminUser) {
    if (confirmDeleteUid !== user.stableUid) {
      setConfirmDeleteUid(user.stableUid);
      setTimeout(() => setConfirmDeleteUid((uid) => (uid === user.stableUid ? null : uid)), 3000);
      return;
    }
    setDeletingUid(user.stableUid);
    setConfirmDeleteUid(null);
    try {
      await adminApi.deleteUser(user.stableUid);
      setUsers((prev) => prev.filter((u) => u.stableUid !== user.stableUid));
      setTotal((t) => t - 1);
      showToast(`Benutzer "${user.username}" gelöscht`, 'success');
      fetchSummary();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Löschen fehlgeschlagen', 'error');
    } finally {
      setDeletingUid(null);
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!createForm.username.trim()) return;
    setCreating(true);
    try {
      const password = createForm.password.trim();
      const user = await adminApi.createUser({
        username: createForm.username.trim(),
        password: password || undefined,
        webuntisKlasseId: createForm.webuntisKlasseId ? parseInt(createForm.webuntisKlasseId, 10) : 0,
        webuntisKlasseName: createForm.webuntisKlasseName.trim() || undefined,
        role: createForm.role,
        isAdmin: createForm.isAdmin,
        adminPassword: createForm.isAdmin && !password ? createForm.adminPassword : undefined,
      });
      setUsers((prev) => [user, ...prev]);
      setTotal((t) => t + 1);
      setShowCreateModal(false);
      // A new WebUntis admin: show the one-time password with its countdown.
      if (user.adminSetupExpiresAt) {
        setOtpView({
          user,
          known: { password: createForm.adminPassword, expiresAt: user.adminSetupExpiresAt, offset: clockOffset((user as AdminUser & { serverTime?: string }).serverTime) },
        });
      }
      setCreateForm(EMPTY_FORM);
      showToast(`Benutzer "${user.username}" erstellt`, 'success');
      fetchSummary();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erstellen fehlgeschlagen', 'error');
    } finally {
      setCreating(false);
    }
  }

  async function handleSetRole(user: AdminUser, newRole: AccountRole) {
    setRoleDialogUser(null);
    if (newRole === user.role) return;
    setPendingRole(user.stableUid);
    setUsers((prev) => prev.map((u) => u.stableUid === user.stableUid ? { ...u, role: newRole } : u));
    try {
      await adminApi.setUserRole(user.stableUid, newRole);
      showToast(newRole === 'none' ? `${user.username} hat jetzt keine Rolle` : `${user.username} ist jetzt ${roleLabel(newRole)}`, 'success');
      fetchSummary();
      // If a role filter is active, the row may no longer belong on this page.
      if (roleForFilter(filter)) void fetchUsers();
    } catch (err) {
      setUsers((prev) => prev.map((u) => u.stableUid === user.stableUid ? { ...u, role: user.role } : u));
      showToast(err instanceof Error ? err.message : 'Aktion fehlgeschlagen', 'error');
    } finally {
      setPendingRole(null);
    }
  }

  async function handleExport() {
    setExporting(true);
    try {
      await adminApi.exportDatabase();
      showToast('Export gestartet — Download läuft', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Export fehlgeschlagen', 'error');
    } finally {
      setExporting(false);
    }
  }

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file
    if (!file) return;
    if (!window.confirm('Import überschreibt ALLE vorhandenen Daten. Fortfahren?')) return;
    setImporting(true);
    try {
      const text = await file.text();
      const payload = JSON.parse(text) as unknown;
      await adminApi.importDatabase(payload);
      showToast('Import erfolgreich — Daten wiederhergestellt', 'success');
      setPage(1);
      void refreshAll();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Import fehlgeschlagen', 'error');
    } finally {
      setImporting(false);
    }
  }

  // Last 14 days of registrations, with gaps filled in as zero.
  const signupDays = Array.from({ length: 14 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (13 - i));
    return d;
  });
  const byDay = new Map((summary?.byDay ?? []).map((d) => [d.date, d.count]));
  const signupValues = signupDays.map((d) => byDay.get(d.toISOString().slice(0, 10)) ?? 0);

  return (
    <div>
      {showCreateModal && (
        <Dialog title="Benutzer erstellen" subtitle="Neues Konto hinzufügen" onClose={() => setShowCreateModal(false)}>
          <form onSubmit={(e) => void handleCreate(e)} className="flex flex-col gap-5">
            <FieldLabel label="Benutzername *">
              <input
                type="text"
                placeholder="z.B. max.muster"
                required
                autoCapitalize="none"
                spellCheck={false}
                value={createForm.username}
                onChange={(e) => setCreateForm((f) => ({ ...f, username: e.target.value }))}
                className="field h-12 w-full px-4 text-[14.5px]"
              />
            </FieldLabel>
            <FieldLabel label="Passwort" hint="Optional, mindestens 8 Zeichen. Leer lassen für ein WebUntis-Konto.">
              <PasswordInput
                value={createForm.password}
                onChange={(password) => setCreateForm((f) => ({ ...f, password }))}
              />
            </FieldLabel>
            <div className="grid grid-cols-2 gap-4">
              <FieldLabel label="WebUntis Klassen-ID">
                <input
                  type="number"
                  placeholder="0"
                  value={createForm.webuntisKlasseId}
                  onChange={(e) => setCreateForm((f) => ({ ...f, webuntisKlasseId: e.target.value }))}
                  className="field h-12 w-full px-4 text-[14.5px]"
                />
              </FieldLabel>
              <FieldLabel label="Klassenname">
                <input
                  type="text"
                  placeholder="z.B. 4AHIF"
                  value={createForm.webuntisKlasseName}
                  onChange={(e) => setCreateForm((f) => ({ ...f, webuntisKlasseName: e.target.value }))}
                  className="field h-12 w-full px-4 text-[14.5px]"
                />
              </FieldLabel>
            </div>
            {/* Account type — Schüler, Eltern or no role */}
            <div className="flex flex-col gap-2">
              <span className="text-[13px] text-ink-2">Rolle</span>
              <Segmented
                label="Rolle"
                value={createForm.role}
                onChange={(role) => setCreateForm((f) => ({ ...f, role }))}
                options={ROLE_OPTIONS.map((o) => ({ value: o.value, label: o.value === 'none' ? 'Keine' : o.label }))}
              />
            </div>
            <Checkbox
              checked={createForm.isAdmin}
              onChange={(isAdmin) => setCreateForm((f) => ({ ...f, isAdmin }))}
              label="Admin"
              hint="Darf sich im Admin-Panel anmelden. Die Rolle bleibt davon unberührt."
            />
            {createForm.isAdmin && !createForm.password.trim() && (
              <FieldLabel
                label="Einmal-Passwort fürs Admin-Panel *"
                hint="Ohne Passwort oben ist es ein WebUntis-Konto. Gilt 15 Minuten; beim ersten Login muss ein eigenes Passwort gesetzt werden, sonst verfällt der Admin-Zugang."
              >
                <div className="flex gap-2">
                  <input
                    type="text"
                    required
                    minLength={8}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={createForm.adminPassword}
                    onChange={(e) => setCreateForm((f) => ({ ...f, adminPassword: e.target.value }))}
                    className="field h-12 min-w-0 flex-1 px-4 font-mono text-[14.5px]"
                  />
                  <button
                    type="button"
                    onClick={() => setCreateForm((f) => ({ ...f, adminPassword: randomPassword() }))}
                    className="btn btn-quiet"
                    title="Zufälliges Passwort erzeugen"
                  >
                    <Wand2 size={16} strokeWidth={1.7} />
                    Generieren
                  </button>
                </div>
              </FieldLabel>
            )}
            <div className="mt-2 flex gap-3">
              <button type="button" onClick={() => setShowCreateModal(false)} className="btn btn-quiet flex-1">Abbrechen</button>
              <button type="submit" disabled={creating} className="btn btn-primary flex-1">
                {creating ? <Spinner /> : <UserPlus size={16} strokeWidth={1.7} />}
                {creating ? 'Erstelle…' : 'Erstellen'}
              </button>
            </div>
          </form>
        </Dialog>
      )}

      {grantUser && (
        <GrantAdminDialog
          stableUid={grantUser.stableUid}
          username={grantUser.username}
          onClose={() => setGrantUser(null)}
          onGranted={(expiresAt) => handleGranted(grantUser, expiresAt)}
          onLapsed={handleGrantLapsed}
        />
      )}

      {otpView && (
        <OneTimePasswordDialog
          stableUid={otpView.user.stableUid}
          username={otpView.user.username}
          known={otpView.known}
          onClose={() => setOtpView(null)}
          onLapsed={handleGrantLapsed}
        />
      )}

      {roleDialogUser && (
        <RoleDialog
          user={roleDialogUser}
          onPick={(role) => void handleSetRole(roleDialogUser, role)}
          onClose={() => setRoleDialogUser(null)}
        />
      )}

      {selectedUid && (
        <UserDetailDrawer
          stableUid={selectedUid}
          onClose={() => setSelectedUid(null)}
          onUserDeleted={(uid) => { setUsers((prev) => prev.filter((u) => u.stableUid !== uid)); setTotal((t) => t - 1); setSelectedUid(null); fetchSummary(); }}
          onAdminToggled={(uid, isAdmin, adminSetupExpiresAt) => { setUsers((prev) => prev.map((u) => u.stableUid === uid ? { ...u, isAdmin, adminSetupExpiresAt, canViewOneTimePassword: adminSetupExpiresAt !== null } : u)); fetchSummary(); }}
        />
      )}

      <PageHeader title="Benutzer" subtitle="Konten, Rollen und Admin-Berechtigungen verwalten.">
        <IconButton icon={RefreshCw} label="Aktualisieren" size={42} busy={refreshing} onClick={() => void refresh()} />
        <IconButton icon={Download} label="Vollständiges Backup als JSON herunterladen" size={42} busy={exporting} onClick={() => void handleExport()} />
        <IconButton icon={Upload} label="Backup-JSON importieren (überschreibt alle Daten)" size={42} busy={importing} onClick={() => importInputRef.current?.click()} />
        <input
          ref={importInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => void handleImportFile(e)}
        />
        <button type="button" onClick={() => setShowCreateModal(true)} className="btn btn-primary">
          <UserPlus size={16} strokeWidth={1.7} />
          Neuer Benutzer
        </button>
      </PageHeader>

      <Figures
        className="mt-10"
        items={[
          {
            label: 'Konten',
            value: summary?.total ?? total,
            icon: Users,
            note: summary && summary.newThisWeek > 0
              ? <Delta trend="up" tone="mint"><span title="Neue Konten seit Montag 00:00">+{summary.newThisWeek.toLocaleString('de-AT')} diese Woche</span></Delta>
              : undefined,
          },
          { label: 'Schüler:innen', value: summary?.students ?? '–', icon: GraduationCap },
          { label: 'Eltern',        value: summary?.parents ?? '–',  icon: UserCog },
          { label: 'Admins',        value: summary?.admins ?? '–',   icon: ShieldCheck },
        ]}
      />

      <div className="mt-[46px] grid gap-x-16 gap-y-12 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <Section title="Registrierungen" meta="Letzte 14 Tage">
          <div className="mt-8">
            <Bars
              values={signupValues}
              labels={signupDays.map((d) => String(d.getDate()).padStart(2, '0'))}
              titles={signupDays.map((d) => d.toLocaleDateString('de-AT', { weekday: 'short', day: 'numeric', month: 'long' }))}
              unit="neue Konten"
              tickEvery={2}
              ariaLabel="Neue Konten pro Tag in den letzten 14 Tagen"
            />
          </div>
        </Section>
        <Section title="Rollen">
          <div className="mt-9">
            <SplitBar
              ariaLabel="Verteilung der Konten nach Rolle"
              parts={[
                { label: 'Schüler:innen', value: summary?.students ?? 0, color: 'var(--mint)' },
                { label: 'Eltern',        value: summary?.parents ?? 0,  color: '#a98be0' },
                { label: 'Ohne Rolle',    value: summary?.noRole ?? 0,   color: 'var(--well-3)' },
              ]}
            />
          </div>
        </Section>
      </div>

      <Section
        className="mt-[52px]"
        title="Alle Konten"
        meta={`${filteredUsers.length} von ${total.toLocaleString('de-AT')}`}
        action={(
          <>
            <SearchField value={search} onChange={setSearch} placeholder="Benutzername suchen" className="w-full sm:w-[260px]" />
            <Segmented label="Konten filtern" value={filter} onChange={setFilter} options={TABS} />
          </>
        )}
      >
        <div className="tbl-scroll mt-7">
          <table className="tbl">
            <thead>
              <tr>
                <th>Benutzer</th>
                <th className="hidden md:table-cell">Klasse</th>
                <th className="hidden lg:table-cell">Todos</th>
                <th>Rolle</th>
                <th className="hidden sm:table-cell">Beitritt</th>
                <th><span className="sr-only">Aktionen</span></th>
              </tr>
            </thead>
            <tbody>
              {loading && users.length === 0
                ? Array.from({ length: 6 }).map((_, i) => <SkeletonRow key={i} />)
                : filteredUsers.length === 0
                ? (
                  <tr>
                    <td colSpan={6}>
                      <Empty icon={Users}>{search ? `Kein Benutzer mit „${search}“.` : 'Keine Benutzer.'}</Empty>
                    </td>
                  </tr>
                )
                : filteredUsers.map((user) => (
                  <tr key={user.stableUid} data-clickable onClick={() => setSelectedUid(user.stableUid)}>
                    <td>
                      <div className="flex items-center gap-4">
                        <Avatar name={user.username} size={44} />
                        <div className="min-w-0">
                          <div className="truncate font-medium">{user.username}</div>
                          <div className="truncate font-mono text-[11.5px] text-ink-3">{user.stableUid.slice(0, 8)}&hellip;</div>
                        </div>
                      </div>
                    </td>

                    <td className="hidden md:table-cell">
                      <div className="flex items-center gap-2.5">
                        <span className="text-ink-2">{user.webuntisKlasseName ?? '—'}</span>
                        {user.classCode && <Tag tone="sky" mono>{user.classCode}</Tag>}
                      </div>
                    </td>

                    <td className="tabular hidden text-ink-2 lg:table-cell">{user.todoCount}</td>

                    <td>
                      <div className="flex flex-col gap-1.5">
                        {/* "No role" is not a role to show: an admin shows as
                            admin only, and only an account without any role
                            at all says so, quietly. */}
                        {user.role !== 'none'
                          ? <Status tone={roleTone(user.role)}>{roleLabel(user.role)}</Status>
                          : !user.isAdmin && <span className="text-[13.5px] text-ink-3">Keine Rolle</span>}
                        {user.isAdmin && (
                          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                            <Status tone={user.adminSetupExpiresAt ? 'amber' : 'sky'}>Admin</Status>
                            {user.adminSetupExpiresAt && (user.canViewOneTimePassword ? (
                              <button
                                type="button"
                                className="otp-chip"
                                title="Einmal-Passwort nochmal anzeigen"
                                onClick={(e) => { e.stopPropagation(); setOtpView({ user }); }}
                              >
                                <KeyRound size={13} strokeWidth={1.8} />
                                <AdminCountdown expiresAt={user.adminSetupExpiresAt} offset={offset} onExpired={handleGrantLapsed} />
                              </button>
                            ) : (
                              <AdminCountdown expiresAt={user.adminSetupExpiresAt} offset={offset} onExpired={handleGrantLapsed} />
                            ))}
                          </div>
                        )}
                      </div>
                    </td>

                    <td className="hidden whitespace-nowrap text-ink-3 sm:table-cell">{relativeDate(user.createdAt)}</td>

                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="row-actions">
                        <IconButton
                          icon={Shield}
                          tone="sky"
                          active={user.isAdmin}
                          busy={pendingAdmin === user.stableUid}
                          label={user.isAdmin ? 'Admin-Rechte entziehen' : 'Admin-Rechte vergeben'}
                          onClick={() => void handleToggleAdmin(user)}
                        />
                        {/* Role: Schüler, Eltern or none */}
                        <IconButton
                          icon={UserCog}
                          tone="violet"
                          busy={pendingRole === user.stableUid}
                          label="Rolle ändern"
                          onClick={() => setRoleDialogUser(user)}
                        />
                        <IconButton
                          icon={ScrollText}
                          label="Logs anzeigen"
                          onClick={() => navigate('/logs', { state: { username: user.username } })}
                        />
                        {confirmDeleteUid === user.stableUid ? (
                          <button type="button" className="btn btn-sm btn-danger" onClick={() => void handleDelete(user)}>
                            Wirklich löschen?
                          </button>
                        ) : (
                          <IconButton
                            icon={Trash2}
                            tone="rose"
                            busy={deletingUid === user.stableUid}
                            label="Benutzer löschen"
                            onClick={() => void handleDelete(user)}
                          />
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>

        <Pager page={page} pages={totalPages} onChange={setPage} />
      </Section>
    </div>
  );
}
