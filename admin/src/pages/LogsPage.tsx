import { useEffect, useState, useRef, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  ScrollText,
  RefreshCw,
  Search,
  X,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { adminApi } from '../api';
import { useToast } from '../components/Toast';
import type { RequestLog, LogsResponse } from '../types';

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
    case 'GET':    return { bg: 'rgba(255,255,255,0.05)',   color: 'rgba(235,235,245,0.55)', border: 'rgba(255,255,255,0.1)' };
    case 'POST':   return { bg: 'rgba(10,132,255,0.14)',    color: '#0a84ff',                border: 'rgba(10,132,255,0.22)' };
    case 'PATCH':  return { bg: 'rgba(255,159,10,0.14)',    color: '#ff9f0a',                border: 'rgba(255,159,10,0.22)' };
    case 'DELETE': return { bg: 'rgba(255,69,58,0.14)',     color: '#ff453a',                border: 'rgba(255,69,58,0.22)' };
    default:       return { bg: 'rgba(255,255,255,0.04)',   color: 'rgba(235,235,245,0.4)',  border: 'rgba(255,255,255,0.08)' };
  }
}

function statusStyle(status: number): BadgeStyle {
  if (status >= 500) return { bg: 'rgba(255,69,58,0.14)',   color: '#ff453a',  border: 'rgba(255,69,58,0.22)' };
  if (status >= 400) return { bg: 'rgba(255,159,10,0.14)',  color: '#ff9f0a',  border: 'rgba(255,159,10,0.22)' };
  if (status >= 300) return { bg: 'rgba(10,132,255,0.14)',  color: '#0a84ff',  border: 'rgba(10,132,255,0.22)' };
  return { bg: 'rgba(48,209,88,0.14)', color: '#30d158', border: 'rgba(48,209,88,0.22)' };
}

function Badge({ text, style }: { text: string; style: BadgeStyle }) {
  return (
    <span
      className="inline-block text-[11px] px-2 py-0.5 rounded-[6px] font-mono font-semibold"
      style={{ background: style.bg, color: style.color, border: `1px solid ${style.border}` }}
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
      className="px-3 py-2 rounded-[10px] text-[13px] outline-none"
      style={{
        background: '#1c1c1e',
        border: '1px solid rgba(255,255,255,0.08)',
        color: 'rgba(235,235,245,0.7)',
        minWidth: '100px',
      }}
    >
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function InputField({ value, onChange, placeholder, icon }: { value: string; onChange: (v: string) => void; placeholder: string; icon?: React.ReactNode }) {
  return (
    <div className="relative">
      {icon && <span className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'rgba(235,235,245,0.3)' }}>{icon}</span>}
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="apple-input w-full py-2 text-[13px]"
        style={{ paddingLeft: icon ? '32px' : '12px', paddingRight: '12px' }}
      />
    </div>
  );
}

function StatChip({ label, value }: { label: string; value: string | number }) {
  return (
    <div
      className="flex flex-col px-4 py-2.5 rounded-[12px] flex-1 min-w-0"
      style={{ background: '#1c1c1e', border: '1px solid rgba(255,255,255,0.07)' }}
    >
      <span className="text-[11px]" style={{ color: 'rgba(235,235,245,0.35)' }}>{label}</span>
      <span className="text-[15px] font-semibold mt-0.5 truncate text-white" style={{ letterSpacing: '-0.01em' }}>
        {value}
      </span>
    </div>
  );
}

function SkeletonRows({ cols }: { cols: number }) {
  return (
    <>
      {Array.from({ length: 8 }).map((_, i) => (
        <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
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
  fromDate: string;
  toDate: string;
  onNavigateToUser: (username: string) => void;
  autoRefresh: boolean;
}

function AllRequestsTab({ methodFilter, statusFilter, pathFilter, usernameFilter, fromDate, toDate, onNavigateToUser, autoRefresh }: AllRequestsTabProps) {
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
      const res = await adminApi.logs({ page, limit, method: methodFilter || undefined, status: statusNum, path: pathFilter || undefined, username: usernameFilter || undefined, from: fromDate || undefined, to: toDate || undefined });
      setData(res);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Laden fehlgeschlagen', 'error');
    } finally {
      setLoading(false);
    }
  }, [page, methodFilter, statusFilter, pathFilter, usernameFilter, fromDate, toDate, showToast]);

  useEffect(() => { setPage(1); }, [methodFilter, statusFilter, pathFilter, usernameFilter, fromDate, toDate]);
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
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatChip label="Anfragen gesamt" value={total.toLocaleString()} />
        <StatChip label="Fehlerrate" value={`${errorRate}%`} />
        <StatChip label="Ø Dauer" value={`${avgDuration}ms`} />
        <StatChip label="Nutzer" value={uniqueUsers} />
      </div>

      <div
        className="rounded-[16px] overflow-hidden"
        style={{ background: '#1c1c1e', border: '1px solid rgba(255,255,255,0.07)', boxShadow: '0 4px 20px rgba(0,0,0,0.4)' }}
      >
        <div className="flex items-center justify-between px-4 py-2.5" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <span className="text-[12px]" style={{ color: 'rgba(235,235,245,0.35)' }}>{total.toLocaleString()} Einträge</span>
          <button onClick={downloadCsv} className="flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] text-[12px] font-medium transition-colors" style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(235,235,245,0.6)' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.1)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.06)'; }}>
            ↓ CSV Export
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr style={{ background: 'rgba(0,0,0,0.3)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                {['Zeit', 'Methode', 'Pfad', 'Status', 'Dauer', 'Benutzer', 'IP'].map((col) => (
                  <th key={col} className={`px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.05em]${col === 'IP' || col === 'Dauer' ? ' hidden md:table-cell' : ''}`} style={{ color: 'rgba(235,235,245,0.3)' }}>
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <SkeletonRows cols={7} />
              ) : logs.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-12 text-center text-[13px]" style={{ color: 'rgba(235,235,245,0.35)' }}>Keine Logs gefunden</td></tr>
              ) : (
                logs.map((log) => {
                  const ms = methodStyle(log.method);
                  const ss = statusStyle(log.status);
                  const isExpanded = expandedId === log.id;
                  return (
                    <>
                      <tr
                        key={log.id}
                        style={{ borderBottom: isExpanded ? 'none' : '1px solid rgba(255,255,255,0.04)', cursor: 'pointer', background: isExpanded ? 'rgba(10,132,255,0.04)' : '' }}
                        className="transition-colors"
                        onClick={() => setExpandedId(isExpanded ? null : log.id)}
                        onMouseEnter={(e) => { if (!isExpanded) (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.02)'; }}
                        onMouseLeave={(e) => { if (!isExpanded) (e.currentTarget as HTMLElement).style.background = ''; }}
                      >
                        <td className="px-4 py-3 text-[11px] whitespace-nowrap" style={{ color: 'rgba(235,235,245,0.35)' }}>
                          {new Date(log.createdAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        </td>
                        <td className="px-4 py-3"><Badge text={log.method} style={ms} /></td>
                        <td className="px-4 py-3 max-w-xs">
                          <span className="text-[12px] font-mono truncate block" style={{ color: 'rgba(235,235,245,0.65)' }}>{log.path}</span>
                          {log.error && <span className="text-[11px] truncate block mt-0.5" style={{ color: '#ff453a' }}>{log.error}</span>}
                        </td>
                        <td className="px-4 py-3"><Badge text={String(log.status)} style={ss} /></td>
                        <td className="px-4 py-3 hidden md:table-cell text-[12px] whitespace-nowrap" style={{ color: 'rgba(235,235,245,0.4)' }}>{log.duration}ms</td>
                        <td className="px-4 py-3">
                          {log.username ? (
                            <button className="text-[12px] font-medium transition-colors" style={{ color: '#0a84ff' }}
                              onClick={(e) => { e.stopPropagation(); onNavigateToUser(log.username!); }}>
                              {log.username}
                            </button>
                          ) : <span className="text-[12px]" style={{ color: 'rgba(235,235,245,0.2)' }}>—</span>}
                        </td>
                        <td className="px-4 py-3 hidden md:table-cell">
                          <span className="text-[11px] font-mono" style={{ color: 'rgba(235,235,245,0.3)' }}>{log.ip ?? '—'}</span>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr key={`${log.id}-detail`} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', background: 'rgba(10,132,255,0.04)' }}>
                          <td colSpan={7} className="px-4 pb-3">
                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-[12px] mt-1">
                              <div>
                                <span style={{ color: 'rgba(235,235,245,0.35)' }}>Zeitstempel</span>
                                <div className="text-white mt-0.5 font-mono">{new Date(log.createdAt).toLocaleString('de-DE')}</div>
                              </div>
                              <div>
                                <span style={{ color: 'rgba(235,235,245,0.35)' }}>IP-Adresse</span>
                                <div className="text-white mt-0.5 font-mono">{log.ip ?? '—'}</div>
                              </div>
                              <div>
                                <span style={{ color: 'rgba(235,235,245,0.35)' }}>Dauer</span>
                                <div className="text-white mt-0.5">{log.duration}ms</div>
                              </div>
                              {log.userAgent && (
                                <div className="col-span-2 sm:col-span-3">
                                  <span style={{ color: 'rgba(235,235,245,0.35)' }}>User-Agent</span>
                                  <div className="mt-0.5 font-mono break-all" style={{ color: 'rgba(235,235,245,0.6)', fontSize: '11px' }}>{log.userAgent}</div>
                                </div>
                              )}
                              {log.error && (
                                <div className="col-span-2 sm:col-span-3">
                                  <span style={{ color: '#ff453a' }}>Fehler</span>
                                  <div className="mt-0.5 font-mono text-[11px]" style={{ color: '#ff6b63' }}>{log.error}</div>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
            <span className="text-[12px]" style={{ color: 'rgba(235,235,245,0.3)' }}>Seite {page} von {totalPages}</span>
            <div className="flex items-center gap-2">
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}
                className="p-1.5 rounded-[8px] transition-colors disabled:opacity-25" style={{ color: 'rgba(235,235,245,0.55)' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.05)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = ''; }}>
                <ChevronLeft size={16} />
              </button>
              <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                className="p-1.5 rounded-[8px] transition-colors disabled:opacity-25" style={{ color: 'rgba(235,235,245,0.55)' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.05)'; }}
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
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'rgba(235,235,245,0.3)' }} />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && search.trim()) selectUser(search.trim()); }}
            placeholder="Benutzername suchen…"
            className="apple-input w-full pl-8 pr-4 py-2 text-[13px]"
          />
        </div>
        <button
          onClick={() => { if (search.trim()) selectUser(search.trim()); }}
          className="apple-btn px-4 py-2 text-[13px]"
        >
          Anzeigen
        </button>
        {selectedUsername && (
          <button
            onClick={() => { setSelectedUsername(''); setSearch(''); setUserLogs([]); }}
            className="p-2 rounded-[10px] apple-btn-ghost"
          >
            <X size={13} />
          </button>
        )}
      </div>

      {selectedUsername ? (
        <div className="rounded-[16px] overflow-hidden" style={{ background: '#1c1c1e', border: '1px solid rgba(255,255,255,0.07)', boxShadow: '0 4px 20px rgba(0,0,0,0.4)' }}>
          <div className="px-4 py-3 flex items-center gap-2" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <span className="text-[14px] font-semibold text-white">{selectedUsername}</span>
            <span className="text-[12px]" style={{ color: 'rgba(235,235,245,0.35)' }}>· {userTotal.toLocaleString()} Anfragen</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr style={{ background: 'rgba(0,0,0,0.3)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                  {['Zeit', 'Methode', 'Pfad', 'Status', 'Dauer'].map((col) => (
                    <th key={col} className={`px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.05em]${col === 'Dauer' ? ' hidden md:table-cell' : ''}`} style={{ color: 'rgba(235,235,245,0.3)' }}>{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading ? <SkeletonRows cols={5} /> : userLogs.length === 0 ? (
                  <tr><td colSpan={5} className="px-4 py-12 text-center text-[13px]" style={{ color: 'rgba(235,235,245,0.35)' }}>Keine Logs für diesen Benutzer</td></tr>
                ) : userLogs.map((log) => (
                  <tr key={log.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }} className="transition-colors"
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.02)'; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = ''; }}>
                    <td className="px-4 py-3 text-[11px] whitespace-nowrap" style={{ color: 'rgba(235,235,245,0.35)' }}>{relativeTime(log.createdAt)}</td>
                    <td className="px-4 py-3"><Badge text={log.method} style={methodStyle(log.method)} /></td>
                    <td className="px-4 py-3 max-w-xs">
                      <span className="text-[12px] font-mono truncate block" style={{ color: 'rgba(235,235,245,0.65)' }}>{log.path}</span>
                      {log.error && <span className="text-[11px] truncate block mt-0.5" style={{ color: '#ff453a' }}>{log.error}</span>}
                    </td>
                    <td className="px-4 py-3"><Badge text={String(log.status)} style={statusStyle(log.status)} /></td>
                    <td className="px-4 py-3 hidden md:table-cell text-[12px] whitespace-nowrap" style={{ color: 'rgba(235,235,245,0.4)' }}>{log.duration}ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {userTotalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
              <span className="text-[12px]" style={{ color: 'rgba(235,235,245,0.3)' }}>Seite {userPage} von {userTotalPages}</span>
              <div className="flex items-center gap-2">
                <button onClick={() => setUserPage((p) => Math.max(1, p - 1))} disabled={userPage === 1}
                  className="p-1.5 rounded-[8px] transition-colors disabled:opacity-25" style={{ color: 'rgba(235,235,245,0.55)' }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.05)'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = ''; }}>
                  <ChevronLeft size={16} />
                </button>
                <button onClick={() => setUserPage((p) => Math.min(userTotalPages, p + 1))} disabled={userPage === userTotalPages}
                  className="p-1.5 rounded-[8px] transition-colors disabled:opacity-25" style={{ color: 'rgba(235,235,245,0.55)' }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.05)'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = ''; }}>
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-[16px] overflow-hidden" style={{ background: '#1c1c1e', border: '1px solid rgba(255,255,255,0.07)', boxShadow: '0 4px 20px rgba(0,0,0,0.4)' }}>
          <div className="px-4 py-3" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <span className="text-[14px] font-semibold text-white">Aktivste Benutzer</span>
          </div>
          {loadingTop ? (
            <div className="px-4 py-8 flex justify-center">
              <div className="w-5 h-5 border-2 rounded-full animate-spin" style={{ borderColor: 'rgba(255,255,255,0.1)', borderTopColor: '#0a84ff' }} />
            </div>
          ) : topUsers.length === 0 ? (
            <p className="px-4 py-8 text-center text-[13px]" style={{ color: 'rgba(235,235,245,0.35)' }}>Noch keine Daten</p>
          ) : (
            <div className="divide-y" style={{ borderColor: 'rgba(255,255,255,0.04)' }}>
              {topUsers.map((u, idx) => (
                <button key={u.username} className="w-full flex items-center gap-4 px-4 py-3 transition-colors text-left"
                  style={{ background: 'transparent' }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(10,132,255,0.04)'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                  onClick={() => selectUser(u.username)}>
                  <span className="w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold flex-shrink-0"
                    style={{ background: 'rgba(10,132,255,0.18)', color: '#0a84ff' }}>
                    {idx + 1}
                  </span>
                  <span className="flex-1 text-[13px] text-white">{u.username}</span>
                  <span className="text-[11px] px-2 py-0.5 rounded-[6px] font-medium"
                    style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(235,235,245,0.5)' }}>
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

export function LogsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const stateUsername = (location.state as { username?: string } | null)?.username ?? '';

  const [activeTab, setActiveTab] = useState<'all' | 'byUser'>(stateUsername ? 'byUser' : 'all');
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [methodFilter, setMethodFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [pathInput, setPathInput] = useState('');
  const [pathFilter, setPathFilter] = useState('');
  const [usernameInput, setUsernameInput] = useState('');
  const [usernameFilter, setUsernameFilter] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const pathTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const usernameTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  function clearFilters() { setMethodFilter(''); setStatusFilter(''); setPathInput(''); setPathFilter(''); setUsernameInput(''); setUsernameFilter(''); setFromDate(''); setToDate(''); }

  const hasFilters = methodFilter || statusFilter || pathInput || usernameInput || fromDate || toDate;
  const [byUserInitial, setByUserInitial] = useState(stateUsername);

  function navigateToUser(username: string) { setByUserInitial(username); setActiveTab('byUser'); }

  const tabs = [{ key: 'all' as const, label: 'Alle Anfragen' }, { key: 'byUser' as const, label: 'Nach Benutzer' }];

  const quickChips = [
    { label: 'Heute', action: () => setQuickFilter('today') },
    { label: 'Fehler 4xx', action: () => setQuickFilter('errors') },
    { label: 'Fehler 5xx', action: () => setQuickFilter('5xx') },
    { label: 'POST', action: () => setQuickFilter('post') },
  ];

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <ScrollText size={18} style={{ color: '#0a84ff' }} />
            <h1 className="text-[28px] font-bold text-white" style={{ letterSpacing: '-0.03em' }}>Request Logs</h1>
          </div>
          <p className="text-[14px]" style={{ color: 'rgba(235,235,245,0.4)' }}>Eingehende HTTP-Anfragen an die API</p>
        </div>
        <button onClick={() => setAutoRefresh((v) => !v)}
          className="flex items-center gap-2 px-3 py-2 rounded-[10px] text-[13px] transition-all"
          style={{ background: autoRefresh ? 'rgba(10,132,255,0.14)' : '#1c1c1e', color: autoRefresh ? '#0a84ff' : 'rgba(235,235,245,0.5)', border: autoRefresh ? '1px solid rgba(10,132,255,0.28)' : '1px solid rgba(255,255,255,0.08)' }}>
          <RefreshCw size={13} className={autoRefresh ? 'animate-spin' : ''} />
          {autoRefresh ? 'Live (10s)' : 'Auto-Refresh'}
        </button>
      </div>

      {/* Filter bar */}
      <div className="flex flex-col gap-2 p-3 rounded-[14px]" style={{ background: '#1c1c1e', border: '1px solid rgba(255,255,255,0.07)' }}>
        {/* Quick chips */}
        <div className="flex flex-wrap gap-1.5">
          {quickChips.map((chip) => (
            <button key={chip.label} onClick={chip.action}
              className="px-3 py-1 rounded-full text-[12px] font-medium transition-colors"
              style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(235,235,245,0.6)', border: '1px solid rgba(255,255,255,0.08)' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(10,132,255,0.14)'; (e.currentTarget as HTMLElement).style.color = '#0a84ff'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.06)'; (e.currentTarget as HTMLElement).style.color = 'rgba(235,235,245,0.6)'; }}>
              {chip.label}
            </button>
          ))}
        </div>
        {/* Main filters */}
        <div className="flex flex-wrap gap-2 items-center">
          <SelectField value={methodFilter} onChange={setMethodFilter} options={[
            { value: '', label: 'Alle Methoden' }, { value: 'GET', label: 'GET' }, { value: 'POST', label: 'POST' },
            { value: 'PATCH', label: 'PATCH' }, { value: 'DELETE', label: 'DELETE' },
          ]} />
          <SelectField value={statusFilter} onChange={setStatusFilter} options={[
            { value: '', label: 'Alle Status' }, { value: '2xx', label: '2xx' }, { value: '4xx', label: '4xx' }, { value: '5xx', label: '5xx' },
          ]} />
          <div className="flex-1 min-w-[130px]">
            <InputField value={pathInput} onChange={setPathInput} placeholder="Pfad filtern…" />
          </div>
          <div className="flex-1 min-w-[130px]">
            <InputField value={usernameInput} onChange={setUsernameInput} placeholder="Benutzer…" icon={<Search size={12} />} />
          </div>
        </div>
        {/* Date range */}
        <div className="flex flex-wrap gap-2 items-center">
          <span className="text-[12px]" style={{ color: 'rgba(235,235,245,0.35)' }}>Zeitraum:</span>
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)}
            className="px-3 py-1.5 rounded-[8px] text-[12px] outline-none"
            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(235,235,245,0.7)' }} />
          <span className="text-[12px]" style={{ color: 'rgba(235,235,245,0.25)' }}>bis</span>
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)}
            className="px-3 py-1.5 rounded-[8px] text-[12px] outline-none"
            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(235,235,245,0.7)' }} />
          {hasFilters && (
            <button onClick={clearFilters} className="flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] text-[12px] transition-colors apple-btn-ghost ml-auto">
              <X size={11} /> Zurücksetzen
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: '1px' }}>
        {tabs.map((tab) => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)}
            className="px-4 py-2.5 text-[13px] font-medium transition-all rounded-t-[8px]"
            style={{ color: activeTab === tab.key ? '#0a84ff' : 'rgba(235,235,245,0.45)', background: activeTab === tab.key ? 'rgba(10,132,255,0.1)' : 'transparent', borderBottom: activeTab === tab.key ? '2px solid #0a84ff' : '2px solid transparent' }}>
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'all' ? (
        <AllRequestsTab
          methodFilter={methodFilter}
          statusFilter={statusFilter}
          pathFilter={pathFilter}
          usernameFilter={usernameFilter}
          fromDate={fromDate}
          toDate={toDate}
          onNavigateToUser={(username) => navigateToUser(username)}
          autoRefresh={autoRefresh}
        />
      ) : (
        <ByUserTab key={byUserInitial} initialUsername={byUserInitial} />
      )}
    </div>
  );
}
