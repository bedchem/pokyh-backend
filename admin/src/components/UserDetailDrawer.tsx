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

const AVATAR_COLORS = ['#0a84ff', '#bf5af2', '#40c8e0', '#30d158', '#ff9f0a', '#ff453a'];

function avatarColor(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h);
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length]!;
}

function relativeDate(d: string) {
  const diff = Date.now() - new Date(d).getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'Heute';
  if (days === 1) return 'Gestern';
  if (days < 30) return `vor ${days}T`;
  return `vor ${Math.floor(days / 30)}M`;
}

function fmtDate(d: string | null) {
  if (!d) return null;
  return new Date(d).toLocaleDateString('de-AT', { month: 'short', day: 'numeric', year: 'numeric' });
}

function toDatetimeLocal(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

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

  useEffect(() => { if (editing) titleInputRef.current?.focus(); }, [editing]);

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
      showToast(e instanceof Error ? e.message : 'Fehler', 'error');
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
    if (Object.keys(updateData).length === 0) { setEditing(false); setSaving(false); return; }
    try {
      const updated = await adminApi.updateTodo(stableUid, todo.id, updateData);
      onUpdated(updated);
      setEditing(false);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Fehler', 'error');
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
      showToast(e instanceof Error ? e.message : 'Fehler', 'error');
      setDeleting(false);
    }
  }

  const isOverdue = todo.dueAt && !todo.done && new Date(todo.dueAt) < new Date();

  return (
    <div
      className="rounded-[12px] transition-all"
      style={{
        background: todo.done ? 'rgba(255,255,255,0.02)' : '#2c2c2e',
        border: `1px solid ${editing ? 'rgba(10,132,255,0.3)' : isOverdue ? 'rgba(255,69,58,0.22)' : 'rgba(255,255,255,0.07)'}`,
      }}
    >
      <div className="flex items-start gap-3 p-3">
        <button
          onClick={() => void toggleDone()}
          disabled={saving || editing}
          className="mt-0.5 flex-shrink-0 transition-opacity"
          style={{ color: todo.done ? '#30d158' : 'rgba(235,235,245,0.28)', opacity: (saving && !editing) ? 0.5 : 1 }}
        >
          {(saving && !editing)
            ? <Loader2 size={16} className="animate-spin" />
            : todo.done ? <CheckSquare size={16} /> : <Square size={16} />
          }
        </button>

        <div className="flex-1 min-w-0">
          {editing ? (
            <div className="flex flex-col gap-2">
              <input
                ref={titleInputRef}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') resetEdit(); }}
                className="text-[14px] bg-transparent outline-none border-b w-full text-white"
                style={{ borderColor: 'rgba(10,132,255,0.5)', paddingBottom: '4px' }}
                placeholder="Titel"
              />
              <textarea
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                rows={3}
                className="text-[12px] outline-none resize-none rounded-[8px] p-2 w-full"
                style={{
                  color: 'rgba(235,235,245,0.55)',
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid rgba(255,255,255,0.07)',
                }}
                placeholder="Details (optional)"
              />
              <div className="flex items-center gap-2">
                <Clock size={11} style={{ color: 'rgba(235,235,245,0.3)' }} />
                <input
                  type="datetime-local"
                  value={dueAtLocal}
                  onChange={(e) => setDueAtLocal(e.target.value)}
                  className="text-[11px] bg-transparent outline-none flex-1"
                  style={{ color: 'rgba(235,235,245,0.5)', colorScheme: 'dark' }}
                />
                {dueAtLocal && (
                  <button onClick={() => setDueAtLocal('')} style={{ color: 'rgba(235,235,245,0.3)' }}>
                    <X size={11} />
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={() => void saveEdit()}
                  disabled={saving || !title.trim()}
                  className="flex items-center gap-1 text-[12px] px-2.5 py-1.5 rounded-[8px] font-medium apple-btn disabled:opacity-50"
                >
                  {saving ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
                  Speichern
                </button>
                <button
                  onClick={resetEdit}
                  className="text-[12px] px-2.5 py-1.5 rounded-[8px] apple-btn-ghost"
                >
                  Abbrechen
                </button>
              </div>
            </div>
          ) : (
            <>
              <span
                className="text-[14px] leading-snug"
                style={{
                  color: todo.done ? 'rgba(235,235,245,0.28)' : '#ffffff',
                  textDecoration: todo.done ? 'line-through' : 'none',
                }}
              >
                {todo.title}
              </span>
              <div className="flex items-center gap-3 mt-1 flex-wrap">
                {todo.dueAt && (
                  <span className="text-[11px] flex items-center gap-1" style={{ color: isOverdue ? '#ff453a' : 'rgba(235,235,245,0.3)' }}>
                    {isOverdue && <AlertTriangle size={10} />}
                    <Clock size={10} />
                    {fmtDate(todo.dueAt)}
                  </span>
                )}
                <span className="text-[11px]" style={{ color: 'rgba(235,235,245,0.3)' }}>
                  {relativeDate(todo.createdAt)}
                </span>
              </div>
              {todo.details && (
                <button
                  onClick={() => setExpanded(!expanded)}
                  className="flex items-center gap-1 text-[12px] mt-1 transition-opacity hover:opacity-75"
                  style={{ color: '#0a84ff' }}
                >
                  {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                  {expanded ? 'Weniger' : 'Details'}
                </button>
              )}
              {expanded && todo.details && (
                <p className="text-[12px] mt-2 whitespace-pre-wrap leading-relaxed" style={{ color: 'rgba(235,235,245,0.5)' }}>
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
              className="p-1 rounded-[6px] transition-colors"
              style={{ color: 'rgba(235,235,245,0.28)' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#0a84ff'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'rgba(235,235,245,0.28)'; }}
              title="Bearbeiten"
            >
              <Edit3 size={13} />
            </button>
            <button
              onClick={() => void handleDelete()}
              disabled={deleting}
              className="p-1 rounded-[6px] transition-colors"
              style={{ color: 'rgba(235,235,245,0.28)', opacity: deleting ? 0.5 : 1 }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff453a'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'rgba(235,235,245,0.28)'; }}
              title="Löschen"
            >
              {deleting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

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
      setTitle(''); setDetails(''); setDueAtLocal('');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Fehler', 'error');
    } finally {
      setCreating(false);
    }
  }

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="rounded-[12px] p-3 flex flex-col gap-2"
      style={{ background: '#2c2c2e', border: '1px solid rgba(10,132,255,0.25)' }}
    >
      <input
        ref={inputRef}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Todo-Titel *"
        className="text-[14px] bg-transparent outline-none border-b w-full text-white"
        style={{ borderColor: 'rgba(10,132,255,0.4)', paddingBottom: '4px' }}
      />
      <textarea
        value={details}
        onChange={(e) => setDetails(e.target.value)}
        rows={2}
        className="text-[12px] outline-none resize-none rounded-[8px] p-2 w-full"
        style={{ color: 'rgba(235,235,245,0.55)', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}
        placeholder="Details (optional)"
      />
      <div className="flex items-center gap-2">
        <Clock size={11} style={{ color: 'rgba(235,235,245,0.3)' }} />
        <input
          type="datetime-local"
          value={dueAtLocal}
          onChange={(e) => setDueAtLocal(e.target.value)}
          className="text-[11px] bg-transparent outline-none flex-1"
          style={{ color: 'rgba(235,235,245,0.5)', colorScheme: 'dark' }}
        />
        {dueAtLocal && (
          <button type="button" onClick={() => setDueAtLocal('')} style={{ color: 'rgba(235,235,245,0.3)' }}>
            <X size={11} />
          </button>
        )}
      </div>
      <div className="flex items-center gap-2 pt-1">
        <button
          type="submit"
          disabled={creating || !title.trim()}
          className="apple-btn flex items-center gap-1.5 text-[12px] px-2.5 py-1.5 disabled:opacity-50"
        >
          {creating ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
          Hinzufügen
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="apple-btn-ghost text-[12px] px-2.5 py-1.5"
        >
          Abbrechen
        </button>
      </div>
    </form>
  );
}

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
      showToast(e instanceof Error ? e.message : 'Fehler', 'error');
      setRemoving(false);
    }
  }

  return (
    <div
      className="flex items-center gap-3 p-3 rounded-[12px]"
      style={{ background: '#2c2c2e', border: '1px solid rgba(255,255,255,0.06)' }}
    >
      <div
        className="w-8 h-8 rounded-[10px] flex items-center justify-center flex-shrink-0"
        style={{ background: 'rgba(64,200,224,0.12)', color: '#40c8e0' }}
      >
        <Building2 size={14} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[14px] font-medium truncate text-white">{cls.className}</div>
        <div className="text-[11px] font-mono mt-0.5" style={{ color: '#40c8e0' }}>{cls.classCode}</div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <span className="text-[11px]" style={{ color: 'rgba(235,235,245,0.3)' }}>{relativeDate(cls.joinedAt)}</span>
        <button
          onClick={() => void handleRemove()}
          disabled={removing}
          className="flex items-center gap-1 text-[12px] px-2.5 py-1.5 rounded-[8px] transition-all font-medium"
          style={{ color: '#ff453a', border: '1px solid rgba(255,69,58,0.22)', background: 'transparent' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,69,58,0.08)'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
        >
          {removing ? <Loader2 size={11} className="animate-spin" /> : <LogOut size={11} />}
          Entfernen
        </button>
      </div>
    </div>
  );
}

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
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < 640);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 639px)');
    setIsMobile(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    setLoading(true);
    adminApi.userDetail(stableUid)
      .then(setUser)
      .catch((e) => showToast(e instanceof Error ? e.message : 'Laden fehlgeschlagen', 'error'))
      .finally(() => setLoading(false));
  }, [stableUid, showToast]);

  function handleTodoCreated(todo: AdminTodo) { setUser((prev) => prev ? { ...prev, todos: [todo, ...prev.todos] } : prev); setShowCreateTodo(false); }
  function handleTodoUpdated(updated: AdminTodo) { setUser((prev) => prev ? { ...prev, todos: prev.todos.map((t) => t.id === updated.id ? updated : t) } : prev); }
  function handleTodoDeleted(id: string) { setUser((prev) => prev ? { ...prev, todos: prev.todos.filter((t) => t.id !== id) } : prev); }
  function handleClassRemoved(classId: string) { setUser((prev) => prev ? { ...prev, classes: prev.classes.filter((c) => c.classId !== classId) } : prev); }

  async function handleToggleAdmin() {
    if (!user) return;
    setTogglingAdmin(true);
    try {
      if (user.isAdmin) {
        await adminApi.revokeAdmin(user.stableUid);
        showToast(`Admin von ${user.username} entzogen`, 'success');
      } else {
        await adminApi.grantAdmin(user.stableUid);
        showToast(`Admin an ${user.username} vergeben`, 'success');
      }
      const newIsAdmin = !user.isAdmin;
      setUser((prev) => prev ? { ...prev, isAdmin: newIsAdmin } : prev);
      onAdminToggled(user.stableUid, newIsAdmin);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Fehler', 'error');
    } finally {
      setTogglingAdmin(false);
    }
  }

  async function handleDeleteUser() {
    if (!user) return;
    setDeletingUser(true);
    try {
      await adminApi.deleteUser(user.stableUid);
      showToast(`${user.username} gelöscht`, 'success');
      onUserDeleted(user.stableUid);
      onClose();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Fehler', 'error');
      setDeletingUser(false);
    }
  }

  const doneTodos    = user?.todos.filter((t) => t.done)  ?? [];
  const pendingTodos = user?.todos.filter((t) => !t.done) ?? [];

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40"
        style={{
          background: 'rgba(0,0,0,0.7)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          transition: 'opacity 0.25s ease',
          opacity: mounted ? 1 : 0,
        }}
        onClick={onClose}
      />

      {/* Drawer */}
      <div
        className="fixed z-50 flex flex-col overflow-hidden"
        style={isMobile ? {
          bottom: 0, left: 0, right: 0,
          height: '88vh',
          background: '#1c1c1e',
          borderTop: '1px solid rgba(255,255,255,0.1)',
          borderRadius: '20px 20px 0 0',
          boxShadow: '0 -32px 80px rgba(0,0,0,0.7)',
          transform: mounted ? 'translateY(0)' : 'translateY(100%)',
          transition: 'transform 0.35s cubic-bezier(0.4,0,0.2,1)',
        } : {
          right: 0, top: 0,
          height: '100%',
          width: '480px',
          maxWidth: '100vw',
          background: '#1c1c1e',
          borderLeft: '1px solid rgba(255,255,255,0.08)',
          boxShadow: '-32px 0 80px rgba(0,0,0,0.65)',
          transform: mounted ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 0.32s cubic-bezier(0.4,0,0.2,1)',
        }}
      >
        {/* Mobile handle */}
        {isMobile && (
          <div className="flex justify-center pt-3 pb-1 flex-shrink-0">
            <div className="w-9 h-1 rounded-full" style={{ background: 'rgba(255,255,255,0.15)' }} />
          </div>
        )}

        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-4 flex-shrink-0"
          style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}
        >
          <span className="text-[14px] font-semibold text-white" style={{ letterSpacing: '-0.01em' }}>
            Benutzerdetails
          </span>
          <button
            onClick={onClose}
            className="p-2 rounded-[10px] transition-colors"
            style={{ color: 'rgba(235,235,245,0.4)', background: 'rgba(255,255,255,0.05)' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#fff'; (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.09)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'rgba(235,235,245,0.4)'; (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.05)'; }}
          >
            <X size={15} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto scroll-touch scrollbar-thin p-5 flex flex-col gap-5">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 size={22} className="animate-spin" style={{ color: 'rgba(235,235,245,0.3)' }} />
            </div>
          ) : !user ? (
            <div className="text-center py-16 text-[14px]" style={{ color: 'rgba(235,235,245,0.3)' }}>
              Benutzer nicht gefunden
            </div>
          ) : (
            <>
              {/* User card */}
              <div
                className="rounded-[16px] p-5"
                style={{ background: '#2c2c2e', border: '1px solid rgba(255,255,255,0.07)' }}
              >
                <div className="flex items-center gap-4">
                  <div
                    className="w-14 h-14 rounded-[16px] flex items-center justify-center text-[20px] font-bold text-white flex-shrink-0"
                    style={{ background: avatarColor(user.username) }}
                  >
                    {user.username[0]?.toUpperCase() ?? '?'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[18px] font-bold text-white truncate" style={{ letterSpacing: '-0.02em' }}>
                        {user.username}
                      </span>
                      {user.isAdmin && (
                        <span className="badge-blue text-[11px] px-2 py-0.5 font-medium">Admin</span>
                      )}
                    </div>
                    <div className="text-[11px] font-mono mt-1" style={{ color: 'rgba(235,235,245,0.28)' }}>
                      {user.stableUid}
                    </div>
                    <div className="flex items-center gap-3 mt-1.5 text-[12px] flex-wrap" style={{ color: 'rgba(235,235,245,0.4)' }}>
                      {user.webuntisKlasseName && <span>{user.webuntisKlasseName}</span>}
                      <span>Beigetreten {relativeDate(user.createdAt)}</span>
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
                    className="flex items-center gap-1.5 text-[12px] px-3 py-2 rounded-[10px] transition-all font-medium"
                    style={user.isAdmin
                      ? { color: '#ff453a', border: '1px solid rgba(255,69,58,0.25)', background: 'transparent' }
                      : { color: '#0a84ff', border: '1px solid rgba(10,132,255,0.25)', background: 'transparent' }
                    }
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = user.isAdmin ? 'rgba(255,69,58,0.08)' : 'rgba(10,132,255,0.1)'; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                  >
                    {togglingAdmin ? <Loader2 size={12} className="animate-spin" /> : user.isAdmin ? <ShieldOff size={12} /> : <Shield size={12} />}
                    {user.isAdmin ? 'Admin entziehen' : 'Admin vergeben'}
                  </button>
                </div>
              </div>

              {/* Classes */}
              <section>
                <div className="flex items-center justify-between mb-3">
                  <h3
                    className="text-[11px] font-semibold uppercase tracking-[0.05em]"
                    style={{ color: 'rgba(235,235,245,0.3)' }}
                  >
                    Klassen ({user.classes.length})
                  </h3>
                </div>
                {user.classes.length === 0 ? (
                  <div
                    className="rounded-[12px] p-4 text-center text-[13px]"
                    style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', color: 'rgba(235,235,245,0.3)' }}
                  >
                    In keiner Klasse
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
                  <h3
                    className="text-[11px] font-semibold uppercase tracking-[0.05em]"
                    style={{ color: 'rgba(235,235,245,0.3)' }}
                  >
                    Todos &mdash; {pendingTodos.length} offen, {doneTodos.length} erledigt
                  </h3>
                  {!showCreateTodo && (
                    <button
                      onClick={() => setShowCreateTodo(true)}
                      className="flex items-center gap-1 text-[12px] px-2 py-1 rounded-[8px] transition-all font-medium"
                      style={{ color: '#0a84ff', border: '1px solid rgba(10,132,255,0.25)', background: 'transparent' }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(10,132,255,0.1)'; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                    >
                      <Plus size={11} /> Hinzufügen
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
                    className="rounded-[12px] p-4 text-center text-[13px]"
                    style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', color: 'rgba(235,235,245,0.3)' }}
                  >
                    Keine Todos
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {pendingTodos.map((t) => (
                      <TodoRow key={t.id} todo={t} stableUid={user.stableUid} onUpdated={handleTodoUpdated} onDeleted={handleTodoDeleted} />
                    ))}
                    {doneTodos.length > 0 && pendingTodos.length > 0 && (
                      <div className="flex items-center gap-3 my-1">
                        <div className="flex-1 h-px" style={{ background: 'rgba(255,255,255,0.05)' }} />
                        <span className="text-[11px]" style={{ color: 'rgba(235,235,245,0.3)' }}>Erledigt</span>
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
                className="rounded-[14px] p-4"
                style={{ background: 'rgba(255,69,58,0.05)', border: '1px solid rgba(255,69,58,0.15)' }}
              >
                <h3
                  className="text-[11px] font-semibold uppercase tracking-[0.05em] mb-3"
                  style={{ color: '#ff453a' }}
                >
                  Gefahrenzone
                </h3>
                {!confirmDelete ? (
                  <button
                    onClick={() => setConfirmDelete(true)}
                    className="flex items-center gap-2 text-[13px] px-3 py-2 rounded-[10px] transition-all font-medium"
                    style={{ color: '#ff453a', border: '1px solid rgba(255,69,58,0.3)', background: 'transparent' }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,69,58,0.08)'; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                  >
                    <Trash2 size={13} />
                    Benutzerkonto löschen
                  </button>
                ) : (
                  <div className="flex flex-col gap-2">
                    <p className="text-[12px] leading-relaxed" style={{ color: '#ff453a' }}>
                      <strong>{user.username}</strong> und alle zugehörigen Daten werden dauerhaft gelöscht. Diese Aktion kann nicht rückgängig gemacht werden.
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => void handleDeleteUser()}
                        disabled={deletingUser}
                        className="flex items-center gap-2 text-[13px] px-3 py-2 rounded-[10px] font-medium transition-all"
                        style={{ background: '#ff453a', color: '#fff', opacity: deletingUser ? 0.6 : 1 }}
                      >
                        {deletingUser ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                        Bestätigen
                      </button>
                      <button
                        onClick={() => setConfirmDelete(false)}
                        className="apple-btn-ghost text-[13px] px-3 py-2"
                      >
                        Abbrechen
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
