import { useState, useEffect, useCallback, useRef } from 'react';
import { CheckSquare, Bell, Search, ChevronLeft, ChevronRight, RefreshCw, User, Building2, Clock, CheckCircle2, Archive } from 'lucide-react';
import { adminApi } from '../api';
import type { AdminAllTodo, AdminAllReminder } from '../types';

type Tab = 'todos' | 'reminders';
type TodoStatus = 'all' | 'active' | 'done' | 'archived';
type ReminderStatus = 'all' | 'active' | 'archived';

const PAGE_SIZE = 50;

function StatusBadge({ label, color }: { label: string; color: string }) {
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium"
      style={{ background: `${color}22`, color }}
    >
      {label}
    </span>
  );
}

function Pagination({ page, total, limit, onPage }: { page: number; total: number; limit: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / limit));
  if (pages <= 1) return null;
  return (
    <div className="flex items-center gap-2 text-sm" style={{ color: 'rgba(235,235,245,0.5)' }}>
      <button
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
        className="p-1.5 rounded-[8px] disabled:opacity-30 transition-colors"
        style={{ background: 'rgba(255,255,255,0.06)' }}
      >
        <ChevronLeft size={14} />
      </button>
      <span className="text-[13px]">{page} / {pages}</span>
      <button
        disabled={page >= pages}
        onClick={() => onPage(page + 1)}
        className="p-1.5 rounded-[8px] disabled:opacity-30 transition-colors"
        style={{ background: 'rgba(255,255,255,0.06)' }}
      >
        <ChevronRight size={14} />
      </button>
      <span className="text-[12px] ml-1">{total} gesamt</span>
    </div>
  );
}

export function TodosRemindersPage() {
  const [tab, setTab] = useState<Tab>('todos');

  // Todos state
  const [todos, setTodos] = useState<AdminAllTodo[]>([]);
  const [todosTotal, setTodosTotal] = useState(0);
  const [todosPage, setTodosPage] = useState(1);
  const [todoSearch, setTodoSearch] = useState('');
  const [todoStatus, setTodoStatus] = useState<TodoStatus>('active');
  const [todosLoading, setTodosLoading] = useState(false);

  // Reminders state
  const [reminders, setReminders] = useState<AdminAllReminder[]>([]);
  const [remindersTotal, setRemindersTotal] = useState(0);
  const [remindersPage, setRemindersPage] = useState(1);
  const [reminderSearch, setReminderSearch] = useState('');
  const [reminderStatus, setReminderStatus] = useState<ReminderStatus>('active');
  const [remindersLoading, setRemindersLoading] = useState(false);

  const todoSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reminderSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchTodos = useCallback(async (page: number, search: string, status: TodoStatus) => {
    setTodosLoading(true);
    try {
      const res = await adminApi.allTodos({ page, limit: PAGE_SIZE, search: search || undefined, status });
      setTodos(res.todos);
      setTodosTotal(res.total);
    } catch {
      // ignore
    } finally {
      setTodosLoading(false);
    }
  }, []);

  const fetchReminders = useCallback(async (page: number, search: string, status: ReminderStatus) => {
    setRemindersLoading(true);
    try {
      const res = await adminApi.allReminders({ page, limit: PAGE_SIZE, search: search || undefined, status });
      setReminders(res.reminders);
      setRemindersTotal(res.total);
    } catch {
      // ignore
    } finally {
      setRemindersLoading(false);
    }
  }, []);

  useEffect(() => { fetchTodos(todosPage, todoSearch, todoStatus); }, [fetchTodos, todosPage, todoStatus]);
  useEffect(() => { fetchReminders(remindersPage, reminderSearch, reminderStatus); }, [fetchReminders, remindersPage, reminderStatus]);

  function handleTodoSearch(val: string) {
    setTodoSearch(val);
    if (todoSearchTimer.current) clearTimeout(todoSearchTimer.current);
    todoSearchTimer.current = setTimeout(() => { setTodosPage(1); fetchTodos(1, val, todoStatus); }, 350);
  }

  function handleReminderSearch(val: string) {
    setReminderSearch(val);
    if (reminderSearchTimer.current) clearTimeout(reminderSearchTimer.current);
    reminderSearchTimer.current = setTimeout(() => { setRemindersPage(1); fetchReminders(1, val, reminderStatus); }, 350);
  }

  function handleTodoStatusChange(s: TodoStatus) {
    setTodoStatus(s);
    setTodosPage(1);
  }

  function handleReminderStatusChange(s: ReminderStatus) {
    setReminderStatus(s);
    setRemindersPage(1);
  }

  function todoStatusBadge(t: AdminAllTodo) {
    if (t.archivedAt) return <StatusBadge label="Archiviert" color="#8e8e93" />;
    if (t.done) return <StatusBadge label="Erledigt" color="#30d158" />;
    if (t.dueAt && new Date(t.dueAt) < new Date()) return <StatusBadge label="Überfällig" color="#ff453a" />;
    return <StatusBadge label="Aktiv" color="#0a84ff" />;
  }

  function reminderStatusBadge(r: AdminAllReminder) {
    if (r.archivedAt) return <StatusBadge label="Archiviert" color="#8e8e93" />;
    if (new Date(r.remindAt) < new Date()) return <StatusBadge label="Vergangen" color="#ff9f0a" />;
    return <StatusBadge label="Aktiv" color="#0a84ff" />;
  }

  const cell = 'px-4 py-3 text-[13px]';
  const dimText = { color: 'rgba(235,235,245,0.4)' };
  const tableHeader = 'px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.05em]';

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-[22px] font-bold text-white tracking-[-0.02em]">Todos &amp; Erinnerungen</h1>
        <p className="text-[13px] mt-1" style={dimText}>Alle Todos und Erinnerungen über alle Nutzer und Klassen</p>
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 mb-5 p-1 rounded-[12px] w-fit" style={{ background: 'rgba(255,255,255,0.06)' }}>
        {([['todos', 'Todos', <CheckSquare size={14} />], ['reminders', 'Erinnerungen', <Bell size={14} />]] as [Tab, string, React.ReactNode][]).map(([key, label, icon]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className="flex items-center gap-2 px-4 py-2 rounded-[9px] text-[13px] font-medium transition-all"
            style={tab === key
              ? { background: '#0a84ff', color: '#fff' }
              : { color: 'rgba(235,235,245,0.5)' }}
          >
            {icon}{label}
            {key === 'todos' && <span className="text-[11px] opacity-70">({todosTotal})</span>}
            {key === 'reminders' && <span className="text-[11px] opacity-70">({remindersTotal})</span>}
          </button>
        ))}
      </div>

      {tab === 'todos' && (
        <div>
          {/* Todos toolbar */}
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <div className="relative flex-1 min-w-[200px] max-w-[320px]">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={dimText} />
              <input
                type="text"
                value={todoSearch}
                onChange={(e) => handleTodoSearch(e.target.value)}
                placeholder="Todos durchsuchen…"
                className="w-full pl-9 pr-3 py-2 rounded-[10px] text-[13px] text-white placeholder-[rgba(235,235,245,0.3)] outline-none"
                style={{ background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.08)' }}
              />
            </div>
            <div className="flex gap-1 p-0.5 rounded-[10px]" style={{ background: 'rgba(255,255,255,0.06)' }}>
              {(['all', 'active', 'done', 'archived'] as TodoStatus[]).map((s) => (
                <button
                  key={s}
                  onClick={() => handleTodoStatusChange(s)}
                  className="px-3 py-1.5 rounded-[8px] text-[12px] font-medium transition-all"
                  style={todoStatus === s
                    ? { background: 'rgba(255,255,255,0.12)', color: '#fff' }
                    : { color: 'rgba(235,235,245,0.45)' }}
                >
                  {{ all: 'Alle', active: 'Aktiv', done: 'Erledigt', archived: 'Archiviert' }[s]}
                </button>
              ))}
            </div>
            <button
              onClick={() => fetchTodos(todosPage, todoSearch, todoStatus)}
              className="p-2 rounded-[10px] transition-colors"
              style={{ background: 'rgba(255,255,255,0.07)', color: 'rgba(235,235,245,0.5)' }}
              title="Aktualisieren"
            >
              <RefreshCw size={14} className={todosLoading ? 'animate-spin' : ''} />
            </button>
          </div>

          <div className="rounded-[14px] overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.07)', background: '#0d0d0d' }}>
            <table className="w-full border-collapse">
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', color: 'rgba(235,235,245,0.35)' }}>
                  <th className={tableHeader}>Titel</th>
                  <th className={tableHeader}><span className="flex items-center gap-1"><User size={10} />Nutzer</span></th>
                  <th className={tableHeader}>Fällig</th>
                  <th className={tableHeader}>Status</th>
                  <th className={tableHeader}>Erstellt</th>
                </tr>
              </thead>
              <tbody>
                {todosLoading && todos.length === 0 && (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-[13px]" style={dimText}>Laden…</td></tr>
                )}
                {!todosLoading && todos.length === 0 && (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-[13px]" style={dimText}>Keine Todos gefunden</td></tr>
                )}
                {todos.map((t) => (
                  <tr key={t.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }} className="hover:bg-white/[0.02] transition-colors">
                    <td className={cell}>
                      <div className="flex items-center gap-2">
                        {t.done
                          ? <CheckCircle2 size={14} style={{ color: '#30d158', flexShrink: 0 }} />
                          : t.archivedAt
                            ? <Archive size={14} style={{ color: '#8e8e93', flexShrink: 0 }} />
                            : <CheckSquare size={14} style={{ color: '#0a84ff', flexShrink: 0 }} />
                        }
                        <span className="text-white font-medium truncate max-w-[280px]">{t.title}</span>
                      </div>
                      {t.details && <p className="text-[12px] mt-0.5 ml-[22px] truncate max-w-[280px]" style={dimText}>{t.details}</p>}
                    </td>
                    <td className={cell} style={dimText}>{t.username}</td>
                    <td className={cell}>
                      {t.dueAt
                        ? <span className="flex items-center gap-1 text-[12px]" style={{ color: new Date(t.dueAt) < new Date() && !t.done ? '#ff453a' : 'rgba(235,235,245,0.5)' }}>
                            <Clock size={12} />{new Date(t.dueAt).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })}
                          </span>
                        : <span style={dimText}>—</span>}
                    </td>
                    <td className={cell}>{todoStatusBadge(t)}</td>
                    <td className={`${cell} text-[12px]`} style={dimText}>{new Date(t.createdAt).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: '2-digit' })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex justify-end mt-4">
            <Pagination page={todosPage} total={todosTotal} limit={PAGE_SIZE} onPage={(p) => setTodosPage(p)} />
          </div>
        </div>
      )}

      {tab === 'reminders' && (
        <div>
          {/* Reminders toolbar */}
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <div className="relative flex-1 min-w-[200px] max-w-[320px]">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={dimText} />
              <input
                type="text"
                value={reminderSearch}
                onChange={(e) => handleReminderSearch(e.target.value)}
                placeholder="Erinnerungen durchsuchen…"
                className="w-full pl-9 pr-3 py-2 rounded-[10px] text-[13px] text-white placeholder-[rgba(235,235,245,0.3)] outline-none"
                style={{ background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.08)' }}
              />
            </div>
            <div className="flex gap-1 p-0.5 rounded-[10px]" style={{ background: 'rgba(255,255,255,0.06)' }}>
              {(['all', 'active', 'archived'] as ReminderStatus[]).map((s) => (
                <button
                  key={s}
                  onClick={() => handleReminderStatusChange(s)}
                  className="px-3 py-1.5 rounded-[8px] text-[12px] font-medium transition-all"
                  style={reminderStatus === s
                    ? { background: 'rgba(255,255,255,0.12)', color: '#fff' }
                    : { color: 'rgba(235,235,245,0.45)' }}
                >
                  {{ all: 'Alle', active: 'Aktiv', archived: 'Archiviert' }[s]}
                </button>
              ))}
            </div>
            <button
              onClick={() => fetchReminders(remindersPage, reminderSearch, reminderStatus)}
              className="p-2 rounded-[10px] transition-colors"
              style={{ background: 'rgba(255,255,255,0.07)', color: 'rgba(235,235,245,0.5)' }}
              title="Aktualisieren"
            >
              <RefreshCw size={14} className={remindersLoading ? 'animate-spin' : ''} />
            </button>
          </div>

          <div className="rounded-[14px] overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.07)', background: '#0d0d0d' }}>
            <table className="w-full border-collapse">
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', color: 'rgba(235,235,245,0.35)' }}>
                  <th className={tableHeader}>Titel</th>
                  <th className={tableHeader}><span className="flex items-center gap-1"><Building2 size={10} />Klasse</span></th>
                  <th className={tableHeader}>Erinnerung am</th>
                  <th className={tableHeader}>Status</th>
                  <th className={tableHeader}>Erstellt von</th>
                  <th className={tableHeader}>Erstellt</th>
                </tr>
              </thead>
              <tbody>
                {remindersLoading && reminders.length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-[13px]" style={dimText}>Laden…</td></tr>
                )}
                {!remindersLoading && reminders.length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-[13px]" style={dimText}>Keine Erinnerungen gefunden</td></tr>
                )}
                {reminders.map((r) => (
                  <tr key={r.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }} className="hover:bg-white/[0.02] transition-colors">
                    <td className={cell}>
                      <div className="flex items-center gap-2">
                        <Bell size={14} style={{ color: r.archivedAt ? '#8e8e93' : '#ff9f0a', flexShrink: 0 }} />
                        <span className="text-white font-medium truncate max-w-[240px]">{r.title}</span>
                      </div>
                      {r.body && <p className="text-[12px] mt-0.5 ml-[22px] truncate max-w-[240px]" style={dimText}>{r.body}</p>}
                    </td>
                    <td className={`${cell} text-[13px]`} style={dimText}>{r.className}</td>
                    <td className={cell}>
                      <span className="flex items-center gap-1 text-[12px]" style={{ color: new Date(r.remindAt) < new Date() && !r.archivedAt ? '#ff9f0a' : 'rgba(235,235,245,0.5)' }}>
                        <Clock size={12} />{new Date(r.remindAt).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </td>
                    <td className={cell}>{reminderStatusBadge(r)}</td>
                    <td className={`${cell} text-[13px]`} style={dimText}>{r.createdByUsername || r.createdByName}</td>
                    <td className={`${cell} text-[12px]`} style={dimText}>{new Date(r.createdAt).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: '2-digit' })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex justify-end mt-4">
            <Pagination page={remindersPage} total={remindersTotal} limit={PAGE_SIZE} onPage={(p) => setRemindersPage(p)} />
          </div>
        </div>
      )}
    </div>
  );
}
