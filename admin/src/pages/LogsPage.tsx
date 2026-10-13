import { Fragment, useEffect, useState, useRef, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  RefreshCw,
  Search,
  X,
  ChevronLeft,
  ChevronRight,
  Shield,
} from 'lucide-react';
import { adminApi } from '../api';
import { useToast } from '../components/Toast';
import { useLive } from '../live';
import { PageHeader, Section, Segmented } from '../components/kit';
import { TrendChart } from '../components/TrendChart';
import type { RequestLog, LogsResponse, FrontendActivityLog, FrontendActivityStats, RequestsChartPoint } from '../types';

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

interface BadgeStyle { bg: string; color: string; border: string; }

function methodStyle(method: string): BadgeStyle {
  switch (method.toUpperCase()) {
    case 'GET':    return { bg: 'rgb(var(--ink-rgb) / calc(0.04 * var(--veil)))',   color: 'rgb(var(--ink-rgb) / 0.7)', border: 'rgb(var(--ink-rgb) / calc(0.12 * var(--veil)))' };
    case 'POST':   return { bg: 'rgba(60,135,215,0.14)',    color: 'var(--sky-deep)',                border: 'rgba(60,135,215,0.22)' };
    case 'PATCH':  return { bg: 'rgba(236,140,40,0.14)',    color: 'var(--amber-deep)',                border: 'rgba(236,140,40,0.22)' };
    case 'DELETE': return { bg: 'rgba(225,70,75,0.14)',     color: 'var(--rose-deep)',                border: 'rgba(225,70,75,0.22)' };
    default:       return { bg: 'rgb(var(--ink-rgb) / calc(0.032 * var(--veil)))',   color: 'rgb(var(--ink-rgb) / 0.58)',  border: 'rgb(var(--ink-rgb) / calc(0.098 * var(--veil)))' };
  }
}

function statusStyle(status: number): BadgeStyle {
  if (status >= 500) return { bg: 'rgba(225,70,75,0.14)',   color: 'var(--rose-deep)',  border: 'rgba(225,70,75,0.22)' };
  if (status >= 400) return { bg: 'rgba(236,140,40,0.14)',  color: 'var(--amber-deep)',  border: 'rgba(236,140,40,0.22)' };
  if (status >= 300) return { bg: 'rgba(60,135,215,0.14)',  color: 'var(--sky-deep)',  border: 'rgba(60,135,215,0.22)' };
  return { bg: 'rgba(40,170,125,0.14)', color: 'var(--mint-deep)', border: 'rgba(40,170,125,0.22)' };
}

function Badge({ text, style }: { text: string; style: BadgeStyle }) {
  return (
    <span
      className="inline-block rounded-full px-2.5 py-[3px] font-mono text-[11.5px] font-semibold"
      style={{ background: style.bg, color: style.color }}
    >
      {text}
    </span>
  );
}

function SelectField({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="field h-11 px-4 text-[14px]"
      style={{ minWidth: '128px' }}
    >
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function InputField({ value, onChange, placeholder, icon }: { value: string; onChange: (v: string) => void; placeholder: string; icon?: React.ReactNode }) {
  return (
    <div className="relative">
      {icon && <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-ink-3">{icon}</span>}
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="field h-11 px-4 text-[14px] w-full"
        style={{ paddingLeft: icon ? '42px' : '16px', paddingRight: '16px' }}
      />
    </div>
  );
}

function StatChip({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="stat-chip">
      <span className="text-[13.5px] text-ink-3">{label}</span>
      <span className="tabular mt-0.5 truncate text-[19px] font-semibold">{value}</span>
    </div>
  );
}

function SkeletonRows({ cols }: { cols: number }) {
  return (
    <>
      {Array.from({ length: 8 }).map((_, i) => (
        <tr key={i} style={{ borderBottom: '1px solid rgb(var(--ink-rgb) / calc(0.054 * var(--veil)))' }}>
          {Array.from({ length: cols }).map((__, j) => (
            <td key={j} className="px-4 py-3">
              <div className="h-3.5 rounded shimmer" style={{ width: j === 2 ? '180px' : '70px' }} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

interface AllRequestsTabProps {
  methodFilter: string;
  statusFilter: string;
  pathFilter: string;
  usernameFilter: string;
  scopeFilter: string;
  fromDate: string;
  toDate: string;
  onNavigateToUser: (username: string) => void;
  autoRefresh: boolean;
}

function AllRequestsTab({ methodFilter, statusFilter, pathFilter, usernameFilter, scopeFilter, fromDate, toDate, onNavigateToUser, autoRefresh }: AllRequestsTabProps) {
  const { showToast } = useToast();
  const [data, setData] = useState<LogsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const limit = 50;

  const fetchLogs = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const statusNum = statusFilter === '2xx' ? 200 : statusFilter === '4xx' ? 400 : statusFilter === '5xx' ? 500 : undefined;
      const res = await adminApi.logs({ page, limit, method: methodFilter || undefined, status: statusNum, path: pathFilter || undefined, username: usernameFilter || undefined, scope: scopeFilter === 'learn' || scopeFilter === 'core' ? scopeFilter : undefined, from: fromDate || undefined, to: toDate || undefined });
      setData(res);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Laden fehlgeschlagen', 'error');
    } finally {
      setLoading(false);
    }
  }, [page, methodFilter, statusFilter, pathFilter, usernameFilter, scopeFilter, fromDate, toDate, showToast]);

  useEffect(() => { setPage(1); }, [methodFilter, statusFilter, pathFilter, usernameFilter, scopeFilter, fromDate, toDate]);
  useEffect(() => { void fetchLogs(); }, [fetchLogs]);
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => void fetchLogs(true), 10000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchLogs]);

  const logs = data?.logs ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const errorCount = logs.filter((l) => l.status >= 400).length;
  const errorRate = logs.length > 0 ? ((errorCount / logs.length) * 100).toFixed(1) : '0.0';
  const avgDuration = logs.length > 0 ? Math.round(logs.reduce((s, l) => s + l.duration, 0) / logs.length) : 0;
  const uniqueUsers = new Set(logs.map((l) => l.username).filter(Boolean)).size;

  function downloadCsv() {
    const header = 'Zeit,Methode,Pfad,Status,Dauer,Benutzer,IP,UserAgent,Fehler';
    const rows = logs.map((l) => [
      l.createdAt, l.method, l.path, l.status, `${l.duration}ms`,
      l.username ?? '', l.ip ?? '', (l.userAgent ?? '').replace(/,/g, ';'), l.error ?? '',
    ].map(String).join(','));
    const blob = new Blob([header + '\n' + rows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `logs-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="stat-chips">
        <StatChip label="Anfragen gesamt" value={total.toLocaleString()} />
        <StatChip label="Fehlerrate" value={`${errorRate}%`} />
        <StatChip label="Ø Dauer" value={`${avgDuration}ms`} />
        <StatChip label="Nutzer" value={uniqueUsers} />
      </div>

      <div
        className="mt-2"
      >
        <div className="flex items-center justify-between px-4 py-2.5" style={{ borderBottom: '1px solid rgb(var(--ink-rgb) / calc(0.076 * var(--veil)))' }}>
          <span className="text-[12px]" style={{ color: 'rgb(var(--ink-rgb) / 0.54)' }}>{total.toLocaleString()} Einträge</span>
          <button onClick={downloadCsv} className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-medium transition-colors" style={{ background: 'rgb(var(--ink-rgb) / calc(0.048 * var(--veil)))', color: 'rgb(var(--ink-rgb) / 0.74)' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgb(var(--ink-rgb) / calc(0.08 * var(--veil)))'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgb(var(--ink-rgb) / calc(0.048 * var(--veil)))'; }}>
            ↓ CSV Export
          </button>
        </div>
        <div className="tbl-scroll">
          <table className="tbl">
            <thead>
              <tr style={{ background: 'rgb(var(--ink-rgb) / calc(0.045 * var(--veil)))', borderBottom: '1px solid rgb(var(--ink-rgb) / calc(0.076 * var(--veil)))' }}>
                {['Zeit', 'Methode', 'Pfad', 'Status', 'Dauer', 'Benutzer', 'IP'].map((col) => (
                  <th key={col} className={`px-4 py-3 text-left text-[13px]${col === 'IP' || col === 'Dauer' ? ' hidden md:table-cell' : ''}`} style={{ color: 'rgb(var(--ink-rgb) / 0.5)' }}>
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <SkeletonRows cols={7} />
              ) : logs.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-12 text-center text-[13px]" style={{ color: 'rgb(var(--ink-rgb) / 0.54)' }}>Keine Logs gefunden</td></tr>
              ) : (
                logs.map((log) => {
                  const ms = methodStyle(log.method);
                  const ss = statusStyle(log.status);
                  const isExpanded = expandedId === log.id;
                  return (
                    <Fragment key={log.id}>
                      <tr
                        key={log.id}
                        style={{ borderBottom: isExpanded ? 'none' : '1px solid rgb(var(--ink-rgb) / calc(0.054 * var(--veil)))', cursor: 'pointer', background: isExpanded ? 'rgba(60,135,215,0.04)' : '' }}
                        className="transition-colors"
                        onClick={() => setExpandedId(isExpanded ? null : log.id)}
                        onMouseEnter={(e) => { if (!isExpanded) (e.currentTarget as HTMLElement).style.background = 'rgb(var(--ink-rgb) / calc(0.016 * var(--veil)))'; }}
                        onMouseLeave={(e) => { if (!isExpanded) (e.currentTarget as HTMLElement).style.background = ''; }}
                      >
                        <td className="px-4 py-3 text-[11px] whitespace-nowrap" style={{ color: 'rgb(var(--ink-rgb) / 0.54)' }}>
                          {new Date(log.createdAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        </td>
                        <td className="px-4 py-3"><Badge text={log.method} style={ms} /></td>
                        <td className="px-4 py-3 max-w-xs">
                          <span className="text-[12px] font-mono truncate block" style={{ color: 'rgb(var(--ink-rgb) / 0.78)' }}>{log.path}</span>
                          {log.error && <span className="text-[11px] truncate block mt-0.5" style={{ color: 'var(--rose-deep)' }}>{log.error}</span>}
                        </td>
                        <td className="px-4 py-3"><Badge text={String(log.status)} style={ss} /></td>
                        <td className="px-4 py-3 hidden md:table-cell text-[12px] whitespace-nowrap" style={{ color: 'rgb(var(--ink-rgb) / 0.58)' }}>{log.duration}ms</td>
                        <td className="px-4 py-3">
                          {log.username ? (
                            <button className="text-[12px] font-medium transition-colors" style={{ color: 'var(--sky-deep)' }}
                              onClick={(e) => { e.stopPropagation(); onNavigateToUser(log.username!); }}>
                              {log.username}
                            </button>
                          ) : <span className="text-[12px]" style={{ color: 'rgb(var(--ink-rgb) / 0.42)' }}>—</span>}
                        </td>
                        <td className="px-4 py-3 hidden md:table-cell">
                          <span className="text-[11px] font-mono" style={{ color: 'rgb(var(--ink-rgb) / 0.5)' }}>{log.ip ?? '—'}</span>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr key={`${log.id}-detail`} style={{ borderBottom: '1px solid rgb(var(--ink-rgb) / calc(0.054 * var(--veil)))', background: 'rgba(60,135,215,0.04)' }}>
                          <td colSpan={7} className="px-4 pb-3">
                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-[12px] mt-1">
                              <div>
                                <span style={{ color: 'rgb(var(--ink-rgb) / 0.54)' }}>Zeitstempel</span>
                                <div className="text-ink mt-0.5 font-mono">{new Date(log.createdAt).toLocaleString('de-DE')}</div>
                              </div>
                              <div>
                                <span style={{ color: 'rgb(var(--ink-rgb) / 0.54)' }}>IP-Adresse</span>
                                <div className="text-ink mt-0.5 font-mono">{log.ip ?? '—'}</div>
                              </div>
                              <div>
                                <span style={{ color: 'rgb(var(--ink-rgb) / 0.54)' }}>Dauer</span>
                                <div className="text-ink mt-0.5">{log.duration}ms</div>
                              </div>
                              {log.requestId && (
                                <div>
                                  <span style={{ color: 'rgb(var(--ink-rgb) / 0.54)' }}>Request-ID</span>
                                  <div className="text-ink mt-0.5 font-mono text-[11px]">{log.requestId}</div>
                                </div>
                              )}
                              {log.scope && (
                                <div>
                                  <span style={{ color: 'rgb(var(--ink-rgb) / 0.54)' }}>Bereich</span>
                                  <div className="text-ink mt-0.5">{log.scope === 'learn' ? 'Learn' : 'Core'}</div>
                                </div>
                              )}
                              {log.userAgent && (
                                <div className="col-span-2 sm:col-span-3">
                                  <span style={{ color: 'rgb(var(--ink-rgb) / 0.54)' }}>User-Agent</span>
                                  <div className="mt-0.5 font-mono break-all" style={{ color: 'rgb(var(--ink-rgb) / 0.74)', fontSize: '11px' }}>{log.userAgent}</div>
                                </div>
                              )}
                              {log.error && (
                                <div className="col-span-2 sm:col-span-3">
                                  <span style={{ color: 'var(--rose-deep)' }}>Fehler</span>
                                  <div className="mt-0.5 font-mono text-[11px]" style={{ color: '#ff6b63' }}>{log.error}</div>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3" style={{ borderTop: '1px solid rgb(var(--ink-rgb) / calc(0.076 * var(--veil)))' }}>
            <span className="text-[12px]" style={{ color: 'rgb(var(--ink-rgb) / 0.5)' }}>Seite {page} von {totalPages}</span>
            <div className="flex items-center gap-2">
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}
                className="p-1.5 rounded-full transition-colors disabled:opacity-25" style={{ color: 'rgb(var(--ink-rgb) / 0.7)' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgb(var(--ink-rgb) / calc(0.04 * var(--veil)))'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = ''; }}>
                <ChevronLeft size={16} />
              </button>
              <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                className="p-1.5 rounded-full transition-colors disabled:opacity-25" style={{ color: 'rgb(var(--ink-rgb) / 0.7)' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgb(var(--ink-rgb) / calc(0.04 * var(--veil)))'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = ''; }}>
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ByUserTab({ initialUsername }: { initialUsername?: string }) {
  const { showToast } = useToast();
  const [search, setSearch] = useState(initialUsername ?? '');
  const [selectedUsername, setSelectedUsername] = useState(initialUsername ?? '');
  const [userLogs, setUserLogs] = useState<RequestLog[]>([]);
  const [topUsers, setTopUsers] = useState<{ username: string; count: number }[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingTop, setLoadingTop] = useState(true);
  const [userPage, setUserPage] = useState(1);
  const [userTotal, setUserTotal] = useState(0);
  const userLimit = 50;

  useEffect(() => {
    setLoadingTop(true);
    adminApi.logs({ limit: 500 }).then((res) => {
      const counts = new Map<string, number>();
      for (const log of res.logs) {
        if (log.username) counts.set(log.username, (counts.get(log.username) ?? 0) + 1);
      }
      const sorted = Array.from(counts.entries()).map(([username, count]) => ({ username, count })).sort((a, b) => b.count - a.count).slice(0, 10);
      setTopUsers(sorted);
    }).catch((err) => showToast(err instanceof Error ? err.message : 'Fehler', 'error')).finally(() => setLoadingTop(false));
  }, [showToast]);

  const fetchUserLogs = useCallback(async (username: string, page: number) => {
    setLoading(true);
    try {
      const res = await adminApi.logs({ username, page, limit: userLimit });
      setUserLogs(res.logs);
      setUserTotal(res.total);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Fehler', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    if (selectedUsername) void fetchUserLogs(selectedUsername, userPage);
  }, [selectedUsername, userPage, fetchUserLogs]);

  function selectUser(username: string) { setSelectedUsername(username); setSearch(username); setUserPage(1); }

  const userTotalPages = Math.max(1, Math.ceil(userTotal / userLimit));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'rgb(var(--ink-rgb) / 0.5)' }} />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && search.trim()) selectUser(search.trim()); }}
            placeholder="Benutzername suchen…"
            className="field h-11 pl-11 pr-4 text-[14px] w-full"
          />
        </div>
        <button
          onClick={() => { if (search.trim()) selectUser(search.trim()); }}
          className="btn btn-sm btn-primary"
        >
          Anzeigen
        </button>
        {selectedUsername && (
          <button
            onClick={() => { setSelectedUsername(''); setSearch(''); setUserLogs([]); }}
            className="btn btn-sm p-2 btn-quiet"
          >
            <X size={13} />
          </button>
        )}
      </div>

      {selectedUsername ? (
        <div className="mt-2">
          <div className="px-4 py-3 flex items-center gap-2" style={{ borderBottom: '1px solid rgb(var(--ink-rgb) / calc(0.076 * var(--veil)))' }}>
            <span className="text-[14px] font-semibold text-ink">{selectedUsername}</span>
            <span className="text-[12px]" style={{ color: 'rgb(var(--ink-rgb) / 0.54)' }}>· {userTotal.toLocaleString()} Anfragen</span>
          </div>
          <div className="tbl-scroll">
            <table className="tbl">
              <thead>
                <tr style={{ background: 'rgb(var(--ink-rgb) / calc(0.045 * var(--veil)))', borderBottom: '1px solid rgb(var(--ink-rgb) / calc(0.076 * var(--veil)))' }}>
                  {['Zeit', 'Methode', 'Pfad', 'Status', 'Dauer'].map((col) => (
                    <th key={col} className={`px-4 py-3 text-left text-[13px]${col === 'Dauer' ? ' hidden md:table-cell' : ''}`} style={{ color: 'rgb(var(--ink-rgb) / 0.5)' }}>{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading ? <SkeletonRows cols={5} /> : userLogs.length === 0 ? (
                  <tr><td colSpan={5} className="px-4 py-12 text-center text-[13px]" style={{ color: 'rgb(var(--ink-rgb) / 0.54)' }}>Keine Logs für diesen Benutzer</td></tr>
                ) : userLogs.map((log) => (
                  <tr key={log.id} style={{ borderBottom: '1px solid rgb(var(--ink-rgb) / calc(0.054 * var(--veil)))' }} className="transition-colors"
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgb(var(--ink-rgb) / calc(0.016 * var(--veil)))'; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = ''; }}>
                    <td className="px-4 py-3 text-[11px] whitespace-nowrap" style={{ color: 'rgb(var(--ink-rgb) / 0.54)' }}>{relativeTime(log.createdAt)}</td>
                    <td className="px-4 py-3"><Badge text={log.method} style={methodStyle(log.method)} /></td>
                    <td className="px-4 py-3 max-w-xs">
                      <span className="text-[12px] font-mono truncate block" style={{ color: 'rgb(var(--ink-rgb) / 0.78)' }}>{log.path}</span>
                      {log.error && <span className="text-[11px] truncate block mt-0.5" style={{ color: 'var(--rose-deep)' }}>{log.error}</span>}
                    </td>
                    <td className="px-4 py-3"><Badge text={String(log.status)} style={statusStyle(log.status)} /></td>
                    <td className="px-4 py-3 hidden md:table-cell text-[12px] whitespace-nowrap" style={{ color: 'rgb(var(--ink-rgb) / 0.58)' }}>{log.duration}ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {userTotalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3" style={{ borderTop: '1px solid rgb(var(--ink-rgb) / calc(0.076 * var(--veil)))' }}>
              <span className="text-[12px]" style={{ color: 'rgb(var(--ink-rgb) / 0.5)' }}>Seite {userPage} von {userTotalPages}</span>
              <div className="flex items-center gap-2">
                <button onClick={() => setUserPage((p) => Math.max(1, p - 1))} disabled={userPage === 1}
                  className="p-1.5 rounded-full transition-colors disabled:opacity-25" style={{ color: 'rgb(var(--ink-rgb) / 0.7)' }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgb(var(--ink-rgb) / calc(0.04 * var(--veil)))'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = ''; }}>
                  <ChevronLeft size={16} />
                </button>
                <button onClick={() => setUserPage((p) => Math.min(userTotalPages, p + 1))} disabled={userPage === userTotalPages}
                  className="p-1.5 rounded-full transition-colors disabled:opacity-25" style={{ color: 'rgb(var(--ink-rgb) / 0.7)' }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgb(var(--ink-rgb) / calc(0.04 * var(--veil)))'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = ''; }}>
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="mt-2">
          <div className="px-4 py-3" style={{ borderBottom: '1px solid rgb(var(--ink-rgb) / calc(0.076 * var(--veil)))' }}>
            <span className="text-[14px] font-semibold text-ink">Aktivste Benutzer</span>
          </div>
          {loadingTop ? (
            <div className="px-4 py-8 flex justify-center">
              <div className="w-5 h-5 border-2 rounded-full animate-spin" style={{ borderColor: 'rgb(var(--ink-rgb) / calc(0.12 * var(--veil)))', borderTopColor: 'var(--sky-deep)' }} />
            </div>
          ) : topUsers.length === 0 ? (
            <p className="px-4 py-8 text-center text-[13px]" style={{ color: 'rgb(var(--ink-rgb) / 0.54)' }}>Noch keine Daten</p>
          ) : (
            <div className="divide-y" style={{ borderColor: 'rgb(var(--ink-rgb) / calc(0.054 * var(--veil)))' }}>
              {topUsers.map((u, idx) => (
                <button key={u.username} className="w-full flex items-center gap-4 px-4 py-3 transition-colors text-left"
                  style={{ background: 'transparent' }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(60,135,215,0.04)'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                  onClick={() => selectUser(u.username)}>
                  <span className="w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold flex-shrink-0"
                    style={{ background: 'rgba(60,135,215,0.18)', color: 'var(--sky-deep)' }}>
                    {idx + 1}
                  </span>
                  <span className="flex-1 text-[13px] text-ink">{u.username}</span>
                  <span className="text-[11px] px-2 py-0.5 rounded-[8px] font-medium"
                    style={{ background: 'rgb(var(--ink-rgb) / calc(0.048 * var(--veil)))', color: 'rgb(var(--ink-rgb) / 0.66)' }}>
                    {u.count.toLocaleString()} Anfr.
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const ACTION_LABELS: Record<string, string> = {
  admin_login:           'Login erfolgreich',
  admin_login_failed:    'Login fehlgeschlagen',
  delete_user:           'Benutzer gelöscht',
  grant_admin:           'Admin vergeben',
  revoke_admin:          'Admin entzogen',
  delete_all_sessions:   'Sessions gelöscht',
};

const ACTION_COLORS: Record<string, string> = {
  admin_login:           'var(--mint-deep)',
  admin_login_failed:    'var(--rose-deep)',
  delete_user:           'var(--rose-deep)',
  grant_admin:           'var(--sky-deep)',
  revoke_admin:          'var(--amber-deep)',
  delete_all_sessions:   'var(--amber-deep)',
};

function AuditLogTab() {
  const { showToast } = useToast();
  const [entries, setEntries] = useState<import('../types').FileLogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await adminApi.auditLog(100);
      setEntries(data.entries);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Fehler', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-[13px]" style={{ color: 'rgb(var(--ink-rgb) / 0.58)' }}>
          Admin-Aktionen der letzten 3 Tage
        </p>
        <button onClick={() => void load()} disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-medium transition-colors"
          style={{ background: 'rgb(var(--ink-rgb) / calc(0.048 * var(--veil)))', color: 'rgb(var(--ink-rgb) / 0.74)' }}>
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Aktualisieren
        </button>
      </div>

      <div className="mt-2">
        {loading ? (
          <div className="px-4 py-8 flex flex-col gap-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-12 rounded-[10px] shimmer" />
            ))}
          </div>
        ) : entries.length === 0 ? (
          <div className="px-4 py-16 text-center">
            <Shield size={28} className="mx-auto mb-3" style={{ color: 'rgb(var(--ink-rgb) / 0.42)' }} />
            <p className="text-[13px]" style={{ color: 'rgb(var(--ink-rgb) / 0.54)' }}>Noch keine Admin-Aktionen</p>
          </div>
        ) : (
          <div className="divide-y" style={{ borderColor: 'rgb(var(--ink-rgb) / calc(0.054 * var(--veil)))' }}>
            {entries.map((entry, idx) => {
              const action = String(entry['action'] ?? '');
              const label = ACTION_LABELS[action] ?? action;
              const color = ACTION_COLORS[action] ?? 'var(--sky-deep)';
              const time = entry.timestamp
                ? new Date(String(entry.timestamp)).toLocaleString('de-DE')
                : '—';
              const { action: _a, timestamp: _t, level: _l, message: _m, ...rest } = entry;
              return (
                <div key={idx} className="flex items-start gap-3 px-4 py-3">
                  <div className="w-2 h-2 rounded-full mt-1.5 flex-shrink-0" style={{ background: color }} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[13px] font-semibold" style={{ color }}>{label}</span>
                      {Boolean(rest['adminUsername']) && (
                        <span className="text-[12px]" style={{ color: 'rgb(var(--ink-rgb) / 0.7)' }}>
                          von <span className="text-ink">{String(rest['adminUsername'])}</span>
                        </span>
                      )}
                      {Boolean(rest['targetUid']) && (
                        <span className="text-[11px] font-mono px-1.5 py-0.5 rounded" style={{ background: 'rgb(var(--ink-rgb) / calc(0.048 * var(--veil)))', color: 'rgb(var(--ink-rgb) / 0.58)' }}>
                          {String(rest['targetUid']).slice(0, 8)}…
                        </span>
                      )}
                      {Boolean(rest['username']) && !rest['adminUsername'] && (
                        <span className="text-[12px]" style={{ color: 'rgb(var(--ink-rgb) / 0.7)' }}>
                          <span className="text-ink">{String(rest['username'])}</span>
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5 text-[11px]" style={{ color: 'rgb(var(--ink-rgb) / 0.5)' }}>
                      <span>{time}</span>
                      {Boolean(rest['ip']) && <span className="font-mono">{String(rest['ip'])}</span>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

const EVENT_LABELS: Record<string, string> = {
  page_view: 'Seitenaufruf',
  download:  'Download',
  login:     'Login',
  logout:    'Logout',
};

const EVENT_COLORS: Record<string, string> = {
  page_view: 'var(--sky-deep)',
  download:  'var(--mint-deep)',
  login:     'var(--mint-deep)',
  logout:    'var(--amber-deep)',
};

function FrontendActivityTab({ autoRefresh }: { autoRefresh: boolean }) {
  const { showToast } = useToast();
  const [data, setData] = useState<{ logs: FrontendActivityLog[]; total: number } | null>(null);
  const [stats, setStats] = useState<FrontendActivityStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [eventFilter, setEventFilter] = useState('');
  const [usernameInput, setUsernameInput] = useState('');
  const [usernameFilter, setUsernameFilter] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const usernameTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const limit = 50;

  useEffect(() => {
    if (usernameTimer.current) clearTimeout(usernameTimer.current);
    usernameTimer.current = setTimeout(() => setUsernameFilter(usernameInput), 500);
    return () => { if (usernameTimer.current) clearTimeout(usernameTimer.current); };
  }, [usernameInput]);

  const fetchData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [logsRes, statsRes] = await Promise.all([
        adminApi.activityLogs({ page, limit, event: eventFilter || undefined, username: usernameFilter || undefined, from: fromDate || undefined, to: toDate || undefined }),
        adminApi.activityStats(),
      ]);
      setData(logsRes);
      setStats(statsRes);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Fehler', 'error');
    } finally {
      setLoading(false);
    }
  }, [page, eventFilter, usernameFilter, fromDate, toDate, showToast]);

  useEffect(() => { setPage(1); }, [eventFilter, usernameFilter, fromDate, toDate]);
  useEffect(() => { void fetchData(); }, [fetchData]);
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => void fetchData(true), 10000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchData]);

  const logs = data?.logs ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  function downloadCsv() {
    const header = 'Zeit,Event,Seite,Detail,Benutzer,IP,UserAgent';
    const rows = logs.map((l) => [
      l.createdAt, l.event, l.page ?? '', l.detail ?? '', l.username ?? '', l.ip ?? '',
      (l.userAgent ?? '').replace(/,/g, ';'),
    ].map(String).join(','));
    const blob = new Blob([header + '\n' + rows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `frontend-logs-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Stats */}
      {stats && (
        <div className="stat-chips">
          <StatChip label="Events heute" value={stats.totalToday.toLocaleString()} />
          <StatChip label="Nutzer heute" value={stats.uniqueUsersToday.toLocaleString()} />
          <StatChip label="Einträge gesamt" value={total.toLocaleString()} />
          <StatChip label="Event-Typen" value={stats.eventBreakdown.length} />
        </div>
      )}

      {/* Top pages */}
      {stats && stats.topPages.length > 0 && (
        <div className="rounded-[14px] px-4 py-3" style={{ background: 'var(--well)', border: '1px solid transparent' }}>
          <p className="text-[13px] mb-2" style={{ color: 'rgb(var(--ink-rgb) / 0.5)' }}>Top Seiten (24h)</p>
          <div className="flex flex-wrap gap-2">
            {stats.topPages.map((p) => (
              <span key={p.page} className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px]"
                style={{ background: 'rgba(60,135,215,0.1)', color: 'var(--sky-deep)', border: '1px solid transparent' }}>
                <span className="font-mono">{p.page}</span>
                <span className="font-semibold">{p.count}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Filter bar */}
      <div className="flex flex-col gap-2 p-3 rounded-[14px]" style={{ background: 'var(--well)', border: '1px solid transparent' }}>
        <div className="flex flex-wrap gap-2 items-center">
          <SelectField value={eventFilter} onChange={setEventFilter} options={[
            { value: '', label: 'Alle Events' },
            { value: 'page_view', label: 'Seitenaufruf' },
            { value: 'download',  label: 'Download' },
            { value: 'login',     label: 'Login' },
            { value: 'logout',    label: 'Logout' },
          ]} />
          <div className="flex-1 min-w-[150px]">
            <InputField value={usernameInput} onChange={setUsernameInput} placeholder="Benutzer…" icon={<Search size={12} />} />
          </div>
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)}
            className="field h-11 px-4 text-[14px]" />
          <span className="text-[12px]" style={{ color: 'rgb(var(--ink-rgb) / 0.46)' }}>bis</span>
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)}
            className="field h-11 px-4 text-[14px]" />
          {(eventFilter || usernameInput || fromDate || toDate) && (
            <button onClick={() => { setEventFilter(''); setUsernameInput(''); setFromDate(''); setToDate(''); }}
              className="btn btn-sm btn-quiet ml-auto">
              <X size={11} /> Zurücksetzen
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="mt-2">
        <div className="flex items-center justify-between px-4 py-2.5" style={{ borderBottom: '1px solid rgb(var(--ink-rgb) / calc(0.076 * var(--veil)))' }}>
          <span className="text-[12px]" style={{ color: 'rgb(var(--ink-rgb) / 0.54)' }}>{total.toLocaleString()} Einträge</span>
          <button onClick={downloadCsv} className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-medium transition-colors"
            style={{ background: 'rgb(var(--ink-rgb) / calc(0.048 * var(--veil)))', color: 'rgb(var(--ink-rgb) / 0.74)' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgb(var(--ink-rgb) / calc(0.08 * var(--veil)))'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgb(var(--ink-rgb) / calc(0.048 * var(--veil)))'; }}>
            ↓ CSV Export
          </button>
        </div>
        <div className="tbl-scroll">
          <table className="tbl">
            <thead>
              <tr style={{ background: 'rgb(var(--ink-rgb) / calc(0.045 * var(--veil)))', borderBottom: '1px solid rgb(var(--ink-rgb) / calc(0.076 * var(--veil)))' }}>
                {['Zeit', 'Event', 'Seite', 'Detail', 'Benutzer', 'IP'].map((col) => (
                  <th key={col} className={`px-4 py-3 text-left text-[13px]${col === 'IP' || col === 'Detail' ? ' hidden md:table-cell' : ''}`}
                    style={{ color: 'rgb(var(--ink-rgb) / 0.5)' }}>{col}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <SkeletonRows cols={6} />
              ) : logs.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-12 text-center text-[13px]" style={{ color: 'rgb(var(--ink-rgb) / 0.54)' }}>Keine Einträge gefunden</td></tr>
              ) : (
                logs.map((log) => {
                  const color = EVENT_COLORS[log.event] ?? 'var(--sky-deep)';
                  const label = EVENT_LABELS[log.event]  ?? log.event;
                  const isExpanded = expandedId === log.id;
                  return (
                    <Fragment key={log.id}>
                      <tr key={log.id}
                        style={{ borderBottom: isExpanded ? 'none' : '1px solid rgb(var(--ink-rgb) / calc(0.054 * var(--veil)))', cursor: 'pointer', background: isExpanded ? 'rgba(60,135,215,0.04)' : '' }}
                        className="transition-colors"
                        onClick={() => setExpandedId(isExpanded ? null : log.id)}
                        onMouseEnter={(e) => { if (!isExpanded) (e.currentTarget as HTMLElement).style.background = 'rgb(var(--ink-rgb) / calc(0.016 * var(--veil)))'; }}
                        onMouseLeave={(e) => { if (!isExpanded) (e.currentTarget as HTMLElement).style.background = ''; }}>
                        <td className="px-4 py-3 text-[11px] whitespace-nowrap" style={{ color: 'rgb(var(--ink-rgb) / 0.54)' }}>
                          {new Date(log.createdAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        </td>
                        <td className="px-4 py-3">
                          <span className="inline-block text-[11px] px-2 py-0.5 rounded-[8px] font-semibold"
                            style={{ background: `color-mix(in srgb, ${color} 13%, transparent)`, color, border: `1px solid color-mix(in srgb, ${color} 27%, transparent)` }}>
                            {label}
                          </span>
                        </td>
                        <td className="px-4 py-3 max-w-xs">
                          <span className="text-[12px] font-mono truncate block" style={{ color: 'rgb(var(--ink-rgb) / 0.78)' }}>{log.page ?? '—'}</span>
                        </td>
                        <td className="px-4 py-3 hidden md:table-cell max-w-xs">
                          <span className="text-[12px] truncate block" style={{ color: 'rgb(var(--ink-rgb) / 0.66)' }}>{log.detail ?? '—'}</span>
                        </td>
                        <td className="px-4 py-3">
                          {log.username
                            ? <span className="text-[12px] font-medium" style={{ color: 'var(--sky-deep)' }}>{log.username}</span>
                            : <span className="text-[12px]" style={{ color: 'rgb(var(--ink-rgb) / 0.42)' }}>anonym</span>}
                        </td>
                        <td className="px-4 py-3 hidden md:table-cell">
                          <span className="text-[11px] font-mono" style={{ color: 'rgb(var(--ink-rgb) / 0.5)' }}>{log.ip ?? '—'}</span>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr key={`${log.id}-detail`} style={{ borderBottom: '1px solid rgb(var(--ink-rgb) / calc(0.054 * var(--veil)))', background: 'rgba(60,135,215,0.04)' }}>
                          <td colSpan={6} className="px-4 pb-3">
                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-[12px] mt-1">
                              <div>
                                <span style={{ color: 'rgb(var(--ink-rgb) / 0.54)' }}>Zeitstempel</span>
                                <div className="text-ink mt-0.5 font-mono">{new Date(log.createdAt).toLocaleString('de-DE')}</div>
                              </div>
                              <div>
                                <span style={{ color: 'rgb(var(--ink-rgb) / 0.54)' }}>IP-Adresse</span>
                                <div className="text-ink mt-0.5 font-mono">{log.ip ?? '—'}</div>
                              </div>
                              {log.detail && (
                                <div>
                                  <span style={{ color: 'rgb(var(--ink-rgb) / 0.54)' }}>Detail</span>
                                  <div className="text-ink mt-0.5">{log.detail}</div>
                                </div>
                              )}
                              {log.userAgent && (
                                <div className="col-span-2 sm:col-span-3">
                                  <span style={{ color: 'rgb(var(--ink-rgb) / 0.54)' }}>User-Agent</span>
                                  <div className="mt-0.5 font-mono break-all" style={{ color: 'rgb(var(--ink-rgb) / 0.74)', fontSize: '11px' }}>{log.userAgent}</div>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3" style={{ borderTop: '1px solid rgb(var(--ink-rgb) / calc(0.076 * var(--veil)))' }}>
            <span className="text-[12px]" style={{ color: 'rgb(var(--ink-rgb) / 0.5)' }}>Seite {page} von {totalPages}</span>
            <div className="flex items-center gap-2">
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}
                className="p-1.5 rounded-full transition-colors disabled:opacity-25" style={{ color: 'rgb(var(--ink-rgb) / 0.7)' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgb(var(--ink-rgb) / calc(0.04 * var(--veil)))'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = ''; }}>
                <ChevronLeft size={16} />
              </button>
              <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                className="p-1.5 rounded-full transition-colors disabled:opacity-25" style={{ color: 'rgb(var(--ink-rgb) / 0.7)' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgb(var(--ink-rgb) / calc(0.04 * var(--veil)))'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = ''; }}>
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function LogsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const stateUsername = (location.state as { username?: string } | null)?.username ?? '';

  const [activeTab, setActiveTab] = useState<'all' | 'byUser' | 'audit' | 'frontend'>(stateUsername ? 'byUser' : 'all');
  // Live by default; the button pauses it while someone reads a page of logs.
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [methodFilter, setMethodFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [pathInput, setPathInput] = useState('');
  const [pathFilter, setPathFilter] = useState('');
  const [usernameInput, setUsernameInput] = useState('');
  const [usernameFilter, setUsernameFilter] = useState('');
  const [scopeFilter, setScopeFilter] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const pathTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const usernameTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [trend, setTrend] = useState<RequestsChartPoint[]>([]);

  // Hourly totals for the chart above the list; refreshed while "live" is on.
  useEffect(() => {
    const loadTrend = () => { adminApi.requestsChart().then(setTrend).catch(() => { /* the list works without the chart */ }); };
    loadTrend();
    if (!autoRefresh) return;
    const timer = setInterval(loadTrend, 60000);
    return () => clearInterval(timer);
  }, [autoRefresh]);
  useLive(['requests'], () => {
    if (autoRefresh) adminApi.requestsChart().then(setTrend).catch(() => { /* keep the last chart */ });
  }, 10000);

  useEffect(() => {
    if (stateUsername) navigate(location.pathname, { replace: true, state: null });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (pathTimer.current) clearTimeout(pathTimer.current);
    pathTimer.current = setTimeout(() => setPathFilter(pathInput), 500);
    return () => { if (pathTimer.current) clearTimeout(pathTimer.current); };
  }, [pathInput]);

  useEffect(() => {
    if (usernameTimer.current) clearTimeout(usernameTimer.current);
    usernameTimer.current = setTimeout(() => setUsernameFilter(usernameInput), 500);
    return () => { if (usernameTimer.current) clearTimeout(usernameTimer.current); };
  }, [usernameInput]);

  function setQuickFilter(type: 'errors' | 'today' | 'post' | '5xx') {
    const today = new Date().toISOString().slice(0, 10);
    if (type === 'errors') { setStatusFilter('4xx'); setMethodFilter(''); setFromDate(''); setToDate(''); }
    if (type === 'today')  { setFromDate(today); setToDate(today); setStatusFilter(''); setMethodFilter(''); }
    if (type === 'post')   { setMethodFilter('POST'); setStatusFilter(''); setFromDate(''); setToDate(''); }
    if (type === '5xx')    { setStatusFilter('5xx'); setMethodFilter(''); setFromDate(''); setToDate(''); }
  }

  function clearFilters() { setMethodFilter(''); setStatusFilter(''); setPathInput(''); setPathFilter(''); setUsernameInput(''); setUsernameFilter(''); setScopeFilter(''); setFromDate(''); setToDate(''); }

  const hasFilters = methodFilter || statusFilter || pathInput || usernameInput || scopeFilter || fromDate || toDate;
  const [byUserInitial, setByUserInitial] = useState(stateUsername);

  function navigateToUser(username: string) { setByUserInitial(username); setActiveTab('byUser'); }

  const tabs = [
    { key: 'all'      as const, label: 'Alle Anfragen' },
    { key: 'byUser'   as const, label: 'Nach Benutzer' },
    { key: 'frontend' as const, label: 'Frontend-Aktivität' },
    { key: 'audit'    as const, label: 'Admin-Aktivität' },
  ];

  const quickChips = [
    { label: 'Heute', action: () => setQuickFilter('today') },
    { label: 'Fehler 4xx', action: () => setQuickFilter('errors') },
    { label: 'Fehler 5xx', action: () => setQuickFilter('5xx') },
    { label: 'POST', action: () => setQuickFilter('post') },
  ];

  return (
    <div>
      <PageHeader
        title={activeTab === 'frontend' ? 'Frontend-Aktivität' : 'Request Logs'}
        subtitle={activeTab === 'frontend' ? 'Seitenaufrufe, Downloads und Aktionen im Frontend.' : 'Eingehende HTTP-Anfragen an die API.'}
      >
        <button
          type="button"
          onClick={() => setAutoRefresh((v) => !v)}
          aria-pressed={autoRefresh}
          className={`btn ${autoRefresh ? 'btn-primary' : 'btn-quiet'}`}
        >
          <RefreshCw size={15} strokeWidth={1.7} className={autoRefresh ? 'animate-spin' : ''} />
          {autoRefresh ? 'Live (10 s)' : 'Auto-Refresh'}
        </button>
      </PageHeader>

      <div className="mt-9">
        <Segmented label="Ansicht" value={activeTab} onChange={setActiveTab} options={tabs.map((tab) => ({ value: tab.key, label: tab.label }))} />
      </div>

      {activeTab === 'all' && trend.length > 1 && (
        <Section className="mt-[42px]" title="Verlauf" meta="Letzte 24 Std.">
          <div className="mt-8">
            <TrendChart
              labels={trend.map((p) => p.hour)}
              titles={trend.map((p) => `${p.hour} Uhr`)}
              series={[
                { key: 'count',  label: 'Anfragen', color: '#4f96dc', area: true, values: trend.map((p) => p.count) },
                { key: 'errors', label: 'Fehler',   color: '#f2a55c', values: trend.map((p) => p.errors) },
              ]}
              tickEvery={4}
              drawKey="logs-24h"
              ariaLabel="API-Anfragen und Fehler je Stunde, letzte 24 Stunden"
            />
          </div>
        </Section>
      )}

      {/* Filter bar — hidden on audit + frontend tab (they have their own) */}
      {activeTab !== 'audit' && activeTab !== 'frontend' && (
        <Section
          className="mt-[44px]"
          title="Filter"
          action={hasFilters ? (
            <button type="button" onClick={clearFilters} className="btn btn-sm btn-line">
              <X size={13} strokeWidth={1.8} /> Zurücksetzen
            </button>
          ) : undefined}
        >
          <div className="mt-6 flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              {quickChips.map((chip) => (
                <button key={chip.label} type="button" onClick={chip.action} className="btn btn-sm btn-quiet">
                  {chip.label}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              <SelectField value={methodFilter} onChange={setMethodFilter} options={[
                { value: '', label: 'Alle Methoden' }, { value: 'GET', label: 'GET' }, { value: 'POST', label: 'POST' },
                { value: 'PATCH', label: 'PATCH' }, { value: 'DELETE', label: 'DELETE' },
              ]} />
              <SelectField value={statusFilter} onChange={setStatusFilter} options={[
                { value: '', label: 'Alle Status' }, { value: '2xx', label: '2xx' }, { value: '4xx', label: '4xx' }, { value: '5xx', label: '5xx' },
              ]} />
              <SelectField value={scopeFilter} onChange={setScopeFilter} options={[
                { value: '', label: 'Alle Bereiche' }, { value: 'learn', label: 'Learn' }, { value: 'core', label: 'Core' },
              ]} />
              <div className="min-w-[150px] flex-1">
                <InputField value={pathInput} onChange={setPathInput} placeholder="Pfad filtern" />
              </div>
              <div className="min-w-[150px] flex-1">
                <InputField value={usernameInput} onChange={setUsernameInput} placeholder="Benutzer" icon={<Search size={15} strokeWidth={1.6} />} />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2.5 text-[13.5px] text-ink-3">
              <span>Zeitraum</span>
              <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} aria-label="Von" className="field h-11 px-4 text-[14px]" />
              <span>bis</span>
              <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} aria-label="Bis" className="field h-11 px-4 text-[14px]" />
            </div>
          </div>
        </Section>
      )}

      <div className="mt-[44px]">
        {activeTab === 'all' ? (
          <AllRequestsTab
            methodFilter={methodFilter}
            statusFilter={statusFilter}
            pathFilter={pathFilter}
            usernameFilter={usernameFilter}
            scopeFilter={scopeFilter}
            fromDate={fromDate}
            toDate={toDate}
            onNavigateToUser={(username) => navigateToUser(username)}
            autoRefresh={autoRefresh}
          />
        ) : activeTab === 'byUser' ? (
          <ByUserTab key={byUserInitial} initialUsername={byUserInitial} />
        ) : activeTab === 'frontend' ? (
          <FrontendActivityTab autoRefresh={autoRefresh} />
        ) : (
          <AuditLogTab />
        )}
      </div>
    </div>
  );
}
