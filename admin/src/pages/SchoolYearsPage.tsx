import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Archive, Users, Building2, CheckSquare, Bell, Search,
  ChevronLeft, ChevronRight, RefreshCw, AlertTriangle, CheckCircle2,
  Clock, RotateCcw,
} from 'lucide-react';
import { adminApi } from '../api';
import type {
  SchoolYearMeta, ArchivedUser, ArchivedClass, ArchivedTodo, ArchivedReminder,
} from '../types';

type DataTab = 'users' | 'classes' | 'todos' | 'reminders';
const PAGE_SIZE = 50;

const dimText = { color: 'rgba(235,235,245,0.4)' };

// ─── helpers ─────────────────────────────────────────────────────────────────

function Pagination({ page, total, limit, onPage }: { page: number; total: number; limit: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / limit));
  if (pages <= 1) return null;
  return (
    <div className="flex items-center gap-2 text-sm" style={dimText}>
      <button disabled={page <= 1} onClick={() => onPage(page - 1)}
        className="p-1.5 rounded-[8px] disabled:opacity-30" style={{ background: 'rgba(255,255,255,0.06)' }}>
        <ChevronLeft size={14} />
      </button>
      <span className="text-[13px]">{page} / {pages}</span>
      <button disabled={page >= pages} onClick={() => onPage(page + 1)}
        className="p-1.5 rounded-[8px] disabled:opacity-30" style={{ background: 'rgba(255,255,255,0.06)' }}>
        <ChevronRight size={14} />
      </button>
      <span className="text-[12px] ml-1">{total} gesamt</span>
    </div>
  );
}

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium"
      style={{ background: `${color}22`, color }}>{label}</span>
  );
}

function TableHead({ children }: { children: React.ReactNode }) {
  return (
    <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', color: 'rgba(235,235,245,0.35)' }}>
      {children}
    </tr>
  );
}

const th = 'px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.05em]';
const td = 'px-4 py-3 text-[13px]';

// ─── sub-views ────────────────────────────────────────────────────────────────

function UsersTab({ yearId }: { yearId: string }) {
  const [users, setUsers] = useState<ArchivedUser[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (p: number, s: string) => {
    setLoading(true);
    try {
      const r = await adminApi.archivedUsers(yearId, { page: p, limit: PAGE_SIZE, search: s || undefined });
      setUsers(r.users); setTotal(r.total);
    } finally { setLoading(false); }
  }, [yearId]);

  useEffect(() => { void load(1, ''); }, [load]);

  function handleSearch(v: string) {
    setSearch(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { setPage(1); void load(1, v); }, 350);
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-[300px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={dimText} />
          <input type="text" value={search} onChange={(e) => handleSearch(e.target.value)}
            placeholder="Nutzer suchen…"
            className="w-full pl-9 pr-3 py-2 rounded-[10px] text-[13px] text-white placeholder-[rgba(235,235,245,0.3)] outline-none"
            style={{ background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.08)' }} />
        </div>
        <button onClick={() => void load(page, search)} className="p-2 rounded-[10px]"
          style={{ background: 'rgba(255,255,255,0.07)', color: 'rgba(235,235,245,0.5)' }}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
      <div className="rounded-[14px] overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.07)', background: '#0d0d0d' }}>
        <table className="w-full border-collapse">
          <thead><TableHead>
            <th className={th}>Benutzername</th>
            <th className={th}>Rolle</th>
            <th className={th}>Klasse</th>
            <th className={th}>WebUntis-ID</th>
            <th className={th}>Erstellt</th>
          </TableHead></thead>
          <tbody>
            {!loading && users.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-[13px]" style={dimText}>Keine Nutzer</td></tr>
            )}
            {users.map((u) => (
              <tr key={u.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }} className="hover:bg-white/[0.02]">
                <td className={`${td} font-medium text-white`}>{u.username}</td>
                <td className={td}>
                  {u.role === 'parent'
                    ? <Badge label="Elternteil" color="#bf5af2" />
                    : <Badge label="Schüler:in" color="#30d158" />}
                </td>
                <td className={td} style={dimText}>{u.className ?? '—'}{u.classCode ? ` (${u.classCode})` : ''}</td>
                <td className={td} style={dimText}>{u.webuntisKlasseId || '—'}</td>
                <td className={`${td} text-[12px]`} style={dimText}>{new Date(u.createdAt).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: '2-digit' })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex justify-end mt-4">
        <Pagination page={page} total={total} limit={PAGE_SIZE} onPage={(p) => { setPage(p); void load(p, search); }} />
      </div>
    </div>
  );
}

function ClassesTab({ yearId }: { yearId: string }) {
  const [classes, setClasses] = useState<ArchivedClass[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    adminApi.archivedClasses(yearId).then((r) => setClasses(r)).finally(() => setLoading(false));
  }, [yearId]);

  if (loading) return <p className="py-8 text-center text-[13px]" style={dimText}>Laden…</p>;
  if (!classes.length) return <p className="py-8 text-center text-[13px]" style={dimText}>Keine Klassen</p>;

  return (
    <div className="flex flex-col gap-3">
      {classes.map((c) => (
        <div key={c.id} className="rounded-[14px] overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.07)', background: '#0d0d0d' }}>
          <button onClick={() => setExpanded(expanded === c.id ? null : c.id)}
            className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-white/[0.02] transition-colors">
            <div className="flex items-center gap-3">
              <Building2 size={15} style={{ color: '#0a84ff' }} />
              <span className="font-medium text-white text-[14px]">{c.name}</span>
              <span className="text-[12px] px-2 py-0.5 rounded-[6px]" style={{ background: 'rgba(255,255,255,0.08)', color: 'rgba(235,235,245,0.5)' }}>{c.code}</span>
            </div>
            <span className="text-[12px]" style={dimText}>{c.memberCount} Mitglieder</span>
          </button>
          {expanded === c.id && c.members.length > 0 && (
            <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
              {c.members.map((m) => (
                <div key={m.stableUid} className="flex items-center gap-3 px-4 py-2" style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                  <span className="text-[13px] text-white flex-1">{m.username}</span>
                  {m.role === 'parent' ? <Badge label="Elternteil" color="#bf5af2" /> : <Badge label="Schüler:in" color="#30d158" />}
                  <span className="text-[12px]" style={dimText}>{new Date(m.joinedAt).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: '2-digit' })}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function TodosTab({ yearId }: { yearId: string }) {
  const [todos, setTodos] = useState<ArchivedTodo[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (p: number, s: string, st: string) => {
    setLoading(true);
    try {
      const r = await adminApi.archivedTodos(yearId, { page: p, limit: PAGE_SIZE, search: s || undefined, status: st });
      setTodos(r.todos); setTotal(r.total);
    } finally { setLoading(false); }
  }, [yearId]);

  useEffect(() => { void load(1, '', 'all'); }, [load]);

  function handleSearch(v: string) {
    setSearch(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { setPage(1); void load(1, v, status); }, 350);
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-[300px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={dimText} />
          <input type="text" value={search} onChange={(e) => handleSearch(e.target.value)}
            placeholder="Todos suchen…"
            className="w-full pl-9 pr-3 py-2 rounded-[10px] text-[13px] text-white placeholder-[rgba(235,235,245,0.3)] outline-none"
            style={{ background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.08)' }} />
        </div>
        <div className="flex gap-1 p-0.5 rounded-[10px]" style={{ background: 'rgba(255,255,255,0.06)' }}>
          {(['all', 'active', 'done', 'archived'] as const).map((s) => (
            <button key={s} onClick={() => { setStatus(s); setPage(1); void load(1, search, s); }}
              className="px-3 py-1.5 rounded-[8px] text-[12px] font-medium"
              style={status === s ? { background: 'rgba(255,255,255,0.12)', color: '#fff' } : { color: 'rgba(235,235,245,0.45)' }}>
              {{ all: 'Alle', active: 'Aktiv', done: 'Erledigt', archived: 'Archiviert' }[s]}
            </button>
          ))}
        </div>
      </div>
      <div className="rounded-[14px] overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.07)', background: '#0d0d0d' }}>
        <table className="w-full border-collapse">
          <thead><TableHead>
            <th className={th}>Titel</th>
            <th className={th}>Nutzer</th>
            <th className={th}>Fällig</th>
            <th className={th}>Status</th>
          </TableHead></thead>
          <tbody>
            {!loading && todos.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-8 text-center text-[13px]" style={dimText}>Keine Todos</td></tr>
            )}
            {todos.map((t) => (
              <tr key={t.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }} className="hover:bg-white/[0.02]">
                <td className={td}>
                  <span className="font-medium text-white">{t.title}</span>
                  {t.details && <p className="text-[12px] truncate max-w-[260px]" style={dimText}>{t.details}</p>}
                </td>
                <td className={td} style={dimText}>{t.username}</td>
                <td className={td}>
                  {t.dueAt
                    ? <span className="flex items-center gap-1 text-[12px]" style={dimText}><Clock size={12} />{new Date(t.dueAt).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: '2-digit' })}</span>
                    : <span style={dimText}>—</span>}
                </td>
                <td className={td}>
                  {t.archivedAt ? <Badge label="Archiviert" color="#8e8e93" />
                    : t.done ? <Badge label="Erledigt" color="#30d158" />
                    : <Badge label="Aktiv" color="#0a84ff" />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex justify-end mt-4">
        <Pagination page={page} total={total} limit={PAGE_SIZE} onPage={(p) => { setPage(p); void load(p, search, status); }} />
      </div>
    </div>
  );
}

function RemindersTab({ yearId }: { yearId: string }) {
  const [reminders, setReminders] = useState<ArchivedReminder[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (p: number, s: string, st: string) => {
    setLoading(true);
    try {
      const r = await adminApi.archivedReminders(yearId, { page: p, limit: PAGE_SIZE, search: s || undefined, status: st });
      setReminders(r.reminders); setTotal(r.total);
    } finally { setLoading(false); }
  }, [yearId]);

  useEffect(() => { void load(1, '', 'all'); }, [load]);

  function handleSearch(v: string) {
    setSearch(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { setPage(1); void load(1, v, status); }, 350);
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-[300px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={dimText} />
          <input type="text" value={search} onChange={(e) => handleSearch(e.target.value)}
            placeholder="Erinnerungen suchen…"
            className="w-full pl-9 pr-3 py-2 rounded-[10px] text-[13px] text-white placeholder-[rgba(235,235,245,0.3)] outline-none"
            style={{ background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.08)' }} />
        </div>
        <div className="flex gap-1 p-0.5 rounded-[10px]" style={{ background: 'rgba(255,255,255,0.06)' }}>
          {(['all', 'active', 'archived'] as const).map((s) => (
            <button key={s} onClick={() => { setStatus(s); setPage(1); void load(1, search, s); }}
              className="px-3 py-1.5 rounded-[8px] text-[12px] font-medium"
              style={status === s ? { background: 'rgba(255,255,255,0.12)', color: '#fff' } : { color: 'rgba(235,235,245,0.45)' }}>
              {{ all: 'Alle', active: 'Aktiv', archived: 'Archiviert' }[s]}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-3">
        {!loading && reminders.length === 0 && (
          <p className="py-8 text-center text-[13px]" style={dimText}>Keine Erinnerungen</p>
        )}
        {reminders.map((r) => (
          <div key={r.id} className="rounded-[14px] p-4" style={{ border: '1px solid rgba(255,255,255,0.07)', background: '#0d0d0d' }}>
            <div className="flex items-start justify-between gap-3 mb-1">
              <div>
                <span className="font-medium text-white text-[14px]">{r.title}</span>
                {r.body && <p className="text-[13px] mt-0.5" style={dimText}>{r.body}</p>}
              </div>
              {r.archivedAt ? <Badge label="Archiviert" color="#8e8e93" /> : <Badge label="Aktiv" color="#0a84ff" />}
            </div>
            <div className="flex flex-wrap gap-4 mt-2 text-[12px]" style={dimText}>
              <span className="flex items-center gap-1"><Building2 size={11} />{r.className}</span>
              <span className="flex items-center gap-1"><Clock size={11} />{new Date(r.remindAt).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
              {r.createdByUsername && <span>von {r.createdByUsername}</span>}
            </div>
            {r.comments.length > 0 && (
              <div className="mt-3 pt-3 flex flex-col gap-2" style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                {r.comments.map((c) => (
                  <div key={c.id} className="flex gap-2 text-[12px]">
                    <span style={{ color: '#0a84ff' }}>{c.username}</span>
                    <span style={dimText}>{c.body}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="flex justify-end mt-4">
        <Pagination page={page} total={total} limit={PAGE_SIZE} onPage={(p) => { setPage(p); void load(p, search, status); }} />
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function SchoolYearsPage() {
  const [currentLabel, setCurrentLabel] = useState('');
  const [archived, setArchived] = useState<SchoolYearMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dataTab, setDataTab] = useState<DataTab>('users');

  const [rolling, setRolling] = useState(false);
  const [rolloverError, setRolloverError] = useState<string | null>(null);
  const [rolloverSuccess, setRolloverSuccess] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await adminApi.schoolYears();
      setCurrentLabel(r.current.label);
      setArchived(r.archived);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function handleRollover() {
    const ok = window.confirm(
      `⚠️ Schuljahreswechsel durchführen?\n\nDas archiviert alle Schüler, Klassen, Todos und Erinnerungen des aktuellen Schuljahres (${currentLabel}) und startet das neue Jahr mit leeren Listen.\n\nDieser Vorgang kann NICHT rückgängig gemacht werden!`
    );
    if (!ok) return;
    setRolling(true); setRolloverError(null); setRolloverSuccess(null);
    try {
      const r = await adminApi.rolloverSchoolYear();
      setRolloverSuccess(`Schuljahr ${r.label} archiviert: ${r.usersArchived} Nutzer, ${r.classesArchived} Klassen, ${r.todosArchived} Todos, ${r.remindersArchived} Erinnerungen`);
      await load();
    } catch (err) {
      setRolloverError(err instanceof Error ? err.message : 'Fehler beim Schuljahreswechsel');
    } finally { setRolling(false); }
  }

  const selectedYear = archived.find((y) => y.id === selectedId);

  const dataTabs: { key: DataTab; label: string; icon: React.ReactNode }[] = [
    { key: 'users',     label: 'Schüler',       icon: <Users size={14} /> },
    { key: 'classes',   label: 'Klassen',        icon: <Building2 size={14} /> },
    { key: 'todos',     label: 'Todos',          icon: <CheckSquare size={14} /> },
    { key: 'reminders', label: 'Erinnerungen',   icon: <Bell size={14} /> },
  ];

  return (
    <div>
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-[22px] font-bold text-white tracking-[-0.02em]">Schuljahre</h1>
          <p className="text-[13px] mt-1" style={dimText}>Archivierte Schuljahre anzeigen und neues Schuljahr starten</p>
        </div>
        <button
          onClick={() => void handleRollover()}
          disabled={rolling}
          className="flex items-center gap-2 px-4 py-2.5 rounded-[10px] text-[13px] font-medium transition-all disabled:opacity-50 flex-shrink-0"
          style={{ background: 'rgba(255,69,58,0.12)', color: '#ff453a', border: '1px solid rgba(255,69,58,0.22)' }}
        >
          <RotateCcw size={14} />
          {rolling ? 'Läuft…' : 'Schuljahreswechsel'}
        </button>
      </div>

      {/* Feedback */}
      {rolloverError && (
        <div className="flex items-center gap-2 mb-4 px-3 py-2.5 rounded-[10px] text-[13px]"
          style={{ background: 'rgba(255,69,58,0.1)', color: '#ff453a', border: '1px solid rgba(255,69,58,0.2)' }}>
          <AlertTriangle size={14} />{rolloverError}
        </div>
      )}
      {rolloverSuccess && (
        <div className="flex items-center gap-2 mb-4 px-3 py-2.5 rounded-[10px] text-[13px]"
          style={{ background: 'rgba(48,209,88,0.1)', color: '#30d158', border: '1px solid rgba(48,209,88,0.2)' }}>
          <CheckCircle2 size={14} />{rolloverSuccess}
        </div>
      )}

      {/* Current year card */}
      <div className="mb-5 p-4 rounded-[14px] flex items-center gap-3"
        style={{ background: 'rgba(10,132,255,0.08)', border: '1px solid rgba(10,132,255,0.18)' }}>
        <div className="w-9 h-9 rounded-[10px] flex items-center justify-center flex-shrink-0"
          style={{ background: 'rgba(10,132,255,0.15)', border: '1px solid rgba(10,132,255,0.25)' }}>
          <Archive size={16} style={{ color: '#0a84ff' }} />
        </div>
        <div>
          <div className="text-[15px] font-semibold text-white">Aktuelles Schuljahr: {currentLabel}</div>
          <div className="text-[12px] mt-0.5" style={dimText}>Live-Daten — wechsle zu einem archivierten Jahr um vergangene Daten einzusehen</div>
        </div>
      </div>

      {loading && <p className="text-[13px] py-8 text-center" style={dimText}>Laden…</p>}

      {!loading && archived.length === 0 && (
        <div className="rounded-[14px] p-8 text-center" style={{ border: '1px solid rgba(255,255,255,0.07)', background: '#0d0d0d' }}>
          <Archive size={28} className="mx-auto mb-3" style={{ color: 'rgba(235,235,245,0.2)' }} />
          <p className="text-[14px] text-white font-medium mb-1">Noch keine archivierten Schuljahre</p>
          <p className="text-[13px]" style={dimText}>Am 1. August wird automatisch ein Archiv des aktuellen Schuljahres erstellt.<br />Mit dem Button oben rechts kann der Wechsel auch manuell ausgelöst werden.</p>
        </div>
      )}

      {!loading && archived.length > 0 && (
        <div className="flex gap-4">
          {/* Year list */}
          <div className="w-48 flex-shrink-0 flex flex-col gap-1.5">
            {archived.map((y) => (
              <button key={y.id}
                onClick={() => { setSelectedId(y.id); setDataTab('users'); }}
                className="flex items-center gap-2.5 px-3 py-2.5 rounded-[10px] text-left transition-all text-[13px]"
                style={selectedId === y.id
                  ? { background: 'rgba(10,132,255,0.14)', color: '#0a84ff' }
                  : { color: 'rgba(235,235,245,0.5)', background: 'rgba(255,255,255,0.04)' }}>
                <Archive size={14} />
                <div>
                  <div className="font-medium">{y.label}</div>
                  <div className="text-[11px] opacity-60">{new Date(y.rolledAt).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: '2-digit' })}</div>
                </div>
              </button>
            ))}
          </div>

          {/* Year content */}
          <div className="flex-1 min-w-0">
            {!selectedId && (
              <div className="rounded-[14px] p-8 text-center" style={{ border: '1px solid rgba(255,255,255,0.07)', background: '#0d0d0d' }}>
                <p className="text-[13px]" style={dimText}>Schuljahr auswählen um die archivierten Daten anzuzeigen</p>
              </div>
            )}
            {selectedId && selectedYear && (
              <div>
                {/* Year meta */}
                <div className="mb-4 flex items-center justify-between">
                  <div>
                    <h2 className="text-[17px] font-bold text-white">Schuljahr {selectedYear.label}</h2>
                    <p className="text-[12px] mt-0.5" style={dimText}>
                      Archiviert am {new Date(selectedYear.rolledAt).toLocaleDateString('de-AT', { day: '2-digit', month: 'long', year: 'numeric' })}
                      {selectedYear.note ? ` · ${selectedYear.note}` : ''}
                    </p>
                  </div>
                </div>

                {/* Data tabs */}
                <div className="flex gap-1 mb-4 p-1 rounded-[12px] w-fit" style={{ background: 'rgba(255,255,255,0.06)' }}>
                  {dataTabs.map(({ key, label, icon }) => (
                    <button key={key} onClick={() => setDataTab(key)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-[9px] text-[12px] font-medium transition-all"
                      style={dataTab === key ? { background: '#0a84ff', color: '#fff' } : { color: 'rgba(235,235,245,0.5)' }}>
                      {icon}{label}
                    </button>
                  ))}
                </div>

                {dataTab === 'users'     && <UsersTab     yearId={selectedId} />}
                {dataTab === 'classes'   && <ClassesTab   yearId={selectedId} />}
                {dataTab === 'todos'     && <TodosTab     yearId={selectedId} />}
                {dataTab === 'reminders' && <RemindersTab yearId={selectedId} />}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
