import { useEffect, useState, useCallback, useRef } from 'react';
import { Search, Shield, ShieldOff, ChevronLeft, ChevronRight, ScrollText, Users, RefreshCw, UserPlus, Trash2, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { adminApi } from '../api';
import { useToast } from '../components/Toast';
import { useAutoRefresh } from '../hooks/useAutoRefresh';
import { UserDetailDrawer } from '../components/UserDetailDrawer';
import type { AdminUser } from '../types';

const AVATAR_COLORS = [
  '#6366f1', '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ef4444',
];

function avatarColor(username: string): string {
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = username.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]!;
}

function relativeDate(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

type FilterTab = 'all' | 'admins' | 'regular';

function SkeletonRow() {
  return (
    <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
      {[140, 80, 90, 60, 70, 90, 80].map((w, i) => (
        <td key={i} className="px-4 py-3.5">
          <div
            className="h-3.5 rounded animate-pulse"
            style={{ background: 'rgba(255,255,255,0.05)', width: `${w}px` }}
          />
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
    searchTimer.current = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 300);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [search]);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminApi.users(debouncedSearch || undefined, page, limit);
      setUsers(res.users);
      setTotal(res.total);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to load users', 'error');
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, page, showToast]);

  useEffect(() => {
    void fetchUsers();
  }, [fetchUsers]);

  const { refresh, refreshing } = useAutoRefresh(fetchUsers, 30000);

  const filteredUsers = users.filter((u) => {
    if (filter === 'admins') return u.isAdmin;
    if (filter === 'regular') return !u.isAdmin;
    return true;
  });

  const totalPages = Math.ceil(total / limit);

  async function handleToggleAdmin(user: AdminUser) {
    setPendingAdmin(user.stableUid);
    try {
      if (user.isAdmin) {
        await adminApi.revokeAdmin(user.stableUid);
        showToast(`Admin revoked from ${user.username}`, 'success');
      } else {
        await adminApi.grantAdmin(user.stableUid);
        showToast(`Admin granted to ${user.username}`, 'success');
      }
      setUsers((prev) =>
        prev.map((u) =>
          u.stableUid === user.stableUid ? { ...u, isAdmin: !u.isAdmin } : u
        )
      );
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Action failed', 'error');
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
      showToast(`User "${user.username}" deleted`, 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Delete failed', 'error');
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
      showToast(`User "${user.username}" created`, 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Create failed', 'error');
    } finally {
      setCreating(false);
    }
  }

  const tabs: { key: FilterTab; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'admins', label: 'Admin' },
    { key: 'regular', label: 'Regular' },
  ];

  return (
    <div className="flex flex-col gap-6">
      {showCreateModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}
          onClick={() => setShowCreateModal(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl p-6 flex flex-col gap-5"
            style={{ background: '#111116', border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 24px 60px rgba(0,0,0,0.6)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold" style={{ color: '#f0f0f5' }}>Create User</h2>
                <p className="text-sm mt-0.5" style={{ color: '#8b8b9b' }}>Add a new user to the system</p>
              </div>
              <button onClick={() => setShowCreateModal(false)} style={{ color: '#4a4a5e' }} className="hover:text-white transition-colors">
                <X size={18} />
              </button>
            </div>
            <form onSubmit={(e) => void handleCreate(e)} className="flex flex-col gap-4">
              {[
                { label: 'Username', key: 'username', placeholder: 'e.g. max.muster', required: true },
                { label: 'WebUntis Klasse ID', key: 'webuntisKlasseId', placeholder: '0', required: false },
                { label: 'Klasse Name', key: 'webuntisKlasseName', placeholder: 'e.g. 4AHIF', required: false },
              ].map(({ label, key, placeholder, required }) => (
                <div key={key} className="flex flex-col gap-1.5">
                  <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: '#4a4a5e' }}>{label}{required && ' *'}</label>
                  <input
                    type={key === 'webuntisKlasseId' ? 'number' : 'text'}
                    placeholder={placeholder}
                    required={required}
                    value={createForm[key as keyof typeof createForm]}
                    onChange={(e) => setCreateForm((f) => ({ ...f, [key]: e.target.value }))}
                    className="w-full px-3 py-2.5 text-sm outline-none rounded-lg"
                    style={{ background: '#0a0a0f', border: '1px solid rgba(255,255,255,0.08)', color: '#f0f0f5' }}
                    onFocus={(e) => { e.currentTarget.style.borderColor = 'rgba(99,102,241,0.4)'; }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'; }}
                  />
                </div>
              ))}
              <div className="flex gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="flex-1 py-2.5 rounded-xl text-sm font-medium transition-all"
                  style={{ background: 'rgba(255,255,255,0.05)', color: '#8b8b9b', border: '1px solid rgba(255,255,255,0.08)' }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="flex-1 py-2.5 rounded-xl text-sm font-medium transition-all flex items-center justify-center gap-2"
                  style={{ background: 'rgba(99,102,241,0.2)', color: '#818cf8', border: '1px solid rgba(99,102,241,0.3)' }}
                >
                  {creating ? <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" /> : <UserPlus size={15} />}
                  {creating ? 'Creating...' : 'Create User'}
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
          onUserDeleted={(uid) => {
            setUsers((prev) => prev.filter((u) => u.stableUid !== uid));
            setTotal((t) => t - 1);
            setSelectedUid(null);
          }}
          onAdminToggled={(uid, isAdmin) => {
            setUsers((prev) => prev.map((u) => u.stableUid === uid ? { ...u, isAdmin } : u));
          }}
        />
      )}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: '#f0f0f5' }}>Users</h1>
          <p className="text-sm mt-1" style={{ color: '#8b8b9b' }}>Manage accounts and admin permissions</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all"
            style={{ background: 'rgba(99,102,241,0.15)', color: '#818cf8', border: '1px solid rgba(99,102,241,0.25)' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(99,102,241,0.25)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(99,102,241,0.15)'; }}
          >
            <UserPlus size={15} />
            New User
          </button>
          <button
            onClick={() => void refresh()}
            disabled={refreshing}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-all"
            style={{ background: '#111116', color: refreshing ? '#818cf8' : '#64748b', border: '1px solid rgba(255,255,255,0.08)' }}
          >
            <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1" style={{ minWidth: '220px' }}>
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: '#4a4a5e' }} />
          <input
            type="text"
            placeholder="Search by username..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-4 py-2.5 text-sm outline-none transition-all"
            style={{
              background: '#111116',
              border: '1px solid rgba(255,255,255,0.07)',
              borderRadius: '8px',
              color: '#f0f0f5',
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = 'rgba(99,102,241,0.4)'; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)'; }}
          />
        </div>

        <div
          className="flex p-1 gap-0.5"
          style={{
            background: '#111116',
            border: '1px solid rgba(255,255,255,0.07)',
            borderRadius: '8px',
          }}
        >
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setFilter(tab.key)}
              className="px-3 py-1.5 text-sm font-medium transition-all"
              style={{
                borderRadius: '6px',
                background: filter === tab.key ? 'rgba(99,102,241,0.18)' : 'transparent',
                color: filter === tab.key ? '#818cf8' : '#8b8b9b',
                border: filter === tab.key ? '1px solid rgba(99,102,241,0.25)' : '1px solid transparent',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="text-xs" style={{ color: '#4a4a5e' }}>
        Showing{' '}
        <span style={{ color: '#8b8b9b' }}>{filteredUsers.length}</span>
        {' '}of{' '}
        <span style={{ color: '#8b8b9b' }}>{total}</span>
        {' '}users
      </div>

      <div
        className="rounded-xl overflow-hidden"
        style={{
          background: '#111116',
          border: '1px solid rgba(255,255,255,0.07)',
          boxShadow: '0 1px 3px rgba(0,0,0,0.4), 0 8px 24px rgba(0,0,0,0.2)',
        }}
      >
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                {[
                  { label: 'User', cls: '' },
                  { label: 'Class', cls: 'hidden md:table-cell' },
                  { label: 'Todos', cls: 'hidden md:table-cell' },
                  { label: 'Status', cls: '' },
                  { label: 'Joined', cls: 'hidden sm:table-cell' },
                  { label: 'Actions', cls: '' },
                ].map(({ label, cls }) => (
                  <th
                    key={label}
                    className={`px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider ${cls}`}
                    style={{ color: '#4a4a5e' }}
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
                        <Users size={32} style={{ color: '#4a4a5e' }} />
                        <p className="text-sm" style={{ color: '#8b8b9b' }}>
                          {search ? `No users matching "${search}"` : 'No users found'}
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
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.02)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = ''; }}
                  >
                    <td className="px-4 py-3.5">
                      <div className="flex items-center gap-3">
                        <div
                          className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
                          style={{ background: avatarColor(user.username) }}
                        >
                          {user.username[0]?.toUpperCase() ?? '?'}
                        </div>
                        <div className="min-w-0">
                          <div className="text-sm font-medium truncate" style={{ color: '#f0f0f5' }}>{user.username}</div>
                          <div className="text-xs font-mono truncate" style={{ color: '#4a4a5e' }}>{user.stableUid.slice(0, 8)}&hellip;</div>
                        </div>
                      </div>
                    </td>

                    <td className="px-4 py-3.5 hidden md:table-cell">
                      <div className="flex items-center gap-2">
                        <span className="text-sm" style={{ color: '#8b8b9b' }}>{user.webuntisKlasseName ?? '—'}</span>
                        {user.classCode && (
                          <span
                            className="text-xs px-1.5 py-0.5 font-mono"
                            style={{
                              background: 'rgba(6,182,212,0.1)',
                              color: '#06b6d4',
                              border: '1px solid rgba(6,182,212,0.18)',
                              borderRadius: '6px',
                            }}
                          >
                            {user.classCode}
                          </span>
                        )}
                      </div>
                    </td>

                    <td className="px-4 py-3.5 hidden md:table-cell">
                      <span
                        className="text-xs px-2 py-0.5 font-medium"
                        style={{
                          background: 'rgba(255,255,255,0.05)',
                          color: '#8b8b9b',
                          borderRadius: '6px',
                        }}
                      >
                        {user.todoCount}
                      </span>
                    </td>

                    <td className="px-4 py-3.5">
                      {user.isAdmin ? (
                        <span
                          className="text-xs px-2 py-0.5 font-medium"
                          style={{
                            background: 'rgba(99,102,241,0.15)',
                            color: '#818cf8',
                            border: '1px solid rgba(99,102,241,0.22)',
                            borderRadius: '6px',
                          }}
                        >
                          Admin
                        </span>
                      ) : (
                        <span className="text-xs" style={{ color: '#4a4a5e' }}>User</span>
                      )}
                    </td>

                    <td className="px-4 py-3.5 hidden sm:table-cell">
                      <span className="text-sm" style={{ color: '#8b8b9b' }}>{relativeDate(user.createdAt)}</span>
                    </td>

                    <td className="px-4 py-3.5" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => void handleToggleAdmin(user)}
                          disabled={pendingAdmin === user.stableUid}
                          className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg transition-all font-medium"
                          style={
                            user.isAdmin
                              ? { color: '#ff453a', border: '1px solid rgba(255,69,58,0.25)', background: 'transparent' }
                              : { color: '#818cf8', border: '1px solid rgba(99,102,241,0.25)', background: 'transparent' }
                          }
                          onMouseEnter={(e) => {
                            e.currentTarget.style.background = user.isAdmin ? 'rgba(255,69,58,0.08)' : 'rgba(99,102,241,0.1)';
                          }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                        >
                          {pendingAdmin === user.stableUid ? (
                            <div className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
                          ) : user.isAdmin ? (
                            <><ShieldOff size={12} /><span className="hidden sm:inline">Revoke</span></>
                          ) : (
                            <><Shield size={12} /><span className="hidden sm:inline">Grant</span></>
                          )}
                        </button>

                        <button
                          onClick={() => navigate('/logs', { state: { username: user.username } })}
                          className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg transition-all font-medium"
                          style={{ color: '#8b8b9b', border: '1px solid rgba(255,255,255,0.08)', background: 'transparent' }}
                          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.color = '#f0f0f5'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#8b8b9b'; }}
                        >
                          <ScrollText size={12} />
                          <span className="hidden sm:inline">Logs</span>
                        </button>

                        <button
                          onClick={() => void handleDelete(user)}
                          disabled={deletingUid === user.stableUid}
                          className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg transition-all font-medium"
                          style={{
                            color: confirmDeleteUid === user.stableUid ? '#fff' : '#ff453a',
                            border: '1px solid rgba(255,69,58,0.3)',
                            background: confirmDeleteUid === user.stableUid ? 'rgba(255,69,58,0.25)' : 'transparent',
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,69,58,0.12)'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = confirmDeleteUid === user.stableUid ? 'rgba(255,69,58,0.25)' : 'transparent'; }}
                        >
                          {deletingUid === user.stableUid
                            ? <div className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
                            : <Trash2 size={12} />
                          }
                          <span className="hidden sm:inline">{confirmDeleteUid === user.stableUid ? 'Confirm?' : 'Delete'}</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              }
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div
            className="flex items-center justify-between px-4 py-3"
            style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}
          >
            <span className="text-xs" style={{ color: '#4a4a5e' }}>Page {page} of {totalPages}</span>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="p-1.5 rounded-lg transition-colors disabled:opacity-30"
                style={{ color: '#8b8b9b' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = ''; }}
              >
                <ChevronLeft size={16} />
              </button>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="p-1.5 rounded-lg transition-colors disabled:opacity-30"
                style={{ color: '#8b8b9b' }}
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
