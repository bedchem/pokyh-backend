import { useEffect, useState, useCallback } from 'react';
import {
  Users,
  Shield,
  Building2,
  MonitorSmartphone,
  Activity,
  CheckSquare,
  Bell,
  Zap,
  RefreshCw,
} from 'lucide-react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { adminApi } from '../api';
import { useAutoRefresh } from '../hooks/useAutoRefresh';
import type { AdminStats, AdminUser, RequestsChartPoint, TopEndpoint } from '../types';

const AVATAR_COLORS = [
  '#6366f1', '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ef4444',
];

function avatarColor(username: string): string {
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = username.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]!;
}

function relativeDate(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return `${months} month${months > 1 ? 's' : ''} ago`;
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function formatDate(): string {
  return new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

interface StatCardProps {
  label: string;
  value: number;
  icon: React.ReactNode;
  iconBg: string;
  iconColor: string;
}

function StatCard({ label, value, icon, iconBg, iconColor }: StatCardProps) {
  return (
    <div
      className="rounded-xl p-5 flex items-center gap-4 min-w-0"
      style={{
        background: '#111116',
        border: '1px solid rgba(255,255,255,0.07)',
        boxShadow: '0 1px 3px rgba(0,0,0,0.4), 0 8px 24px rgba(0,0,0,0.2)',
      }}
    >
      <div
        className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
        style={{ background: iconBg, color: iconColor }}
      >
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-2xl font-bold" style={{ color: '#f0f0f5' }}>{value.toLocaleString()}</div>
        <div className="text-sm mt-0.5 truncate" style={{ color: '#8b8b9b' }}>{label}</div>
      </div>
    </div>
  );
}

interface ChartTooltipProps {
  active?: boolean;
  payload?: Array<{ value: number; name: string; color: string }>;
  label?: string;
}

function ChartTooltip({ active, payload, label }: ChartTooltipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div
      className="px-3 py-2.5 rounded-lg text-xs"
      style={{
        background: '#18181f',
        border: '1px solid rgba(255,255,255,0.1)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        color: '#f0f0f5',
      }}
    >
      <div className="mb-1.5 font-medium" style={{ color: '#8b8b9b' }}>{label}</div>
      {payload.map((p) => (
        <div key={p.name} className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full" style={{ background: p.color }} />
          <span style={{ color: '#8b8b9b' }}>{p.name === 'count' ? 'Requests' : 'Errors'}:</span>
          <span className="font-semibold ml-1">{p.value}</span>
        </div>
      ))}
    </div>
  );
}

export function DashboardPage() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [recentUsers, setRecentUsers] = useState<AdminUser[]>([]);
  const [chartData, setChartData] = useState<RequestsChartPoint[]>([]);
  const [topEndpoints, setTopEndpoints] = useState<TopEndpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [chartLoading, setChartLoading] = useState(true);

  const fetchAll = useCallback(() => {
    Promise.all([
      adminApi.stats(),
      adminApi.users(undefined, 1, 5),
    ]).then(([s, u]) => {
      setStats(s);
      setRecentUsers(u.users);
    }).catch(console.error).finally(() => setLoading(false));

    Promise.all([
      adminApi.requestsChart().catch(() => [] as RequestsChartPoint[]),
      adminApi.topEndpoints().catch(() => [] as TopEndpoint[]),
    ]).then(([chart, endpoints]) => {
      setChartData(chart);
      setTopEndpoints(endpoints);
    }).finally(() => setChartLoading(false));
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const { refresh, refreshing } = useAutoRefresh(fetchAll, 15000);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex flex-col items-center gap-3">
          <div
            className="w-7 h-7 border-2 rounded-full animate-spin"
            style={{ borderColor: 'rgba(99,102,241,0.3)', borderTopColor: '#6366f1' }}
          />
          <span className="text-sm" style={{ color: '#4a4a5e' }}>Loading...</span>
        </div>
      </div>
    );
  }

  if (!stats) return null;

  const statCards = [
    { label: 'Total Users', value: stats.totalUsers, icon: <Users size={18} />, iconBg: 'rgba(99,102,241,0.15)', iconColor: '#6366f1' },
    { label: 'Total Admins', value: stats.totalAdmins, icon: <Shield size={18} />, iconBg: 'rgba(139,92,246,0.15)', iconColor: '#8b5cf6' },
    { label: 'Active Sessions', value: stats.totalActiveSessions, icon: <MonitorSmartphone size={18} />, iconBg: 'rgba(48,209,88,0.15)', iconColor: '#30d158' },
    { label: 'Total Classes', value: stats.totalClasses, icon: <Building2 size={18} />, iconBg: 'rgba(6,182,212,0.15)', iconColor: '#06b6d4' },
  ];

  const regChartData = (() => {
    const map = new Map(stats.usersByDay.map((d) => [d.date, d.count]));
    return Array.from({ length: 14 }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (13 - i));
      const key = d.toISOString().slice(0, 10);
      return {
        date: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        count: map.get(key) ?? 0,
      };
    });
  })();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: '#f0f0f5' }}>Dashboard</h1>
          <p className="text-sm mt-1" style={{ color: '#8b8b9b' }}>
            {greeting()} &mdash; {formatDate()}
          </p>
        </div>
        <button
          onClick={() => void refresh()}
          disabled={refreshing}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-all"
          style={{
            background: '#111116',
            color: refreshing ? '#818cf8' : '#64748b',
            border: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 md:gap-4">
        {statCards.map((c) => (
          <StatCard key={c.label} {...c} />
        ))}
      </div>

      <div
        className="rounded-xl p-5 md:p-6 min-w-0"
        style={{
          background: '#111116',
          border: '1px solid rgba(255,255,255,0.07)',
          boxShadow: '0 1px 3px rgba(0,0,0,0.4), 0 8px 24px rgba(0,0,0,0.2)',
        }}
      >
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-sm font-semibold" style={{ color: '#f0f0f5' }}>API Requests — Last 24h</h2>
            <p className="text-xs mt-0.5" style={{ color: '#4a4a5e' }}>Hourly breakdown</p>
          </div>
          <div className="flex items-center gap-4 text-xs" style={{ color: '#8b8b9b' }}>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: '#6366f1' }} />
              Requests
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: '#ff453a' }} />
              Errors
            </span>
          </div>
        </div>
        {chartLoading ? (
          <div className="flex items-end gap-1 px-2" style={{ height: '200px' }}>
            {Array.from({ length: 24 }).map((_, i) => (
              <div
                key={i}
                className="flex-1 rounded-t animate-pulse"
                style={{ height: `${25 + (i * 13) % 55}%`, background: 'rgba(99,102,241,0.08)' }}
              />
            ))}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={chartData} margin={{ top: 4, right: 0, left: -28, bottom: 0 }}>
              <defs>
                <linearGradient id="gradCount" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#6366f1" stopOpacity={0.25} />
                  <stop offset="100%" stopColor="#6366f1" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gradErrors" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#ff453a" stopOpacity={0.2} />
                  <stop offset="100%" stopColor="#ff453a" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
              <XAxis
                dataKey="hour"
                tick={{ fill: '#4a4a5e', fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                interval={3}
              />
              <YAxis
                tick={{ fill: '#4a4a5e', fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                allowDecimals={false}
              />
              <Tooltip content={<ChartTooltip />} />
              <Area type="monotone" dataKey="count" stroke="#6366f1" strokeWidth={1.5} fill="url(#gradCount)" />
              <Area type="monotone" dataKey="errors" stroke="#ff453a" strokeWidth={1.5} fill="url(#gradErrors)" />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div
          className="rounded-xl p-5 min-w-0"
          style={{
            background: '#111116',
            border: '1px solid rgba(255,255,255,0.07)',
            boxShadow: '0 1px 3px rgba(0,0,0,0.4), 0 8px 24px rgba(0,0,0,0.2)',
          }}
        >
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold" style={{ color: '#f0f0f5' }}>Recent Users</h2>
            <div className="flex items-center gap-1.5 text-xs" style={{ color: '#4a4a5e' }}>
              <Users size={12} />
              <span>Last 5</span>
            </div>
          </div>
          <div className="flex flex-col gap-3">
            {recentUsers.length === 0 && (
              <p className="text-sm" style={{ color: '#4a4a5e' }}>No users yet.</p>
            )}
            {recentUsers.map((u) => (
              <div key={u.stableUid} className="flex items-center gap-3 min-w-0">
                <div
                  className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
                  style={{ background: avatarColor(u.username) }}
                >
                  {u.username[0]?.toUpperCase() ?? '?'}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium truncate" style={{ color: '#f0f0f5' }}>{u.username}</span>
                    {u.isAdmin && (
                      <span
                        className="text-xs px-1.5 py-0.5 font-medium flex-shrink-0"
                        style={{
                          background: 'rgba(99,102,241,0.15)',
                          color: '#818cf8',
                          border: '1px solid rgba(99,102,241,0.2)',
                          borderRadius: '6px',
                        }}
                      >
                        Admin
                      </span>
                    )}
                  </div>
                  <div className="text-xs truncate mt-0.5" style={{ color: '#4a4a5e' }}>
                    {u.webuntisKlasseName ?? '—'} &middot; {relativeDate(u.createdAt)}
                  </div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <CheckSquare size={12} style={{ color: '#4a4a5e' }} />
                  <span className="text-xs" style={{ color: '#8b8b9b' }}>{u.todoCount}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div
          className="rounded-xl p-5 min-w-0"
          style={{
            background: '#111116',
            border: '1px solid rgba(255,255,255,0.07)',
            boxShadow: '0 1px 3px rgba(0,0,0,0.4), 0 8px 24px rgba(0,0,0,0.2)',
          }}
        >
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold" style={{ color: '#f0f0f5' }}>Top Endpoints</h2>
            <div className="flex items-center gap-1.5 text-xs" style={{ color: '#4a4a5e' }}>
              <Zap size={12} />
              <span>Top 8</span>
            </div>
          </div>
          {chartLoading ? (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3">
                  <div className="h-3 flex-1 rounded animate-pulse" style={{ background: 'rgba(255,255,255,0.05)' }} />
                  <div className="h-3 w-12 rounded animate-pulse" style={{ background: 'rgba(255,255,255,0.05)' }} />
                </div>
              ))}
            </div>
          ) : topEndpoints.length === 0 ? (
            <p className="text-sm" style={{ color: '#4a4a5e' }}>No data yet.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {topEndpoints.map((ep) => (
                <div key={ep.path} className="flex items-center gap-3 min-w-0">
                  <span className="text-xs font-mono truncate flex-1 min-w-0" style={{ color: '#8b8b9b' }}>
                    {ep.path}
                  </span>
                  <span
                    className="text-xs px-2 py-0.5 font-medium flex-shrink-0"
                    style={{ background: 'rgba(99,102,241,0.12)', color: '#818cf8', borderRadius: '6px' }}
                  >
                    {ep.count.toLocaleString()}
                  </span>
                  <span className="text-xs flex-shrink-0 tabular-nums" style={{ color: '#4a4a5e', minWidth: '44px', textAlign: 'right' }}>
                    {ep.avgMs}ms
                  </span>
                </div>
              ))}
            </div>
          )}

          <div
            className="mt-5 pt-4 grid grid-cols-3 gap-3"
            style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}
          >
            {[
              { label: 'Todos', value: stats.totalTodos, icon: <CheckSquare size={14} />, color: '#30d158' },
              { label: 'Reminders', value: stats.totalReminders, icon: <Bell size={14} />, color: '#ffd60a' },
              { label: 'Classes', value: stats.totalClasses, icon: <Building2 size={14} />, color: '#06b6d4' },
            ].map((item) => (
              <div key={item.label} className="flex flex-col items-center gap-1 text-center">
                <span style={{ color: item.color }}>{item.icon}</span>
                <span className="text-base font-bold" style={{ color: '#f0f0f5' }}>{item.value.toLocaleString()}</span>
                <span className="text-xs" style={{ color: '#4a4a5e' }}>{item.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div
        className="rounded-xl p-5 min-w-0"
        style={{
          background: '#111116',
          border: '1px solid rgba(255,255,255,0.07)',
          boxShadow: '0 1px 3px rgba(0,0,0,0.4), 0 8px 24px rgba(0,0,0,0.2)',
        }}
      >
        <div className="flex items-center gap-2 mb-4">
          <Activity size={15} style={{ color: '#6366f1' }} />
          <h2 className="text-sm font-semibold" style={{ color: '#f0f0f5' }}>Registrations — Last 14 Days</h2>
        </div>
        <ResponsiveContainer width="100%" height={160}>
          <AreaChart data={regChartData} margin={{ top: 4, right: 0, left: -28, bottom: 0 }}>
            <defs>
              <linearGradient id="gradReg" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#6366f1" stopOpacity={0.2} />
                <stop offset="100%" stopColor="#6366f1" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
            <XAxis dataKey="date" tick={{ fill: '#4a4a5e', fontSize: 10 }} axisLine={false} tickLine={false} interval={2} />
            <YAxis tick={{ fill: '#4a4a5e', fontSize: 10 }} axisLine={false} tickLine={false} allowDecimals={false} />
            <Tooltip
              contentStyle={{
                background: '#18181f',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '8px',
                fontSize: '12px',
                color: '#f0f0f5',
              }}
              labelStyle={{ color: '#8b8b9b' }}
              itemStyle={{ color: '#818cf8' }}
            />
            <Area type="monotone" dataKey="count" stroke="#6366f1" strokeWidth={1.5} fill="url(#gradReg)" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
