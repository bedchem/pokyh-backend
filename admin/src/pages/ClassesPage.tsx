import { useEffect, useState, useCallback } from 'react';
import {
  Building2, Users, ChevronDown, ChevronRight, Search, Plus, X,
  RefreshCw, UserMinus, UserPlus, Bell, Clock, Loader2, Trash2,
} from 'lucide-react';
import { adminApi } from '../api';
import { useToast } from '../components/Toast';
import { useAutoRefresh } from '../hooks/useAutoRefresh';
import type { AdminClass, AdminReminder } from '../types';

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
        className="w-full max-w-md rounded-2xl p-6"
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

// ─── Expanded class detail panel ──────────────────────────────────────────────

interface ClassDetailProps {
  cls: AdminClass;
  onMemberRemoved: (classId: string, stableUid: string) => void;
  onMemberAdded: (classId: string, member: { stableUid: string; username: string; joinedAt: string }) => void;
}

function ClassDetail({ cls, onMemberRemoved, onMemberAdded }: ClassDetailProps) {
  const { showToast } = useToast();
  const [reminders, setReminders] = useState<AdminReminder[] | null>(null);
  const [loadingReminders, setLoadingReminders] = useState(true);
  const [removingUid, setRemovingUid] = useState<string | null>(null);
  const [addUsername, setAddUsername] = useState('');
  const [adding, setAdding] = useState(false);
  const [tab, setTab] = useState<'members' | 'reminders'>('members');

  useEffect(() => {
    adminApi.classReminders(cls.id)
      .then(setReminders)
      .catch(() => setReminders([]))
      .finally(() => setLoadingReminders(false));
  }, [cls.id]);

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

  return (
    <div className="rounded-xl p-4" style={{ background: 'rgba(99,102,241,0.04)', border: '1px solid rgba(99,102,241,0.1)' }}>
      {/* Tab bar */}
      <div className="flex items-center gap-1 mb-4">
        {(['members', 'reminders'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold uppercase tracking-wider transition-all"
            style={tab === t
              ? { background: 'rgba(99,102,241,0.2)', color: '#818cf8', border: '1px solid rgba(99,102,241,0.3)' }
              : { background: 'transparent', color: '#4a4a5e', border: '1px solid transparent' }}
          >
            {t === 'members' ? <><Users size={11} /> Members ({cls.members.length})</> : <><Bell size={11} /> Reminders ({reminders?.length ?? '…'})</>}
          </button>
        ))}
      </div>

      {tab === 'members' && (
        <div className="flex flex-col gap-3">
          {/* Add member */}
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

          {/* Members list */}
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

      {tab === 'reminders' && (
        <div className="flex flex-col gap-2">
          {loadingReminders ? (
            <div className="flex items-center gap-2 py-2" style={{ color: '#4a4a5e' }}>
              <Loader2 size={13} className="animate-spin" /> Loading…
            </div>
          ) : !reminders || reminders.length === 0 ? (
            <p className="text-sm py-2" style={{ color: '#4a4a5e' }}>No reminders in this class</p>
          ) : (
            reminders.map((r) => {
              const isPast = new Date(r.remindAt) < new Date();
              return (
                <div
                  key={r.id}
                  className="flex flex-col gap-1 px-3 py-2.5 rounded-lg"
                  style={{ background: 'rgba(255,255,255,0.03)', border: `1px solid ${isPast ? 'rgba(239,68,68,0.12)' : 'rgba(255,255,255,0.05)'}` }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-medium" style={{ color: '#f0f0f5' }}>{r.title}</span>
                    <span
                      className="text-xs px-1.5 py-0.5 rounded flex items-center gap-1 flex-shrink-0"
                      style={isPast
                        ? { background: 'rgba(239,68,68,0.1)', color: '#f87171' }
                        : { background: 'rgba(16,185,129,0.1)', color: '#10b981' }}
                    >
                      <Clock size={9} />
                      {formatRemindAt(r.remindAt)}
                    </span>
                  </div>
                  {r.body && <p className="text-xs" style={{ color: '#8b8b9b' }}>{r.body}</p>}
                  <p className="text-xs" style={{ color: '#4a4a5e' }}>by {r.createdByUsername}</p>
                </div>
              );
            })
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
    <div className="flex flex-col gap-6">
      {showModal && <CreateModal onClose={() => setShowModal(false)} onCreated={handleCreated} />}

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: '#f0f0f5' }}>Classes</h1>
          <p className="text-sm mt-1" style={{ color: '#8b8b9b' }}>Manage class groups, members and reminders</p>
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
        ].map(({ icon, color, bg, value, label }) => (
          <div key={label} className="rounded-xl p-5 flex items-center gap-4"
            style={{ background: '#111116', border: '1px solid rgba(255,255,255,0.07)', boxShadow: '0 1px 3px rgba(0,0,0,0.4), 0 8px 24px rgba(0,0,0,0.2)' }}>
            <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: bg, color }}>{icon}</div>
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
        <div className="overflow-x-auto">
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
