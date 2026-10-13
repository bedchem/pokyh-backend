import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Archive, Users, Building2, CheckSquare, Bell, Search,
  ChevronLeft, ChevronRight, RefreshCw, AlertTriangle, CheckCircle2,
  Clock, RotateCcw, Undo2, CalendarRange, History,
} from 'lucide-react';
import { Delta, Empty, Figures, Notice, PageHeader, Section, Segmented, Spinner } from '../components/kit';
import { adminApi } from '../api';
import type {
  SchoolYearMeta, ArchivedUser, ArchivedClass, ArchivedTodo, ArchivedReminder,
} from '../types';

type DataTab = 'users' | 'classes' | 'todos' | 'reminders';
const PAGE_SIZE = 50;

const dimText = { color: 'rgb(var(--ink-rgb) / 0.58)' };

// ─── helpers ─────────────────────────────────────────────────────────────────

function Pagination({ page, total, limit, onPage }: { page: number; total: number; limit: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / limit));
  if (pages <= 1) return null;
  return (
    <div className="flex items-center gap-2 text-sm" style={dimText}>
      <button disabled={page <= 1} onClick={() => onPage(page - 1)}
        className="p-1.5 rounded-full disabled:opacity-30" style={{ background: 'rgb(var(--ink-rgb) / calc(0.048 * var(--veil)))' }}>
        <ChevronLeft size={14} />
      </button>
      <span className="text-[13px]">{page} / {pages}</span>
      <button disabled={page >= pages} onClick={() => onPage(page + 1)}
        className="p-1.5 rounded-full disabled:opacity-30" style={{ background: 'rgb(var(--ink-rgb) / calc(0.048 * var(--veil)))' }}>
        <ChevronRight size={14} />
      </button>
      <span className="text-[12px] ml-1">{total} gesamt</span>
    </div>
  );
}

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium"
      style={{ background: `color-mix(in srgb, ${color} 13%, transparent)`, color }}>{label}</span>
  );
}

function TableHead({ children }: { children: React.ReactNode }) {
  return (
    <tr style={{ borderBottom: '1px solid rgb(var(--ink-rgb) / calc(0.076 * var(--veil)))', color: 'rgb(var(--ink-rgb) / 0.54)' }}>
      {children}
    </tr>
  );
}

const th = 'px-4 py-2.5 text-left text-[13px]';
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
            className="field h-11 pl-11 pr-4 text-[14px] w-full" />
        </div>
        <button onClick={() => void load(page, search)} className="p-2 rounded-full"
          style={{ background: 'rgb(var(--ink-rgb) / calc(0.056 * var(--veil)))', color: 'rgb(var(--ink-rgb) / 0.66)' }}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
      <div className="tbl-scroll">
        <table className="tbl">
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
              <tr key={u.id} style={{ borderBottom: '1px solid rgb(var(--ink-rgb) / calc(0.054 * var(--veil)))' }} className="hover:bg-ink/[0.05]">
                <td className={`${td} font-medium text-ink`}>{u.username}</td>
                <td className={td}>
                  {u.role === 'parent'
                    ? <Badge label="Elternteil" color="var(--violet-deep)" />
                    : <Badge label="Schüler:in" color="var(--mint-deep)" />}
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
        <div key={c.id} className="rounded-[14px] overflow-hidden" style={{ border: '1px solid transparent', background: 'rgb(var(--ink-rgb) / calc(0.05 * var(--veil)))' }}>
          <button onClick={() => setExpanded(expanded === c.id ? null : c.id)}
            className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-ink/[0.05] transition-colors">
            <div className="flex items-center gap-3">
              <Building2 size={15} style={{ color: 'var(--sky-deep)' }} />
              <span className="font-medium text-ink text-[14px]">{c.name}</span>
              <span className="text-[12px] px-2 py-0.5 rounded-[8px]" style={{ background: 'rgb(var(--ink-rgb) / calc(0.064 * var(--veil)))', color: 'rgb(var(--ink-rgb) / 0.66)' }}>{c.code}</span>
            </div>
            <span className="text-[12px]" style={dimText}>{c.memberCount} Mitglieder</span>
          </button>
          {expanded === c.id && c.members.length > 0 && (
            <div style={{ borderTop: '1px solid rgb(var(--ink-rgb) / calc(0.076 * var(--veil)))' }}>
              {c.members.map((m) => (
                <div key={m.stableUid} className="flex items-center gap-3 px-4 py-2" style={{ borderBottom: '1px solid rgb(var(--ink-rgb) / calc(0.043 * var(--veil)))' }}>
                  <span className="text-[13px] text-ink flex-1">{m.username}</span>
                  {m.role === 'parent' ? <Badge label="Elternteil" color="var(--violet-deep)" /> : <Badge label="Schüler:in" color="var(--mint-deep)" />}
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
            className="field h-11 pl-11 pr-4 text-[14px] w-full" />
        </div>
        <div className="flex gap-1 p-0.5 rounded-[12px]" style={{ background: 'rgb(var(--ink-rgb) / calc(0.048 * var(--veil)))' }}>
          {(['all', 'active', 'done', 'archived'] as const).map((s) => (
            <button key={s} onClick={() => { setStatus(s); setPage(1); void load(1, search, s); }}
              className="px-3 py-1.5 rounded-full text-[12px] font-medium"
              style={status === s ? { background: 'rgb(var(--ink-rgb) / calc(0.096 * var(--veil)))', color: 'var(--ink)' } : { color: 'rgb(var(--ink-rgb) / 0.62)' }}>
              {{ all: 'Alle', active: 'Aktiv', done: 'Erledigt', archived: 'Archiviert' }[s]}
            </button>
          ))}
        </div>
      </div>
      <div className="tbl-scroll">
        <table className="tbl">
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
              <tr key={t.id} style={{ borderBottom: '1px solid rgb(var(--ink-rgb) / calc(0.054 * var(--veil)))' }} className="hover:bg-ink/[0.05]">
                <td className={td}>
                  <span className="font-medium text-ink">{t.title}</span>
                  {t.details && <p className="text-[12px] truncate max-w-[260px]" style={dimText}>{t.details}</p>}
                </td>
                <td className={td} style={dimText}>{t.username}</td>
                <td className={td}>
                  {t.dueAt
                    ? <span className="flex items-center gap-1 text-[12px]" style={dimText}><Clock size={12} />{new Date(t.dueAt).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: '2-digit' })}</span>
                    : <span style={dimText}>—</span>}
                </td>
                <td className={td}>
                  {t.archivedAt ? <Badge label="Archiviert" color="var(--ink-3)" />
                    : t.done ? <Badge label="Erledigt" color="var(--mint-deep)" />
                    : <Badge label="Aktiv" color="var(--sky-deep)" />}
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
            className="field h-11 pl-11 pr-4 text-[14px] w-full" />
        </div>
        <div className="flex gap-1 p-0.5 rounded-[12px]" style={{ background: 'rgb(var(--ink-rgb) / calc(0.048 * var(--veil)))' }}>
          {(['all', 'active', 'archived'] as const).map((s) => (
            <button key={s} onClick={() => { setStatus(s); setPage(1); void load(1, search, s); }}
              className="px-3 py-1.5 rounded-full text-[12px] font-medium"
              style={status === s ? { background: 'rgb(var(--ink-rgb) / calc(0.096 * var(--veil)))', color: 'var(--ink)' } : { color: 'rgb(var(--ink-rgb) / 0.62)' }}>
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
          <div key={r.id} className="rounded-[14px] p-4" style={{ border: '1px solid transparent', background: 'rgb(var(--ink-rgb) / calc(0.05 * var(--veil)))' }}>
            <div className="flex items-start justify-between gap-3 mb-1">
              <div>
                <span className="font-medium text-ink text-[14px]">{r.title}</span>
                {r.body && <p className="text-[13px] mt-0.5" style={dimText}>{r.body}</p>}
              </div>
              {r.archivedAt ? <Badge label="Archiviert" color="var(--ink-3)" /> : <Badge label="Aktiv" color="var(--sky-deep)" />}
            </div>
            <div className="flex flex-wrap gap-4 mt-2 text-[12px]" style={dimText}>
              <span className="flex items-center gap-1"><Building2 size={11} />{r.className}</span>
              <span className="flex items-center gap-1"><Clock size={11} />{new Date(r.remindAt).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
              {r.createdByUsername && <span>von {r.createdByUsername}</span>}
            </div>
            {r.comments.length > 0 && (
              <div className="mt-3 pt-3 flex flex-col gap-2" style={{ borderTop: '1px solid rgb(var(--ink-rgb) / calc(0.065 * var(--veil)))' }}>
                {r.comments.map((c) => (
                  <div key={c.id} className="flex gap-2 text-[12px]">
                    <span style={{ color: 'var(--sky-deep)' }}>{c.username}</span>
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
  const [rollingBack, setRollingBack] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await adminApi.schoolYears();
      setCurrentLabel(r.current.label);
      setArchived(r.archived);
    } catch (err) {
      setRolloverError(err instanceof Error ? err.message : 'Schuljahre konnten nicht geladen werden');
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

  async function handleRollback(year: SchoolYearMeta) {
    const ok = window.confirm(
      `↩️ Schuljahreswechsel rückgängig machen?\n\nDie archivierten Daten von ${year.label} werden zurück in die Live-Tabellen geschrieben und das Archiv wird gelöscht.\n\nHinweis: Passwörter und Logins werden NICHT wiederhergestellt — WebUntis-Nutzer melden sich einfach neu an, manuelle Passwörter müssen neu gesetzt werden.`
    );
    if (!ok) return;
    setRollingBack(true); setRolloverError(null); setRolloverSuccess(null);
    try {
      const r = await adminApi.rollbackSchoolYear(year.id);
      setRolloverSuccess(`Schuljahr ${r.label} wiederhergestellt: ${r.usersRestored} Nutzer, ${r.classesRestored} Klassen, ${r.todosRestored} Todos, ${r.remindersRestored} Erinnerungen`);
      setSelectedId(null);
      await load();
    } catch (err) {
      setRolloverError(err instanceof Error ? err.message : 'Fehler beim Rückgängigmachen');
    } finally { setRollingBack(false); }
  }

  const selectedYear = archived.find((y) => y.id === selectedId);
  // Only the most recently archived year (highest startYear) can be rolled back.
  const latestYearId = archived.length > 0
    ? archived.reduce((a, b) => (a.startYear >= b.startYear ? a : b)).id
    : null;

  const dataTabs: { key: DataTab; label: string; icon: React.ReactNode }[] = [
    { key: 'users',     label: 'Schüler',       icon: <Users size={14} /> },
    { key: 'classes',   label: 'Klassen',        icon: <Building2 size={14} /> },
    { key: 'todos',     label: 'Todos',          icon: <CheckSquare size={14} /> },
    { key: 'reminders', label: 'Erinnerungen',   icon: <Bell size={14} /> },
  ];

  const latestYear = archived.find((y) => y.id === latestYearId);

  return (
    <div>
      <PageHeader title="Schuljahre" subtitle="Archivierte Schuljahre anzeigen und ein neues Schuljahr starten.">
        <button type="button" onClick={() => void handleRollover()} disabled={rolling} className="btn btn-danger">
          {rolling ? <Spinner /> : <RotateCcw size={16} strokeWidth={1.7} />}
          {rolling ? 'Läuft…' : 'Schuljahreswechsel'}
        </button>
      </PageHeader>

      {(rolloverError || rolloverSuccess) && (
        <div className="mt-8 flex max-w-[820px] flex-col gap-3">
          {rolloverError && <Notice tone="rose" icon={AlertTriangle}>{rolloverError}</Notice>}
          {rolloverSuccess && <Notice tone="mint" icon={CheckCircle2}>{rolloverSuccess}</Notice>}
        </div>
      )}

      <Figures
        className="mt-10"
        items={[
          { label: 'Aktuelles Schuljahr', value: currentLabel || '–', icon: CalendarRange, note: <Delta tone="mint">Live-Daten</Delta> },
          { label: 'Archivierte Jahre', value: archived.length, icon: Archive },
          {
            label: 'Letzter Wechsel',
            value: latestYear ? new Date(latestYear.rolledAt).toLocaleDateString('de-AT', { day: 'numeric', month: 'short', year: 'numeric' }) : 'noch nie',
            icon: History,
          },
        ]}
      />

      {loading && (
        <div className="mt-10 flex gap-3">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="shimmer h-[58px] w-[132px] rounded-[18px]" />)}</div>
      )}

      {!loading && archived.length === 0 && (
        <Empty icon={Archive}>
          Noch keine archivierten Schuljahre. Am 1. August wird automatisch ein Archiv des aktuellen Schuljahres erstellt;
          mit dem Button oben rechts lässt sich der Wechsel auch manuell auslösen.
        </Empty>
      )}

      {!loading && archived.length > 0 && (
        <>
          <Section className="mt-[46px]" title="Archiv" meta="Jahr wählen, um die archivierten Daten einzusehen">
            <div className="day-strip mt-6" role="group" aria-label="Archivierte Schuljahre">
              {archived.map((y) => (
                <button
                  key={y.id}
                  type="button"
                  className="day-chip"
                  aria-pressed={selectedId === y.id}
                  onClick={() => { setSelectedId(y.id); setDataTab('users'); }}
                >
                  <span className="text-[14px] font-medium">{y.label}</span>
                  <span className="tabular text-[12px]">{new Date(y.rolledAt).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: '2-digit' })}</span>
                </button>
              ))}
            </div>
          </Section>

          {selectedId && selectedYear && (
            <Section
              className="mt-[44px]"
              title={`Schuljahr ${selectedYear.label}`}
              meta={`Archiviert am ${new Date(selectedYear.rolledAt).toLocaleDateString('de-AT', { day: '2-digit', month: 'long', year: 'numeric' })}${selectedYear.note ? ` · ${selectedYear.note}` : ''}`}
              action={(
                <>
                  {selectedYear.id === latestYearId && (
                    <button
                      type="button"
                      onClick={() => void handleRollback(selectedYear)}
                      disabled={rollingBack || rolling}
                      title="Diesen Schuljahreswechsel rückgängig machen"
                      className="btn btn-sm btn-line"
                    >
                      {rollingBack ? <Spinner size={13} /> : <Undo2 size={14} strokeWidth={1.8} />}
                      {rollingBack ? 'Läuft…' : 'Rückgängig machen'}
                    </button>
                  )}
                  <Segmented
                    label="Archivierte Daten"
                    value={dataTab}
                    onChange={setDataTab}
                    options={dataTabs.map(({ key, label, icon }) => ({ value: key, label: <>{icon}{label}</> }))}
                  />
                </>
              )}
            >
              <div className="mt-7">
                {dataTab === 'users'     && <UsersTab     yearId={selectedId} />}
                {dataTab === 'classes'   && <ClassesTab   yearId={selectedId} />}
                {dataTab === 'todos'     && <TodosTab     yearId={selectedId} />}
                {dataTab === 'reminders' && <RemindersTab yearId={selectedId} />}
              </div>
            </Section>
          )}
        </>
      )}
    </div>
  );
}
