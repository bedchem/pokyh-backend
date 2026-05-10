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
  AlertTriangle,
  TrendingUp,
  Clock,
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

const AVATAR_COLORS = ['#0a84ff', '#bf5af2', '#40c8e0', '#30d158', '#ff9f0a', '#ff453a'];

function avatarColor(username: string): string {
  let hash = 0;
  for (let i = 0; i < username.length; i++) hash = username.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]!;
}

function relativeDate(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'Heute';
  if (days === 1) return 'Gestern';
  if (days < 30) return `vor ${days} Tagen`;
  return `vor ${Math.floor(days / 30)} Monat(en)`;
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5)  return 'Nacht-Session';
  if (h < 12) return 'Guten Morgen';
  if (h < 17) return 'Guten Tag';
  return 'Guten Abend';
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

function formatDate(): string {
  return new Date().toLocaleDateString('de-AT', { weekday: 'long', month: 'long', day: 'numeric' });
}

interface StatCardProps {
  label: string;
  value: number;
  icon: React.ReactNode;
  accentColor: string;
  delay?: number;
}

function StatCard({ label, value, icon, accentColor, delay = 0 }: StatCardProps) {
  return (
    <div
      className="apple-card p-5 flex items-center gap-4 min-w-0 animate-fadeInUp cursor-default"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div
        className="w-10 h-10 rounded-[12px] flex items-center justify-center flex-shrink-0"
        style={{ background: `${accentColor}1a`, color: accentColor }}
      >
        {icon}
      </div>
      <div className="min-w-0">
        <div
          className="text-[26px] font-bold leading-none"
          style={{ color: '#ffffff', letterSpacing: '-0.03em' }}
        >
          {value.toLocaleString('de-AT')}
        </div>
        <div className="text-[13px] mt-1 truncate" style={{ color: 'rgba(235,235,245,0.45)' }}>
          {label}
        </div>
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
      className="px-3 py-2.5 rounded-[10px] text-[12px]"
      style={{
        background: 'rgba(44,44,46,0.95)',
        border: '1px solid rgba(255,255,255,0.1)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        color: '#ffffff',
        backdropFilter: 'blur(16px)',
      }}
    >
      <div className="mb-1.5 font-medium" style={{ color: 'rgba(235,235,245,0.5)' }}>{label}</div>
      {payload.map((p) => (
        <div key={p.name} className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: p.color }} />
          <span style={{ color: 'rgba(235,235,245,0.55)' }}>
            {p.name === 'count' ? 'Anfragen' : 'Fehler'}:
          </span>
          <span className="font-semibold ml-0.5">{p.value}</span>
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

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const { refresh, refreshing } = useAutoRefresh(fetchAll, 15000);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex flex-col items-center gap-3">
          <div
            className="w-6 h-6 rounded-full border-2 animate-spin"
            style={{ borderColor: 'rgba(255,255,255,0.1)', borderTopColor: '#0a84ff' }}
          />
          <span className="text-[13px]" style={{ color: 'rgba(235,235,245,0.3)' }}>Laden…</span>
        </div>
      </div>
    );
  }

  if (!stats) return null;

  const statCards = [
    { label: 'Benutzer gesamt',    value: stats.totalUsers,          icon: <Users size={18} />,            accentColor: '#0a84ff' },
    { label: 'Administratoren',    value: stats.totalAdmins,         icon: <Shield size={18} />,           accentColor: '#bf5af2' },
    { label: 'Aktive Sessions',    value: stats.totalActiveSessions, icon: <MonitorSmartphone size={18} />, accentColor: '#30d158' },
    { label: 'Klassen gesamt',     value: stats.totalClasses,        icon: <Building2 size={18} />,        accentColor: '#40c8e0' },
  ];

  const regChartData = (() => {
    const map = new Map(stats.usersByDay.map((d) => [d.date, d.count]));
    return Array.from({ length: 14 }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (13 - i));
      const key = d.toISOString().slice(0, 10);
      return {
        date: d.toLocaleDateString('de-AT', { month: 'short', day: 'numeric' }),
        count: map.get(key) ?? 0,
      };
    });
  })();

  return (
    <div className="flex flex-col gap-6 animate-page">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1
            className="text-[28px] font-bold text-white"
            style={{ letterSpacing: '-0.03em' }}
          >
            Dashboard
          </h1>
          <p className="text-[14px] mt-1" style={{ color: 'rgba(235,235,245,0.4)' }}>
            {greeting()} &mdash; {formatDate()}
          </p>
        </div>
        <button
          onClick={() => void refresh()}
          disabled={refreshing}
          className="apple-btn-ghost flex items-center gap-2 px-3 py-2 rounded-[10px] text-[13px]"
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? 'Aktualisiert…' : 'Aktualisieren'}
        </button>
      </div>

      {/* Stat grid — primary */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        {statCards.map((c, i) => (
          <StatCard key={c.label} {...c} delay={i * 55} />
        ))}
      </div>

      {/* Today stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Anfragen heute', value: stats.requestsToday?.toLocaleString() ?? '—', icon: <TrendingUp size={15} />, color: '#0a84ff' },
          { label: 'Fehler heute',   value: stats.errorsToday?.toLocaleString() ?? '—',   icon: <AlertTriangle size={15} />, color: stats.errorsToday > 0 ? '#ff453a' : '#30d158' },
          { label: 'Neue Nutzer',    value: stats.newUsersToday ?? '—',                   icon: <Users size={15} />,        color: '#30d158' },
          { label: 'Server Uptime',  value: formatUptime(stats.serverUptime ?? 0),        icon: <Clock size={15} />,        color: '#40c8e0' },
        ].map((item, i) => (
          <div
            key={item.label}
            className="apple-card px-4 py-3 flex items-center gap-3 min-w-0 animate-fadeInUp"
            style={{ animationDelay: `${(i + 4) * 55}ms` }}
          >
            <div className="w-8 h-8 rounded-[10px] flex items-center justify-center flex-shrink-0" style={{ background: `${item.color}1a`, color: item.color }}>
              {item.icon}
            </div>
            <div className="min-w-0">
              <div className="text-[18px] font-bold text-white" style={{ letterSpacing: '-0.02em' }}>{item.value}</div>
              <div className="text-[11px] truncate" style={{ color: 'rgba(235,235,245,0.4)' }}>{item.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* API requests chart */}
      <div className="apple-card p-5 md:p-6 animate-fadeInUp delay-200">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-[14px] font-semibold text-white" style={{ letterSpacing: '-0.01em' }}>
              API-Anfragen — letzte 24 Std.
            </h2>
            <p className="text-[12px] mt-0.5" style={{ color: 'rgba(235,235,245,0.35)' }}>Stundenbasis</p>
          </div>
          <div className="flex items-center gap-4 text-[12px]" style={{ color: 'rgba(235,235,245,0.4)' }}>
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full inline-block" style={{ background: '#0a84ff' }} />
              Anfragen
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full inline-block" style={{ background: '#ff453a' }} />
              Fehler
            </span>
          </div>
        </div>
        {chartLoading ? (
          <div className="flex items-end gap-1 px-2" style={{ height: '200px' }}>
            {Array.from({ length: 24 }).map((_, i) => (
              <div
                key={i}
                className="flex-1 rounded-t shimmer"
                style={{ height: `${20 + (i * 11) % 55}%` }}
              />
            ))}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={chartData} margin={{ top: 4, right: 0, left: -30, bottom: 0 }}>
              <defs>
                <linearGradient id="gradCount" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%"   stopColor="#0a84ff" stopOpacity={0.22} />
                  <stop offset="100%" stopColor="#0a84ff" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gradErrors" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%"   stopColor="#ff453a" stopOpacity={0.18} />
                  <stop offset="100%" stopColor="#ff453a" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
              <XAxis dataKey="hour" tick={{ fill: 'rgba(235,235,245,0.25)', fontSize: 10 }} axisLine={false} tickLine={false} interval={3} />
              <YAxis tick={{ fill: 'rgba(235,235,245,0.25)', fontSize: 10 }} axisLine={false} tickLine={false} allowDecimals={false} />
              <Tooltip content={<ChartTooltip />} />
              <Area type="monotone" dataKey="count"  stroke="#0a84ff" strokeWidth={1.5} fill="url(#gradCount)" />
              <Area type="monotone" dataKey="errors" stroke="#ff453a" strokeWidth={1.5} fill="url(#gradErrors)" />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Two-column cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 animate-fadeInUp delay-300">
        {/* Recent users */}
        <div className="apple-card p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-[14px] font-semibold text-white" style={{ letterSpacing: '-0.01em' }}>
              Neue Benutzer
            </h2>
            <div className="flex items-center gap-1.5 text-[12px]" style={{ color: 'rgba(235,235,245,0.3)' }}>
              <Users size={12} />
              <span>Letzte 5</span>
            </div>
          </div>
          <div className="flex flex-col gap-3">
            {recentUsers.length === 0 && (
              <p className="text-[13px]" style={{ color: 'rgba(235,235,245,0.3)' }}>Noch keine Benutzer.</p>
            )}
            {recentUsers.map((u) => (
              <div key={u.stableUid} className="flex items-center gap-3 min-w-0">
                <div
                  className="w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-bold text-white flex-shrink-0"
                  style={{ background: avatarColor(u.username) }}
                >
                  {u.username[0]?.toUpperCase() ?? '?'}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[14px] font-medium truncate text-white">{u.username}</span>
                    {u.isAdmin && (
                      <span className="badge-blue text-[11px] px-1.5 py-0.5 font-medium flex-shrink-0">
                        Admin
                      </span>
                    )}
                  </div>
                  <div className="text-[12px] truncate mt-0.5" style={{ color: 'rgba(235,235,245,0.3)' }}>
                    {u.webuntisKlasseName ?? '—'} &middot; {relativeDate(u.createdAt)}
                  </div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <CheckSquare size={12} style={{ color: 'rgba(235,235,245,0.25)' }} />
                  <span className="text-[12px]" style={{ color: 'rgba(235,235,245,0.45)' }}>{u.todoCount}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Top endpoints */}
        <div className="apple-card p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-[14px] font-semibold text-white" style={{ letterSpacing: '-0.01em' }}>
              Top Endpunkte
            </h2>
            <div className="flex items-center gap-1.5 text-[12px]" style={{ color: 'rgba(235,235,245,0.3)' }}>
              <Zap size={12} />
              <span>Top 8</span>
            </div>
          </div>
          {chartLoading ? (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3">
                  <div className="h-3 flex-1 rounded shimmer" />
                  <div className="h-3 w-12 rounded shimmer" />
                </div>
              ))}
            </div>
          ) : topEndpoints.length === 0 ? (
            <p className="text-[13px]" style={{ color: 'rgba(235,235,245,0.3)' }}>Noch keine Daten.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {topEndpoints.map((ep) => (
                <div key={ep.path} className="flex items-center gap-3 min-w-0">
                  <span className="text-[12px] font-mono truncate flex-1 min-w-0" style={{ color: 'rgba(235,235,245,0.5)' }}>
                    {ep.path}
                  </span>
                  <span className="badge-blue text-[11px] px-2 py-0.5 font-medium flex-shrink-0">
                    {ep.count.toLocaleString()}
                  </span>
                  <span className="text-[11px] flex-shrink-0 tabular-nums" style={{ color: 'rgba(235,235,245,0.3)', minWidth: '44px', textAlign: 'right' }}>
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
              { label: 'Todos',      value: stats.totalTodos,     icon: <CheckSquare size={14} />, color: '#30d158' },
              { label: 'Erinnerungen', value: stats.totalReminders, icon: <Bell size={14} />,       color: '#ffd60a' },
              { label: 'Klassen',    value: stats.totalClasses,   icon: <Building2 size={14} />,   color: '#40c8e0' },
            ].map((item) => (
              <div key={item.label} className="flex flex-col items-center gap-1 text-center">
                <span style={{ color: item.color }}>{item.icon}</span>
                <span className="text-[16px] font-bold text-white" style={{ letterSpacing: '-0.02em' }}>
                  {item.value.toLocaleString()}
                </span>
                <span className="text-[11px]" style={{ color: 'rgba(235,235,245,0.35)' }}>{item.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Registrations chart */}
      <div className="apple-card p-5 animate-fadeInUp delay-400">
        <div className="flex items-center gap-2 mb-4">
          <Activity size={14} style={{ color: '#0a84ff' }} />
          <h2 className="text-[14px] font-semibold text-white" style={{ letterSpacing: '-0.01em' }}>
            Registrierungen — letzte 14 Tage
          </h2>
        </div>
        <ResponsiveContainer width="100%" height={160}>
          <AreaChart data={regChartData} margin={{ top: 4, right: 0, left: -30, bottom: 0 }}>
            <defs>
              <linearGradient id="gradReg" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"   stopColor="#0a84ff" stopOpacity={0.2} />
                <stop offset="100%" stopColor="#0a84ff" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
            <XAxis dataKey="date" tick={{ fill: 'rgba(235,235,245,0.25)', fontSize: 10 }} axisLine={false} tickLine={false} interval={2} />
            <YAxis tick={{ fill: 'rgba(235,235,245,0.25)', fontSize: 10 }} axisLine={false} tickLine={false} allowDecimals={false} />
            <Tooltip
              contentStyle={{
                background: 'rgba(44,44,46,0.95)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '10px',
                fontSize: '12px',
                color: '#ffffff',
              }}
              labelStyle={{ color: 'rgba(235,235,245,0.5)' }}
              itemStyle={{ color: '#0a84ff' }}
            />
            <Area type="monotone" dataKey="count" stroke="#0a84ff" strokeWidth={1.5} fill="url(#gradReg)" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
