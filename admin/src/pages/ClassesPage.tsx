import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Building2, Users, ChevronDown, ChevronRight, Search, Plus, X,
  RefreshCw, UserMinus, UserPlus, Bell, Clock, Loader2, Trash2,
  CheckSquare, Square, Edit3, Check, AlertTriangle, ListTodo, CalendarClock,
} from 'lucide-react';
import { adminApi } from '../api';
import { useToast } from '../components/Toast';
import { useAutoRefresh } from '../hooks/useAutoRefresh';
import type { AdminClass, AdminReminder, AdminClassTodo } from '../types';

const AVATAR_COLORS = [
  '#6366f1', '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ef4444',
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
    <div
      className="rounded-xl transition-all"
      style={{
        background: todo.done ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.03)',
        border: `1px solid ${editing ? 'rgba(99,102,241,0.3)' : isOverdue ? 'rgba(255,69,58,0.2)' : 'rgba(255,255,255,0.05)'}`,
      }}
    >
      <div className="flex items-start gap-2 p-3">
        <button
          onClick={() => void toggleDone()}
          disabled={saving || editing}
          className="mt-0.5 flex-shrink-0"
          style={{ color: todo.done ? '#30d158' : '#4a4a5e' }}
        >
          {(saving && !editing) ? <Loader2 size={15} className="animate-spin" /> : todo.done ? <CheckSquare size={15} /> : <Square size={15} />}
        </button>

        <div className="flex-1 min-w-0">
          {/* Username badge */}
          <div className="mb-1">
            <span
              className="text-xs px-1.5 py-0.5 font-medium font-mono"
              style={{ background: `${avatarColor(todo.username)}22`, color: avatarColor(todo.username), border: `1px solid ${avatarColor(todo.username)}44`, borderRadius: '5px' }}
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
                className="text-sm bg-transparent outline-none border-b w-full"
                style={{ color: '#f0f0f5', borderColor: 'rgba(99,102,241,0.5)' }}
                placeholder="Title"
              />
              <textarea
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                rows={2}
                className="text-xs outline-none resize-none rounded p-2 w-full"
                style={{ color: '#8b8b9b', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '6px' }}
                placeholder="Details (optional)"
              />
              <div className="flex items-center gap-2">
                <Clock size={10} style={{ color: '#4a4a5e' }} />
                <input
                  type="datetime-local"
                  value={dueAtLocal}
                  onChange={(e) => setDueAtLocal(e.target.value)}
                  className="text-xs bg-transparent outline-none flex-1"
                  style={{ color: '#8b8b9b', colorScheme: 'dark' }}
                />
                {dueAtLocal && (
                  <button onClick={() => setDueAtLocal('')} style={{ color: '#4a4a5e' }}><X size={10} /></button>
                )}
              </div>
              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={() => void saveEdit()}
                  disabled={saving || !title.trim()}
                  className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg font-medium disabled:opacity-50"
                  style={{ background: 'rgba(99,102,241,0.2)', color: '#818cf8', border: '1px solid rgba(99,102,241,0.3)' }}
                >
                  {saving ? <Loader2 size={10} className="animate-spin" /> : <Check size={10} />} Save
                </button>
                <button onClick={resetEdit} className="text-xs px-2 py-1 rounded-lg" style={{ color: '#4a4a5e', border: '1px solid rgba(255,255,255,0.06)' }}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <span className="text-sm" style={{ color: todo.done ? '#4a4a5e' : '#f0f0f5', textDecoration: todo.done ? 'line-through' : 'none' }}>
                {todo.title}
              </span>
              <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                {todo.dueAt && (
                  <span className="text-xs flex items-center gap-1" style={{ color: isOverdue ? '#ff453a' : '#4a4a5e' }}>
                    {isOverdue && <AlertTriangle size={9} />}<Clock size={9} />{fmtDue(todo.dueAt)}
                  </span>
                )}
                <span className="text-xs" style={{ color: '#4a4a5e' }}>{relativeDate(todo.createdAt)}</span>
              </div>
              {todo.details && (
                <button
                  onClick={() => setExpanded(!expanded)}
                  className="flex items-center gap-1 text-xs mt-0.5"
                  style={{ color: '#818cf8' }}
                >
                  {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                  {expanded ? 'Hide' : 'Details'}
                </button>
              )}
              {expanded && todo.details && (
                <p className="text-xs mt-1 whitespace-pre-wrap" style={{ color: '#8b8b9b' }}>{todo.details}</p>
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
              <Edit3 size={12} />
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="w-full max-w-md rounded-2xl p-6 animate-scaleIn"
        style={{ background: '#111116', border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 24px 64px rgba(0,0,0,0.6)' }}
      >
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-base font-semibold" style={{ color: '#f0f0f5' }}>Create Class</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg transition-colors" style={{ color: '#4a4a5e' }}
            onMouseEnter={(e) => { e.currentTarget.style.color = '#f0f0f5'; e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = '#4a4a5e'; e.currentTarget.style.background = ''; }}>
            <X size={16} />
          </button>
        </div>
        <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4">
          {[
            { label: 'Name', value: name, onChange: handleNameChange, placeholder: 'e.g. Year 10A', mono: false },
            { label: 'Code', value: code, onChange: (v: string) => { setCodeManual(true); setCode(v); }, placeholder: 'e.g. 10a', mono: true },
          ].map(({ label, value, onChange, placeholder, mono }) => (
            <div key={label} className="flex flex-col gap-1.5">
              <label className="text-xs font-medium" style={{ color: '#8b8b9b' }}>{label}</label>
              <input type="text" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} required
                className={`px-3 py-2.5 text-sm outline-none transition-all${mono ? ' font-mono' : ''}`}
                style={{ background: '#18181f', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '8px', color: mono ? '#06b6d4' : '#f0f0f5' }}
                onFocus={(e) => { e.currentTarget.style.borderColor = 'rgba(99,102,241,0.4)'; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)'; }} />
            </div>
          ))}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium" style={{ color: '#8b8b9b' }}>WebUntis Klasse ID <span style={{ color: '#4a4a5e' }}>(optional)</span></label>
            <input type="number" value={webuntisId} onChange={(e) => setWebuntisId(e.target.value)} placeholder="e.g. 42"
              className="px-3 py-2.5 text-sm outline-none transition-all"
              style={{ background: '#18181f', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '8px', color: '#f0f0f5' }}
              onFocus={(e) => { e.currentTarget.style.borderColor = 'rgba(99,102,241,0.4)'; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)'; }} />
          </div>
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="flex-1 py-2.5 text-sm font-medium rounded-lg transition-all"
              style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.08)', color: '#8b8b9b' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
              Cancel
            </button>
            <button type="submit" disabled={submitting || !name.trim() || !code.trim()}
              className="flex-1 py-2.5 text-sm font-medium rounded-lg transition-all disabled:opacity-50"
              style={{ background: 'rgba(99,102,241,0.9)', color: '#fff', border: '1px solid rgba(99,102,241,0.5)' }}
              onMouseEnter={(e) => { if (!submitting) e.currentTarget.style.background = 'rgba(129,140,248,0.9)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(99,102,241,0.9)'; }}>
              {submitting ? 'Creating...' : 'Create Class'}
            </button>
          </div>
        </form>
      </div>
    </div>
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
    <div
      className="rounded-xl transition-all"
      style={{
        background: 'rgba(255,255,255,0.03)',
        border: `1px solid ${editing ? 'rgba(99,102,241,0.3)' : isPast ? 'rgba(239,68,68,0.12)' : 'rgba(255,255,255,0.05)'}`,
      }}
    >
      <div className="flex items-start gap-2 p-3">
        <div className="flex-shrink-0 mt-0.5" style={{ color: isPast ? '#f87171' : '#10b981' }}>
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
                className="text-sm bg-transparent outline-none border-b w-full font-medium"
                style={{ color: '#f0f0f5', borderColor: 'rgba(99,102,241,0.5)' }}
                placeholder="Title *"
              />
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={3}
                className="text-xs outline-none resize-none rounded p-2 w-full"
                style={{ color: '#8b8b9b', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '6px' }}
                placeholder="Body / description (optional)"
              />
              <div className="flex items-center gap-2">
                <Clock size={10} style={{ color: '#4a4a5e' }} />
                <input
                  type="datetime-local"
                  value={remindAtLocal}
                  onChange={(e) => setRemindAtLocal(e.target.value)}
                  className="text-xs bg-transparent outline-none flex-1"
                  style={{ color: '#8b8b9b', colorScheme: 'dark' }}
                  required
                />
              </div>
              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={() => void saveEdit()}
                  disabled={saving || !title.trim() || !remindAtLocal}
                  className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg font-medium disabled:opacity-50"
                  style={{ background: 'rgba(99,102,241,0.2)', color: '#818cf8', border: '1px solid rgba(99,102,241,0.3)' }}
                >
                  {saving ? <Loader2 size={10} className="animate-spin" /> : <Check size={10} />} Save
                </button>
                <button onClick={resetEdit} className="text-xs px-2.5 py-1.5 rounded-lg" style={{ color: '#4a4a5e', border: '1px solid rgba(255,255,255,0.06)' }}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-start justify-between gap-2">
                <span className="text-sm font-medium leading-snug" style={{ color: '#f0f0f5' }}>{reminder.title}</span>
                <span
                  className="text-xs px-1.5 py-0.5 rounded flex items-center gap-1 flex-shrink-0"
                  style={isPast ? { background: 'rgba(239,68,68,0.1)', color: '#f87171' } : { background: 'rgba(16,185,129,0.1)', color: '#10b981' }}
                >
                  <Clock size={9} />
                  {formatRemindAt(reminder.remindAt)}
                </span>
              </div>
              {reminder.body && <p className="text-xs mt-1 whitespace-pre-wrap" style={{ color: '#8b8b9b' }}>{reminder.body}</p>}
              <p className="text-xs mt-1" style={{ color: '#4a4a5e' }}>by {reminder.createdByUsername}</p>
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
              <Edit3 size={12} />
            </button>
            <button
              onClick={() => void handleDelete()}
              disabled={deleting}
              className="flex items-center gap-0.5 text-xs px-1.5 py-1 rounded transition-all disabled:opacity-50"
              style={{
                color: '#ef4444',
                background: confirmDel ? 'rgba(239,68,68,0.2)' : 'transparent',
                border: confirmDel ? '1px solid rgba(239,68,68,0.4)' : '1px solid transparent',
              }}
              onMouseEnter={(e) => { if (!deleting) (e.currentTarget as HTMLElement).style.background = 'rgba(239,68,68,0.1)'; }}
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

  useEffect(() => {
    if (tab === 'reminders' && reminders === null) {
      setLoadingReminders(true);
      adminApi.classReminders(cls.id)
        .then(setReminders)
        .catch(() => setReminders([]))
        .finally(() => setLoadingReminders(false));
    }
    if (tab === 'todos' && classTodos === null) {
      setLoadingTodos(true);
      adminApi.classTodos(cls.id)
        .then(setClassTodos)
        .catch(() => setClassTodos([]))
        .finally(() => setLoadingTodos(false));
    }
  }, [tab, cls.id, reminders, classTodos]);

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
    <div className="rounded-xl p-4" style={{ background: 'rgba(99,102,241,0.04)', border: '1px solid rgba(99,102,241,0.1)' }}>
      {/* Tab bar */}
      <div className="flex items-center gap-1 mb-4 flex-wrap">
        {([
          { key: 'members', icon: <Users size={11} />, label: `Members (${cls.members.length})` },
          { key: 'reminders', icon: <Bell size={11} />, label: `Reminders (${reminders?.length ?? '…'})` },
          { key: 'todos', icon: <ListTodo size={11} />, label: `Todos (${classTodos?.length ?? '…'})` },
        ] as const).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold uppercase tracking-wider transition-all"
            style={tab === t.key
              ? { background: 'rgba(99,102,241,0.2)', color: '#818cf8', border: '1px solid rgba(99,102,241,0.3)' }
              : { background: 'transparent', color: '#4a4a5e', border: '1px solid transparent' }}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* Members tab */}
      {tab === 'members' && (
        <div className="flex flex-col gap-3">
          <form onSubmit={(e) => void handleAdd(e)} className="flex gap-2">
            <input
              type="text"
              value={addUsername}
              onChange={(e) => setAddUsername(e.target.value)}
              placeholder="Add user by username…"
              className="flex-1 px-3 py-2 text-sm outline-none transition-all"
              style={{ background: '#18181f', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '8px', color: '#f0f0f5' }}
              onFocus={(e) => { e.currentTarget.style.borderColor = 'rgba(99,102,241,0.4)'; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)'; }}
            />
            <button
              type="submit"
              disabled={adding || !addUsername.trim()}
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg transition-all disabled:opacity-50"
              style={{ background: 'rgba(16,185,129,0.15)', color: '#10b981', border: '1px solid rgba(16,185,129,0.25)' }}
              onMouseEnter={(e) => { if (!adding) e.currentTarget.style.background = 'rgba(16,185,129,0.25)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(16,185,129,0.15)'; }}
            >
              {adding ? <Loader2 size={13} className="animate-spin" /> : <UserPlus size={13} />}
              Add
            </button>
          </form>

          {cls.members.length === 0 ? (
            <p className="text-sm py-2" style={{ color: '#4a4a5e' }}>No members yet</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {cls.members.map((m) => (
                <div
                  key={m.stableUid}
                  className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg"
                  style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}
                >
                  <div className="flex items-center gap-2">
                    <div
                      className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
                      style={{ background: avatarColor(m.username) }}
                    >
                      {m.username[0]?.toUpperCase() ?? '?'}
                    </div>
                    <span className="text-sm font-medium" style={{ color: '#f0f0f5' }}>{m.username}</span>
                    <span className="text-xs" style={{ color: '#4a4a5e' }}>joined {relativeDate(m.joinedAt)}</span>
                  </div>
                  <button
                    onClick={() => void handleRemove(m.stableUid, m.username)}
                    disabled={removingUid === m.stableUid}
                    className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs transition-all disabled:opacity-50"
                    style={{ background: 'rgba(239,68,68,0.08)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.15)' }}
                    onMouseEnter={(e) => { if (removingUid !== m.stableUid) e.currentTarget.style.background = 'rgba(239,68,68,0.18)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(239,68,68,0.08)'; }}
                  >
                    {removingUid === m.stableUid
                      ? <Loader2 size={11} className="animate-spin" />
                      : <UserMinus size={11} />}
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Reminders tab */}
      {tab === 'reminders' && (
        <div className="flex flex-col gap-3">
          {/* Header */}
          <div className="flex items-center justify-between">
            <span className="text-xs" style={{ color: '#4a4a5e' }}>
              {loadingReminders ? 'Loading…' : `${reminders?.length ?? 0} reminder${reminders?.length !== 1 ? 's' : ''}`}
            </span>
            {!showCreateReminder && (
              <button
                onClick={() => setShowCreateReminder(true)}
                className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg font-medium transition-all"
                style={{ color: '#f59e0b', border: '1px solid rgba(245,158,11,0.25)', background: 'transparent' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(245,158,11,0.1)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <Plus size={11} /> Add Reminder
              </button>
            )}
          </div>

          {/* Create reminder form */}
          {showCreateReminder && (
            <form
              onSubmit={(e) => void handleCreateReminder(e)}
              className="rounded-xl p-3 flex flex-col gap-2"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(245,158,11,0.25)' }}
            >
              <input
                value={newRemTitle}
                onChange={(e) => setNewRemTitle(e.target.value)}
                placeholder="Title *"
                className="text-sm bg-transparent outline-none border-b w-full font-medium"
                style={{ color: '#f0f0f5', borderColor: 'rgba(245,158,11,0.4)', paddingBottom: '4px' }}
                autoFocus
              />
              <textarea
                value={newRemBody}
                onChange={(e) => setNewRemBody(e.target.value)}
                rows={2}
                className="text-xs outline-none resize-none rounded p-2 w-full"
                style={{ color: '#8b8b9b', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '6px' }}
                placeholder="Body / description (optional)"
              />
              <div className="flex items-center gap-2">
                <Clock size={10} style={{ color: '#4a4a5e' }} />
                <input
                  type="datetime-local"
                  value={newRemAt}
                  onChange={(e) => setNewRemAt(e.target.value)}
                  className="text-xs bg-transparent outline-none flex-1"
                  style={{ color: '#f59e0b', colorScheme: 'dark' }}
                  required
                />
              </div>
              <div className="flex items-center gap-2 pt-1">
                <button
                  type="submit"
                  disabled={creatingReminder || !newRemTitle.trim() || !newRemAt}
                  className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg font-medium disabled:opacity-50"
                  style={{ background: 'rgba(245,158,11,0.15)', color: '#f59e0b', border: '1px solid rgba(245,158,11,0.3)' }}
                >
                  {creatingReminder ? <Loader2 size={10} className="animate-spin" /> : <Plus size={10} />} Add
                </button>
                <button
                  type="button"
                  onClick={() => { setShowCreateReminder(false); setNewRemTitle(''); setNewRemBody(''); setNewRemAt(''); }}
                  className="text-xs px-2.5 py-1.5 rounded-lg"
                  style={{ color: '#4a4a5e', border: '1px solid rgba(255,255,255,0.06)' }}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {/* Reminder list */}
          {loadingReminders ? (
            <div className="flex items-center gap-2 py-2" style={{ color: '#4a4a5e' }}>
              <Loader2 size={13} className="animate-spin" /> Loading…
            </div>
          ) : !reminders || reminders.length === 0 ? (
            <p className="text-sm py-2" style={{ color: '#4a4a5e' }}>No reminders in this class</p>
          ) : (
            <div className="flex flex-col gap-1.5">
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
        <div className="flex flex-col gap-3">
          {/* Header with create button */}
          <div className="flex items-center justify-between">
            <span className="text-xs" style={{ color: '#4a4a5e' }}>
              {loadingTodos ? 'Loading…' : `${pendingTodos.length} pending, ${doneTodos.length} done`}
            </span>
            {cls.members.length > 0 && !showCreateTodo && (
              <button
                onClick={() => { setShowCreateTodo(true); setNewTodoUid(cls.members[0]?.stableUid ?? ''); }}
                className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg font-medium transition-all"
                style={{ color: '#818cf8', border: '1px solid rgba(99,102,241,0.25)', background: 'transparent' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(99,102,241,0.1)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <Plus size={11} /> Add Todo
              </button>
            )}
          </div>

          {/* Create todo form */}
          {showCreateTodo && cls.members.length > 0 && (
            <form
              onSubmit={(e) => void handleCreateTodo(e)}
              className="rounded-xl p-3 flex flex-col gap-2"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(99,102,241,0.25)' }}
            >
              <div className="flex flex-col gap-1.5">
                <label className="text-xs" style={{ color: '#4a4a5e' }}>User</label>
                <select
                  value={newTodoUid}
                  onChange={(e) => setNewTodoUid(e.target.value)}
                  className="text-sm outline-none px-2 py-1.5 rounded-lg"
                  style={{ background: '#18181f', border: '1px solid rgba(255,255,255,0.07)', color: '#f0f0f5' }}
                >
                  {cls.members.map((m) => (
                    <option key={m.stableUid} value={m.stableUid}>{m.username}</option>
                  ))}
                </select>
              </div>
              <input
                value={newTodoTitle}
                onChange={(e) => setNewTodoTitle(e.target.value)}
                placeholder="Title *"
                className="text-sm bg-transparent outline-none border-b w-full"
                style={{ color: '#f0f0f5', borderColor: 'rgba(99,102,241,0.4)', paddingBottom: '4px' }}
                autoFocus
              />
              <textarea
                value={newTodoDetails}
                onChange={(e) => setNewTodoDetails(e.target.value)}
                rows={2}
                className="text-xs outline-none resize-none rounded p-2 w-full"
                style={{ color: '#8b8b9b', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '6px' }}
                placeholder="Details (optional)"
              />
              <div className="flex items-center gap-2">
                <Clock size={10} style={{ color: '#4a4a5e' }} />
                <input
                  type="datetime-local"
                  value={newTodoDueAt}
                  onChange={(e) => setNewTodoDueAt(e.target.value)}
                  className="text-xs bg-transparent outline-none flex-1"
                  style={{ color: '#8b8b9b', colorScheme: 'dark' }}
                />
                {newTodoDueAt && (
                  <button type="button" onClick={() => setNewTodoDueAt('')} style={{ color: '#4a4a5e' }}><X size={10} /></button>
                )}
              </div>
              <div className="flex items-center gap-2 pt-1">
                <button
                  type="submit"
                  disabled={creatingTodo || !newTodoTitle.trim()}
                  className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg font-medium disabled:opacity-50"
                  style={{ background: 'rgba(99,102,241,0.2)', color: '#818cf8', border: '1px solid rgba(99,102,241,0.3)' }}
                >
                  {creatingTodo ? <Loader2 size={10} className="animate-spin" /> : <Plus size={10} />} Add
                </button>
                <button
                  type="button"
                  onClick={() => { setShowCreateTodo(false); setNewTodoTitle(''); setNewTodoDetails(''); setNewTodoDueAt(''); }}
                  className="text-xs px-2.5 py-1.5 rounded-lg"
                  style={{ color: '#4a4a5e', border: '1px solid rgba(255,255,255,0.06)' }}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {/* Todos list */}
          {loadingTodos ? (
            <div className="flex items-center gap-2 py-2" style={{ color: '#4a4a5e' }}>
              <Loader2 size={13} className="animate-spin" /> Loading…
            </div>
          ) : cls.members.length === 0 ? (
            <p className="text-sm py-2" style={{ color: '#4a4a5e' }}>No members in this class</p>
          ) : !classTodos || classTodos.length === 0 ? (
            <p className="text-sm py-2" style={{ color: '#4a4a5e' }}>No todos in this class</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {pendingTodos.map((t) => (
                <ClassTodoRow key={t.id} todo={t} onUpdated={handleTodoUpdated} onDeleted={handleTodoDeleted} />
              ))}
              {doneTodos.length > 0 && pendingTodos.length > 0 && (
                <div className="flex items-center gap-3 my-1">
                  <div className="flex-1 h-px" style={{ background: 'rgba(255,255,255,0.05)' }} />
                  <span className="text-xs" style={{ color: '#4a4a5e' }}>Done</span>
                  <div className="flex-1 h-px" style={{ background: 'rgba(255,255,255,0.05)' }} />
                </div>
              )}
              {doneTodos.map((t) => (
                <ClassTodoRow key={t.id} todo={t} onUpdated={handleTodoUpdated} onDeleted={handleTodoDeleted} />
              ))}
            </div>
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
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
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

  return (
    <div className="flex flex-col gap-6 animate-page">
      {showModal && <CreateModal onClose={() => setShowModal(false)} onCreated={handleCreated} />}

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: '#f0f0f5' }}>Classes</h1>
          <p className="text-sm mt-1" style={{ color: '#8b8b9b' }}>Manage class groups, members, reminders and todos</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={refresh} disabled={refreshing}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm transition-all"
            style={{ background: 'rgba(255,255,255,0.05)', color: '#8b8b9b', border: '1px solid rgba(255,255,255,0.08)' }}>
            <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
          <button onClick={() => setShowModal(true)}
            className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all"
            style={{ background: 'rgba(99,102,241,0.15)', color: '#818cf8', border: '1px solid rgba(99,102,241,0.25)' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(99,102,241,0.25)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(99,102,241,0.15)'; }}>
            <Plus size={15} />
            Create Class
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4">
        {[
          { icon: <Building2 size={18} />, color: '#06b6d4', bg: 'rgba(6,182,212,0.15)', value: classes.length, label: 'Total Classes' },
          { icon: <Users size={18} />, color: '#818cf8', bg: 'rgba(99,102,241,0.15)', value: totalMembers, label: 'Total Members' },
        ].map(({ icon, color, bg, value, label }, i) => (
          <div key={label} className="rounded-xl p-5 flex items-center gap-4 card-hover animate-fadeInUp"
            style={{ background: '#111116', border: '1px solid rgba(255,255,255,0.07)', boxShadow: '0 1px 3px rgba(0,0,0,0.4), 0 8px 24px rgba(0,0,0,0.2)', animationDelay: `${i * 80}ms` }}>
            <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: bg, color }}>{icon}</div>
            <div>
              <div className="text-2xl font-bold" style={{ color: '#f0f0f5' }}>{value}</div>
              <div className="text-sm" style={{ color: '#8b8b9b' }}>{label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Search */}
      <div className="relative" style={{ maxWidth: '380px' }}>
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: '#4a4a5e' }} />
        <input type="text" placeholder="Search classes..." value={search} onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-9 pr-4 py-2.5 text-sm outline-none transition-all"
          style={{ background: '#111116', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '8px', color: '#f0f0f5' }}
          onFocus={(e) => { e.currentTarget.style.borderColor = 'rgba(99,102,241,0.4)'; }}
          onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)'; }} />
      </div>

      {/* Table */}
      <div className="rounded-xl overflow-hidden"
        style={{ background: '#111116', border: '1px solid rgba(255,255,255,0.07)', boxShadow: '0 1px 3px rgba(0,0,0,0.4), 0 8px 24px rgba(0,0,0,0.2)' }}>
        <div className="overflow-x-auto scroll-touch">
          <table className="w-full">
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                {[
                  { label: '', cls: '' },
                  { label: 'Class', cls: '' },
                  { label: 'Code', cls: 'hidden sm:table-cell' },
                  { label: 'WebUntis ID', cls: 'hidden md:table-cell' },
                  { label: 'Members', cls: '' },
                  { label: 'Created By', cls: 'hidden md:table-cell' },
                  { label: 'Created', cls: 'hidden md:table-cell' },
                  { label: '', cls: '' },
                ].map(({ label, cls }, i) => (
                  <th key={i} className={`px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider ${cls}`} style={{ color: '#4a4a5e' }}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                    {[
                      { cls: '' },
                      { cls: '' },
                      { cls: 'hidden sm:table-cell' },
                      { cls: 'hidden md:table-cell' },
                      { cls: '' },
                      { cls: 'hidden md:table-cell' },
                      { cls: 'hidden md:table-cell' },
                    ].map((col, j) => (
                      <td key={j} className={`px-4 py-4 ${col.cls}`}>
                        <div className="h-3.5 rounded animate-pulse" style={{ background: 'rgba(255,255,255,0.05)', width: '80px' }} />
                      </td>
                    ))}
                  </tr>
                ))
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-16 text-center">
                    <div className="flex flex-col items-center gap-3">
                      <Building2 size={32} style={{ color: '#4a4a5e' }} />
                      <p className="text-sm" style={{ color: '#8b8b9b' }}>
                        {search ? `No classes matching "${search}"` : 'No classes yet'}
                      </p>
                    </div>
                  </td>
                </tr>
              ) : (
                filtered.flatMap((cls) => [
                  <tr
                    key={cls.id}
                    style={{ borderBottom: expanded.has(cls.id) ? '1px solid rgba(99,102,241,0.12)' : '1px solid rgba(255,255,255,0.04)' }}
                    className="cursor-pointer transition-colors"
                    onClick={() => toggleExpanded(cls.id)}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.02)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = ''; }}
                  >
                    <td className="px-4 py-4 w-8">
                      <span style={{ color: '#4a4a5e' }}>
                        {expanded.has(cls.id) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </span>
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
                          style={{ background: avatarColor(cls.name) }}>
                          {cls.name[0]?.toUpperCase() ?? '?'}
                        </div>
                        <span className="text-sm font-medium" style={{ color: '#f0f0f5' }}>{cls.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-4 hidden sm:table-cell">
                      <code className="text-xs px-2 py-0.5 font-mono"
                        style={{ background: 'rgba(6,182,212,0.1)', color: '#06b6d4', border: '1px solid rgba(6,182,212,0.18)', borderRadius: '6px' }}>
                        {cls.code}
                      </code>
                    </td>
                    <td className="px-4 py-4 hidden md:table-cell">
                      <span className="text-sm font-mono" style={{ color: '#8b8b9b' }}>{cls.webuntisKlasseId || '—'}</span>
                    </td>
                    <td className="px-4 py-4">
                      <span className="text-xs px-2 py-0.5 font-medium"
                        style={{ background: 'rgba(99,102,241,0.12)', color: '#818cf8', borderRadius: '6px' }}>
                        {cls.memberCount}
                      </span>
                    </td>
                    <td className="px-4 py-4 hidden md:table-cell">
                      <span className="text-sm" style={{ color: '#8b8b9b' }}>{cls.createdByName}</span>
                    </td>
                    <td className="px-4 py-4 hidden md:table-cell">
                      <span className="text-sm" style={{ color: '#4a4a5e' }}>{relativeDate(cls.createdAt)}</span>
                    </td>
                    <td className="px-4 py-4" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => void handleDeleteClass(cls.id, cls.name)}
                        disabled={deletingId === cls.id}
                        className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs transition-all disabled:opacity-50"
                        style={confirmDeleteId === cls.id
                          ? { background: 'rgba(239,68,68,0.25)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.4)' }
                          : { background: 'rgba(239,68,68,0.08)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.15)' }}
                        onMouseEnter={(e) => { if (deletingId !== cls.id) e.currentTarget.style.background = 'rgba(239,68,68,0.2)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = confirmDeleteId === cls.id ? 'rgba(239,68,68,0.25)' : 'rgba(239,68,68,0.08)'; }}
                      >
                        {deletingId === cls.id
                          ? <Loader2 size={11} className="animate-spin" />
                          : <Trash2 size={11} />}
                        {confirmDeleteId === cls.id ? 'Confirm?' : 'Delete'}
                      </button>
                    </td>
                  </tr>,

                  expanded.has(cls.id) && (
                    <tr key={`${cls.id}-detail`} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                      <td colSpan={8} className="px-6 py-4">
                        <ClassDetail
                          cls={cls}
                          onMemberRemoved={handleMemberRemoved}
                          onMemberAdded={handleMemberAdded}
                        />
                      </td>
                    </tr>
                  ),
                ].filter(Boolean))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
