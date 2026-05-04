import { useEffect, useState, useRef } from 'react';
import {
  X,
  CheckSquare,
  Square,
  Trash2,
  Edit3,
  Check,
  Building2,
  Shield,
  ShieldOff,
  LogOut,
  Loader2,
  ChevronDown,
  ChevronUp,
  Clock,
  AlertTriangle,
  Plus,
} from 'lucide-react';
import { adminApi } from '../api';
import { useToast } from './Toast';
import type { AdminUserDetail, AdminTodo, AdminUserClass } from '../types';

const AVATAR_COLORS = [
  '#6366f1', '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ef4444',
];
function avatarColor(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h);
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length]!;
}
function relativeDate(d: string) {
  const diff = Date.now() - new Date(d).getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}
function fmtDate(d: string | null) {
  if (!d) return null;
  return new Date(d).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
}
function toDatetimeLocal(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ─── Todo row ─────────────────────────────────────────────────────────────────

function TodoRow({
  todo,
  stableUid,
  onUpdated,
  onDeleted,
}: {
  todo: AdminTodo;
  stableUid: string;
  onUpdated: (t: AdminTodo) => void;
  onDeleted: (id: string) => void;
}) {
  const { showToast } = useToast();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(todo.title);
  const [details, setDetails] = useState(todo.details);
  const [dueAtLocal, setDueAtLocal] = useState(toDatetimeLocal(todo.dueAt));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) titleInputRef.current?.focus();
  }, [editing]);

  function resetEdit() {
    setTitle(todo.title);
    setDetails(todo.details);
    setDueAtLocal(toDatetimeLocal(todo.dueAt));
    setEditing(false);
  }

  async function toggleDone() {
    setSaving(true);
    try {
      const updated = await adminApi.updateTodo(stableUid, todo.id, { done: !todo.done });
      onUpdated(updated);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Failed to update', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function saveEdit() {
    const trimmed = title.trim();
    if (!trimmed) return;
    setSaving(true);

    const newDueAt = dueAtLocal ? new Date(dueAtLocal).toISOString() : null;
    const updateData: Partial<{ title: string; details: string; dueAt: string | null }> = {};
    if (trimmed !== todo.title) updateData.title = trimmed;
    if (details !== todo.details) updateData.details = details;
    if (newDueAt !== todo.dueAt) updateData.dueAt = newDueAt;

    if (Object.keys(updateData).length === 0) {
      setEditing(false);
      setSaving(false);
      return;
    }

    try {
      const updated = await adminApi.updateTodo(stableUid, todo.id, updateData);
      onUpdated(updated);
      setEditing(false);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Failed to update', 'error');
      resetEdit();
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await adminApi.deleteTodo(stableUid, todo.id);
      onDeleted(todo.id);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Failed to delete', 'error');
      setDeleting(false);
    }
  }

  const isOverdue = todo.dueAt && !todo.done && new Date(todo.dueAt) < new Date();

  return (
    <div
      className="rounded-xl transition-all"
      style={{
        background: todo.done ? 'rgba(255,255,255,0.02)' : '#18181f',
        border: `1px solid ${editing ? 'rgba(99,102,241,0.3)' : isOverdue ? 'rgba(255,69,58,0.2)' : 'rgba(255,255,255,0.06)'}`,
      }}
    >
      <div className="flex items-start gap-3 p-3">
        <button
          onClick={() => void toggleDone()}
          disabled={saving || editing}
          className="mt-0.5 flex-shrink-0 transition-opacity"
          style={{ color: todo.done ? '#30d158' : '#4a4a5e', opacity: (saving && !editing) ? 0.5 : 1 }}
        >
          {(saving && !editing) ? <Loader2 size={16} className="animate-spin" /> : todo.done ? <CheckSquare size={16} /> : <Square size={16} />}
        </button>

        <div className="flex-1 min-w-0">
          {editing ? (
            <div className="flex flex-col gap-2">
              <input
                ref={titleInputRef}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') resetEdit(); }}
                className="text-sm bg-transparent outline-none border-b w-full"
                style={{ color: '#f0f0f5', borderColor: 'rgba(99,102,241,0.5)' }}
                placeholder="Title"
              />
              <textarea
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                rows={3}
                className="text-xs outline-none resize-none rounded p-2 w-full"
                style={{
                  color: '#8b8b9b',
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid rgba(255,255,255,0.07)',
                  borderRadius: '6px',
                }}
                placeholder="Details (optional)"
              />
              <div className="flex items-center gap-2">
                <Clock size={11} style={{ color: '#4a4a5e' }} />
                <input
                  type="datetime-local"
                  value={dueAtLocal}
                  onChange={(e) => setDueAtLocal(e.target.value)}
                  className="text-xs bg-transparent outline-none flex-1"
                  style={{ color: '#8b8b9b', colorScheme: 'dark' }}
                />
                {dueAtLocal && (
                  <button onClick={() => setDueAtLocal('')} style={{ color: '#4a4a5e' }} title="Clear due date">
                    <X size={11} />
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={() => void saveEdit()}
                  disabled={saving || !title.trim()}
                  className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg font-medium transition-all disabled:opacity-50"
                  style={{ background: 'rgba(99,102,241,0.2)', color: '#818cf8', border: '1px solid rgba(99,102,241,0.3)' }}
                >
                  {saving ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
                  Save
                </button>
                <button
                  onClick={resetEdit}
                  className="text-xs px-2.5 py-1.5 rounded-lg transition-all"
                  style={{ color: '#4a4a5e', border: '1px solid rgba(255,255,255,0.06)' }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <span
                className="text-sm leading-snug"
                style={{ color: todo.done ? '#4a4a5e' : '#f0f0f5', textDecoration: todo.done ? 'line-through' : 'none' }}
              >
                {todo.title}
              </span>

              <div className="flex items-center gap-3 mt-1 flex-wrap">
                {todo.dueAt && (
                  <span className="text-xs flex items-center gap-1" style={{ color: isOverdue ? '#ff453a' : '#4a4a5e' }}>
                    {isOverdue && <AlertTriangle size={10} />}
                    <Clock size={10} />
                    {fmtDate(todo.dueAt)}
                  </span>
                )}
                <span className="text-xs" style={{ color: '#4a4a5e' }}>{relativeDate(todo.createdAt)}</span>
              </div>

              {todo.details && (
                <button
                  onClick={() => setExpanded(!expanded)}
                  className="flex items-center gap-1 text-xs mt-1 transition-opacity hover:opacity-80"
                  style={{ color: '#818cf8' }}
                >
                  {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                  {expanded ? 'Hide details' : 'Show details'}
                </button>
              )}

              {expanded && todo.details && (
                <p className="text-xs mt-2 whitespace-pre-wrap leading-relaxed" style={{ color: '#8b8b9b' }}>
                  {todo.details}
                </p>
              )}
            </>
          )}
        </div>

        {!editing && (
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              onClick={() => setEditing(true)}
              className="p-1 rounded transition-colors"
              style={{ color: '#4a4a5e' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#818cf8'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a4a5e'; }}
              title="Edit"
            >
              <Edit3 size={13} />
            </button>
            <button
              onClick={() => void handleDelete()}
              disabled={deleting}
              className="p-1 rounded transition-colors"
              style={{ color: '#4a4a5e', opacity: deleting ? 0.5 : 1 }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff453a'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a4a5e'; }}
              title="Delete"
            >
              {deleting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Create todo form ─────────────────────────────────────────────────────────

function CreateTodoForm({
  stableUid,
  onCreated,
  onCancel,
}: {
  stableUid: string;
  onCreated: (t: AdminTodo) => void;
  onCancel: () => void;
}) {
  const { showToast } = useToast();
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [dueAtLocal, setDueAtLocal] = useState('');
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setCreating(true);
    try {
      const todo = await adminApi.createTodo(stableUid, {
        title: title.trim(),
        details: details.trim() || undefined,
        dueAt: dueAtLocal ? new Date(dueAtLocal).toISOString() : null,
      });
      onCreated(todo);
      setTitle('');
      setDetails('');
      setDueAtLocal('');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Failed to create todo', 'error');
    } finally {
      setCreating(false);
    }
  }

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="rounded-xl p-3 flex flex-col gap-2"
      style={{ background: '#18181f', border: '1px solid rgba(99,102,241,0.25)' }}
    >
      <input
        ref={inputRef}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Todo title *"
        className="text-sm bg-transparent outline-none border-b w-full"
        style={{ color: '#f0f0f5', borderColor: 'rgba(99,102,241,0.4)', paddingBottom: '4px' }}
      />
      <textarea
        value={details}
        onChange={(e) => setDetails(e.target.value)}
        rows={2}
        className="text-xs outline-none resize-none rounded p-2 w-full"
        style={{
          color: '#8b8b9b',
          background: 'rgba(255,255,255,0.03)',
          border: '1px solid rgba(255,255,255,0.07)',
          borderRadius: '6px',
        }}
        placeholder="Details (optional)"
      />
      <div className="flex items-center gap-2">
        <Clock size={11} style={{ color: '#4a4a5e' }} />
        <input
          type="datetime-local"
          value={dueAtLocal}
          onChange={(e) => setDueAtLocal(e.target.value)}
          className="text-xs bg-transparent outline-none flex-1"
          style={{ color: '#8b8b9b', colorScheme: 'dark' }}
        />
        {dueAtLocal && (
          <button type="button" onClick={() => setDueAtLocal('')} style={{ color: '#4a4a5e' }}>
            <X size={11} />
          </button>
        )}
      </div>
      <div className="flex items-center gap-2 pt-1">
        <button
          type="submit"
          disabled={creating || !title.trim()}
          className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg font-medium transition-all disabled:opacity-50"
          style={{ background: 'rgba(99,102,241,0.2)', color: '#818cf8', border: '1px solid rgba(99,102,241,0.3)' }}
        >
          {creating ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
          Add Todo
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-xs px-2.5 py-1.5 rounded-lg transition-all"
          style={{ color: '#4a4a5e', border: '1px solid rgba(255,255,255,0.06)' }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ─── Class row ────────────────────────────────────────────────────────────────

function ClassRow({
  cls,
  stableUid,
  onRemoved,
}: {
  cls: AdminUserClass;
  stableUid: string;
  onRemoved: (classId: string) => void;
}) {
  const { showToast } = useToast();
  const [removing, setRemoving] = useState(false);

  async function handleRemove() {
    setRemoving(true);
    try {
      await adminApi.removeFromClass(stableUid, cls.classId);
      onRemoved(cls.classId);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Failed to remove', 'error');
      setRemoving(false);
    }
  }

  return (
    <div
      className="flex items-center gap-3 p-3 rounded-xl"
      style={{ background: '#18181f', border: '1px solid rgba(255,255,255,0.06)' }}
    >
      <div
        className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
        style={{ background: 'rgba(6,182,212,0.15)', color: '#06b6d4' }}
      >
        <Building2 size={15} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate" style={{ color: '#f0f0f5' }}>{cls.className}</div>
        <div className="text-xs font-mono mt-0.5" style={{ color: '#06b6d4' }}>{cls.classCode}</div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <span className="text-xs" style={{ color: '#4a4a5e' }}>{relativeDate(cls.joinedAt)}</span>
        <button
          onClick={() => void handleRemove()}
          disabled={removing}
          className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg transition-all font-medium"
          style={{ color: '#ff453a', border: '1px solid rgba(255,69,58,0.2)', background: 'transparent' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,69,58,0.08)'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
          title="Remove from class"
        >
          {removing ? <Loader2 size={11} className="animate-spin" /> : <LogOut size={11} />}
          Remove
        </button>
      </div>
    </div>
  );
}

// ─── Main drawer ──────────────────────────────────────────────────────────────

interface UserDetailDrawerProps {
  stableUid: string;
  onClose: () => void;
  onUserDeleted: (stableUid: string) => void;
  onAdminToggled: (stableUid: string, isAdmin: boolean) => void;
}

export function UserDetailDrawer({ stableUid, onClose, onUserDeleted, onAdminToggled }: UserDetailDrawerProps) {
  const { showToast } = useToast();
  const [user, setUser] = useState<AdminUserDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [deletingUser, setDeletingUser] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [togglingAdmin, setTogglingAdmin] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [showCreateTodo, setShowCreateTodo] = useState(false);

  useEffect(() => {
    requestAnimationFrame(() => setMounted(true));
  }, []);

  useEffect(() => {
    setLoading(true);
    adminApi.userDetail(stableUid)
      .then(setUser)
      .catch((e) => showToast(e instanceof Error ? e.message : 'Failed to load user', 'error'))
      .finally(() => setLoading(false));
  }, [stableUid, showToast]);

  function handleTodoCreated(todo: AdminTodo) {
    setUser((prev) => prev ? { ...prev, todos: [todo, ...prev.todos] } : prev);
    setShowCreateTodo(false);
  }

  function handleTodoUpdated(updated: AdminTodo) {
    setUser((prev) => prev ? { ...prev, todos: prev.todos.map((t) => t.id === updated.id ? updated : t) } : prev);
  }

  function handleTodoDeleted(id: string) {
    setUser((prev) => prev ? { ...prev, todos: prev.todos.filter((t) => t.id !== id) } : prev);
  }

  function handleClassRemoved(classId: string) {
    setUser((prev) => prev ? { ...prev, classes: prev.classes.filter((c) => c.classId !== classId) } : prev);
  }

  async function handleToggleAdmin() {
    if (!user) return;
    setTogglingAdmin(true);
    try {
      if (user.isAdmin) {
        await adminApi.revokeAdmin(user.stableUid);
        showToast(`Admin revoked from ${user.username}`, 'success');
      } else {
        await adminApi.grantAdmin(user.stableUid);
        showToast(`Admin granted to ${user.username}`, 'success');
      }
      const newIsAdmin = !user.isAdmin;
      setUser((prev) => prev ? { ...prev, isAdmin: newIsAdmin } : prev);
      onAdminToggled(user.stableUid, newIsAdmin);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Action failed', 'error');
    } finally {
      setTogglingAdmin(false);
    }
  }

  async function handleDeleteUser() {
    if (!user) return;
    setDeletingUser(true);
    try {
      await adminApi.deleteUser(user.stableUid);
      showToast(`User ${user.username} deleted`, 'success');
      onUserDeleted(user.stableUid);
      onClose();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Failed to delete user', 'error');
      setDeletingUser(false);
    }
  }

  const doneTodos = user?.todos.filter((t) => t.done) ?? [];
  const pendingTodos = user?.todos.filter((t) => !t.done) ?? [];

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40"
        style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', transition: 'opacity 0.25s', opacity: mounted ? 1 : 0 }}
        onClick={onClose}
      />

      {/* Drawer */}
      <div
        className="fixed right-0 top-0 h-full z-50 flex flex-col overflow-hidden"
        style={{
          width: '480px',
          maxWidth: '100vw',
          background: '#0e0f1c',
          borderLeft: '1px solid rgba(255,255,255,0.07)',
          boxShadow: '-24px 0 80px rgba(0,0,0,0.6)',
          transform: mounted ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 0.28s cubic-bezier(0.4,0,0.2,1)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-4 flex-shrink-0"
          style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}
        >
          <span className="text-sm font-semibold" style={{ color: '#f0f0f5' }}>User Details</span>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg transition-colors"
            style={{ color: '#4a4a5e' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#f0f0f5'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a4a5e'; }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-5">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 size={24} className="animate-spin" style={{ color: '#4a4a5e' }} />
            </div>
          ) : !user ? (
            <div className="text-center py-16" style={{ color: '#4a4a5e' }}>User not found</div>
          ) : (
            <>
              {/* User info card */}
              <div
                className="rounded-2xl p-5"
                style={{ background: '#111116', border: '1px solid rgba(255,255,255,0.07)' }}
              >
                <div className="flex items-center gap-4">
                  <div
                    className="w-14 h-14 rounded-2xl flex items-center justify-center text-xl font-bold text-white flex-shrink-0"
                    style={{ background: avatarColor(user.username) }}
                  >
                    {user.username[0]?.toUpperCase() ?? '?'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-lg font-bold truncate" style={{ color: '#f0f0f5' }}>{user.username}</span>
                      {user.isAdmin && (
                        <span
                          className="text-xs px-2 py-0.5 font-medium"
                          style={{ background: 'rgba(99,102,241,0.15)', color: '#818cf8', border: '1px solid rgba(99,102,241,0.22)', borderRadius: '6px' }}
                        >
                          Admin
                        </span>
                      )}
                    </div>
                    <div className="text-xs font-mono mt-1" style={{ color: '#4a4a5e' }}>{user.stableUid}</div>
                    <div className="flex items-center gap-3 mt-2 text-xs flex-wrap" style={{ color: '#8b8b9b' }}>
                      {user.webuntisKlasseName && <span>{user.webuntisKlasseName}</span>}
                      <span>Joined {relativeDate(user.createdAt)}</span>
                    </div>
                  </div>
                </div>

                <div
                  className="flex items-center gap-2 mt-4 pt-4"
                  style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}
                >
                  <button
                    onClick={() => void handleToggleAdmin()}
                    disabled={togglingAdmin}
                    className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg transition-all font-medium"
                    style={user.isAdmin
                      ? { color: '#ff453a', border: '1px solid rgba(255,69,58,0.25)', background: 'transparent' }
                      : { color: '#818cf8', border: '1px solid rgba(99,102,241,0.25)', background: 'transparent' }
                    }
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = user.isAdmin ? 'rgba(255,69,58,0.08)' : 'rgba(99,102,241,0.1)'; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                  >
                    {togglingAdmin ? <Loader2 size={12} className="animate-spin" /> : user.isAdmin ? <ShieldOff size={12} /> : <Shield size={12} />}
                    {user.isAdmin ? 'Revoke admin' : 'Grant admin'}
                  </button>
                </div>
              </div>

              {/* Classes */}
              <section>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: '#4a4a5e' }}>
                    Classes ({user.classes.length})
                  </h3>
                </div>
                {user.classes.length === 0 ? (
                  <div
                    className="rounded-xl p-4 text-center text-sm"
                    style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', color: '#4a4a5e' }}
                  >
                    Not in any class
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {user.classes.map((cls) => (
                      <ClassRow key={cls.classId} cls={cls} stableUid={user.stableUid} onRemoved={handleClassRemoved} />
                    ))}
                  </div>
                )}
              </section>

              {/* Todos */}
              <section>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: '#4a4a5e' }}>
                    Todos — {pendingTodos.length} pending, {doneTodos.length} done
                  </h3>
                  {!showCreateTodo && (
                    <button
                      onClick={() => setShowCreateTodo(true)}
                      className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg transition-all font-medium"
                      style={{ color: '#818cf8', border: '1px solid rgba(99,102,241,0.25)', background: 'transparent' }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(99,102,241,0.1)'; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                    >
                      <Plus size={11} /> Add
                    </button>
                  )}
                </div>

                {showCreateTodo && (
                  <div className="mb-2">
                    <CreateTodoForm
                      stableUid={user.stableUid}
                      onCreated={handleTodoCreated}
                      onCancel={() => setShowCreateTodo(false)}
                    />
                  </div>
                )}

                {user.todos.length === 0 && !showCreateTodo ? (
                  <div
                    className="rounded-xl p-4 text-center text-sm"
                    style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', color: '#4a4a5e' }}
                  >
                    No todos
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {pendingTodos.map((t) => (
                      <TodoRow key={t.id} todo={t} stableUid={user.stableUid} onUpdated={handleTodoUpdated} onDeleted={handleTodoDeleted} />
                    ))}
                    {doneTodos.length > 0 && pendingTodos.length > 0 && (
                      <div className="flex items-center gap-3 my-1">
                        <div className="flex-1 h-px" style={{ background: 'rgba(255,255,255,0.05)' }} />
                        <span className="text-xs" style={{ color: '#4a4a5e' }}>Done</span>
                        <div className="flex-1 h-px" style={{ background: 'rgba(255,255,255,0.05)' }} />
                      </div>
                    )}
                    {doneTodos.map((t) => (
                      <TodoRow key={t.id} todo={t} stableUid={user.stableUid} onUpdated={handleTodoUpdated} onDeleted={handleTodoDeleted} />
                    ))}
                  </div>
                )}
              </section>

              {/* Danger zone */}
              <section
                className="rounded-xl p-4"
                style={{ background: 'rgba(255,69,58,0.05)', border: '1px solid rgba(255,69,58,0.15)' }}
              >
                <h3 className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: '#ff453a' }}>
                  Danger Zone
                </h3>
                {!confirmDelete ? (
                  <button
                    onClick={() => setConfirmDelete(true)}
                    className="flex items-center gap-2 text-sm px-3 py-2 rounded-lg transition-all font-medium"
                    style={{ color: '#ff453a', border: '1px solid rgba(255,69,58,0.3)', background: 'transparent' }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,69,58,0.08)'; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                  >
                    <Trash2 size={14} />
                    Delete user account
                  </button>
                ) : (
                  <div className="flex flex-col gap-2">
                    <p className="text-xs" style={{ color: '#ff453a' }}>
                      This will permanently delete <strong>{user.username}</strong> and all their data (todos, sessions, class memberships). This cannot be undone.
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => void handleDeleteUser()}
                        disabled={deletingUser}
                        className="flex items-center gap-2 text-sm px-3 py-2 rounded-lg font-medium"
                        style={{ background: '#ff453a', color: '#fff', border: 'none', cursor: deletingUser ? 'not-allowed' : 'pointer', opacity: deletingUser ? 0.6 : 1 }}
                      >
                        {deletingUser ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                        Confirm delete
                      </button>
                      <button
                        onClick={() => setConfirmDelete(false)}
                        className="text-sm px-3 py-2 rounded-lg"
                        style={{ color: '#8b8b9b', border: '1px solid rgba(255,255,255,0.08)', background: 'transparent' }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </>
  );
}
