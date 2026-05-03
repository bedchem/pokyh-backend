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

// ─── helpers ────────────────────────────────────────────────────────────────

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ─── badge helpers ───────────────────────────────────────────────────────────

interface BadgeStyle {
  bg: string;
  color: string;
  border: string;
}

function methodStyle(method: string): BadgeStyle {
  switch (method.toUpperCase()) {
    case 'GET':
      return { bg: 'rgba(100,116,139,0.15)', color: '#94a3b8', border: 'rgba(100,116,139,0.2)' };
    case 'POST':
      return { bg: 'rgba(99,102,241,0.15)', color: '#818cf8', border: 'rgba(99,102,241,0.2)' };
    case 'PATCH':
      return { bg: 'rgba(234,179,8,0.15)', color: '#fde047', border: 'rgba(234,179,8,0.2)' };
    case 'DELETE':
      return { bg: 'rgba(239,68,68,0.15)', color: '#f87171', border: 'rgba(239,68,68,0.2)' };
    default:
      return { bg: 'rgba(100,116,139,0.1)', color: '#64748b', border: 'rgba(100,116,139,0.15)' };
  }
}

function statusStyle(status: number): BadgeStyle {
  if (status >= 500) return { bg: 'rgba(239,68,68,0.15)', color: '#f87171', border: 'rgba(239,68,68,0.2)' };
  if (status >= 400) return { bg: 'rgba(245,158,11,0.15)', color: '#fbbf24', border: 'rgba(245,158,11,0.2)' };
  if (status >= 300) return { bg: 'rgba(59,130,246,0.15)', color: '#60a5fa', border: 'rgba(59,130,246,0.2)' };
  return { bg: 'rgba(16,185,129,0.15)', color: '#34d399', border: 'rgba(16,185,129,0.2)' };
}

function Badge({ text, style }: { text: string; style: BadgeStyle }) {
  return (
    <span
      className="inline-block text-xs px-2 py-0.5 rounded font-mono font-semibold"
      style={{ background: style.bg, color: style.color, border: `1px solid ${style.border}` }}
    >
      {text}
    </span>
  );
}

// ─── sub-components ──────────────────────────────────────────────────────────

function SelectField({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="px-3 py-2 rounded-lg text-sm text-slate-300 outline-none"
      style={{
        background: '#0e0f1c',
        border: '1px solid rgba(255,255,255,0.08)',
        minWidth: '100px',
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function InputField({
  value,
  onChange,
  placeholder,
  icon,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="relative">
      {icon && (
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">{icon}</span>
      )}
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full py-2 rounded-lg text-sm text-slate-200 placeholder-slate-600 outline-none"
        style={{
          background: '#0e0f1c',
          border: '1px solid rgba(255,255,255,0.08)',
          paddingLeft: icon ? '32px' : '12px',
          paddingRight: '12px',
        }}
        onFocus={(e) => {
          (e.target as HTMLInputElement).style.borderColor = 'rgba(99,102,241,0.5)';
        }}
        onBlur={(e) => {
          (e.target as HTMLInputElement).style.borderColor = 'rgba(255,255,255,0.08)';
        }}
      />
    </div>
  );
}

function StatChip({ label, value }: { label: string; value: string | number }) {
  return (
    <div
      className="flex flex-col px-4 py-2.5 rounded-xl flex-1 min-w-0"
      style={{ background: '#0e0f1c', border: '1px solid rgba(255,255,255,0.06)' }}
    >
      <span className="text-xs text-slate-500 truncate">{label}</span>
      <span className="text-base font-semibold text-slate-100 mt-0.5 truncate">{value}</span>
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
              <div
                className="h-4 rounded animate-pulse"
                style={{ background: 'rgba(255,255,255,0.06)', width: j === 2 ? '180px' : '80px' }}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

// ─── All Requests tab ─────────────────────────────────────────────────────────

interface AllRequestsTabProps {
  methodFilter: string;
  statusFilter: string;
  pathFilter: string;
  usernameFilter: string;
  onNavigateToUser: (username: string) => void;
  autoRefresh: boolean;
}

function AllRequestsTab({
  methodFilter,
  statusFilter,
  pathFilter,
  usernameFilter,
  onNavigateToUser,
  autoRefresh,
}: AllRequestsTabProps) {
  const { showToast } = useToast();
  const [data, setData] = useState<LogsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const limit = 50;

  const fetchLogs = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const statusNum = statusFilter === '2xx' ? 200 : statusFilter === '4xx' ? 400 : statusFilter === '5xx' ? 500 : undefined;
      const res = await adminApi.logs({
        page,
        limit,
        method: methodFilter || undefined,
        status: statusNum,
        path: pathFilter || undefined,
        username: usernameFilter || undefined,
      });
      setData(res);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to load logs', 'error');
    } finally {
      setLoading(false);
    }
  }, [page, methodFilter, statusFilter, pathFilter, usernameFilter, showToast]);

  // Reset page when filters change
  useEffect(() => {
    setPage(1);
  }, [methodFilter, statusFilter, pathFilter, usernameFilter]);

  useEffect(() => {
    void fetchLogs();
  }, [fetchLogs]);

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
  const avgDuration =
    logs.length > 0
      ? Math.round(logs.reduce((s, l) => s + l.duration, 0) / logs.length)
      : 0;
  const uniqueUsers = new Set(logs.map((l) => l.username).filter(Boolean)).size;

  return (
    <div className="flex flex-col gap-4">
      {/* Stats row */}
      <div className="flex gap-3 flex-wrap">
        <StatChip label="Shown" value={total.toLocaleString()} />
        <StatChip label="Error rate" value={`${errorRate}%`} />
        <StatChip label="Avg duration" value={`${avgDuration}ms`} />
        <StatChip label="Unique users" value={uniqueUsers} />
      </div>

      {/* Table */}
      <div
        className="rounded-2xl overflow-hidden min-w-0"
        style={{
          background: '#0e0f1c',
          border: '1px solid rgba(255,255,255,0.06)',
          boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
        }}
      >
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr style={{ background: '#060710', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                {['Time', 'Method', 'Path', 'Status', 'Duration', 'User', 'IP'].map((col) => (
                  <th
                    key={col}
                    className={`px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider${
                      col === 'IP' || col === 'Duration' ? ' hidden md:table-cell' : ''
                    }`}
                    style={{ color: '#64748b' }}
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <SkeletonRows cols={7} />
              ) : logs.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-slate-500">
                    No logs found
                  </td>
                </tr>
              ) : (
                logs.map((log) => {
                  const ms = methodStyle(log.method);
                  const ss = statusStyle(log.status);
                  return (
                    <tr
                      key={log.id}
                      style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}
                      className="transition-colors"
                      onMouseEnter={(e) => {
                        (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.03)';
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLElement).style.background = '';
                      }}
                    >
                      {/* Time */}
                      <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">
                        {relativeTime(log.createdAt)}
                      </td>
                      {/* Method */}
                      <td className="px-4 py-3">
                        <Badge text={log.method} style={ms} />
                      </td>
                      {/* Path */}
                      <td className="px-4 py-3 max-w-xs">
                        <span className="text-xs font-mono text-slate-300 truncate block">{log.path}</span>
                        {log.error && (
                          <span className="text-xs text-red-400 truncate block mt-0.5">{log.error}</span>
                        )}
                      </td>
                      {/* Status */}
                      <td className="px-4 py-3">
                        <Badge text={String(log.status)} style={ss} />
                      </td>
                      {/* Duration */}
                      <td className="px-4 py-3 hidden md:table-cell text-xs text-slate-400 whitespace-nowrap">
                        {log.duration}ms
                      </td>
                      {/* User */}
                      <td className="px-4 py-3">
                        {log.username ? (
                          <button
                            className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors font-medium"
                            onClick={() => onNavigateToUser(log.username!)}
                          >
                            {log.username}
                          </button>
                        ) : (
                          <span className="text-xs text-slate-600">—</span>
                        )}
                      </td>
                      {/* IP */}
                      <td className="px-4 py-3 hidden md:table-cell">
                        <span className="text-xs font-mono text-slate-500">{log.ip ?? '—'}</span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div
            className="flex items-center justify-between px-4 py-3"
            style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}
          >
            <span className="text-xs text-slate-500">
              Page {page} of {totalPages}
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="p-1.5 rounded-lg transition-colors disabled:opacity-30"
                style={{ color: '#94a3b8' }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.05)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.background = '';
                }}
              >
                <ChevronLeft size={16} />
              </button>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="p-1.5 rounded-lg transition-colors disabled:opacity-30"
                style={{ color: '#94a3b8' }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.05)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.background = '';
                }}
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── By User tab ──────────────────────────────────────────────────────────────

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

  // Load top users from general logs
  useEffect(() => {
    setLoadingTop(true);
    adminApi
      .logs({ limit: 500 })
      .then((res) => {
        const counts = new Map<string, number>();
        for (const log of res.logs) {
          if (log.username) counts.set(log.username, (counts.get(log.username) ?? 0) + 1);
        }
        const sorted = Array.from(counts.entries())
          .map(([username, count]) => ({ username, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 10);
        setTopUsers(sorted);
      })
      .catch((err) => showToast(err instanceof Error ? err.message : 'Failed to load top users', 'error'))
      .finally(() => setLoadingTop(false));
  }, [showToast]);

  const fetchUserLogs = useCallback(
    async (username: string, page: number) => {
      setLoading(true);
      try {
        const res = await adminApi.logs({ username, page, limit: userLimit });
        setUserLogs(res.logs);
        setUserTotal(res.total);
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Failed to load user logs', 'error');
      } finally {
        setLoading(false);
      }
    },
    [showToast],
  );

  useEffect(() => {
    if (selectedUsername) {
      void fetchUserLogs(selectedUsername, userPage);
    }
  }, [selectedUsername, userPage, fetchUserLogs]);

  function selectUser(username: string) {
    setSelectedUsername(username);
    setSearch(username);
    setUserPage(1);
  }

  const userTotalPages = Math.max(1, Math.ceil(userTotal / userLimit));

  return (
    <div className="flex flex-col gap-4">
      {/* Search bar */}
      <div className="flex gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && search.trim()) selectUser(search.trim());
            }}
            placeholder="Search username..."
            className="w-full pl-8 pr-4 py-2 rounded-lg text-sm text-slate-200 placeholder-slate-600 outline-none"
            style={{
              background: '#0e0f1c',
              border: '1px solid rgba(255,255,255,0.08)',
            }}
            onFocus={(e) => {
              (e.target as HTMLInputElement).style.borderColor = 'rgba(99,102,241,0.5)';
            }}
            onBlur={(e) => {
              (e.target as HTMLInputElement).style.borderColor = 'rgba(255,255,255,0.08)';
            }}
          />
        </div>
        <button
          onClick={() => { if (search.trim()) selectUser(search.trim()); }}
          className="px-4 py-2 rounded-lg text-sm font-medium transition-all"
          style={{
            background: 'rgba(99,102,241,0.2)',
            color: '#818cf8',
            border: '1px solid rgba(99,102,241,0.3)',
          }}
        >
          View Logs
        </button>
        {selectedUsername && (
          <button
            onClick={() => { setSelectedUsername(''); setSearch(''); setUserLogs([]); }}
            className="p-2 rounded-lg text-slate-500 hover:text-slate-300 transition-colors"
            style={{ background: '#0e0f1c', border: '1px solid rgba(255,255,255,0.06)' }}
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* User logs or top users */}
      {selectedUsername ? (
        <div
          className="rounded-2xl overflow-hidden min-w-0"
          style={{
            background: '#0e0f1c',
            border: '1px solid rgba(255,255,255,0.06)',
            boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
          }}
        >
          <div className="px-4 py-3 flex items-center gap-2" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <span className="text-sm font-semibold text-slate-200">{selectedUsername}</span>
            <span className="text-xs text-slate-500">· {userTotal.toLocaleString()} requests</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr style={{ background: '#060710', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                  {['Time', 'Method', 'Path', 'Status', 'Duration'].map((col) => (
                    <th
                      key={col}
                      className={`px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider${col === 'Duration' ? ' hidden md:table-cell' : ''}`}
                      style={{ color: '#64748b' }}
                    >
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <SkeletonRows cols={5} />
                ) : userLogs.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-12 text-center text-slate-500">
                      No logs for this user
                    </td>
                  </tr>
                ) : (
                  userLogs.map((log) => (
                    <tr
                      key={log.id}
                      style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}
                      className="transition-colors"
                      onMouseEnter={(e) => {
                        (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.03)';
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLElement).style.background = '';
                      }}
                    >
                      <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">
                        {relativeTime(log.createdAt)}
                      </td>
                      <td className="px-4 py-3">
                        <Badge text={log.method} style={methodStyle(log.method)} />
                      </td>
                      <td className="px-4 py-3 max-w-xs">
                        <span className="text-xs font-mono text-slate-300 truncate block">{log.path}</span>
                        {log.error && (
                          <span className="text-xs text-red-400 truncate block mt-0.5">{log.error}</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <Badge text={String(log.status)} style={statusStyle(log.status)} />
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell text-xs text-slate-400 whitespace-nowrap">
                        {log.duration}ms
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {userTotalPages > 1 && (
            <div
              className="flex items-center justify-between px-4 py-3"
              style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}
            >
              <span className="text-xs text-slate-500">
                Page {userPage} of {userTotalPages}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setUserPage((p) => Math.max(1, p - 1))}
                  disabled={userPage === 1}
                  className="p-1.5 rounded-lg transition-colors disabled:opacity-30"
                  style={{ color: '#94a3b8' }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.05)'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = ''; }}
                >
                  <ChevronLeft size={16} />
                </button>
                <button
                  onClick={() => setUserPage((p) => Math.min(userTotalPages, p + 1))}
                  disabled={userPage === userTotalPages}
                  className="p-1.5 rounded-lg transition-colors disabled:opacity-30"
                  style={{ color: '#94a3b8' }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.05)'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = ''; }}
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        /* Top users */
        <div
          className="rounded-2xl overflow-hidden min-w-0"
          style={{
            background: '#0e0f1c',
            border: '1px solid rgba(255,255,255,0.06)',
            boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
          }}
        >
          <div className="px-4 py-3" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <span className="text-sm font-semibold text-slate-200">Most Active Users</span>
          </div>
          {loadingTop ? (
            <div className="px-4 py-8 flex justify-center">
              <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : topUsers.length === 0 ? (
            <p className="px-4 py-8 text-center text-slate-500 text-sm">No user data available</p>
          ) : (
            <div className="divide-y" style={{ borderColor: 'rgba(255,255,255,0.04)' }}>
              {topUsers.map((u, idx) => (
                <button
                  key={u.username}
                  className="w-full flex items-center gap-4 px-4 py-3 transition-colors text-left"
                  style={{ background: 'transparent' }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.background = 'rgba(99,102,241,0.05)';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.background = 'transparent';
                  }}
                  onClick={() => selectUser(u.username)}
                >
                  <span
                    className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
                    style={{ background: 'rgba(99,102,241,0.2)', color: '#818cf8' }}
                  >
                    {idx + 1}
                  </span>
                  <span className="flex-1 text-sm text-slate-200">{u.username}</span>
                  <span
                    className="text-xs px-2 py-0.5 rounded-full font-medium"
                    style={{ background: 'rgba(255,255,255,0.06)', color: '#94a3b8' }}
                  >
                    {u.count.toLocaleString()} reqs
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

// ─── Main LogsPage ────────────────────────────────────────────────────────────

export function LogsPage() {
  const location = useLocation();
  const navigate = useNavigate();

  // Read pre-filled username from navigation state
  const stateUsername = (location.state as { username?: string } | null)?.username ?? '';

  const [activeTab, setActiveTab] = useState<'all' | 'byUser'>(stateUsername ? 'byUser' : 'all');
  const [autoRefresh, setAutoRefresh] = useState(false);

  // Filter state
  const [methodFilter, setMethodFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [pathInput, setPathInput] = useState('');
  const [pathFilter, setPathFilter] = useState('');
  const [usernameInput, setUsernameInput] = useState('');
  const [usernameFilter, setUsernameFilter] = useState('');
  const pathTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const usernameTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear navigation state after reading it
  useEffect(() => {
    if (stateUsername) {
      navigate(location.pathname, { replace: true, state: null });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounce path input
  useEffect(() => {
    if (pathTimer.current) clearTimeout(pathTimer.current);
    pathTimer.current = setTimeout(() => setPathFilter(pathInput), 500);
    return () => { if (pathTimer.current) clearTimeout(pathTimer.current); };
  }, [pathInput]);

  // Debounce username input
  useEffect(() => {
    if (usernameTimer.current) clearTimeout(usernameTimer.current);
    usernameTimer.current = setTimeout(() => setUsernameFilter(usernameInput), 500);
    return () => { if (usernameTimer.current) clearTimeout(usernameTimer.current); };
  }, [usernameInput]);

  function clearFilters() {
    setMethodFilter('');
    setStatusFilter('');
    setPathInput('');
    setPathFilter('');
    setUsernameInput('');
    setUsernameFilter('');
  }

  const hasFilters = methodFilter || statusFilter || pathInput || usernameInput;

  const [byUserInitial, setByUserInitial] = useState(stateUsername);
  function navigateToUser(username: string) {
    setByUserInitial(username);
    setActiveTab('byUser');
  }

  const tabs = [
    { key: 'all' as const, label: 'All Requests' },
    { key: 'byUser' as const, label: 'By User' },
  ];

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <ScrollText size={20} className="text-indigo-400" />
            <h1 className="text-2xl font-bold text-white">Request Logs</h1>
          </div>
          <p className="text-slate-500 text-sm mt-1">Incoming HTTP requests to the API</p>
        </div>
        <button
          onClick={() => setAutoRefresh((v) => !v)}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-all"
          style={{
            background: autoRefresh ? 'rgba(99,102,241,0.15)' : '#0e0f1c',
            color: autoRefresh ? '#818cf8' : '#64748b',
            border: autoRefresh ? '1px solid rgba(99,102,241,0.3)' : '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <RefreshCw size={14} className={autoRefresh ? 'animate-spin' : ''} />
          {autoRefresh ? 'Live (10s)' : 'Auto-refresh'}
        </button>
      </div>

      {/* Filter bar */}
      <div
        className="flex flex-wrap gap-2 items-center p-3 rounded-xl"
        style={{ background: '#0e0f1c', border: '1px solid rgba(255,255,255,0.06)' }}
      >
        <SelectField
          value={methodFilter}
          onChange={setMethodFilter}
          options={[
            { value: '', label: 'All Methods' },
            { value: 'GET', label: 'GET' },
            { value: 'POST', label: 'POST' },
            { value: 'PATCH', label: 'PATCH' },
            { value: 'DELETE', label: 'DELETE' },
          ]}
        />
        <SelectField
          value={statusFilter}
          onChange={setStatusFilter}
          options={[
            { value: '', label: 'All Status' },
            { value: '2xx', label: '2xx' },
            { value: '4xx', label: '4xx' },
            { value: '5xx', label: '5xx' },
          ]}
        />
        <div className="flex-1 min-w-40">
          <InputField
            value={pathInput}
            onChange={setPathInput}
            placeholder="Filter path..."
          />
        </div>
        <div className="flex-1 min-w-40">
          <InputField
            value={usernameInput}
            onChange={setUsernameInput}
            placeholder="Filter username..."
          />
        </div>
        {hasFilters && (
          <button
            onClick={clearFilters}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs text-slate-400 hover:text-slate-200 transition-colors"
            style={{ background: 'rgba(255,255,255,0.05)' }}
          >
            <X size={12} />
            Clear
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: '1px' }}>
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className="px-4 py-2.5 text-sm font-medium transition-all rounded-t-lg"
            style={{
              color: activeTab === tab.key ? '#818cf8' : '#64748b',
              background: activeTab === tab.key ? 'rgba(99,102,241,0.1)' : 'transparent',
              borderBottom: activeTab === tab.key ? '2px solid #6366f1' : '2px solid transparent',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'all' ? (
        <AllRequestsTab
          methodFilter={methodFilter}
          statusFilter={statusFilter}
          pathFilter={pathFilter}
          usernameFilter={usernameFilter}
          onNavigateToUser={(username) => navigateToUser(username)}
          autoRefresh={autoRefresh}
        />
      ) : (
        <ByUserTab key={byUserInitial} initialUsername={byUserInitial} />
      )}
    </div>
  );
}
