import { useEffect, useState, useCallback, useRef } from 'react';
import { useHanded } from '../useHanded';
import {
  Building2, Users, ChevronDown, ChevronRight, Plus, X,
  RefreshCw, UserMinus, UserPlus, Bell, Clock, Loader2, Trash2,
  CheckSquare, Square, Edit3, Check, AlertTriangle, ListTodo, CalendarClock,
} from 'lucide-react';
import { adminApi } from '../api';
import { useToast } from '../components/Toast';
import { useAutoRefresh } from '../hooks/useAutoRefresh';
import { useLive } from '../live';
import { Avatar, Collapse, Dialog, Empty, FieldLabel, Figures, IconButton, PageHeader, SearchField, Section, Segmented, Spinner, Tag } from '../components/kit';
import { RankBars } from '../components/charts';
import type { AdminClass, AdminReminder, AdminClassTodo } from '../types';

const AVATAR_COLORS = [
  '#2a78cc', '#8a3fc4', '#0f7f96', '#16845f', '#b3610d', '#d93a40',
];

function avatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
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

function formatRemindAt(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const isPast = d < now;
  const abs = Math.abs(d.getTime() - now.getTime());
  const days = Math.floor(abs / 86400000);
  const hours = Math.floor(abs / 3600000);
  const mins = Math.floor(abs / 60000);

  let rel = '';
  if (mins < 1) rel = 'now';
  else if (hours < 1) rel = `${mins}m`;
  else if (days < 1) rel = `${hours}h`;
  else rel = `${days}d`;

  const label = isPast ? `${rel} ago` : `in ${rel}`;
  return `${d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' })} ${d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} (${label})`;
}

function fmtDue(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
}

function toDatetimeLocal(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function generateCode(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .split(/\s+/)
    .map((w) => w.slice(0, 3))
    .join('-')
    .slice(0, 12);
  return slug || 'class';
}

// ─── Class Todo Row ───────────────────────────────────────────────────────────

function ClassTodoRow({
  todo,
  onUpdated,
  onDeleted,
}: {
  todo: AdminClassTodo;
  onUpdated: (t: AdminClassTodo) => void;
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
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) titleRef.current?.focus();
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
      const updated = await adminApi.updateTodo(todo.stableUid, todo.id, { done: !todo.done });
      onUpdated({ ...todo, ...updated });
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
    const patch: Partial<{ title: string; details: string; dueAt: string | null }> = {};
    if (trimmed !== todo.title) patch.title = trimmed;
    if (details !== todo.details) patch.details = details;
    if (newDueAt !== todo.dueAt) patch.dueAt = newDueAt;

    if (Object.keys(patch).length === 0) {
      setEditing(false);
      setSaving(false);
      return;
    }
    try {
      const updated = await adminApi.updateTodo(todo.stableUid, todo.id, patch);
      onUpdated({ ...todo, ...updated });
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
      await adminApi.deleteTodo(todo.stableUid, todo.id);
      onDeleted(todo.id);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Failed to delete', 'error');
      setDeleting(false);
    }
  }

  const isOverdue = todo.dueAt && !todo.done && new Date(todo.dueAt) < new Date();

  return (
    <div style={{ opacity: todo.done && !editing ? 0.62 : 1 }}>
      <div className={`flex items-start gap-3 py-3 ${editing ? 'rounded-[16px] bg-well px-4' : ''}`}>
        <button
          onClick={() => void toggleDone()}
          disabled={saving || editing}
          className="mt-0.5 flex-shrink-0"
          style={{ color: todo.done ? 'var(--mint-deep)' : 'rgb(var(--ink-rgb) / 0.5)' }}
        >
          {(saving && !editing) ? <Loader2 size={15} className="animate-spin" /> : todo.done ? <CheckSquare size={15} /> : <Square size={15} />}
        </button>

        <div className="flex-1 min-w-0">
          {/* Username badge */}
          <div className="mb-1">
            <span
              className="text-xs px-1.5 py-0.5 font-medium font-mono"
              style={{ background: `color-mix(in srgb, ${avatarColor(todo.username)} 13%, transparent)`, color: avatarColor(todo.username), border: `1px solid color-mix(in srgb, ${avatarColor(todo.username)} 27%, transparent)`, borderRadius: '5px' }}
            >
              {todo.username}
            </span>
          </div>

          {editing ? (
            <div className="flex flex-col gap-2">
              <input
                ref={titleRef}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') resetEdit(); }}
                className="field h-11 px-4 text-[14px] w-full"
                placeholder="Title"
              />
              <textarea
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                rows={2}
                className="field px-4 py-3 text-[14px] resize-none w-full"
                placeholder="Details (optional)"
              />
              <div className="flex items-center gap-2">
                <Clock size={10} style={{ color: 'rgb(var(--ink-rgb) / 0.5)' }} />
                <input
                  type="datetime-local"
                  value={dueAtLocal}
                  onChange={(e) => setDueAtLocal(e.target.value)}
                  className="field h-11 px-4 text-[14px] flex-1"
                  style={{ color: 'rgb(var(--ink-rgb) / 0.74)' }}
                />
                {dueAtLocal && (
                  <button onClick={() => setDueAtLocal('')} style={{ color: 'rgb(var(--ink-rgb) / 0.5)' }}><X size={10} /></button>
                )}
              </div>
              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={() => void saveEdit()}
                  disabled={saving || !title.trim()}
                  className="flex items-center gap-1 text-xs px-2 py-1 rounded-full font-medium disabled:opacity-50"
                  style={{ background: 'rgba(60,135,215,0.2)', color: 'var(--sky-deep)', border: '1px solid transparent' }}
                >
                  {saving ? <Loader2 size={10} className="animate-spin" /> : <Check size={10} />} Save
                </button>
                <button onClick={resetEdit} className="text-xs px-2 py-1 rounded-full" style={{ color: 'rgb(var(--ink-rgb) / 0.5)', border: '1px solid rgb(var(--ink-rgb) / calc(0.076 * var(--veil)))' }}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <span className="text-sm" style={{ color: todo.done ? 'rgb(var(--ink-rgb) / 0.5)' : 'var(--ink)', textDecoration: todo.done ? 'line-through' : 'none' }}>
                {todo.title}
              </span>
              <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                {todo.dueAt && (
                  <span className="text-xs flex items-center gap-1" style={{ color: isOverdue ? 'var(--rose-deep)' : 'rgb(var(--ink-rgb) / 0.5)' }}>
                    {isOverdue && <AlertTriangle size={9} />}<Clock size={9} />{fmtDue(todo.dueAt)}
                  </span>
                )}
                <span className="text-xs" style={{ color: 'rgb(var(--ink-rgb) / 0.5)' }}>{relativeDate(todo.createdAt)}</span>
              </div>
              {todo.details && (
                <button
                  onClick={() => setExpanded(!expanded)}
                  className="flex items-center gap-1 text-xs mt-0.5"
                  style={{ color: 'var(--sky-deep)' }}
                >
                  {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                  {expanded ? 'Hide' : 'Details'}
                </button>
              )}
              {expanded && todo.details && (
                <p className="text-xs mt-1 whitespace-pre-wrap" style={{ color: 'rgb(var(--ink-rgb) / 0.74)' }}>{todo.details}</p>
              )}
            </>
          )}
        </div>

        {!editing && (
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              onClick={() => setEditing(true)}
              className="p-1 rounded transition-colors"
              style={{ color: 'rgb(var(--ink-rgb) / 0.5)' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--sky-deep)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'rgb(var(--ink-rgb) / 0.5)'; }}
              title="Edit"
            >
              <Edit3 size={12} />
            </button>
            <button
              onClick={() => void handleDelete()}
              disabled={deleting}
              className="p-1 rounded transition-colors"
              style={{ color: 'rgb(var(--ink-rgb) / 0.5)', opacity: deleting ? 0.5 : 1 }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--rose-deep)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'rgb(var(--ink-rgb) / 0.5)'; }}
              title="Delete"
            >
              {deleting ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Create class modal ────────────────────────────────────────────────────────

interface CreateModalProps {
  onClose: () => void;
  onCreated: (cls: AdminClass) => void;
}

function CreateModal({ onClose, onCreated }: CreateModalProps) {
  const { showToast } = useToast();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [webuntisId, setWebuntisId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [codeManual, setCodeManual] = useState(false);

  function handleNameChange(v: string) {
    setName(v);
    if (!codeManual) setCode(generateCode(v));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !code.trim()) return;
    setSubmitting(true);
    try {
      const cls = await adminApi.createClass({
        name: name.trim(),
        code: code.trim(),
        webuntisKlasseId: webuntisId ? parseInt(webuntisId, 10) : undefined,
      });
      showToast(`Class "${cls.name}" created`, 'success');
      onCreated(cls);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to create class', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog title="Create class" subtitle="Members join a class with its code." onClose={onClose}>
      <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-5">
        <FieldLabel label="Name">
          <input type="text" value={name} onChange={(e) => handleNameChange(e.target.value)} placeholder="e.g. Year 10A" required
            className="field h-11 px-4 text-[14px] w-full" />
        </FieldLabel>
        <FieldLabel label="Code">
          <input type="text" value={code} onChange={(e) => { setCodeManual(true); setCode(e.target.value); }} placeholder="e.g. 10a" required
            autoCapitalize="none" spellCheck={false}
            className="field h-11 px-4 text-[14px] w-full font-mono" />
        </FieldLabel>
        <FieldLabel label="WebUntis Klasse ID" hint="Optional.">
          <input type="number" value={webuntisId} onChange={(e) => setWebuntisId(e.target.value)} placeholder="e.g. 42"
            className="field h-11 px-4 text-[14px] w-full" />
        </FieldLabel>
        <div className="mt-2 flex gap-3">
          <button type="button" onClick={onClose} className="btn btn-quiet flex-1">Cancel</button>
          <button type="submit" disabled={submitting || !name.trim() || !code.trim()} className="btn btn-primary flex-1">
            {submitting ? <Spinner /> : <Plus size={16} strokeWidth={1.8} />}
            {submitting ? 'Creating…' : 'Create class'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// ─── Reminder Row ────────────────────────────────────────────────────────────

function ReminderRow({
  reminder,
  onUpdated,
  onDeleted,
}: {
  reminder: AdminReminder;
  onUpdated: (r: AdminReminder) => void;
  onDeleted: (id: string) => void;
}) {
  const { showToast } = useToast();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(reminder.title);
  const [body, setBody] = useState(reminder.body);
  const [remindAtLocal, setRemindAtLocal] = useState(toDatetimeLocal(reminder.remindAt));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) titleRef.current?.focus();
  }, [editing]);

  function resetEdit() {
    setTitle(reminder.title);
    setBody(reminder.body);
    setRemindAtLocal(toDatetimeLocal(reminder.remindAt));
    setEditing(false);
  }

  async function saveEdit() {
    const trimmed = title.trim();
    if (!trimmed) return;
    setSaving(true);
    const patch: Partial<{ title: string; body: string; remindAt: string }> = {};
    if (trimmed !== reminder.title) patch.title = trimmed;
    if (body !== reminder.body) patch.body = body;
    if (remindAtLocal) {
      const iso = new Date(remindAtLocal).toISOString();
      if (iso !== reminder.remindAt) patch.remindAt = iso;
    }
    if (Object.keys(patch).length === 0) {
      setEditing(false);
      setSaving(false);
      return;
    }
    try {
      const updated = await adminApi.updateReminder(reminder.id, patch);
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
    if (!confirmDel) {
      setConfirmDel(true);
      setTimeout(() => setConfirmDel(false), 3000);
      return;
    }
    setDeleting(true);
    try {
      await adminApi.deleteReminder(reminder.id);
      onDeleted(reminder.id);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Failed to delete', 'error');
      setDeleting(false);
    }
  }

  const isPast = new Date(reminder.remindAt) < new Date();

  return (
    <div>
      <div className={`flex items-start gap-3 py-3 ${editing ? 'rounded-[16px] bg-well px-4' : ''}`}>
        <div className="flex-shrink-0 mt-0.5" style={{ color: isPast ? 'var(--rose-deep)' : 'var(--mint-deep)' }}>
          <CalendarClock size={14} />
        </div>

        <div className="flex-1 min-w-0">
          {editing ? (
            <div className="flex flex-col gap-2">
              <input
                ref={titleRef}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') resetEdit(); }}
                className="field h-11 px-4 text-[14px] w-full font-medium"
                placeholder="Title *"
              />
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={3}
                className="field px-4 py-3 text-[14px] resize-none w-full"
                placeholder="Body / description (optional)"
              />
              <div className="flex items-center gap-2">
                <Clock size={10} style={{ color: 'rgb(var(--ink-rgb) / 0.5)' }} />
                <input
                  type="datetime-local"
                  value={remindAtLocal}
                  onChange={(e) => setRemindAtLocal(e.target.value)}
                  className="field h-11 px-4 text-[14px] flex-1"
                  style={{ color: 'rgb(var(--ink-rgb) / 0.74)' }}
                  required
                />
              </div>
              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={() => void saveEdit()}
                  disabled={saving || !title.trim() || !remindAtLocal}
                  className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-full font-medium disabled:opacity-50"
                  style={{ background: 'rgba(60,135,215,0.2)', color: 'var(--sky-deep)', border: '1px solid transparent' }}
                >
                  {saving ? <Loader2 size={10} className="animate-spin" /> : <Check size={10} />} Save
                </button>
                <button onClick={resetEdit} className="text-xs px-2.5 py-1.5 rounded-full" style={{ color: 'rgb(var(--ink-rgb) / 0.5)', border: '1px solid rgb(var(--ink-rgb) / calc(0.076 * var(--veil)))' }}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-start justify-between gap-2">
                <span className="text-sm font-medium leading-snug" style={{ color: 'var(--ink)' }}>{reminder.title}</span>
                <span
                  className="text-xs px-1.5 py-0.5 rounded flex items-center gap-1 flex-shrink-0"
                  style={isPast ? { background: 'rgba(225,70,75,0.1)', color: 'var(--rose-deep)' } : { background: 'rgba(40,170,125,0.1)', color: 'var(--mint-deep)' }}
                >
                  <Clock size={9} />
                  {formatRemindAt(reminder.remindAt)}
                </span>
              </div>
              {reminder.body && <p className="text-xs mt-1 whitespace-pre-wrap" style={{ color: 'rgb(var(--ink-rgb) / 0.74)' }}>{reminder.body}</p>}
              <p className="text-xs mt-1" style={{ color: 'rgb(var(--ink-rgb) / 0.5)' }}>by {reminder.createdByUsername}</p>
            </>
          )}
        </div>

        {!editing && (
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              onClick={() => setEditing(true)}
              className="p-1 rounded transition-colors"
              style={{ color: 'rgb(var(--ink-rgb) / 0.5)' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--sky-deep)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'rgb(var(--ink-rgb) / 0.5)'; }}
              title="Edit"
            >
              <Edit3 size={12} />
            </button>
            <button
              onClick={() => void handleDelete()}
              disabled={deleting}
              className="flex items-center gap-0.5 text-xs px-1.5 py-1 rounded transition-all disabled:opacity-50"
              style={{
                color: 'var(--rose-deep)',
                background: confirmDel ? 'rgba(225,70,75,0.2)' : 'transparent',
                border: confirmDel ? '1px solid rgba(225,70,75,0.4)' : '1px solid transparent',
              }}
              onMouseEnter={(e) => { if (!deleting) (e.currentTarget as HTMLElement).style.background = 'rgba(225,70,75,0.1)'; }}
              onMouseLeave={(e) => { if (!confirmDel) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
              title={confirmDel ? 'Click again to confirm' : 'Delete'}
            >
              {deleting ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
              {confirmDel && <span className="ml-0.5">Sure?</span>}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Expanded class detail panel ──────────────────────────────────────────────

interface ClassDetailProps {
  cls: AdminClass;
  onMemberRemoved: (classId: string, stableUid: string) => void;
  onMemberAdded: (classId: string, member: { stableUid: string; username: string; joinedAt: string }) => void;
}

function ClassDetail({ cls, onMemberRemoved, onMemberAdded }: ClassDetailProps) {
  const { showToast } = useToast();
  const [reminders, setReminders] = useState<AdminReminder[] | null>(null);
  const [loadingReminders, setLoadingReminders] = useState(false);
  const [classTodos, setClassTodos] = useState<AdminClassTodo[] | null>(null);
  const [loadingTodos, setLoadingTodos] = useState(false);
  const [removingUid, setRemovingUid] = useState<string | null>(null);
  const [addUsername, setAddUsername] = useState('');
  const [adding, setAdding] = useState(false);
  const [tab, setTab] = useState<'members' | 'reminders' | 'todos'>('members');

  // Create todo form state (class level)
  const [showCreateTodo, setShowCreateTodo] = useState(false);
  const [newTodoUid, setNewTodoUid] = useState(cls.members[0]?.stableUid ?? '');
  const [newTodoTitle, setNewTodoTitle] = useState('');
  const [newTodoDetails, setNewTodoDetails] = useState('');
  const [newTodoDueAt, setNewTodoDueAt] = useState('');
  const [creatingTodo, setCreatingTodo] = useState(false);

  // Create reminder form state
  const [showCreateReminder, setShowCreateReminder] = useState(false);
  const [newRemTitle, setNewRemTitle] = useState('');
  const [newRemBody, setNewRemBody] = useState('');
  const [newRemAt, setNewRemAt] = useState('');
  const [creatingReminder, setCreatingReminder] = useState(false);

  const loadReminders = useCallback((quiet = false) => {
    if (!quiet) setLoadingReminders(true);
    adminApi.classReminders(cls.id)
      .then(setReminders)
      .catch(() => setReminders((current) => current ?? []))
      .finally(() => setLoadingReminders(false));
  }, [cls.id]);

  const loadTodos = useCallback((quiet = false) => {
    if (!quiet) setLoadingTodos(true);
    adminApi.classTodos(cls.id)
      .then(setClassTodos)
      .catch(() => setClassTodos((current) => current ?? []))
      .finally(() => setLoadingTodos(false));
  }, [cls.id]);

  // Both lists load as soon as the class is opened, so the tabs show their
  // real counts straight away instead of a placeholder.
  useEffect(() => { loadReminders(); loadTodos(); }, [loadReminders, loadTodos]);
  useLive(['reminders'], () => loadReminders(true));
  useLive(['todos'], () => loadTodos(true));

  async function handleRemove(stableUid: string, username: string) {
    setRemovingUid(stableUid);
    try {
      await adminApi.removeFromClass(stableUid, cls.id);
      showToast(`Removed ${username} from class`, 'success');
      onMemberRemoved(cls.id, stableUid);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to remove member', 'error');
    } finally {
      setRemovingUid(null);
    }
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!addUsername.trim()) return;
    setAdding(true);
    try {
      const member = await adminApi.addToClass(cls.id, addUsername.trim());
      showToast(`Added ${member.username} to class`, 'success');
      onMemberAdded(cls.id, member);
      setAddUsername('');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to add member', 'error');
    } finally {
      setAdding(false);
    }
  }

  async function handleCreateTodo(e: React.FormEvent) {
    e.preventDefault();
    if (!newTodoTitle.trim() || !newTodoUid) return;
    setCreatingTodo(true);
    try {
      const todo = await adminApi.createTodo(newTodoUid, {
        title: newTodoTitle.trim(),
        details: newTodoDetails.trim() || undefined,
        dueAt: newTodoDueAt ? new Date(newTodoDueAt).toISOString() : null,
      });
      const member = cls.members.find((m) => m.stableUid === newTodoUid);
      const classTodo: AdminClassTodo = { ...todo, stableUid: newTodoUid, username: member?.username ?? '' };
      setClassTodos((prev) => prev ? [classTodo, ...prev] : [classTodo]);
      setNewTodoTitle('');
      setNewTodoDetails('');
      setNewTodoDueAt('');
      setShowCreateTodo(false);
      showToast('Todo created', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to create todo', 'error');
    } finally {
      setCreatingTodo(false);
    }
  }

  function handleTodoUpdated(updated: AdminClassTodo) {
    setClassTodos((prev) => prev ? prev.map((t) => t.id === updated.id ? updated : t) : prev);
  }

  function handleTodoDeleted(id: string) {
    setClassTodos((prev) => prev ? prev.filter((t) => t.id !== id) : prev);
  }

  function handleReminderUpdated(updated: AdminReminder) {
    setReminders((prev) => prev ? prev.map((r) => r.id === updated.id ? updated : r) : prev);
  }

  function handleReminderDeleted(id: string) {
    setReminders((prev) => prev ? prev.filter((r) => r.id !== id) : prev);
  }

  async function handleCreateReminder(e: React.FormEvent) {
    e.preventDefault();
    if (!newRemTitle.trim() || !newRemAt) return;
    setCreatingReminder(true);
    try {
      const reminder = await adminApi.createReminder(cls.id, {
        title: newRemTitle.trim(),
        body: newRemBody.trim() || undefined,
        remindAt: new Date(newRemAt).toISOString(),
      });
      setReminders((prev) => prev ? [...prev, reminder].sort((a, b) => a.remindAt.localeCompare(b.remindAt)) : [reminder]);
      setNewRemTitle('');
      setNewRemBody('');
      setNewRemAt('');
      setShowCreateReminder(false);
      showToast('Reminder created', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to create reminder', 'error');
    } finally {
      setCreatingReminder(false);
    }
  }

  const pendingTodos = classTodos?.filter((t) => !t.done) ?? [];
  const doneTodos = classTodos?.filter((t) => t.done) ?? [];

  return (
    <div>
      <Segmented
        label="Class data"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'members',   label: <><Users size={14} /> Members <span className="tabular opacity-60">{cls.members.length}</span></> },
          { value: 'reminders', label: <><Bell size={14} /> Reminders <span className="tabular opacity-60">{reminders?.length ?? '…'}</span></> },
          { value: 'todos',     label: <><ListTodo size={14} /> Todos <span className="tabular opacity-60">{classTodos?.length ?? '…'}</span></> },
        ]}
      />

      {/* Members tab */}
      {tab === 'members' && (
        <div className="mt-5">
          <form onSubmit={(e) => void handleAdd(e)} className="flex max-w-[560px] gap-2.5">
            <input
              type="text"
              value={addUsername}
              onChange={(e) => setAddUsername(e.target.value)}
              placeholder="Add user by username"
              aria-label="Add user by username"
              autoCapitalize="none"
              spellCheck={false}
              className="field h-11 min-w-0 flex-1 px-4 text-[14px]"
            />
            <button type="submit" disabled={adding || !addUsername.trim()} className="btn btn-primary">
              {adding ? <Spinner /> : <UserPlus size={16} strokeWidth={1.7} />}
              Add
            </button>
          </form>

          {cls.members.length === 0 ? (
            <p className="mt-5 text-[14px] text-ink-3">No members yet.</p>
          ) : (
            <ul className="stack mt-3">
              {cls.members.map((m) => (
                <li key={m.stableUid} className="spot flex items-center gap-3.5 py-2.5">
                  <Avatar name={m.username} size={34} />
                  <span className="min-w-0 flex-1 truncate text-[14.5px] font-medium">{m.username}</span>
                  <span className="hidden whitespace-nowrap text-[13px] text-ink-3 sm:block">joined {relativeDate(m.joinedAt)}</span>
                  <IconButton
                    icon={UserMinus}
                    tone="rose"
                    size={34}
                    label={`Remove ${m.username}`}
                    busy={removingUid === m.stableUid}
                    onClick={() => void handleRemove(m.stableUid, m.username)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Reminders tab */}
      {tab === 'reminders' && (
        <div className="mt-5">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[13.5px] text-ink-3">
              {loadingReminders ? 'Loading…' : `${reminders?.length ?? 0} reminder${reminders?.length !== 1 ? 's' : ''}`}
            </span>
            {!showCreateReminder && (
              <button type="button" onClick={() => setShowCreateReminder(true)} className="btn btn-sm btn-line">
                <Plus size={14} strokeWidth={1.8} /> Add reminder
              </button>
            )}
          </div>

          {/* Create reminder form */}
          <Collapse open={showCreateReminder}>
            <form onSubmit={(e) => void handleCreateReminder(e)} className="flex max-w-[560px] flex-col gap-3 pb-3 pt-4">
              <input
                value={newRemTitle}
                onChange={(e) => setNewRemTitle(e.target.value)}
                placeholder="Title *"
                aria-label="Reminder title"
                className="field h-11 w-full px-4 text-[14px] font-medium"
              />
              <textarea
                value={newRemBody}
                onChange={(e) => setNewRemBody(e.target.value)}
                rows={2}
                className="field w-full resize-none px-4 py-3 text-[14px]"
                placeholder="Body / description (optional)"
                aria-label="Reminder description"
              />
              <label className="flex items-center gap-3 text-ink-3">
                <Clock size={15} strokeWidth={1.7} />
                <input
                  type="datetime-local"
                  value={newRemAt}
                  onChange={(e) => setNewRemAt(e.target.value)}
                  aria-label="Remind at"
                  className="field h-11 min-w-0 flex-1 px-4 text-[14px]"
                  required
                />
              </label>
              <div className="flex items-center gap-2.5">
                <button type="submit" disabled={creatingReminder || !newRemTitle.trim() || !newRemAt} className="btn btn-sm btn-primary">
                  {creatingReminder ? <Spinner size={13} /> : <Plus size={14} strokeWidth={1.8} />} Add
                </button>
                <button
                  type="button"
                  onClick={() => { setShowCreateReminder(false); setNewRemTitle(''); setNewRemBody(''); setNewRemAt(''); }}
                  className="btn btn-sm btn-quiet"
                >
                  Cancel
                </button>
              </div>
            </form>
          </Collapse>

          {/* Reminder list */}
          {loadingReminders ? (
            <div className="flex items-center gap-2.5 py-4 text-[14px] text-ink-3"><Spinner size={14} /> Loading…</div>
          ) : !reminders || reminders.length === 0 ? (
            <p className="py-4 text-[14px] text-ink-3">No reminders in this class.</p>
          ) : (
            <div className="stack mt-2">
              {reminders.map((r) => (
                <ReminderRow
                  key={r.id}
                  reminder={r}
                  onUpdated={handleReminderUpdated}
                  onDeleted={handleReminderDeleted}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Todos tab */}
      {tab === 'todos' && (
        <div className="mt-5">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[13.5px] text-ink-3">
              {loadingTodos ? 'Loading…' : `${pendingTodos.length} pending, ${doneTodos.length} done`}
            </span>
            {cls.members.length > 0 && !showCreateTodo && (
              <button
                type="button"
                onClick={() => { setShowCreateTodo(true); setNewTodoUid(cls.members[0]?.stableUid ?? ''); }}
                className="btn btn-sm btn-line"
              >
                <Plus size={14} strokeWidth={1.8} /> Add todo
              </button>
            )}
          </div>

          {/* Create todo form */}
          <Collapse open={showCreateTodo && cls.members.length > 0}>
            <form onSubmit={(e) => void handleCreateTodo(e)} className="flex max-w-[560px] flex-col gap-3 pb-3 pt-4">
              <label className="flex flex-col gap-2">
                <span className="text-[13px] text-ink-2">User</span>
                <select value={newTodoUid} onChange={(e) => setNewTodoUid(e.target.value)} className="field h-11 px-4 text-[14px]">
                  {cls.members.map((m) => (
                    <option key={m.stableUid} value={m.stableUid}>{m.username}</option>
                  ))}
                </select>
              </label>
              <input
                value={newTodoTitle}
                onChange={(e) => setNewTodoTitle(e.target.value)}
                placeholder="Title *"
                aria-label="Todo title"
                className="field h-11 w-full px-4 text-[14px] font-medium"
              />
              <textarea
                value={newTodoDetails}
                onChange={(e) => setNewTodoDetails(e.target.value)}
                rows={2}
                className="field w-full resize-none px-4 py-3 text-[14px]"
                placeholder="Details (optional)"
                aria-label="Todo details"
              />
              <div className="flex items-center gap-3 text-ink-3">
                <Clock size={15} strokeWidth={1.7} />
                <input
                  type="datetime-local"
                  value={newTodoDueAt}
                  onChange={(e) => setNewTodoDueAt(e.target.value)}
                  aria-label="Due at"
                  className="field h-11 min-w-0 flex-1 px-4 text-[14px]"
                />
                {newTodoDueAt && (
                  <IconButton icon={X} label="Clear due date" size={34} onClick={() => setNewTodoDueAt('')} />
                )}
              </div>
              <div className="flex items-center gap-2.5">
                <button type="submit" disabled={creatingTodo || !newTodoTitle.trim()} className="btn btn-sm btn-primary">
                  {creatingTodo ? <Spinner size={13} /> : <Plus size={14} strokeWidth={1.8} />} Add
                </button>
                <button
                  type="button"
                  onClick={() => { setShowCreateTodo(false); setNewTodoTitle(''); setNewTodoDetails(''); setNewTodoDueAt(''); }}
                  className="btn btn-sm btn-quiet"
                >
                  Cancel
                </button>
              </div>
            </form>
          </Collapse>

          {/* Todos list */}
          {loadingTodos ? (
            <div className="flex items-center gap-2.5 py-4 text-[14px] text-ink-3"><Spinner size={14} /> Loading…</div>
          ) : cls.members.length === 0 ? (
            <p className="py-4 text-[14px] text-ink-3">No members in this class.</p>
          ) : !classTodos || classTodos.length === 0 ? (
            <p className="py-4 text-[14px] text-ink-3">No todos in this class.</p>
          ) : (
            <>
              <div className="stack mt-2">
                {pendingTodos.map((t) => (
                  <ClassTodoRow key={t.id} todo={t} onUpdated={handleTodoUpdated} onDeleted={handleTodoDeleted} />
                ))}
              </div>
              {doneTodos.length > 0 && (
                <>
                  {pendingTodos.length > 0 && <div className="rule-label my-3 text-[13px] !text-ink-3">Done</div>}
                  <div className="stack">
                    {doneTodos.map((t) => (
                      <ClassTodoRow key={t.id} todo={t} onUpdated={handleTodoUpdated} onDeleted={handleTodoDeleted} />
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function ClassesPage() {
  const { showToast } = useToast();
  const [classes, setClasses] = useState<AdminClass[]>([]);
  const [loading, setLoading] = useState(true);
  // The search hands over a class to show, opened.
  const handed = useHanded<{ open: string; search: string }>();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(handed.open ? [handed.open] : []));
  const [search, setSearch] = useState(handed.search ?? '');
  const [showModal, setShowModal] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchClasses = useCallback(() => {
    adminApi.classes()
      .then(setClasses)
      .catch((err) => showToast(err instanceof Error ? err.message : 'Failed to load classes', 'error'))
      .finally(() => setLoading(false));
  }, [showToast]);

  useEffect(() => { fetchClasses(); }, [fetchClasses]);

  const { refresh, refreshing } = useAutoRefresh(fetchClasses, 30000);
  useLive(['classes'], fetchClasses);

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function handleCreated(cls: AdminClass) {
    setClasses((prev) => [cls, ...prev]);
    setShowModal(false);
  }

  async function handleDeleteClass(id: string, name: string) {
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);
      setTimeout(() => setConfirmDeleteId((cur) => cur === id ? null : cur), 3000);
      return;
    }
    setDeletingId(id);
    setConfirmDeleteId(null);
    try {
      await adminApi.deleteClass(id);
      showToast(`Class "${name}" deleted`, 'success');
      setClasses((prev) => prev.filter((c) => c.id !== id));
      setExpanded((prev) => { const next = new Set(prev); next.delete(id); return next; });
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to delete class', 'error');
    } finally {
      setDeletingId(null);
    }
  }

  function handleMemberRemoved(classId: string, stableUid: string) {
    setClasses((prev) => prev.map((c) =>
      c.id === classId
        ? { ...c, members: c.members.filter((m) => m.stableUid !== stableUid), memberCount: c.memberCount - 1 }
        : c
    ));
  }

  function handleMemberAdded(classId: string, member: { stableUid: string; username: string; joinedAt: string }) {
    setClasses((prev) => prev.map((c) =>
      c.id === classId
        ? {
            ...c,
            members: c.members.some((m) => m.stableUid === member.stableUid)
              ? c.members
              : [...c.members, member],
            memberCount: c.members.some((m) => m.stableUid === member.stableUid)
              ? c.memberCount
              : c.memberCount + 1,
          }
        : c
    ));
  }

  const filtered = classes.filter(
    (c) => !search ||
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.code.toLowerCase().includes(search.toLowerCase()) ||
      c.createdByName.toLowerCase().includes(search.toLowerCase())
  );

  const totalMembers = classes.reduce((sum, c) => sum + c.memberCount, 0);
  const averageSize = classes.length > 0 ? totalMembers / classes.length : 0;
  const largest = [...classes].sort((a, b) => b.memberCount - a.memberCount).slice(0, 6);

  return (
    <div>
      {showModal && <CreateModal onClose={() => setShowModal(false)} onCreated={handleCreated} />}

      <PageHeader title="Classes" subtitle="Manage class groups, members, reminders and todos.">
        <IconButton icon={RefreshCw} label="Refresh" size={42} busy={refreshing} onClick={() => void refresh()} />
        <button type="button" onClick={() => setShowModal(true)} className="btn btn-primary">
          <Plus size={16} strokeWidth={1.8} />
          Create class
        </button>
      </PageHeader>

      <Figures
        className="mt-10"
        items={[
          { label: 'Classes', value: classes.length, icon: Building2 },
          { label: 'Members', value: totalMembers, icon: Users },
          { label: 'Average size', value: averageSize.toLocaleString('en-US', { maximumFractionDigits: 1 }), icon: ListTodo },
        ]}
      />

      {classes.length > 1 && (
        <Section className="mt-[46px]" title="Largest classes" meta="by members">
          <div className="mt-8 max-w-[760px]">
            <RankBars items={largest.map((c) => ({ label: c.name, value: c.memberCount, note: c.code }))} />
          </div>
        </Section>
      )}

      <Section
        className="mt-[52px]"
        title="All classes"
        meta={`${filtered.length} of ${classes.length}`}
        action={<SearchField value={search} onChange={setSearch} placeholder="Search classes" className="w-full sm:w-[260px]" />}
      >
        {loading ? (
          <div className="mt-7 flex flex-col gap-5">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4"><div className="shimmer h-12 w-12 rounded-full" /><div className="shimmer h-4 flex-1 rounded-full" /></div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <Empty icon={Building2}>{search ? `No classes match “${search}”.` : 'No classes yet.'}</Empty>
        ) : (
          <ul className="stack mt-3">
            {filtered.map((cls) => {
              const open = expanded.has(cls.id);
              return (
                <li key={cls.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    aria-expanded={open}
                    className="class-row spot flex cursor-pointer items-center gap-4 py-4"
                    onClick={() => toggleExpanded(cls.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpanded(cls.id); } }}
                  >
                    <span className="orb h-12 w-12"><Building2 size={19} strokeWidth={1.6} /></span>
                    <div className="min-w-0 flex-1">
                      <div className="class-row-name truncate text-[14.5px] font-medium">{cls.name}</div>
                      <div className="mt-0.5 truncate text-[13px] text-ink-3">
                        Created by {cls.createdByName} · {relativeDate(cls.createdAt)}
                      </div>
                    </div>
                    <span className="hidden sm:block"><Tag tone="sky" mono>{cls.code}</Tag></span>
                    <span className="tabular hidden w-[120px] text-[13.5px] text-ink-3 lg:block">WebUntis {cls.webuntisKlasseId}</span>
                    <span className="tabular flex w-[64px] items-center gap-2 text-[14.5px] font-medium" title={`${cls.memberCount} members`}>
                      <Users size={15} strokeWidth={1.7} className="text-ink-3" />
                      {cls.memberCount}
                    </span>
                    <span className="flex flex-shrink-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                      {confirmDeleteId === cls.id ? (
                        <button type="button" className="btn btn-sm btn-danger" onClick={() => void handleDeleteClass(cls.id, cls.name)}>
                          Really delete?
                        </button>
                      ) : (
                        <IconButton
                          icon={Trash2}
                          tone="rose"
                          label={`Delete class ${cls.name}`}
                          busy={deletingId === cls.id}
                          onClick={() => void handleDeleteClass(cls.id, cls.name)}
                        />
                      )}
                    </span>
                    <ChevronDown size={18} strokeWidth={1.7} className="flex-shrink-0 text-ink-3" style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform 0.4s var(--glide)' }} />
                  </div>

                  <Collapse open={open}>
                    <div className="pb-7 pt-1 sm:pl-16">
                      <ClassDetail
                        cls={cls}
                        onMemberRemoved={handleMemberRemoved}
                        onMemberAdded={handleMemberAdded}
                      />
                    </div>
                  </Collapse>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </div>
  );
}
