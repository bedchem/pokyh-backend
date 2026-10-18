import { useEffect, useMemo, useState, useRef } from 'react';
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
  Key,
} from 'lucide-react';
import { adminApi } from '../api';
import { useToast } from './Toast';
import { AdminCountdown, clockOffset } from './AdminCountdown';
import { GrantAdminDialog, OneTimePasswordDialog } from './GrantAdminDialog';
import { AppointAdminDialog } from './AppointAdminDialog';
import { PasswordInput } from './PasswordInput';
import { roleLabel } from '../roles';
import { useAccess } from '../access';
import { FactorList, LastLogin, PasskeySwitch, SecondFactorBadge } from './LoginSecurity';
import type { AdminUserDetail, AdminTodo, AdminUserClass } from '../types';

const AVATAR_COLORS = ['#2a78cc', '#8a3fc4', '#0f7f96', '#16845f', '#b3610d', '#d93a40'];

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
      className="rounded-[14px] transition-all"
      style={{
        background: todo.done ? 'rgb(var(--ink-rgb) / calc(0.016 * var(--veil)))' : 'var(--well-2)',
        border: `1px solid ${editing ? 'rgba(60,135,215,0.3)' : isOverdue ? 'rgba(225,70,75,0.22)' : 'rgb(var(--ink-rgb) / calc(0.087 * var(--veil)))'}`,
      }}
    >
      <div className="flex items-start gap-3 p-3">
        <button
          onClick={() => void toggleDone()}
          disabled={saving || editing}
          className="mt-0.5 flex-shrink-0 transition-opacity"
          style={{ color: todo.done ? 'var(--mint-deep)' : 'rgb(var(--ink-rgb) / 0.484)', opacity: (saving && !editing) ? 0.5 : 1 }}
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
                className="field h-11 px-4 text-[14px] w-full"
                style={{ borderColor: 'rgba(60,135,215,0.5)', paddingBottom: '4px' }}
                placeholder="Titel"
              />
              <textarea
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                rows={3}
                className="field px-4 py-3 text-[14px] resize-none w-full"
                placeholder="Details (optional)"
              />
              <div className="flex items-center gap-2">
                <Clock size={11} style={{ color: 'rgb(var(--ink-rgb) / 0.5)' }} />
                <input
                  type="datetime-local"
                  value={dueAtLocal}
                  onChange={(e) => setDueAtLocal(e.target.value)}
                  className="field h-11 px-4 text-[14px] flex-1"
                  style={{ color: 'rgb(var(--ink-rgb) / 0.66)' }}
                />
                {dueAtLocal && (
                  <button onClick={() => setDueAtLocal('')} style={{ color: 'rgb(var(--ink-rgb) / 0.5)' }}>
                    <X size={11} />
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={() => void saveEdit()}
                  disabled={saving || !title.trim()}
                  className="btn btn-sm btn-primary"
                >
                  {saving ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
                  Speichern
                </button>
                <button
                  onClick={resetEdit}
                  className="btn btn-sm btn-quiet"
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
                  color: todo.done ? 'rgb(var(--ink-rgb) / 0.484)' : 'var(--ink)',
                  textDecoration: todo.done ? 'line-through' : 'none',
                }}
              >
                {todo.title}
              </span>
              <div className="flex items-center gap-3 mt-1 flex-wrap">
                {todo.dueAt && (
                  <span className="text-[11px] flex items-center gap-1" style={{ color: isOverdue ? 'var(--rose-deep)' : 'rgb(var(--ink-rgb) / 0.5)' }}>
                    {isOverdue && <AlertTriangle size={10} />}
                    <Clock size={10} />
                    {fmtDate(todo.dueAt)}
                  </span>
                )}
                <span className="text-[11px]" style={{ color: 'rgb(var(--ink-rgb) / 0.5)' }}>
                  {relativeDate(todo.createdAt)}
                </span>
              </div>
              {todo.details && (
                <button
                  onClick={() => setExpanded(!expanded)}
                  className="flex items-center gap-1 text-[12px] mt-1 transition-opacity hover:opacity-75"
                  style={{ color: 'var(--sky-deep)' }}
                >
                  {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                  {expanded ? 'Weniger' : 'Details'}
                </button>
              )}
              {expanded && todo.details && (
                <p className="text-[12px] mt-2 whitespace-pre-wrap leading-relaxed" style={{ color: 'rgb(var(--ink-rgb) / 0.66)' }}>
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
              className="p-1 rounded-full transition-colors"
              style={{ color: 'rgb(var(--ink-rgb) / 0.484)' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--sky-deep)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'rgb(var(--ink-rgb) / 0.484)'; }}
              title="Bearbeiten"
            >
              <Edit3 size={13} />
            </button>
            <button
              onClick={() => void handleDelete()}
              disabled={deleting}
              className="p-1 rounded-full transition-colors"
              style={{ color: 'rgb(var(--ink-rgb) / 0.484)', opacity: deleting ? 0.5 : 1 }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--rose-deep)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'rgb(var(--ink-rgb) / 0.484)'; }}
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
      className="rounded-[14px] p-3 flex flex-col gap-2"
      style={{ background: 'var(--well-2)', border: '1px solid transparent' }}
    >
      <input
        ref={inputRef}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Todo-Titel *"
        className="field h-11 px-4 text-[14px] w-full"
        style={{ borderColor: 'rgba(60,135,215,0.4)', paddingBottom: '4px' }}
      />
      <textarea
        value={details}
        onChange={(e) => setDetails(e.target.value)}
        rows={2}
        className="field px-4 py-3 text-[14px] resize-none w-full"
        placeholder="Details (optional)"
      />
      <div className="flex items-center gap-2">
        <Clock size={11} style={{ color: 'rgb(var(--ink-rgb) / 0.5)' }} />
        <input
          type="datetime-local"
          value={dueAtLocal}
          onChange={(e) => setDueAtLocal(e.target.value)}
          className="field h-11 px-4 text-[14px] flex-1"
          style={{ color: 'rgb(var(--ink-rgb) / 0.66)' }}
        />
        {dueAtLocal && (
          <button type="button" onClick={() => setDueAtLocal('')} style={{ color: 'rgb(var(--ink-rgb) / 0.5)' }}>
            <X size={11} />
          </button>
        )}
      </div>
      <div className="flex items-center gap-2 pt-1">
        <button
          type="submit"
          disabled={creating || !title.trim()}
          className="btn btn-sm btn-primary"
        >
          {creating ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
          Hinzufügen
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="btn btn-sm btn-quiet"
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
      className="flex items-center gap-3 p-3 rounded-[14px]"
      style={{ background: 'var(--well-2)', border: '1px solid transparent' }}
    >
      <div
        className="w-8 h-8 rounded-[12px] flex items-center justify-center flex-shrink-0"
        style={{ background: 'rgba(20,150,175,0.12)', color: 'var(--teal-deep)' }}
      >
        <Building2 size={14} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[14px] font-medium truncate text-ink">{cls.className}</div>
        <div className="text-[11px] font-mono mt-0.5" style={{ color: 'var(--teal-deep)' }}>{cls.classCode}</div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <span className="text-[11px]" style={{ color: 'rgb(var(--ink-rgb) / 0.5)' }}>{relativeDate(cls.joinedAt)}</span>
        <button
          onClick={() => void handleRemove()}
          disabled={removing}
          className="flex items-center gap-1 text-[12px] px-2.5 py-1.5 rounded-full transition-all font-medium"
          style={{ color: 'var(--rose-deep)', border: '1px solid rgba(225,70,75,0.22)', background: 'transparent' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(225,70,75,0.08)'; }}
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
  onAdminToggled: (stableUid: string, isAdmin: boolean, adminSetupExpiresAt: string | null) => void;
}

export function UserDetailDrawer({ stableUid, onClose, onUserDeleted, onAdminToggled }: UserDetailDrawerProps) {
  const { showToast } = useToast();
  const { me, can } = useAccess();
  const [user, setUser] = useState<AdminUserDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [deletingUser, setDeletingUser] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [togglingAdmin, setTogglingAdmin] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [showCreateTodo, setShowCreateTodo] = useState(false);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [settingPassword, setSettingPassword] = useState(false);
  const [showGrantDialog, setShowGrantDialog] = useState(false);
  const [showAppoint, setShowAppoint] = useState(false);
  const [showOtp, setShowOtp] = useState(false);
  // Server clock minus local clock, measured when the details arrived.
  const offset = useMemo(() => clockOffset(user?.serverTime), [user?.serverTime]);
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

  // After the passkey requirement changed: the admin's login security again.
  function reloadSecurity() {
    adminApi.userDetail(stableUid)
      .then((fresh) => setUser((prev) => prev ? { ...prev, adminSecurity: fresh.adminSecurity } : fresh))
      .catch(() => { /* the toast of the change already told */ });
  }

  function handleTodoCreated(todo: AdminTodo) { setUser((prev) => prev ? { ...prev, todos: [todo, ...prev.todos] } : prev); setShowCreateTodo(false); }
  function handleTodoUpdated(updated: AdminTodo) { setUser((prev) => prev ? { ...prev, todos: prev.todos.map((t) => t.id === updated.id ? updated : t) } : prev); }
  function handleTodoDeleted(id: string) { setUser((prev) => prev ? { ...prev, todos: prev.todos.filter((t) => t.id !== id) } : prev); }
  function handleClassRemoved(classId: string) { setUser((prev) => prev ? { ...prev, classes: prev.classes.filter((c) => c.classId !== classId) } : prev); }

  // The popup stays open on the password; the drawer shows the countdown.
  function handleGranted(adminSetupExpiresAt: string | null) {
    if (!user) return;
    setUser((prev) => prev ? { ...prev, isAdmin: true, adminSetupExpiresAt, adminCanSignIn: adminSetupExpiresAt === null, canViewOneTimePassword: adminSetupExpiresAt !== null } : prev);
    onAdminToggled(user.stableUid, true, adminSetupExpiresAt);
  }

  // The countdown ran out: the server has removed the grant by now.
  function handleGrantLapsed() {
    setTimeout(() => {
      adminApi.userDetail(stableUid).then((fresh) => {
        setUser(fresh);
        if (!fresh.isAdmin) onAdminToggled(stableUid, false, null);
      }).catch(() => {});
    }, 1500);
  }

  async function handleToggleAdmin() {
    if (!user) return;
    // Becoming an admin starts with choosing the rights (and, for a WebUntis
    // account, a one-time password) — never all rights at once.
    if (!user.isAdmin) {
      setShowAppoint(true);
      return;
    }
    setTogglingAdmin(true);
    try {
      if (user.isAdmin) {
        await adminApi.revokeAdmin(user.stableUid);
        showToast(`Admin von ${user.username} entzogen`, 'success');
        // The drawer stays open: "Admin vergeben" is right there again, and
        // with it a new one-time password if one was lost.
        setUser((prev) => prev ? { ...prev, isAdmin: false, adminSetupExpiresAt: null, canViewOneTimePassword: false, adminCanSignIn: false } : prev);
        setShowOtp(false);
        onAdminToggled(user.stableUid, false, null);
      } else {
        const result = await adminApi.grantAdmin(user.stableUid);
        showToast(`Admin an ${user.username} vergeben`, 'success');
        setUser((prev) => prev ? { ...prev, isAdmin: true, adminSetupExpiresAt: result.adminSetupExpiresAt, adminCanSignIn: true } : prev);
        onAdminToggled(user.stableUid, true, result.adminSetupExpiresAt);
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Fehler', 'error');
    } finally {
      setTogglingAdmin(false);
    }
  }

  async function handleSetPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    if (newPassword.length < 8) {
      showToast('Passwort muss mindestens 8 Zeichen lang sein', 'error');
      return;
    }
    setSettingPassword(true);
    try {
      await adminApi.setUserPassword(user.stableUid, newPassword);
      showToast(`Passwort für ${user.username} gesetzt`, 'success');
      setUser((prev) => prev ? { ...prev, hasPassword: true } : prev);
      setShowPasswordModal(false);
      setNewPassword('');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Fehler', 'error');
    } finally {
      setSettingPassword(false);
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
      {showAppoint && user && (
        <AppointAdminDialog
          stableUid={user.stableUid}
          username={user.username}
          schoolId={user.schoolId ?? null}
          needsOneTimePassword={user.needsOneTimePassword}
          onClose={() => setShowAppoint(false)}
          onDone={handleGranted}
        />
      )}

      {showGrantDialog && user && (
        <GrantAdminDialog
          stableUid={user.stableUid}
          username={user.username}
          onClose={() => setShowGrantDialog(false)}
          onGranted={handleGranted}
          onLapsed={handleGrantLapsed}
        />
      )}

      {showOtp && user && (
        <OneTimePasswordDialog
          stableUid={user.stableUid}
          username={user.username}
          onClose={() => setShowOtp(false)}
          onLapsed={handleGrantLapsed}
        />
      )}

      {/* Password modal */}
      {showPasswordModal && user && (
        <div
          className="fixed inset-0 z-[60] flex items-start justify-center p-4 pt-20 overflow-y-auto"
          style={{ background: 'var(--scrim)' }}
          onClick={() => { if (!settingPassword) { setShowPasswordModal(false); setNewPassword(''); } }}
        >
          <div
            className="w-full max-w-md rounded-[26px] p-6 flex flex-col gap-5 animate-scaleIn"
            style={{ background: 'var(--raise)', border: '1px solid transparent', boxShadow: '0 44px 70px -40px rgb(0 0 0 / 0.4)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-[18px] font-bold text-ink" style={{ letterSpacing: '-0.02em' }}>
                  Passwort setzen
                </h2>
                <p className="text-[13px] mt-0.5" style={{ color: 'rgb(var(--ink-rgb) / 0.58)' }}>
                  Für {user.username}
                </p>
              </div>
              <button
                onClick={() => { setShowPasswordModal(false); setNewPassword(''); }}
                style={{ color: 'rgb(var(--ink-rgb) / 0.54)' }}
                className="p-1.5 rounded-full transition-colors hover:bg-ink/[0.07]"
              >
                <X size={16} />
              </button>
            </div>
            <form onSubmit={(e) => void handleSetPassword(e)} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label
                  className="text-[13px]"
                  style={{ color: 'rgb(var(--ink-rgb) / 0.58)' }}
                >
                  Neues Passwort *
                </label>
                <PasswordInput
                  value={newPassword}
                  onChange={setNewPassword}
                  placeholder="Min. 8 Zeichen"
                  required
                />
              </div>
              <div className="flex gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => { setShowPasswordModal(false); setNewPassword(''); }}
                  className="btn btn-sm btn-quiet flex-1"
                >
                  Abbrechen
                </button>
                <button
                  type="submit"
                  disabled={settingPassword || newPassword.length < 8}
                  className="btn btn-sm btn-primary flex-1"
                >
                  {settingPassword
                    ? <Loader2 size={14} className="animate-spin" />
                    : <Key size={14} />
                  }
                  {settingPassword ? 'Speichere…' : 'Speichern'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40"
        style={{
          background: 'var(--scrim)',
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
          background: 'var(--raise)',
          borderTop: '1px solid rgb(var(--ink-rgb) / calc(0.12 * var(--veil)))',
          borderRadius: '20px 20px 0 0',
          boxShadow: 'none',
          transform: mounted ? 'translateY(0)' : 'translateY(100%)',
          transition: 'transform 0.35s cubic-bezier(0.4,0,0.2,1)',
        } : {
          right: 0, top: 0,
          height: '100%',
          width: '480px',
          maxWidth: '100vw',
          background: 'var(--well)',
          borderLeft: '1px solid rgb(var(--ink-rgb) / calc(0.098 * var(--veil)))',
          boxShadow: 'none',
          transform: mounted ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 0.32s cubic-bezier(0.4,0,0.2,1)',
        }}
      >
        {/* Mobile handle */}
        {isMobile && (
          <div className="flex justify-center pt-3 pb-1 flex-shrink-0">
            <div className="w-9 h-1 rounded-full" style={{ background: 'rgb(var(--ink-rgb) / calc(0.12 * var(--veil)))' }} />
          </div>
        )}

        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-4 flex-shrink-0"
          style={{ borderBottom: '1px solid rgb(var(--ink-rgb) / calc(0.087 * var(--veil)))' }}
        >
          <span className="text-[14px] font-semibold text-ink" style={{ letterSpacing: '-0.01em' }}>
            Benutzerdetails
          </span>
          <button
            onClick={onClose}
            className="p-2 rounded-full transition-colors"
            style={{ color: 'rgb(var(--ink-rgb) / 0.58)', background: 'rgb(var(--ink-rgb) / calc(0.04 * var(--veil)))' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--ink)'; (e.currentTarget as HTMLElement).style.background = 'rgb(var(--ink-rgb) / calc(0.072 * var(--veil)))'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'rgb(var(--ink-rgb) / 0.58)'; (e.currentTarget as HTMLElement).style.background = 'rgb(var(--ink-rgb) / calc(0.04 * var(--veil)))'; }}
          >
            <X size={15} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto scroll-touch scrollbar-thin p-5 flex flex-col gap-5">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 size={22} className="animate-spin" style={{ color: 'rgb(var(--ink-rgb) / 0.5)' }} />
            </div>
          ) : !user ? (
            <div className="text-center py-16 text-[14px]" style={{ color: 'rgb(var(--ink-rgb) / 0.5)' }}>
              Benutzer nicht gefunden
            </div>
          ) : (
            <>
              {/* User card */}
              <div
                className="rounded-[22px] p-5"
                style={{ background: 'var(--well-2)', border: '1px solid transparent' }}
              >
                <div className="flex items-center gap-4">
                  <div
                    className="w-14 h-14 rounded-full flex items-center justify-center text-[20px] font-semibold text-white flex-shrink-0"
                    style={{ background: avatarColor(user.username) }}
                  >
                    {user.username[0]?.toUpperCase() ?? '?'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[18px] font-bold text-ink truncate" style={{ letterSpacing: '-0.02em' }}>
                        {user.username}
                      </span>
                      {user.isAdmin && (
                        <span className="badge-blue text-[11px] px-2 py-0.5 font-medium">Admin</span>
                      )}
                      {user.isAdmin && user.adminSetupExpiresAt && (
                        <AdminCountdown expiresAt={user.adminSetupExpiresAt} offset={offset} onExpired={handleGrantLapsed} />
                      )}
                    </div>
                    <div className="text-[11px] font-mono mt-1" style={{ color: 'rgb(var(--ink-rgb) / 0.484)' }}>
                      {user.stableUid}
                    </div>
                    <div className="flex items-center gap-3 mt-1.5 text-[12px] flex-wrap" style={{ color: 'rgb(var(--ink-rgb) / 0.58)' }}>
                      {/* An admin without student/parent role shows as admin only. */}
                      {(user.role !== 'none' || !user.isAdmin) && <span>{roleLabel(user.role)}</span>}
                      {user.webuntisKlasseName && <span>{user.webuntisKlasseName}</span>}
                      <span>Beigetreten {relativeDate(user.createdAt)}</span>
                      <span>App-Anmeldung <LastLogin iso={user.lastSignInAt} never="keine in den Logs" /></span>
                    </div>
                  </div>
                </div>

                <div
                  className="flex items-center gap-2 mt-4 pt-4"
                  style={{ borderTop: '1px solid rgb(var(--ink-rgb) / calc(0.076 * var(--veil)))' }}
                >
                  <button
                    onClick={() => void handleToggleAdmin()}
                    disabled={togglingAdmin}
                    className="flex items-center gap-1.5 text-[12px] px-3 py-2 rounded-full transition-all font-medium"
                    style={user.isAdmin
                      ? { color: 'var(--rose-deep)', border: '1px solid rgba(225,70,75,0.25)', background: 'transparent' }
                      : { color: 'var(--sky-deep)', border: '1px solid rgba(60,135,215,0.25)', background: 'transparent' }
                    }
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = user.isAdmin ? 'rgba(225,70,75,0.08)' : 'rgba(60,135,215,0.1)'; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                  >
                    {togglingAdmin ? <Loader2 size={12} className="animate-spin" /> : user.isAdmin ? <ShieldOff size={12} /> : <Shield size={12} />}
                    {user.isAdmin ? 'Admin entziehen' : 'Admin vergeben'}
                  </button>
                  <button
                    onClick={() => setShowPasswordModal(true)}
                    className="flex items-center gap-1.5 text-[12px] px-3 py-2 rounded-full transition-all font-medium"
                    style={{ color: 'var(--violet-deep)', border: '1px solid rgba(150,80,205,0.25)', background: 'transparent' }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(150,80,205,0.08)'; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                  >
                    <Key size={12} />
                    Passwort setzen
                  </button>
                </div>
                {user.adminSecurity && (
                  <div className="mt-4 flex flex-col gap-2.5 rounded-2xl p-4" style={{ background: 'rgb(var(--ink-rgb) / calc(0.035 * var(--veil)))' }}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-[12.5px] font-medium text-ink-2">Admin-Panel</span>
                      <SecondFactorBadge security={user.adminSecurity} />
                    </div>
                    <FactorList security={user.adminSecurity} />
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[12.5px] text-ink-3">
                      <PasskeySwitch
                        username={user.username}
                        security={user.adminSecurity}
                        self={user.username.toLowerCase() === me?.username.toLowerCase()}
                        owner={user.isOwner === true}
                        mayManage={can('admins.manage')}
                        onChanged={reloadSecurity}
                      />
                      <span>Zuletzt im Panel: <LastLogin iso={user.adminSecurity.lastLoginAt} method={user.adminSecurity.lastLoginMethod} /></span>
                    </div>
                  </div>
                )}
                {user.isAdmin && user.adminSetupExpiresAt ? (
                  <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                    <p className="min-w-0 flex-1 text-[12px] leading-relaxed" style={{ color: 'var(--amber-deep)' }}>
                      Wartet auf den ersten Login mit dem Einmal-Passwort. Ohne Login verfällt der Admin-Zugang samt Einmal-Passwort.
                    </p>
                    {user.canViewOneTimePassword && (
                      <button type="button" onClick={() => setShowOtp(true)} className="otp-chip" title="Einmal-Passwort nochmal anzeigen">
                        <Key size={12} />
                        Passwort anzeigen
                      </button>
                    )}
                  </div>
                ) : user.isAdmin && !user.adminCanSignIn && user.needsOneTimePassword ? (
                  <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                    <p className="min-w-0 flex-1 text-[12px] leading-relaxed" style={{ color: 'var(--amber-deep)' }}>
                      {user.username} kann sich nicht im Admin-Panel anmelden: ein WebUntis-Konto braucht ein Einmal-Passwort.
                    </p>
                    <button
                      onClick={() => setShowGrantDialog(true)}
                      className="flex items-center gap-1.5 text-[12px] px-3 py-2 rounded-full transition-colors font-medium"
                      style={{ color: 'var(--amber-deep)', border: '1px solid rgba(190,110,20,0.3)', background: 'transparent' }}
                    >
                      <Key size={12} />
                      Einmal-Passwort vergeben
                    </button>
                  </div>
                ) : user.isAdmin && user.hasPassword === false && (
                  <p className="mt-3 text-[12px] leading-relaxed" style={{ color: 'var(--amber-deep)' }}>
                    Kein eigenes Passwort: {user.username} kommt nur mit dem gemeinsamen Admin-Passwort ins Panel.
                    Setze ein Passwort, damit die Anmeldung mit eigenen Zugangsdaten klappt.
                  </p>
                )}
              </div>

              {/* Classes */}
              <section>
                <div className="flex items-center justify-between mb-3">
                  <h3
                    className="text-[13px]"
                    style={{ color: 'rgb(var(--ink-rgb) / 0.5)' }}
                  >
                    Klassen ({user.classes.length})
                  </h3>
                </div>
                {user.classes.length === 0 ? (
                  <div
                    className="rounded-[14px] p-4 text-center text-[13px]"
                    style={{ background: 'rgb(var(--ink-rgb) / calc(0.016 * var(--veil)))', border: '1px solid transparent', color: 'rgb(var(--ink-rgb) / 0.5)' }}
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
                    className="text-[13px]"
                    style={{ color: 'rgb(var(--ink-rgb) / 0.5)' }}
                  >
                    Todos &mdash; {pendingTodos.length} offen, {doneTodos.length} erledigt
                  </h3>
                  {!showCreateTodo && (
                    <button
                      onClick={() => setShowCreateTodo(true)}
                      className="flex items-center gap-1 text-[12px] px-2 py-1 rounded-full transition-all font-medium"
                      style={{ color: 'var(--sky-deep)', border: '1px solid rgba(60,135,215,0.25)', background: 'transparent' }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(60,135,215,0.1)'; }}
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
                    className="rounded-[14px] p-4 text-center text-[13px]"
                    style={{ background: 'rgb(var(--ink-rgb) / calc(0.016 * var(--veil)))', border: '1px solid transparent', color: 'rgb(var(--ink-rgb) / 0.5)' }}
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
                        <div className="flex-1 h-px" style={{ background: 'rgb(var(--ink-rgb) / calc(0.04 * var(--veil)))' }} />
                        <span className="text-[11px]" style={{ color: 'rgb(var(--ink-rgb) / 0.5)' }}>Erledigt</span>
                        <div className="flex-1 h-px" style={{ background: 'rgb(var(--ink-rgb) / calc(0.04 * var(--veil)))' }} />
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
                style={{ background: 'rgba(225,70,75,0.05)', border: '1px solid transparent' }}
              >
                <h3
                  className="text-[13px] mb-3"
                  style={{ color: 'var(--rose-deep)' }}
                >
                  Gefahrenzone
                </h3>
                {!confirmDelete ? (
                  <button
                    onClick={() => setConfirmDelete(true)}
                    className="flex items-center gap-2 text-[13px] px-3 py-2 rounded-full transition-all font-medium"
                    style={{ color: 'var(--rose-deep)', border: '1px solid rgba(225,70,75,0.3)', background: 'transparent' }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(225,70,75,0.08)'; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                  >
                    <Trash2 size={13} />
                    Benutzerkonto löschen
                  </button>
                ) : (
                  <div className="flex flex-col gap-2">
                    <p className="text-[12px] leading-relaxed" style={{ color: 'var(--rose-deep)' }}>
                      <strong>{user.username}</strong> und alle zugehörigen Daten werden dauerhaft gelöscht. Diese Aktion kann nicht rückgängig gemacht werden.
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => void handleDeleteUser()}
                        disabled={deletingUser}
                        className="flex items-center gap-2 text-[13px] px-3 py-2 rounded-full font-medium transition-all"
                        style={{ background: 'var(--rose-solid)', color: '#fff', opacity: deletingUser ? 0.6 : 1 }}
                      >
                        {deletingUser ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                        Bestätigen
                      </button>
                      <button
                        onClick={() => setConfirmDelete(false)}
                        className="btn btn-sm btn-quiet"
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
