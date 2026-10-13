import { useState, useEffect, useCallback, useRef } from 'react';
import { CheckSquare, Bell, RefreshCw, Clock, CheckCircle2, Archive, ListTodo } from 'lucide-react';
import { adminApi } from '../api';
import { useToast } from '../components/Toast';
import { useLive } from '../live';
import { Avatar, Empty, Figures, IconButton, PageHeader, Pager, SearchField, Section, Segmented, Status, type Tone } from '../components/kit';
import { SplitBar } from '../components/charts';
import type { AdminAllTodo, AdminAllReminder } from '../types';

type Tab = 'todos' | 'reminders';
type TodoStatus = 'all' | 'active' | 'done' | 'archived';
type ReminderStatus = 'all' | 'active' | 'archived';

const PAGE_SIZE = 50;

// Totals per state for the figures and the two bars above the lists.
interface Totals {
  todosActive: number;
  todosDone: number;
  todosArchived: number;
  remindersActive: number;
  remindersArchived: number;
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function dateTime(iso: string): string {
  return new Date(iso).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function todoState(t: AdminAllTodo): { tone: Tone; label: string } {
  if (t.archivedAt) return { tone: 'ink', label: 'Archiviert' };
  if (t.done) return { tone: 'mint', label: 'Erledigt' };
  if (t.dueAt && new Date(t.dueAt) < new Date()) return { tone: 'rose', label: 'Überfällig' };
  return { tone: 'sky', label: 'Aktiv' };
}

function reminderState(r: AdminAllReminder): { tone: Tone; label: string } {
  if (r.archivedAt) return { tone: 'ink', label: 'Archiviert' };
  if (new Date(r.remindAt) < new Date()) return { tone: 'amber', label: 'Vergangen' };
  return { tone: 'sky', label: 'Aktiv' };
}

function SkeletonRows({ columns }: { columns: number }) {
  return (
    <>
      {Array.from({ length: 6 }).map((_, i) => (
        <tr key={i}>
          <td colSpan={columns}><div className="shimmer h-4 rounded-full" style={{ width: `${70 - i * 6}%` }} /></td>
        </tr>
      ))}
    </>
  );
}

export function TodosRemindersPage() {
  const { showToast } = useToast();
  const [tab, setTab] = useState<Tab>('todos');
  const [totals, setTotals] = useState<Totals | null>(null);

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

  const fetchTotals = useCallback(() => {
    Promise.all([
      adminApi.allTodos({ limit: 1, status: 'active' }),
      adminApi.allTodos({ limit: 1, status: 'done' }),
      adminApi.allTodos({ limit: 1, status: 'archived' }),
      adminApi.allReminders({ limit: 1, status: 'active' }),
      adminApi.allReminders({ limit: 1, status: 'archived' }),
    ]).then(([active, done, archived, remActive, remArchived]) => {
      setTotals({
        todosActive: active.total,
        todosDone: done.total,
        todosArchived: archived.total,
        remindersActive: remActive.total,
        remindersArchived: remArchived.total,
      });
    }).catch(() => { /* the lists below do not depend on the totals */ });
  }, []);

  const fetchTodos = useCallback(async (page: number, search: string, status: TodoStatus) => {
    setTodosLoading(true);
    try {
      const res = await adminApi.allTodos({ page, limit: PAGE_SIZE, search: search || undefined, status });
      setTodos(res.todos);
      setTodosTotal(res.total);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Todos konnten nicht geladen werden', 'error');
    } finally {
      setTodosLoading(false);
    }
  }, [showToast]);

  const fetchReminders = useCallback(async (page: number, search: string, status: ReminderStatus) => {
    setRemindersLoading(true);
    try {
      const res = await adminApi.allReminders({ page, limit: PAGE_SIZE, search: search || undefined, status });
      setReminders(res.reminders);
      setRemindersTotal(res.total);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erinnerungen konnten nicht geladen werden', 'error');
    } finally {
      setRemindersLoading(false);
    }
  }, [showToast]);

  // The search term is deliberately not a dependency: typing is debounced below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void fetchTodos(todosPage, todoSearch, todoStatus); }, [fetchTodos, todosPage, todoStatus]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void fetchReminders(remindersPage, reminderSearch, reminderStatus); }, [fetchReminders, remindersPage, reminderStatus]);
  useEffect(() => { fetchTotals(); }, [fetchTotals]);

  useEffect(() => () => {
    if (todoSearchTimer.current) clearTimeout(todoSearchTimer.current);
    if (reminderSearchTimer.current) clearTimeout(reminderSearchTimer.current);
  }, []);

  function handleTodoSearch(val: string) {
    setTodoSearch(val);
    if (todoSearchTimer.current) clearTimeout(todoSearchTimer.current);
    todoSearchTimer.current = setTimeout(() => { setTodosPage(1); void fetchTodos(1, val, todoStatus); }, 350);
  }

  function handleReminderSearch(val: string) {
    setReminderSearch(val);
    if (reminderSearchTimer.current) clearTimeout(reminderSearchTimer.current);
    reminderSearchTimer.current = setTimeout(() => { setRemindersPage(1); void fetchReminders(1, val, reminderStatus); }, 350);
  }

  function handleTodoStatusChange(s: TodoStatus) {
    setTodoStatus(s);
    setTodosPage(1);
  }

  function handleReminderStatusChange(s: ReminderStatus) {
    setReminderStatus(s);
    setRemindersPage(1);
  }

  function refreshCurrent() {
    fetchTotals();
    if (tab === 'todos') void fetchTodos(todosPage, todoSearch, todoStatus);
    else void fetchReminders(remindersPage, reminderSearch, reminderStatus);
  }

  const busy = tab === 'todos' ? todosLoading : remindersLoading;
  useLive(['todos', 'reminders'], refreshCurrent);

  return (
    <div>
      <PageHeader title="Todos & Erinnerungen" subtitle="Alle Todos und Erinnerungen über alle Nutzer und Klassen.">
        <IconButton icon={RefreshCw} label="Aktualisieren" size={42} busy={busy} onClick={refreshCurrent} />
      </PageHeader>

      <Figures
        className="mt-10"
        items={[
          { label: 'Offene Todos',        value: totals?.todosActive ?? '–',     icon: ListTodo },
          { label: 'Erledigt',            value: totals?.todosDone ?? '–',       icon: CheckCircle2 },
          { label: 'Aktive Erinnerungen', value: totals?.remindersActive ?? '–', icon: Bell },
          { label: 'Archiviert',          value: totals ? totals.todosArchived + totals.remindersArchived : '–', icon: Archive },
        ]}
      />

      <div className="mt-[46px] grid gap-x-16 gap-y-12 lg:grid-cols-2">
        <Section title="Todos" meta="nach Zustand">
          <div className="mt-8">
            <SplitBar
              ariaLabel="Todos nach Zustand"
              parts={[
                { label: 'Offen',      value: totals?.todosActive ?? 0,   color: '#4f96dc' },
                { label: 'Erledigt',   value: totals?.todosDone ?? 0,     color: 'var(--mint)' },
                { label: 'Archiviert', value: totals?.todosArchived ?? 0, color: 'var(--ink-4)' },
              ]}
            />
          </div>
        </Section>
        <Section title="Erinnerungen" meta="nach Zustand">
          <div className="mt-8">
            <SplitBar
              ariaLabel="Erinnerungen nach Zustand"
              parts={[
                { label: 'Aktiv',      value: totals?.remindersActive ?? 0,   color: 'var(--amber)' },
                { label: 'Archiviert', value: totals?.remindersArchived ?? 0, color: 'var(--ink-4)' },
              ]}
            />
          </div>
        </Section>
      </div>

      <div className="mt-[52px]">
        <Segmented
          label="Liste wählen"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'todos', label: <><CheckSquare size={14} /> Todos</> },
            { value: 'reminders', label: <><Bell size={14} /> Erinnerungen</> },
          ]}
        />
      </div>

      {tab === 'todos' && (
        <Section
          className="mt-8"
          title="Todos"
          meta={`${todosTotal.toLocaleString('de-AT')} Einträge`}
          action={(
            <>
              <SearchField value={todoSearch} onChange={handleTodoSearch} placeholder="Todos durchsuchen" className="w-full sm:w-[250px]" />
              <Segmented
                label="Todos filtern"
                value={todoStatus}
                onChange={handleTodoStatusChange}
                options={[
                  { value: 'all', label: 'Alle' },
                  { value: 'active', label: 'Aktiv' },
                  { value: 'done', label: 'Erledigt' },
                  { value: 'archived', label: 'Archiviert' },
                ]}
              />
            </>
          )}
        >
          <div className="tbl-scroll mt-7">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Titel</th>
                  <th>Nutzer</th>
                  <th className="hidden md:table-cell">Fällig</th>
                  <th>Status</th>
                  <th className="hidden sm:table-cell">Erstellt</th>
                </tr>
              </thead>
              <tbody>
                {todosLoading && todos.length === 0 && <SkeletonRows columns={5} />}
                {!todosLoading && todos.length === 0 && (
                  <tr><td colSpan={5}><Empty icon={CheckSquare}>Keine Todos gefunden.</Empty></td></tr>
                )}
                {todos.map((t) => {
                  const state = todoState(t);
                  const overdue = !!t.dueAt && new Date(t.dueAt) < new Date() && !t.done && !t.archivedAt;
                  return (
                    <tr key={t.id}>
                      <td>
                        <div className="max-w-[380px]">
                          <div className="truncate font-medium" style={{ textDecoration: t.done ? 'line-through' : undefined, color: t.done ? 'var(--ink-3)' : undefined }}>{t.title}</div>
                          {t.details && <p className="mt-0.5 truncate text-[13px] text-ink-3">{t.details}</p>}
                        </div>
                      </td>
                      <td>
                        <div className="flex items-center gap-3">
                          <Avatar name={t.username} size={30} />
                          <span className="text-ink-2">{t.username}</span>
                        </div>
                      </td>
                      <td className="hidden md:table-cell">
                        {t.dueAt ? (
                          <span className="flex items-center gap-2 whitespace-nowrap text-[13.5px]" style={{ color: overdue ? 'var(--rose-deep)' : 'var(--ink-2)' }}>
                            <Clock size={13} strokeWidth={1.7} />{dateTime(t.dueAt)}
                          </span>
                        ) : <span className="text-ink-4">—</span>}
                      </td>
                      <td><Status tone={state.tone}>{state.label}</Status></td>
                      <td className="hidden whitespace-nowrap text-[13.5px] text-ink-3 sm:table-cell">{shortDate(t.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pager page={todosPage} pages={Math.max(1, Math.ceil(todosTotal / PAGE_SIZE))} onChange={setTodosPage} />
        </Section>
      )}

      {tab === 'reminders' && (
        <Section
          className="mt-8"
          title="Erinnerungen"
          meta={`${remindersTotal.toLocaleString('de-AT')} Einträge`}
          action={(
            <>
              <SearchField value={reminderSearch} onChange={handleReminderSearch} placeholder="Erinnerungen durchsuchen" className="w-full sm:w-[250px]" />
              <Segmented
                label="Erinnerungen filtern"
                value={reminderStatus}
                onChange={handleReminderStatusChange}
                options={[
                  { value: 'all', label: 'Alle' },
                  { value: 'active', label: 'Aktiv' },
                  { value: 'archived', label: 'Archiviert' },
                ]}
              />
            </>
          )}
        >
          <div className="tbl-scroll mt-7">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Titel</th>
                  <th>Klasse</th>
                  <th className="hidden md:table-cell">Erinnerung am</th>
                  <th>Status</th>
                  <th className="hidden lg:table-cell">Erstellt von</th>
                  <th className="hidden sm:table-cell">Erstellt</th>
                </tr>
              </thead>
              <tbody>
                {remindersLoading && reminders.length === 0 && <SkeletonRows columns={6} />}
                {!remindersLoading && reminders.length === 0 && (
                  <tr><td colSpan={6}><Empty icon={Bell}>Keine Erinnerungen gefunden.</Empty></td></tr>
                )}
                {reminders.map((r) => {
                  const state = reminderState(r);
                  const past = new Date(r.remindAt) < new Date() && !r.archivedAt;
                  return (
                    <tr key={r.id}>
                      <td>
                        <div className="max-w-[340px]">
                          <div className="truncate font-medium">{r.title}</div>
                          {r.body && <p className="mt-0.5 truncate text-[13px] text-ink-3">{r.body}</p>}
                        </div>
                      </td>
                      <td className="whitespace-nowrap text-ink-2">{r.className}</td>
                      <td className="hidden md:table-cell">
                        <span className="flex items-center gap-2 whitespace-nowrap text-[13.5px]" style={{ color: past ? 'var(--amber-deep)' : 'var(--ink-2)' }}>
                          <Clock size={13} strokeWidth={1.7} />{dateTime(r.remindAt)}
                        </span>
                      </td>
                      <td><Status tone={state.tone}>{state.label}</Status></td>
                      <td className="hidden text-ink-2 lg:table-cell">{r.createdByUsername || r.createdByName}</td>
                      <td className="hidden whitespace-nowrap text-[13.5px] text-ink-3 sm:table-cell">{shortDate(r.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pager page={remindersPage} pages={Math.max(1, Math.ceil(remindersTotal / PAGE_SIZE))} onChange={setRemindersPage} />
        </Section>
      )}
    </div>
  );
}
