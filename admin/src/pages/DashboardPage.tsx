import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  ArrowUpDown,
  CheckSquare,
  Clock,
  DatabaseBackup,
  GraduationCap,
  KeyRound,
  MessageCircle,
  MonitorSmartphone,
  RefreshCw,
  School,
  ScrollText,
  ShieldCheck,
  Sparkles,
  UserPlus,
  Users,
  UtensilsCrossed,
  Waypoints,
  type LucideIcon,
} from 'lucide-react';
import gsap from 'gsap';
import { adminApi } from '../api';
import { useAccess } from '../access';
import { useAuth } from '../hooks/useAuth';
import { useAutoRefresh } from '../hooks/useAutoRefresh';
import { useLive } from '../live';
import { present, prefersReducedMotion } from '../motion';
import { TrendChart, type TrendSeries } from '../components/TrendChart';
import { RankBars, Ring, SplitBar } from '../components/charts';
import { Avatar, Count, Delta, Figures, Notice, Section, Segmented, Tag, TONES, toneFor } from '../components/kit';
import type { AdminComment, AdminSchool, AdminStats, AdminUser, FrontendActivityStats, RequestsChartPoint, TopEndpoint } from '../types';

// Schools that joined within this many days show as new on the overview.
const NEW_SCHOOL_DAYS = 14;

const LINE_SKY = '#4f96dc';
const LINE_AMBER = '#f2a55c';
const EVENT_COLORS = [LINE_SKY, 'var(--amber)', 'var(--mint)', '#a98be0', 'var(--ink-4)'];

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5)  return 'Nacht-Session';
  if (h < 12) return 'Guten Morgen';
  if (h < 17) return 'Guten Tag';
  return 'Guten Abend';
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
  return `${Math.floor(seconds / 86400)} d ${Math.floor((seconds % 86400) / 3600)} h`;
}

function relativeTime(dateStr: string): string {
  const then = new Date(dateStr);
  const minutes = Math.floor((Date.now() - then.getTime()) / 60000);
  if (minutes < 1) return 'gerade eben';
  if (minutes < 60) return `vor ${minutes} Min.`;
  if (then.toDateString() === new Date().toDateString()) {
    return then.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' });
  }
  const days = Math.floor(minutes / 1440);
  if (days <= 1) return 'Gestern';
  if (days < 30) return `vor ${days} Tagen`;
  return then.toLocaleDateString('de-AT', { day: 'numeric', month: 'short' });
}

function endpointIcon(path: string): LucideIcon {
  if (/auth|login|session|token/.test(path)) return KeyRound;
  if (/learn|course|vocab/.test(path)) return GraduationCap;
  if (/comment/.test(path)) return MessageCircle;
  if (/dish|menu|rating/.test(path)) return UtensilsCrossed;
  if (/todo|reminder/.test(path)) return CheckSquare;
  if (/user|class|member/.test(path)) return Users;
  return Waypoints;
}

function endpointTone(avgMs: number) {
  if (avgMs < 100) return { label: 'Schnell', dot: 'var(--mint)',  well: 'var(--well)' };
  if (avgMs < 500) return { label: 'Normal',  dot: '#6ba6e0',      well: 'var(--sky-wash)' };
  return { label: 'Langsam', dot: 'var(--amber)', well: 'var(--amber-wash)' };
}

type Range = 'day' | 'fortnight';

type FeedItem =
  | { kind: 'comment'; id: string; at: string; name: string; comment: AdminComment }
  | { kind: 'signup'; id: string; at: string; name: string; user: AdminUser };

function Skeleton() {
  return (
    <div className="dash" aria-busy="true" aria-label="Laden">
      <div className="dash-main">
        <div className="shimmer h-9 w-64 rounded-full" />
        <div className="shimmer mt-4 h-4 w-80 max-w-full rounded-full" />
        <div className="mt-10 h-px bg-line" />
        <div className="flex gap-10 py-8">
          {[0, 1, 2].map((i) => <div key={i} className="shimmer h-12 flex-1 rounded-full" />)}
        </div>
        <div className="h-px bg-line" />
        <div className="shimmer mt-14 h-6 w-40 rounded-full" />
        <div className="shimmer mt-8 h-[200px] rounded-[22px]" />
      </div>
      <aside className="dash-rail">
        <div className="shimmer m-[14px] h-[300px] rounded-[26px]" />
      </aside>
    </div>
  );
}

export function DashboardPage() {
  const { username } = useAuth();
  const { view, me, can, canGlobal } = useAccess();
  const isGlobal = view?.kind === 'global';
  // The global view adds the schools: who joined, who has no menu yet.
  const [schools, setSchools] = useState<AdminSchool[] | null>(null);
  const showSchools = isGlobal && canGlobal('schools.view');
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [recentUsers, setRecentUsers] = useState<AdminUser[]>([]);
  const [comments, setComments] = useState<AdminComment[]>([]);
  const [chartData, setChartData] = useState<RequestsChartPoint[]>([]);
  const [topEndpoints, setTopEndpoints] = useState<TopEndpoint[]>([]);
  const [usage, setUsage] = useState<FrontendActivityStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [chartLoading, setChartLoading] = useState(true);
  const [range, setRange] = useState<Range>('day');
  const [sortBy, setSortBy] = useState<'count' | 'avgMs'>('count');
  const rootRef = useRef<HTMLDivElement>(null);

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
      adminApi.comments({ limit: 4, sortBy: 'createdAt', sortOrder: 'desc' }).then((r) => r.comments).catch(() => [] as AdminComment[]),
      adminApi.activityStats().catch(() => null),
    ]).then(([chart, endpoints, latestComments, activity]) => {
      setChartData(chart);
      setTopEndpoints(endpoints);
      setComments(latestComments);
      setUsage(activity);
    }).finally(() => setChartLoading(false));
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const fetchSchools = useCallback(() => {
    if (!showSchools) return;
    adminApi.schools().then((r) => setSchools(r.schools)).catch(() => setSchools([]));
  }, [showSchools]);
  useEffect(() => { fetchSchools(); }, [fetchSchools]);
  useLive(['schools'], fetchSchools, 3000);

  const { refresh, refreshing } = useAutoRefresh(fetchAll, 15000);
  // Anything the dashboard shows refreshes the moment it changes on the server.
  useLive(['users', 'sessions', 'comments', 'todos', 'reminders', 'classes', 'requests', 'activity'], fetchAll, 3000);

  // One entrance for the page, played when the first figures arrive.
  useLayoutEffect(() => {
    if (loading || !stats || prefersReducedMotion()) return;
    const ctx = gsap.context(() => {
      const settle = { autoAlpha: 0, duration: 0.5, ease: 'power2.out', clearProps: 'transform,opacity,visibility' };
      const timeline = gsap.timeline();
      // Only the parts on the page now (GSAP warns about missing ones).
      const from = (selector: string, vars: gsap.TweenVars, at: number) => {
        const targets = present(rootRef.current, selector);
        if (targets.length > 0) timeline.from(targets, vars, at);
      };
      from('[data-rise]', { ...settle, y: 8, stagger: 0.045 }, 0);
      from('[data-rule]', { scaleX: 0, transformOrigin: '0% 50%', duration: 0.7, ease: 'power2.out', stagger: 0.08, clearProps: 'transform' }, 0.05);
      from('[data-cell]', { ...settle, y: 8, stagger: 0.045 }, 0.1);
      from('[data-rail]', { ...settle, y: 8, stagger: 0.06 }, 0.12);
    }, rootRef);
    return () => ctx.revert();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  const chart = useMemo(() => {
    if (range === 'day') {
      const series: TrendSeries[] = [
        { key: 'count',  label: 'Anfragen', color: LINE_SKY,   area: true, values: chartData.map((p) => p.count) },
        { key: 'errors', label: 'Fehler',   color: LINE_AMBER, values: chartData.map((p) => p.errors) },
      ];
      return {
        labels: chartData.map((p) => p.hour),
        titles: chartData.map((p) => `${p.hour} Uhr`),
        series,
        tickEvery: 4,
      };
    }
    const byDay = new Map((stats?.usersByDay ?? []).map((d) => [d.date, d.count]));
    const days = Array.from({ length: 14 }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (13 - i));
      return d;
    });
    const series: TrendSeries[] = [
      { key: 'signups', label: 'Registrierungen', color: LINE_SKY, area: true, values: days.map((d) => byDay.get(d.toISOString().slice(0, 10)) ?? 0) },
    ];
    return {
      labels: days.map((d) => String(d.getDate()).padStart(2, '0')),
      titles: days.map((d) => d.toLocaleDateString('de-AT', { day: 'numeric', month: 'long', year: 'numeric' })),
      series,
      tickEvery: 2,
    };
  }, [range, chartData, stats]);

  const endpoints = useMemo(
    () => [...topEndpoints].sort((a, b) => b[sortBy] - a[sortBy]),
    [topEndpoints, sortBy],
  );

  const feed = useMemo<FeedItem[]>(() => {
    const items: FeedItem[] = [
      ...comments.map((c): FeedItem => ({ kind: 'comment', id: `c-${c.id}`, at: c.createdAt, name: c.username, comment: c })),
      ...recentUsers.map((u): FeedItem => ({ kind: 'signup', id: `u-${u.stableUid}`, at: u.createdAt, name: u.username, user: u })),
    ];
    return items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).slice(0, 6);
  }, [comments, recentUsers]);

  if (loading) return <Skeleton />;

  if (!stats) {
    return (
      <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-5 px-6 text-center">
        <span className="orb h-14 w-14"><AlertTriangle size={22} strokeWidth={1.6} /></span>
        <p className="text-[15px] text-ink-2">Die Statistiken konnten nicht geladen werden.</p>
        <button type="button" onClick={() => void refresh()} className="btn btn-primary">
          Erneut versuchen
        </button>
      </div>
    );
  }

  const requestsToday = stats.requestsToday ?? 0;
  const errorsToday = stats.errorsToday ?? 0;
  const newThisWeek = stats.newUsersThisWeek ?? 0;
  const errorRate = requestsToday > 0 ? (errorsToday / requestsToday) * 100 : 0;
  const today = new Date().toLocaleDateString('de-AT', { day: 'numeric', month: 'short', year: 'numeric' });
  const activeShare = usage && stats.totalUsers > 0 ? usage.activeUsersToday / stats.totalUsers : 0;

  const ledger = [
    { label: 'Admins',       value: stats.totalAdmins },
    { label: 'Klassen',      value: stats.totalClasses },
    { label: 'Todos',        value: stats.totalTodos },
    { label: 'Erinnerungen', value: stats.totalReminders },
  ];

  // Only what this admin may open in this view.
  const quickLinks = [
    { to: '/users',    label: 'Benutzer verwalten', icon: UserPlus,       show: can('users.view') },
    { to: '/requests', label: 'Anfragen öffnen',    icon: ScrollText,     show: can('requests.view') },
    { to: '/schools',  label: 'Schulen öffnen',     icon: School,         show: showSchools },
    { to: '/backups',  label: 'Backups öffnen',     icon: DatabaseBackup, show: isGlobal && canGlobal('backups.manage') },
  ].filter((link) => link.show).slice(0, 3);

  const roleLabel = me?.owner ? 'Server-Owner' : isGlobal ? 'Global-Admin' : 'Schul-Admin';
  const newSchools = (schools ?? []).filter((sc) => sc.origin === 'webuntis' && Date.now() - new Date(sc.createdAt).getTime() < NEW_SCHOOL_DAYS * 86_400_000);
  const schoolsWithoutMenu = (schools ?? []).filter((sc) => sc.active && !sc.menu);
  const topSchools = [...(schools ?? [])].sort((a, b) => (b.users ?? 0) - (a.users ?? 0)).slice(0, 6);

  const profileTone = TONES[toneFor(username)];

  return (
    <div ref={rootRef} className="dash">
      <div className="dash-main scrollbar-thin">
        <header className="flex items-start justify-between gap-6">
          <div className="min-w-0">
            <h1 data-rise className="truncate text-[30px] font-semibold leading-[1.15] tracking-[-0.02em] sm:text-[36px]">
              Hallo, {username}
            </h1>
            <p data-rise className="mt-2 text-[15px] text-ink-3">
              {view?.kind === 'school'
                ? <>{greeting()} — du siehst <span className="text-ink-2">{view.school.name}</span>.</>
                : <>{greeting()} — alle Schulen{schools ? ` (${schools.length})` : ''}; der Server läuft seit {formatUptime(stats.serverUptime ?? 0)}.</>}
            </p>
          </div>
          <div data-rise className="flex flex-shrink-0 items-center gap-3">
            <span className="hidden whitespace-nowrap text-[14px] sm:block">{today}</span>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={refreshing}
              className="orb h-11 w-11"
              aria-label="Aktualisieren"
              title="Aktualisieren"
            >
              <RefreshCw size={18} strokeWidth={1.6} className={refreshing ? 'animate-spin' : ''} />
            </button>
          </div>
        </header>

        <Figures
          className="mt-10"
          items={[
            {
              label: 'Benutzer',
              value: stats.totalUsers,
              icon: Users,
              to: '/users',
              note: newThisWeek > 0
                ? <Delta trend="up" tone="mint"><span title="Neue Konten in dieser Woche">+{newThisWeek.toLocaleString('de-AT')} neu</span></Delta>
                : <Delta>keine neuen</Delta>,
            },
            { label: 'Sessions', value: stats.totalActiveSessions, icon: MonitorSmartphone, to: '/sessions', note: <Delta>aktiv</Delta> },
            { label: 'Anfragen', value: requestsToday, icon: Activity, to: '/requests', note: <Delta>⌀ {Math.round(stats.avgResponseTimeToday ?? 0)} ms</Delta> },
            {
              label: 'Fehler',
              value: errorsToday,
              icon: AlertTriangle,
              to: '/requests',
              note: errorsToday > 0
                ? <Delta trend="up" tone="rose">{errorRate.toLocaleString('de-AT', { maximumFractionDigits: 1 })} %</Delta>
                : <Delta tone="mint">keine heute</Delta>,
            },
          ]}
        />

        {showSchools && schools && schools.length > 0 && (
          <Section
            className="mt-[52px]"
            title="Schulen"
            meta={newSchools.length > 0 ? `${newSchools.length} neu in ${NEW_SCHOOL_DAYS} Tagen` : `${schools.length}`}
            action={<Link to="/schools" className="btn btn-sm btn-line">Alle Schulen</Link>}
          >
            {schoolsWithoutMenu.length > 0 && (
              <div className="mt-6">
                <Notice tone="amber" icon={UtensilsCrossed}>
                  {schoolsWithoutMenu.length === 1 ? `${schoolsWithoutMenu[0]!.name} hat` : `${schoolsWithoutMenu.length} Schulen haben`} keinen Mensaplan — ihre App zeigt keine Mensa.
                </Notice>
              </div>
            )}
            <ul className="rows mt-4">
              {topSchools.map((sc) => {
                const fresh = newSchools.includes(sc);
                return (
                  <li key={sc.id} className="row-line flex items-center gap-4 py-[9px]">
                    <span className="orb h-11 w-11"><School size={18} strokeWidth={1.6} /></span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-[14.5px] font-medium">{sc.name}</span>
                        {fresh && <Tag tone="mint"><Sparkles size={11} /> neu</Tag>}
                        {!sc.active && <Tag tone="rose">deaktiviert</Tag>}
                      </span>
                      <span className="block truncate text-[12.5px] text-ink-3">{sc.menu ? sc.menu.name : 'kein Mensaplan'}</span>
                    </span>
                    <span className="tabular flex-shrink-0 text-[14px]"><Count value={sc.users ?? 0} /> <span className="text-ink-3">Konten</span></span>
                  </li>
                );
              })}
            </ul>
          </Section>
        )}

        <section className="mt-[52px]" aria-labelledby="dash-trend">
          <div data-rise className="flex items-center justify-between gap-4">
            <h2 id="dash-trend" className="sec-title text-[20px] font-semibold">
              {range === 'day' ? 'API-Anfragen' : 'Registrierungen'}
            </h2>
            <Segmented
              label="Zeitraum"
              value={range}
              onChange={setRange}
              options={[{ value: 'day', label: '24 Std.' }, { value: 'fortnight', label: '14 Tage' }]}
            />
          </div>
          <div className="mt-8">
            {range === 'day' && chartLoading ? (
              <div className="shimmer h-[236px] rounded-[22px]" />
            ) : (
              <TrendChart
                labels={chart.labels}
                titles={chart.titles}
                series={chart.series}
                tickEvery={chart.tickEvery}
                drawKey={range}
                ariaLabel={range === 'day'
                  ? 'API-Anfragen und Fehler je Stunde, letzte 24 Stunden'
                  : 'Registrierungen je Tag, letzte 14 Tage'}
              />
            )}
          </div>
        </section>

        {usage && (
          <Section
            className="mt-[50px]"
            title="App-Nutzung"
            meta="Heute"
            action={<Link to="/analytics" className="btn btn-sm btn-line">Alle Analytics</Link>}
          >
            <div className="mt-8 grid gap-x-14 gap-y-10 md:grid-cols-[auto_minmax(0,1fr)]">
              <div className="flex items-center gap-7">
                <Ring share={activeShare} ariaLabel="Anteil der heute aktiven Konten">
                  <span className="tabular text-[24px] font-semibold leading-none">
                    {(activeShare * 100).toLocaleString('de-AT', { maximumFractionDigits: 0 })} %
                  </span>
                  <span className="mt-1.5 text-[12px] text-ink-3">aktiv</span>
                </Ring>
                <dl className="flex flex-col gap-5">
                  <div>
                    <dt className="text-[13.5px] text-ink-3">Aktive Nutzer</dt>
                    <dd className="mt-0.5 text-[19px] font-semibold"><Count value={usage.activeUsersToday} /></dd>
                  </div>
                  <div>
                    <dt className="text-[13.5px] text-ink-3">Ereignisse</dt>
                    <dd className="mt-0.5 text-[19px] font-semibold"><Count value={usage.totalToday} /></dd>
                  </div>
                </dl>
              </div>
              <div className="min-w-0">
                <h3 className="mb-5 text-[14.5px] text-ink-3">Meistbesuchte Seiten</h3>
                <RankBars
                  items={usage.topPagesToday.slice(0, 4).map((p) => ({ label: p.page, value: p.count }))}
                  empty="Heute noch keine Seitenaufrufe."
                />
              </div>
            </div>
            {usage.eventsToday.length > 0 && (
              <div className="mt-10">
                <SplitBar
                  ariaLabel="Ereignisse von heute nach Art"
                  parts={usage.eventsToday.slice(0, 5).map((e, i) => ({
                    label: e.event.replace(/_/g, ' '),
                    value: e.count,
                    color: EVENT_COLORS[i % EVENT_COLORS.length]!,
                  }))}
                />
              </div>
            )}
          </Section>
        )}

        <section className="mt-[50px]" aria-labelledby="dash-endpoints">
          <div data-rise className="flex items-center justify-between gap-4">
            <div className="flex min-w-0 items-center">
              <h2 id="dash-endpoints" className="sec-title whitespace-nowrap text-[20px] font-semibold">Top-Endpunkte</h2>
              <span className="ml-6 hidden whitespace-nowrap border-l border-line py-0.5 pl-6 text-[14px] sm:block">
                Letzte 24 Std.
              </span>
            </div>
            <button
              type="button"
              onClick={() => setSortBy((s) => (s === 'count' ? 'avgMs' : 'count'))}
              className="btn btn-sm btn-line flex-shrink-0"
              title="Sortierung wechseln"
            >
              {sortBy === 'count' ? 'Aufrufe' : 'Latenz'}
              <ArrowUpDown size={13} strokeWidth={1.8} />
            </button>
          </div>

          <div className="rows mt-5">
            {chartLoading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4 py-[9px]">
                  <div className="shimmer h-12 w-12 flex-shrink-0 rounded-full" />
                  <div className="shimmer h-4 flex-1 rounded-full" />
                  <div className="shimmer h-4 w-20 rounded-full" />
                </div>
              ))
            ) : endpoints.length === 0 ? (
              <p className="py-6 text-[14px] text-ink-3">Noch keine Daten.</p>
            ) : (
              <ul>
                {endpoints.map((ep, i) => {
                  const Icon = endpointIcon(ep.path);
                  const tone = endpointTone(ep.avgMs);
                  return (
                    <li
                      key={ep.path}
                      className="row-line spot animate-fadeInUp flex items-center gap-4 py-[9px]"
                      style={{ animationDelay: `${i * 55}ms` }}
                    >
                      <span className="orb h-12 w-12" style={{ background: tone.well }}>
                        <Icon size={19} strokeWidth={1.6} />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[14.5px] font-medium" title={ep.path}>{ep.path}</span>
                      <span className="row-status flex items-center gap-[10px] text-[14px]">
                        <i className="h-[7px] w-[7px] flex-shrink-0 rounded-full" style={{ background: tone.dot }} />
                        <span className="row-status-label">{tone.label}</span>
                      </span>
                      <span className="flex w-[104px] flex-shrink-0 items-center gap-[10px] text-[15px] font-medium">
                        <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full" style={{ background: 'var(--ink-4)' }}>
                          <Clock size={11} strokeWidth={2.4} color="var(--sheet)" />
                        </span>
                        <span className="tabular">{ep.avgMs.toLocaleString('de-AT')} ms</span>
                      </span>
                      <span className="tabular w-[62px] flex-shrink-0 text-right text-[13.5px] text-ink-3">
                        {ep.count.toLocaleString('de-AT')}×
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>
      </div>

      <aside className="dash-rail scrollbar-thin" aria-label="Konto und Aktivität">
        <div data-rail className="dash-profile">
          <div className="relative mx-auto h-[92px] w-[92px]">
            <span
              className="flex h-full w-full items-center justify-center rounded-full text-[32px] font-semibold"
              style={{ background: profileTone.wash, color: profileTone.deep, boxShadow: '0 0 0 4px var(--sheet)' }}
            >
              {username[0]?.toUpperCase() ?? 'A'}
            </span>
            <span
              className="absolute bottom-[3px] right-[3px] h-[15px] w-[15px] rounded-full"
              style={{ background: 'var(--mint)', boxShadow: '0 0 0 3px var(--sheet)' }}
              title="Angemeldet"
            />
          </div>
          <div className="mt-[18px] truncate text-[16px] font-medium">{username}</div>
          <div className="mt-1 flex items-center justify-center gap-1.5 text-[13.5px] text-ink-3">
            <ShieldCheck size={14} strokeWidth={1.7} />
            {roleLabel}
          </div>
          <div className="mt-[22px] flex justify-center gap-5">
            {quickLinks.map(({ to, label, icon: Icon }) => (
              <Link key={to} to={to} className="orb orb-white h-[42px] w-[42px]" aria-label={label} title={label}>
                <Icon size={18} strokeWidth={1.6} />
              </Link>
            ))}
          </div>
          <dl className="mt-7 grid grid-cols-4 border-t pt-5" style={{ borderColor: 'rgb(var(--ink-rgb) / calc(0.07 * var(--veil)))' }}>
            {ledger.map((item) => (
              <div key={item.label} className="min-w-0">
                <dd className="text-[16px] font-semibold"><Count value={item.value} /></dd>
                <dt className="mt-0.5 truncate text-[11px] tracking-[-0.01em] text-ink-3" title={item.label}>{item.label}</dt>
              </div>
            ))}
          </dl>
        </div>

        <div data-rail className="rule-label mt-[26px]">Aktivität</div>

        <div className="dash-feed">
          {feed.length === 0 && !chartLoading && (
            <p className="py-4 text-center text-[14px] text-ink-3">Noch keine Aktivität.</p>
          )}
          {feed.map((item, i) => (
            <article key={item.id} className="animate-fadeInUp" style={{ animationDelay: `${160 + i * 70}ms` }}>
              <div className="flex items-start gap-[14px]">
                <span className="mt-0.5"><Avatar name={item.name} size={38} /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-[15px] font-medium">{item.name}</span>
                    <time className="flex-shrink-0 text-[12.5px] text-ink-3" dateTime={item.at}>{relativeTime(item.at)}</time>
                  </div>
                  <p className="mt-0.5 truncate text-[13.5px] text-ink-3">
                    {item.kind === 'comment' ? (
                      <>Kommentierte <Link to="/comments" className="text-sky-deep hover:underline">{item.comment.contextTitle || 'einen Beitrag'}</Link></>
                    ) : (
                      <>Registriert{item.user.webuntisKlasseName
                        ? <> in <Link to="/users" state={{ search: item.user.username }} className="text-sky-deep hover:underline">{item.user.webuntisKlasseName}</Link></>
                        : <> als <Link to="/users" state={{ search: item.user.username }} className="text-sky-deep hover:underline">{item.user.role === 'parent' ? 'Elternteil' : 'Schüler:in'}</Link></>}</>
                    )}
                  </p>
                  {item.kind === 'comment' && item.comment.body && (
                    <p className="dash-bubble">{item.comment.body}</p>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>

      </aside>
    </div>
  );
}
