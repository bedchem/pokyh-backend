import { useEffect, useState, useCallback, useRef } from 'react';
import { Search, Shield, ShieldOff, ChevronLeft, ChevronRight, ScrollText, Users, RefreshCw, UserPlus, Trash2, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { adminApi } from '../api';
import { useToast } from '../components/Toast';
import { useAutoRefresh } from '../hooks/useAutoRefresh';
import { UserDetailDrawer } from '../components/UserDetailDrawer';
import type { AdminUser } from '../types';

const AVATAR_COLORS = ['#0a84ff', '#bf5af2', '#40c8e0', '#30d158', '#ff9f0a', '#ff453a'];

function avatarColor(username: string): string {
  let hash = 0;
  for (let i = 0; i < username.length; i++) hash = username.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]!;
}

function relativeDate(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'Heute';
  if (days === 1) return 'Gestern';
  if (days < 30) return `${days}T`;
  return `${Math.floor(days / 30)}M`;
}

type FilterTab = 'all' | 'admins' | 'regular';

function SkeletonRow() {
  return (
    <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
      {[140, 80, 90, 60, 70, 90, 80].map((w, i) => (
        <td key={i} className="px-4 py-3.5">
          <div className="h-3.5 rounded shimmer" style={{ width: `${w}px` }} />
        </td>
      ))}
    </tr>
  );
}

export function UsersPage() {
  const { showToast } = useToast();
  const navigate = useNavigate();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [filter, setFilter] = useState<FilterTab>('all');
  const [loading, setLoading] = useState(true);
  const [pendingAdmin, setPendingAdmin] = useState<string | null>(null);
  const [deletingUid, setDeletingUid] = useState<string | null>(null);
  const [confirmDeleteUid, setConfirmDeleteUid] = useState<string | null>(null);
  const [selectedUid, setSelectedUid] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createForm, setCreateForm] = useState({ username: '', webuntisKlasseId: '', webuntisKlasseName: '' });
  const [creating, setCreating] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const limit = 20;

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => { setDebouncedSearch(search); setPage(1); }, 300);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [search]);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminApi.users(debouncedSearch || undefined, page, limit);
      setUsers(res.users);
      setTotal(res.total);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Laden fehlgeschlagen', 'error');
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, page, showToast]);

  useEffect(() => { void fetchUsers(); }, [fetchUsers]);

  const { refresh, refreshing } = useAutoRefresh(fetchUsers, 30000);

  const filteredUsers = users.filter((u) => {
    if (filter === 'admins') return u.isAdmin;
    if (filter === 'regular') return !u.isAdmin;
    return true;
  });

  const totalPages = Math.ceil(total / limit);

  async function handleToggleAdmin(user: AdminUser) {
    setPendingAdmin(user.stableUid);
    const newIsAdmin = !user.isAdmin;
    setUsers((prev) => prev.map((u) => u.stableUid === user.stableUid ? { ...u, isAdmin: newIsAdmin } : u));
    try {
      if (user.isAdmin) {
        await adminApi.revokeAdmin(user.stableUid);
        showToast(`Admin-Rechte von ${user.username} entzogen`, 'success');
      } else {
        await adminApi.grantAdmin(user.stableUid);
        showToast(`Admin-Rechte an ${user.username} vergeben`, 'success');
      }
    } catch (err) {
      setUsers((prev) => prev.map((u) => u.stableUid === user.stableUid ? { ...u, isAdmin: user.isAdmin } : u));
      showToast(err instanceof Error ? err.message : 'Aktion fehlgeschlagen', 'error');
    } finally {
      setPendingAdmin(null);
    }
  }

  async function handleDelete(user: AdminUser) {
    if (confirmDeleteUid !== user.stableUid) {
      setConfirmDeleteUid(user.stableUid);
      setTimeout(() => setConfirmDeleteUid(null), 3000);
      return;
    }
    setDeletingUid(user.stableUid);
    setConfirmDeleteUid(null);
    try {
      await adminApi.deleteUser(user.stableUid);
      setUsers((prev) => prev.filter((u) => u.stableUid !== user.stableUid));
      setTotal((t) => t - 1);
      showToast(`Benutzer "${user.username}" gelöscht`, 'success');
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
      const user = await adminApi.createUser({
        username: createForm.username.trim(),
        webuntisKlasseId: createForm.webuntisKlasseId ? parseInt(createForm.webuntisKlasseId, 10) : 0,
        webuntisKlasseName: createForm.webuntisKlasseName.trim() || 'Unknown',
      });
      setUsers((prev) => [user, ...prev]);
      setTotal((t) => t + 1);
      setShowCreateModal(false);
      setCreateForm({ username: '', webuntisKlasseId: '', webuntisKlasseName: '' });
      showToast(`Benutzer "${user.username}" erstellt`, 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erstellen fehlgeschlagen', 'error');
    } finally {
      setCreating(false);
    }
  }

  const tabs: { key: FilterTab; label: string }[] = [
    { key: 'all',     label: 'Alle' },
    { key: 'admins',  label: 'Admin' },
    { key: 'regular', label: 'Standard' },
  ];

  return (
    <div className="flex flex-col gap-6 animate-page">
      {/* Create modal */}
      {showCreateModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}
          onClick={() => setShowCreateModal(false)}
        >
          <div
            className="w-full max-w-md rounded-[20px] p-6 flex flex-col gap-5 animate-scaleIn"
            style={{
              background: '#1c1c1e',
              border: '1px solid rgba(255,255,255,0.1)',
              boxShadow: '0 32px 80px rgba(0,0,0,0.65)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-[18px] font-bold text-white" style={{ letterSpacing: '-0.02em' }}>
                  Benutzer erstellen
                </h2>
                <p className="text-[13px] mt-0.5" style={{ color: 'rgba(235,235,245,0.4)' }}>
                  Neuen Benutzer hinzufügen
                </p>
              </div>
              <button
                onClick={() => setShowCreateModal(false)}
                style={{ color: 'rgba(235,235,245,0.35)' }}
                className="p-1.5 rounded-[8px] transition-colors hover:bg-white/5"
              >
                <X size={16} />
              </button>
            </div>
            <form onSubmit={(e) => void handleCreate(e)} className="flex flex-col gap-4">
              {[
                { label: 'Benutzername', key: 'username', placeholder: 'z.B. max.muster', required: true },
                { label: 'WebUntis Klassen-ID', key: 'webuntisKlasseId', placeholder: '0', required: false },
                { label: 'Klassenname', key: 'webuntisKlasseName', placeholder: 'z.B. 4AHIF', required: false },
              ].map(({ label, key, placeholder, required }) => (
                <div key={key} className="flex flex-col gap-1.5">
                  <label
                    className="text-[11px] font-semibold uppercase tracking-[0.05em]"
                    style={{ color: 'rgba(235,235,245,0.4)' }}
                  >
                    {label}{required && ' *'}
                  </label>
                  <input
                    type={key === 'webuntisKlasseId' ? 'number' : 'text'}
                    placeholder={placeholder}
                    required={required}
                    value={createForm[key as keyof typeof createForm]}
                    onChange={(e) => setCreateForm((f) => ({ ...f, [key]: e.target.value }))}
                    className="apple-input w-full px-3 py-2.5 text-[14px]"
                  />
                </div>
              ))}
              <div className="flex gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="apple-btn-ghost flex-1 py-2.5 rounded-[10px] text-[14px]"
                >
                  Abbrechen
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="apple-btn flex-1 py-2.5 text-[14px] flex items-center justify-center gap-2"
                >
                  {creating
                    ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    : <UserPlus size={14} />
                  }
                  {creating ? 'Erstelle…' : 'Erstellen'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {selectedUid && (
        <UserDetailDrawer
          stableUid={selectedUid}
          onClose={() => setSelectedUid(null)}
          onUserDeleted={(uid) => { setUsers((prev) => prev.filter((u) => u.stableUid !== uid)); setTotal((t) => t - 1); setSelectedUid(null); }}
          onAdminToggled={(uid, isAdmin) => { setUsers((prev) => prev.map((u) => u.stableUid === uid ? { ...u, isAdmin } : u)); }}
        />
      )}

      {/* Page header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-bold text-white" style={{ letterSpacing: '-0.03em' }}>Benutzer</h1>
          <p className="text-[14px] mt-1" style={{ color: 'rgba(235,235,245,0.4)' }}>
            Konten und Admin-Berechtigungen verwalten
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowCreateModal(true)}
            className="apple-btn flex items-center gap-2 px-3 py-2 text-[13px]"
          >
            <UserPlus size={14} />
            Neu
          </button>
          <button
            onClick={() => void refresh()}
            disabled={refreshing}
            className="apple-btn-ghost flex items-center gap-2 px-3 py-2 text-[13px]"
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
            {refreshing ? 'Lädt…' : 'Aktualisieren'}
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1" style={{ minWidth: '200px' }}>
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'rgba(235,235,245,0.3)' }} />
          <input
            type="text"
            placeholder="Benutzername suchen…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="apple-input w-full pl-9 pr-4 py-2.5 text-[14px]"
          />
        </div>
        <div
          className="flex p-1 gap-0.5 rounded-[10px]"
          style={{ background: '#1c1c1e', border: '1px solid rgba(255,255,255,0.07)' }}
        >
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setFilter(tab.key)}
              className="px-3 py-1.5 text-[13px] font-medium transition-all rounded-[8px]"
              style={{
                background: filter === tab.key ? 'rgba(10,132,255,0.16)' : 'transparent',
                color:      filter === tab.key ? '#0a84ff'               : 'rgba(235,235,245,0.45)',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="text-[12px]" style={{ color: 'rgba(235,235,245,0.3)' }}>
        <span style={{ color: 'rgba(235,235,245,0.6)' }}>{filteredUsers.length}</span>
        {' '}von{' '}
        <span style={{ color: 'rgba(235,235,245,0.6)' }}>{total}</span>
        {' '}Benutzer
      </div>

      {/* Table */}
      <div
        className="rounded-[16px] overflow-hidden"
        style={{
          background: '#1c1c1e',
          border: '1px solid rgba(255,255,255,0.08)',
          boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
        }}
      >
        <div className="overflow-x-auto scroll-touch">
          <table className="w-full">
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                {[
                  { label: 'Benutzer', cls: '' },
                  { label: 'Klasse',   cls: 'hidden md:table-cell' },
                  { label: 'Todos',    cls: 'hidden md:table-cell' },
                  { label: 'Status',   cls: '' },
                  { label: 'Beitritt', cls: 'hidden sm:table-cell' },
                  { label: 'Aktionen', cls: '' },
                ].map(({ label, cls }) => (
                  <th
                    key={label}
                    className={`px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.05em] ${cls}`}
                    style={{ color: 'rgba(235,235,245,0.3)' }}
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading
                ? Array.from({ length: 6 }).map((_, i) => <SkeletonRow key={i} />)
                : filteredUsers.length === 0
                ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-16 text-center">
                      <div className="flex flex-col items-center gap-3">
                        <Users size={28} style={{ color: 'rgba(235,235,245,0.2)' }} />
                        <p className="text-[13px]" style={{ color: 'rgba(235,235,245,0.35)' }}>
                          {search ? `Kein Benutzer mit "${search}"` : 'Keine Benutzer'}
                        </p>
                      </div>
                    </td>
                  </tr>
                )
                : filteredUsers.map((user) => (
                  <tr
                    key={user.stableUid}
                    style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', cursor: 'pointer' }}
                    className="transition-colors"
                    onClick={() => setSelectedUid(user.stableUid)}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.025)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = ''; }}
                  >
                    <td className="px-4 py-3.5">
                      <div className="flex items-center gap-3">
                        <div
                          className="w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-bold text-white flex-shrink-0"
                          style={{ background: avatarColor(user.username) }}
                        >
                          {user.username[0]?.toUpperCase() ?? '?'}
                        </div>
                        <div className="min-w-0">
                          <div className="text-[14px] font-medium truncate text-white">{user.username}</div>
                          <div className="text-[11px] font-mono truncate" style={{ color: 'rgba(235,235,245,0.28)' }}>
                            {user.stableUid.slice(0, 8)}&hellip;
                          </div>
                        </div>
                      </div>
                    </td>

                    <td className="px-4 py-3.5 hidden md:table-cell">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px]" style={{ color: 'rgba(235,235,245,0.5)' }}>
                          {user.webuntisKlasseName ?? '—'}
                        </span>
                        {user.classCode && (
                          <span
                            className="text-[11px] px-1.5 py-0.5 font-mono rounded-[6px]"
                            style={{ background: 'rgba(64,200,224,0.12)', color: '#40c8e0', border: '1px solid rgba(64,200,224,0.2)' }}
                          >
                            {user.classCode}
                          </span>
                        )}
                      </div>
                    </td>

                    <td className="px-4 py-3.5 hidden md:table-cell">
                      <span
                        className="text-[12px] px-2 py-0.5 rounded-[6px]"
                        style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(235,235,245,0.5)' }}
                      >
                        {user.todoCount}
                      </span>
                    </td>

                    <td className="px-4 py-3.5">
                      {user.isAdmin ? (
                        <span className="badge-blue text-[11px] px-2 py-0.5 font-medium">Admin</span>
                      ) : (
                        <span className="text-[12px]" style={{ color: 'rgba(235,235,245,0.3)' }}>User</span>
                      )}
                    </td>

                    <td className="px-4 py-3.5 hidden sm:table-cell">
                      <span className="text-[13px]" style={{ color: 'rgba(235,235,245,0.4)' }}>
                        {relativeDate(user.createdAt)}
                      </span>
                    </td>

                    <td className="px-4 py-3.5" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-1.5">
                        {/* Toggle admin */}
                        <button
                          onClick={() => void handleToggleAdmin(user)}
                          disabled={pendingAdmin === user.stableUid}
                          className="flex items-center gap-1 text-[12px] px-2.5 py-1.5 rounded-[8px] transition-all font-medium"
                          style={
                            user.isAdmin
                              ? { color: '#ff453a', border: '1px solid rgba(255,69,58,0.25)', background: 'transparent' }
                              : { color: '#0a84ff', border: '1px solid rgba(10,132,255,0.25)', background: 'transparent' }
                          }
                          onMouseEnter={(e) => { e.currentTarget.style.background = user.isAdmin ? 'rgba(255,69,58,0.08)' : 'rgba(10,132,255,0.1)'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                        >
                          {pendingAdmin === user.stableUid ? (
                            <div className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
                          ) : user.isAdmin ? (
                            <><ShieldOff size={12} /><span className="hidden sm:inline">Entziehen</span></>
                          ) : (
                            <><Shield size={12} /><span className="hidden sm:inline">Vergeben</span></>
                          )}
                        </button>

                        {/* Logs */}
                        <button
                          onClick={() => navigate('/logs', { state: { username: user.username } })}
                          className="flex items-center gap-1 text-[12px] px-2.5 py-1.5 rounded-[8px] transition-all font-medium"
                          style={{ color: 'rgba(235,235,245,0.45)', border: '1px solid rgba(255,255,255,0.08)', background: 'transparent' }}
                          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.color = '#fff'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(235,235,245,0.45)'; }}
                        >
                          <ScrollText size={12} />
                          <span className="hidden sm:inline">Logs</span>
                        </button>

                        {/* Delete */}
                        <button
                          onClick={() => void handleDelete(user)}
                          disabled={deletingUid === user.stableUid}
                          className="flex items-center gap-1 text-[12px] px-2.5 py-1.5 rounded-[8px] transition-all font-medium"
                          style={{
                            color: '#ff453a',
                            border: '1px solid rgba(255,69,58,0.28)',
                            background: confirmDeleteUid === user.stableUid ? 'rgba(255,69,58,0.22)' : 'transparent',
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,69,58,0.1)'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = confirmDeleteUid === user.stableUid ? 'rgba(255,69,58,0.22)' : 'transparent'; }}
                        >
                          {deletingUid === user.stableUid
                            ? <div className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
                            : <Trash2 size={12} />
                          }
                          <span className="hidden sm:inline">
                            {confirmDeleteUid === user.stableUid ? 'Sicher?' : 'Löschen'}
                          </span>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              }
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div
            className="flex items-center justify-between px-4 py-3"
            style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}
          >
            <span className="text-[12px]" style={{ color: 'rgba(235,235,245,0.3)' }}>
              Seite {page} von {totalPages}
            </span>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="p-1.5 rounded-[8px] transition-colors disabled:opacity-25"
                style={{ color: 'rgba(235,235,245,0.55)' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = ''; }}
              >
                <ChevronLeft size={16} />
              </button>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="p-1.5 rounded-[8px] transition-colors disabled:opacity-25"
                style={{ color: 'rgba(235,235,245,0.55)' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = ''; }}
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
