import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  CalendarDays,
  ChartNoAxesColumn,
  Clock,
  Flame,
  Globe,
  Hourglass,
  Info,
  Layers,
  Medal,
  MessagesSquare,
  Moon,
  RefreshCw,
  Repeat,
  Smartphone,
  Sparkles,
  Star,
  Sunrise,
  Timer,
  Trophy,
  Users,
  UtensilsCrossed,
  type LucideIcon,
} from 'lucide-react';
import { adminApi } from '../api';
import { useAutoRefresh } from '../hooks/useAutoRefresh';
import { useLive, useLiveStatus } from '../live';
import { useTheme, type Theme } from '../theme';
import { TrendChart, type TrendSeries } from '../components/TrendChart';
import { Bars, RankBars, Ring, SplitBar } from '../components/charts';
import { Delta, Empty, Figures, IconButton, Notice, PageHeader, Section, Segmented, TONES, Tag, useTableLabels, type Tone } from '../components/kit';
import type { AdminAnalytics, AnalyticsRange, UsagePlatform } from '../types';

// ─── Vocabulary ─────────────────────────────────────────────────────────────

// iPhone and Android are the native apps only. Everything in a browser — on a
// phone or a computer, in a tab or installed to the home screen — is "Web".
const PLATFORM_ORDER: UsagePlatform[] = ['ios', 'android', 'web', 'other'];
const PLATFORM_LABEL: Record<UsagePlatform, string> = { ios: 'iPhone-App', android: 'Android-App', web: 'Web', other: 'Andere App' };

// One colour per platform, the same in every chart on the page. Checked for
// colour-vision deficiencies and contrast on both sheets; dark mode has its
// own, darker steps rather than the light ones.
const PLATFORM_COLOR: Record<Theme, Record<UsagePlatform, string>> = {
  light: { ios: '#4f96dc', android: '#3fae86', web: '#e0892f', other: '#9b7ad6' },
  dark:  { ios: '#4a8fd6', android: '#2f9a73', web: '#c9782a', other: '#9f80db' },
};
const NEUTRAL = '#4f96dc';

const WEEKDAYS = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
const WEEKDAYS_SHORT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

type Metric = 'users' | 'time' | 'sessions';
type TabKey = 'overview' | 'platforms' | 'usage' | 'features' | 'accounts';

const TABS: Array<{ value: TabKey; label: string }> = [
  { value: 'overview',  label: 'Überblick' },
  { value: 'platforms', label: 'Plattformen' },
  { value: 'usage',     label: 'Nutzungszeiten' },
  { value: 'features',  label: 'Funktionen' },
  { value: 'accounts',  label: 'Konten' },
];
const TAB_KEY = 'pokyh_admin_analytics_tab';

function storedTab(): TabKey {
  try {
    const value = localStorage.getItem(TAB_KEY);
    return TABS.some((t) => t.value === value) ? value as TabKey : 'overview';
  } catch {
    return 'overview';
  }
}

// ─── Formatting ─────────────────────────────────────────────────────────────

const de = (value: number, digits = 0) => value.toLocaleString('de-AT', { maximumFractionDigits: digits });

function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} Sek.`;
  if (s < 600) return `${de(s / 60, 1)} Min.`;
  if (s < 3600) return `${Math.round(s / 60)} Min.`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m > 0 ? `${h} Std. ${m} Min.` : `${h} Std.`;
}

function hours(seconds: number): string {
  const h = seconds / 3600;
  return `${de(h, h < 10 ? 1 : 0)} Std.`;
}

function percent(part: number, whole: number): string {
  if (whole <= 0) return '–';
  const value = part / whole;
  return `${de(value * 100, value < 0.1 ? 1 : 0)} %`;
}

function dayDate(dayKey: string): Date {
  return new Date(`${dayKey}T12:00:00`);
}

function longDay(dayKey: string): string {
  return dayDate(dayKey).toLocaleDateString('de-AT', { weekday: 'short', day: 'numeric', month: 'long' });
}

function shortDay(dayKey: string, days: number): string {
  const d = dayDate(dayKey);
  return days > 31 ? `${d.getDate()}.${d.getMonth() + 1}.` : String(d.getDate()).padStart(2, '0');
}

function hourSpan(hour: number): string {
  return `${String(hour).padStart(2, '0')}–${String((hour + 1) % 24).padStart(2, '0')} Uhr`;
}

// ─── Small pieces ───────────────────────────────────────────────────────────

interface Fact {
  icon: LucideIcon;
  tone: Tone;
  value: string;
  label: string;
}

// Short statements with one number each, three to a row on wide screens.
function FactGrid({ facts, columns = 3 }: { facts: Fact[]; columns?: 2 | 3 }) {
  if (facts.length === 0) return <p className="mt-6 text-[14px] text-ink-3">Noch keine Daten in diesem Zeitraum.</p>;
  return (
    <ul className={`mt-7 grid gap-x-10 gap-y-7 sm:grid-cols-2 ${columns === 3 ? '2xl:grid-cols-3' : ''}`}>
      {facts.map((fact, i) => (
        <li key={fact.label} className="animate-fadeInUp flex min-w-0 items-start gap-4" style={{ animationDelay: `${i * 35}ms` }}>
          <span className="orb h-11 w-11 flex-shrink-0" style={{ background: TONES[fact.tone].wash, color: TONES[fact.tone].deep }}>
            <fact.icon size={18} strokeWidth={1.6} />
          </span>
          <div className="min-w-0">
            <div className="truncate text-[17px] font-semibold leading-snug" title={fact.value}>{fact.value}</div>
            <div className="mt-0.5 text-[13.5px] leading-snug text-ink-3">{fact.label}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function Legend({ items }: { items: Array<{ label: string; color: string }> }) {
  return (
    <ul className="flex flex-wrap gap-x-6 gap-y-2" aria-hidden="true">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-[10px] text-[13.5px] text-ink-3">
          <i className="h-[7px] w-[7px] flex-shrink-0 rounded-full" style={{ background: item.color }} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

function Ledger({ items, columns = 3 }: { items: Array<{ label: string; value: string; hint?: string }>; columns?: 2 | 3 }) {
  return (
    <dl className={`grid grid-cols-2 gap-x-8 gap-y-6 ${columns === 3 ? 'sm:grid-cols-3' : ''}`}>
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="truncate text-[13.5px] text-ink-3" title={item.hint ?? item.label}>{item.label}</dt>
          <dd className="tabular mt-0.5 text-[19px] font-semibold">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

// One line under a section that says what its numbers mean.
function Explain({ children }: { children: ReactNode }) {
  return <p className="mt-5 max-w-[70ch] text-[13px] leading-relaxed text-ink-3">{children}</p>;
}

function Pair({ children }: { children: ReactNode }) {
  return <div className="grid gap-x-16 gap-y-14 xl:grid-cols-2">{children}</div>;
}

function Skeleton() {
  return (
    <div aria-busy="true" aria-label="Laden">
      <div className="shimmer h-9 w-56 rounded-full" />
      <div className="shimmer mt-4 h-4 w-96 max-w-full rounded-full" />
      <div className="mt-10 h-px bg-line" />
      <div className="flex gap-10 py-8">
        {[0, 1, 2, 3].map((i) => <div key={i} className="shimmer h-12 flex-1 rounded-full" />)}
      </div>
      <div className="h-px bg-line" />
      <div className="shimmer mt-10 h-11 w-[520px] max-w-full rounded-full" />
      <div className="shimmer mt-10 h-[236px] rounded-[22px]" />
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export function AnalyticsPage() {
  const theme = useTheme();
  const colors = PLATFORM_COLOR[theme];
  const [days, setDays] = useState<AnalyticsRange>(30);
  const [tab, setTabState] = useState<TabKey>(storedTab);
  const [data, setData] = useState<AdminAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [metric, setMetric] = useState<Metric>('users');
  const tableRef = useRef<HTMLDivElement>(null);
  useTableLabels(tableRef);
  // While the admin stream is connected every change reaches the page at once.
  const streaming = useLiveStatus();

  const setTab = (next: TabKey) => {
    setTabState(next);
    try { localStorage.setItem(TAB_KEY, next); } catch { /* remembered for this visit only */ }
  };

  const load = useCallback(async (fresh = false) => {
    try {
      const next = await adminApi.analytics(days, fresh);
      setData(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Analytics konnten nicht geladen werden');
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  const timed = useCallback(() => { void load(); }, [load]);
  // Live: every visit, ping, sign-up, comment or rating announced on the admin
  // stream refetches the figures; the timer is the fallback when the stream is
  // down and keeps "online now" current while nothing else happens.
  useLive(['analytics', 'users', 'sessions', 'todos', 'reminders', 'comments', 'ratings', 'activity', 'learn'], timed, 3000);
  const { refreshing } = useAutoRefresh(timed, 30_000);
  const [manual, setManual] = useState(false);
  const refreshNow = async () => {
    setManual(true);
    try { await load(true); } finally { setManual(false); }
  };

  const trend = useMemo(() => {
    if (!data) return null;
    const labels = data.daily.map((d) => shortDay(d.dayKey, data.days));
    const titles = data.daily.map((d) => longDay(d.dayKey));
    const tickEvery = data.days <= 7 ? 1 : data.days <= 30 ? 3 : 10;
    let series: TrendSeries[];
    if (metric === 'users') {
      series = PLATFORM_ORDER
        .filter((p) => data.daily.some((d) => d.byPlatform[p] > 0))
        .map((p) => ({ key: p, label: PLATFORM_LABEL[p], color: colors[p], values: data.daily.map((d) => d.byPlatform[p]) }));
    } else if (metric === 'time') {
      series = [{
        key: 'time',
        label: 'Ø Minuten pro Nutzer',
        color: NEUTRAL,
        area: true,
        values: data.daily.map((d) => (d.users > 0 ? Math.round((d.userSeconds / d.users / 60) * 10) / 10 : 0)),
      }];
    } else {
      series = [{ key: 'sessions', label: 'Sitzungen', color: NEUTRAL, area: true, values: data.daily.map((d) => d.sessions) }];
    }
    return { labels, titles, tickEvery, series };
  }, [data, metric, colors]);

  if (loading && !data) return <Skeleton />;

  if (!data) {
    return (
      <div>
        <PageHeader title="Analytics" />
        <Empty icon={AlertTriangle}>{error ?? 'Analytics konnten nicht geladen werden.'}</Empty>
        <div className="flex justify-center">
          <button type="button" className="btn btn-primary" onClick={() => { setLoading(true); void load(true); }}>Erneut versuchen</button>
        </div>
      </div>
    );
  }

  const { platforms, time, engagement, accounts, features, mensa, live } = data;
  const hasVisits = time.sessions > 0;
  const rangeLabel = `letzte ${data.days} Tage`;
  const loadedAt = new Date(data.generatedAt).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const platformSum = PLATFORM_ORDER.reduce((s, p) => s + platforms.byPlatform[p], 0);
  const shownPlatforms = PLATFORM_ORDER.filter((p) => p !== 'other' || platforms.byPlatform.other > 0 || time.byPlatform.other.sessions > 0);

  // ── Derived records ───────────────────────────────────────────────────────
  const busiestDay = data.daily.reduce<AdminAnalytics['daily'][number] | null>((best, d) => (d.users > (best?.users ?? 0) ? d : best), null);
  const peakHour = data.hours.reduce<AdminAnalytics['hours'][number] | null>((best, h) => (h.sessions > (best?.sessions ?? 0) ? h : best), null);
  const favouriteDay = data.weekdays.reduce<AdminAnalytics['weekdays'][number] | null>((best, w) => (w.avgUsers > (best?.avgUsers ?? 0) ? w : best), null);
  const sumHours = (from: number, to: number) => data.hours.filter((h) => (from <= to ? h.hour >= from && h.hour < to : h.hour >= from || h.hour < to)).reduce((s, h) => s + h.sessions, 0);
  const weekendSeconds = data.weekdays.filter((w) => w.weekday >= 5).reduce((s, w) => s + w.seconds, 0);
  const topPlatform = PLATFORM_ORDER.reduce<UsagePlatform | null>((best, p) => (platforms.byPlatform[p] > (best ? platforms.byPlatform[best] : 0) ? p : best), null);
  const lengthPeak = time.lengthBands.reduce((best, b, i, all) => (b.sessions > (all[best]?.sessions ?? 0) ? i : best), 0);

  const highlights: Fact[] = [];
  if (hasVisits) highlights.push({ icon: Hourglass, tone: 'sky', value: hours(time.totalSeconds), label: 'insgesamt auf Pokyh verbracht' });
  if (busiestDay && busiestDay.users > 0) highlights.push({ icon: Trophy, tone: 'amber', value: `${de(busiestDay.users)} Nutzer`, label: `Rekordtag: ${longDay(busiestDay.dayKey)}` });
  if (peakHour && peakHour.sessions > 0) highlights.push({ icon: Flame, tone: 'rose', value: hourSpan(peakHour.hour), label: `Stoßzeit — ${percent(peakHour.sessions, time.sessions)} aller Sitzungen starten hier` });
  if (topPlatform && platformSum > 0) highlights.push({ icon: Medal, tone: 'violet', value: `${PLATFORM_LABEL[topPlatform]} vorn`, label: `${percent(platforms.byPlatform[topPlatform], platformSum)} der Plattform-Nutzungen` });
  if (favouriteDay && favouriteDay.avgUsers > 0) highlights.push({ icon: CalendarDays, tone: 'mint', value: WEEKDAYS[favouriteDay.weekday]!, label: `Lieblingstag mit Ø ${de(favouriteDay.avgUsers, 1)} aktiven Nutzern` });
  if (engagement.loyalUsers > 0) highlights.push({ icon: Repeat, tone: 'mint', value: `${de(engagement.loyalUsers)} Stammnutzer`, label: 'an mindestens jedem zweiten Tag aktiv' });
  if (time.longestSessionSeconds > 0) highlights.push({ icon: Timer, tone: 'sky', value: duration(time.longestSessionSeconds), label: 'längste einzelne Sitzung' });
  if (platforms.multiPlatform > 0) highlights.push({ icon: Layers, tone: 'violet', value: `${de(platforms.multiPlatform)} Nutzer`, label: `nutzen mehrere Plattformen (${percent(platforms.multiPlatform, platforms.total)})` });
  if (mensa.topRated) highlights.push({ icon: UtensilsCrossed, tone: 'amber', value: mensa.topRated.name, label: `Mensa-Liebling: Ø ${de(mensa.topRated.avg, 1)} ★` });

  const habits: Fact[] = hasVisits ? [
    { icon: Moon, tone: 'violet', value: percent(sumHours(22, 5), time.sessions), label: 'Nachteulen — Sitzungen zwischen 22 und 5 Uhr' },
    { icon: Sunrise, tone: 'amber', value: percent(sumHours(5, 7), time.sessions), label: 'Frühaufsteher — Sitzungen zwischen 5 und 7 Uhr' },
    { icon: BookOpen, tone: 'mint', value: percent(sumHours(8, 13), time.sessions), label: 'der Sitzungen in der Schulzeit (8–13 Uhr)' },
    { icon: CalendarDays, tone: 'ink', value: percent(weekendSeconds, time.totalSeconds), label: 'der Nutzungszeit liegt am Wochenende' },
    { icon: Sparkles, tone: 'sky', value: de(time.screensPerSession, 1), label: 'Bildschirme werden pro Sitzung geöffnet' },
    { icon: Repeat, tone: 'mint', value: de(time.sessionsPerUserDay, 1), label: 'Sitzungen pro Nutzer und aktivem Tag' },
  ] : [];

  return (
    <div>
      <PageHeader
        title="Analytics"
        subtitle="Wie Pokyh genutzt wird — iPhone-App, Android-App und Web im Vergleich. Nur Gesamtzahlen, keine Einzelpersonen."
      >
        <Segmented
          label="Zeitraum"
          value={String(days) as '7' | '30' | '90'}
          onChange={(next) => setDays(Number(next) as AnalyticsRange)}
          options={[{ value: '7', label: '7 Tage' }, { value: '30', label: '30 Tage' }, { value: '90', label: '90 Tage' }]}
        />
        <IconButton icon={RefreshCw} label="Aktualisieren" size={42} busy={manual || refreshing || loading} onClick={() => void refreshNow()} />
      </PageHeader>

      <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 text-[14px]">
        <Tag tone={live.online > 0 ? 'mint' : 'ink'}>{live.online > 0 ? 'Live' : 'Ruhig'}</Tag>
        <span><span className="tabular font-semibold">{de(live.online)}</span> gerade online</span>
        {PLATFORM_ORDER.filter((p) => live.byPlatform[p] > 0).map((p) => (
          <span key={p} className="flex items-center gap-2 text-ink-3">
            <i className="h-[7px] w-[7px] rounded-full" style={{ background: colors[p] }} />
            <span className="tabular">{de(live.byPlatform[p])}</span> {PLATFORM_LABEL[p]}
          </span>
        ))}
        <span className="text-ink-3" title={`Zuletzt geladen um ${loadedAt}`}>
          · {streaming ? 'Live-Stand' : `Stand ${loadedAt.slice(0, 5)}`}
        </span>
      </div>

      <div style={{ opacity: loading ? 0.55 : 1, transition: 'opacity 0.25s ease' }}>
        <Figures
          className="mt-7"
          items={[
            {
              label: 'iPhone-App',
              value: platforms.byPlatform.ios,
              icon: Smartphone,
              note: <Delta>{percent(platforms.byPlatform.ios, platforms.total)} der Nutzer</Delta>,
            },
            {
              label: 'Android-App',
              value: platforms.byPlatform.android,
              icon: Smartphone,
              note: <Delta>{percent(platforms.byPlatform.android, platforms.total)} der Nutzer</Delta>,
            },
            {
              label: 'Web',
              value: platforms.byPlatform.web,
              icon: Globe,
              note: <Delta>{percent(platforms.byPlatform.web, platforms.total)} der Nutzer</Delta>,
            },
            {
              label: 'Ø Zeit pro Tag',
              value: hasVisits ? duration(time.avgDailySecondsPerUser) : '–',
              icon: Clock,
              note: <Delta>je aktivem Nutzer</Delta>,
            },
          ]}
        />
        <Figures
          className="-mt-px"
          items={[
            { label: 'Aktiv heute', value: engagement.dau, icon: Users, note: <Delta>Nutzer</Delta> },
            { label: 'Letzte 7 Tage', value: engagement.wau, icon: CalendarDays, note: <Delta>Nutzer</Delta> },
            { label: 'Letzte 30 Tage', value: engagement.mau, icon: ChartNoAxesColumn, note: <Delta>Nutzer</Delta> },
            {
              label: 'Ø Sitzung',
              value: hasVisits ? duration(time.avgSessionSeconds) : '–',
              icon: Timer,
              note: hasVisits ? <Delta>Median {duration(time.medianSessionSeconds)}</Delta> : undefined,
            },
          ]}
        />

        {!hasVisits && (
          <div className="mt-8">
            <Notice tone="sky" icon={Sparkles}>
              Nutzungszeiten, Sitzungen und Stoßzeiten erscheinen, sobald die aktualisierten Apps (iPhone, Android, Web)
              genutzt werden. Die Plattform-Zahlen oben kommen bis dahin aus den Server-Logs.
            </Notice>
          </div>
        )}

        <div className="mt-10">
          <Segmented label="Bereich" value={tab} onChange={setTab} options={TABS} />
        </div>

        <div key={tab} className="animate-fadeInUp mt-10">
          {tab === 'overview' && (
            <div className="flex flex-col gap-[56px]">
              {hasVisits && trend && (
                <Section
                  title={metric === 'users' ? 'Aktive Nutzer' : metric === 'time' ? 'Zeit pro Nutzer' : 'Sitzungen'}
                  meta={rangeLabel}
                  action={(
                    <Segmented
                      label="Kennzahl"
                      value={metric}
                      onChange={setMetric}
                      options={[{ value: 'users', label: 'Nutzer' }, { value: 'time', label: 'Zeit' }, { value: 'sessions', label: 'Sitzungen' }]}
                    />
                  )}
                >
                  {metric === 'users' && (
                    <div className="mt-6">
                      <Legend items={trend.series.map((s) => ({ label: s.label, color: s.color }))} />
                    </div>
                  )}
                  <div className="mt-6">
                    <TrendChart
                      labels={trend.labels}
                      titles={trend.titles}
                      series={trend.series}
                      tickEvery={trend.tickEvery}
                      drawKey={`${metric}-${data.days}`}
                      ariaLabel={metric === 'users'
                        ? `Aktive Nutzer je Tag und Plattform, letzte ${data.days} Tage`
                        : metric === 'time'
                          ? `Durchschnittliche Minuten pro aktivem Nutzer je Tag, letzte ${data.days} Tage`
                          : `Sitzungen je Tag, letzte ${data.days} Tage`}
                    />
                  </div>
                  <Explain>
                    {metric === 'users' && 'Wie viele verschiedene Konten an einem Tag Pokyh geöffnet haben — getrennt nach iPhone-App, Android-App und Web.'}
                    {metric === 'time' && 'Durchschnittliche Vordergrundzeit pro aktivem Konto und Tag.'}
                    {metric === 'sessions' && 'Wie oft Pokyh pro Tag geöffnet wurde. Nach 30 Minuten im Hintergrund zählt das nächste Öffnen als neue Sitzung.'}
                  </Explain>
                </Section>
              )}

              <Section title="Highlights" meta={rangeLabel}>
                <FactGrid facts={highlights} />
              </Section>
            </div>
          )}

          {tab === 'platforms' && (
            <div className="flex flex-col gap-[56px]">
              <Pair>
                <Section title="Verteilung" meta={`${de(platforms.total)} aktive Konten`}>
                  <div className="mt-8">
                    <SplitBar
                      ariaLabel="Aktive Konten nach Plattform"
                      parts={shownPlatforms.map((p) => ({ label: PLATFORM_LABEL[p], value: platforms.byPlatform[p], color: colors[p] }))}
                    />
                  </div>
                  <div ref={tableRef} className="tbl-scroll mt-9">
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th>Plattform</th>
                          <th style={{ textAlign: 'right' }}>Nutzer</th>
                          <th style={{ textAlign: 'right' }}>Sitzungen</th>
                          <th style={{ textAlign: 'right' }}>Ø Sitzung</th>
                          <th style={{ textAlign: 'right' }}>Zeit gesamt</th>
                        </tr>
                      </thead>
                      <tbody>
                        {shownPlatforms.map((p) => {
                          const t = time.byPlatform[p];
                          return (
                            <tr key={p}>
                              <td data-primary>
                                <span className="flex items-center gap-[10px] font-medium">
                                  <i className="h-[7px] w-[7px] flex-shrink-0 rounded-full" style={{ background: colors[p] }} />
                                  {PLATFORM_LABEL[p]}
                                </span>
                              </td>
                              <td className="tabular text-right">{de(platforms.byPlatform[p])}</td>
                              <td className="tabular text-right text-ink-2">{de(t.sessions)}</td>
                              <td className="tabular text-right text-ink-2">{t.sessions > 0 ? duration(t.seconds / t.sessions) : '–'}</td>
                              <td className="tabular text-right text-ink-2">{t.seconds > 0 ? hours(t.seconds) : '–'}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <Explain>
                    Ein Konto, das z. B. die iPhone-App und die Website nutzt, zählt bei beiden.
                    {platforms.multiPlatform > 0 && ` Das trifft auf ${de(platforms.multiPlatform)} Konten zu.`}
                  </Explain>
                </Section>

                <Section title="Web im Detail" meta={`${de(platforms.byPlatform.web)} Nutzer`}>
                  <div className="mt-8">
                    <RankBars
                      color={colors.web}
                      unit=" Nutzer"
                      items={[
                        { label: 'Am Computer', value: platforms.web.desktop },
                        { label: 'Am Handy oder Tablet', value: platforms.web.mobile },
                        { label: 'Als Web-App installiert (PWA)', value: platforms.web.pwa },
                        { label: 'Im Browser-Tab', value: platforms.web.browser },
                      ]}
                    />
                  </div>
                  <Explain>
                    Alles, was im Browser läuft, zählt als Web — auch auf iPhone und Android. Ob als Web-App installiert
                    oder im Tab geöffnet, wissen nur die aktualisierten Web-Besuche.
                  </Explain>
                </Section>
              </Pair>

              {data.appVersions.length > 0 && (
                <Pair>
                  {(['ios', 'android'] as const).map((p) => {
                    const versions = data.appVersions.filter((v) => v.platform === p);
                    return (
                      <Section key={p} title={`${PLATFORM_LABEL[p]}-Versionen`} meta="Nutzer je Version">
                        <div className="mt-8">
                          <RankBars
                            color={colors[p]}
                            items={versions.map((v) => ({ label: v.version, value: v.users }))}
                            empty="Noch keine Version gemeldet."
                          />
                        </div>
                      </Section>
                    );
                  })}
                </Pair>
              )}
            </div>
          )}

          {tab === 'usage' && (
            hasVisits ? (
              <div className="flex flex-col gap-[56px]">
                <Pair>
                  <Section title="Tageszeit" meta="Beginn der Sitzungen">
                    <div className="mt-8">
                      <Bars
                        values={data.hours.map((h) => h.sessions)}
                        labels={data.hours.map((h) => String(h.hour).padStart(2, '0'))}
                        titles={data.hours.map((h) => hourSpan(h.hour))}
                        unit="Sitzungen"
                        tickEvery={3}
                        color={NEUTRAL}
                        ariaLabel="Sitzungen nach Startstunde"
                      />
                    </div>
                    {peakHour && <Explain>Am meisten los ist {hourSpan(peakHour.hour)}.</Explain>}
                  </Section>
                  <Section title="Wochentage" meta="Ø aktive Nutzer">
                    <div className="mt-8">
                      <Bars
                        values={data.weekdays.map((w) => w.avgUsers)}
                        labels={WEEKDAYS_SHORT}
                        titles={WEEKDAYS}
                        unit="Nutzer"
                        color={NEUTRAL}
                        format={(v) => de(v, 1)}
                        ariaLabel="Durchschnittlich aktive Nutzer je Wochentag"
                      />
                    </div>
                    {favouriteDay && <Explain>Stärkster Tag: {WEEKDAYS[favouriteDay.weekday]}.</Explain>}
                  </Section>
                </Pair>

                <Pair>
                  <Section title="Sitzungslänge" meta={`Median ${duration(time.medianSessionSeconds)}`}>
                    <div className="mt-8">
                      <Bars
                        values={time.lengthBands.map((b) => b.sessions)}
                        labels={time.lengthBands.map((b) => b.label)}
                        unit="Sitzungen"
                        color={NEUTRAL}
                        ariaLabel="Sitzungen nach Länge"
                      />
                    </div>
                    <Explain>
                      Die meisten Besuche dauern {time.lengthBands[lengthPeak]?.label} — die Hälfte aller Sitzungen ist
                      kürzer als {duration(time.medianSessionSeconds)}
                    </Explain>
                  </Section>
                  <Section title="Treue" meta={rangeLabel}>
                    <div className="mt-8 flex flex-wrap items-center gap-x-10 gap-y-8">
                      <Ring share={engagement.stickiness ?? 0} ariaLabel="Anteil der Monatsnutzer, die an einem durchschnittlichen Tag aktiv sind">
                        <span className="tabular text-[24px] font-semibold leading-none">
                          {engagement.stickiness === null ? '–' : `${de(engagement.stickiness * 100)} %`}
                        </span>
                        <span className="mt-1.5 text-[12px] text-ink-3">täglich da</span>
                      </Ring>
                      <div className="min-w-0 flex-1">
                        <Ledger
                          columns={2}
                          items={[
                            { label: 'Neu', value: de(engagement.newUsers), hint: 'Konto im Zeitraum erstellt' },
                            { label: 'Wiederkehrend', value: de(engagement.returningUsers) },
                            { label: 'Stammnutzer', value: de(engagement.loyalUsers), hint: 'an mindestens jedem zweiten Tag aktiv' },
                            { label: 'Ø aktive Tage', value: de(engagement.activeDaysPerUser, 1) },
                          ]}
                        />
                      </div>
                    </div>
                    <Explain>
                      „Täglich da": wie viele der Nutzer der letzten 30 Tage an einem durchschnittlichen Tag Pokyh öffnen (DAU/MAU).
                    </Explain>
                  </Section>
                </Pair>

                <Section title="Gewohnheiten" meta={rangeLabel}>
                  <FactGrid facts={habits} />
                </Section>
              </div>
            ) : (
              <Empty icon={Clock}>Nutzungszeiten erscheinen, sobald die aktualisierten Apps genutzt werden.</Empty>
            )
          )}

          {tab === 'features' && (
            <div className="flex flex-col gap-[56px]">
              <Pair>
                <Section title="Was erstellt wird" meta={rangeLabel}>
                  <div className="mt-8">
                    <RankBars
                      items={[
                        { label: 'Todos', value: features.todos, note: features.todos > 0 ? `${percent(features.todosDone, features.todos)} erledigt` : undefined },
                        { label: 'Erinnerungen', value: features.reminders },
                        { label: 'Kommentare zu Erinnerungen', value: features.reminderComments },
                        { label: 'Mensa-Bewertungen', value: features.dishRatings },
                        { label: 'Mensa-Kommentare', value: features.dishComments },
                        { label: 'Learn-Antworten', value: features.learnAnswers },
                        { label: 'Downloads', value: features.downloads },
                      ].filter((item) => item.value > 0)}
                      empty="In diesem Zeitraum wurde noch nichts erstellt."
                    />
                  </div>
                </Section>

                <Section title="Mensa" meta="alle Bewertungen">
                  <div className="mt-8">
                    <Bars
                      values={mensa.starBands}
                      labels={['1 ★', '2 ★', '3 ★', '4 ★', '5 ★']}
                      titles={['1 Stern', '2 Sterne', '3 Sterne', '4 Sterne', '5 Sterne']}
                      unit="Bewertungen"
                      color={NEUTRAL}
                      height={110}
                      ariaLabel="Mensa-Bewertungen nach Sternen"
                    />
                  </div>
                  <FactGrid
                    columns={2}
                    facts={[
                      ...(features.avgStars !== null ? [{ icon: Star, tone: 'amber' as Tone, value: `Ø ${de(features.avgStars, 2)} ★`, label: 'durchschnittliche Bewertung' }] : []),
                      ...(mensa.topRated ? [{ icon: Medal, tone: 'amber' as Tone, value: mensa.topRated.name, label: `Liebling: Ø ${de(mensa.topRated.avg, 1)} ★ (${de(mensa.topRated.ratings)}×)` }] : []),
                      ...(mensa.mostRated ? [{ icon: UtensilsCrossed, tone: 'sky' as Tone, value: mensa.mostRated.name, label: `meistbewertet (${de(mensa.mostRated.ratings)}×)` }] : []),
                      ...(mensa.mostCommented ? [{ icon: MessagesSquare, tone: 'rose' as Tone, value: mensa.mostCommented.name, label: `meistdiskutiert (${de(mensa.mostCommented.comments)} Kommentare)` }] : []),
                    ]}
                  />
                </Section>
              </Pair>

              <Pair>
                <Section title="Web-Seiten" meta={`${de(features.pageViews)} Aufrufe`}>
                  <div className="mt-8">
                    <RankBars items={data.pages.map((p) => ({ label: p.page, value: p.views }))} empty="Noch keine Seitenaufrufe." />
                  </div>
                  <Explain>Meistbesuchte Seiten der Website; Sprachvarianten (/de, /it …) sind zusammengefasst.</Explain>
                </Section>
                <Section title="Pokyh Learn" meta={rangeLabel}>
                  <div className="mt-8">
                    {features.learnAnswers > 0 ? (
                      <Ledger
                        columns={2}
                        items={[
                          { label: 'Lernende', value: de(features.learnLearners) },
                          { label: 'Antworten', value: de(features.learnAnswers) },
                          { label: 'Davon richtig', value: percent(features.learnCorrect, features.learnAnswers) },
                          { label: 'Lernzeit', value: `${de(features.learnMinutes)} Min.` },
                        ]}
                      />
                    ) : (
                      <p className="text-[14px] text-ink-3">In diesem Zeitraum wurde in Pokyh Learn noch nicht gelernt.</p>
                    )}
                  </div>
                </Section>
              </Pair>
            </div>
          )}

          {tab === 'accounts' && (
            <Pair>
              <Section title="Konten" meta={`${de(accounts.newInRange)} neu`}>
                <div className="mt-8">
                  <Ledger
                    items={[
                      { label: 'Konten gesamt', value: de(accounts.total) },
                      { label: 'Aktiv im Zeitraum', value: percent(platforms.total, accounts.total) },
                      { label: 'Ohne Aktivität', value: de(Math.max(0, accounts.total - platforms.total)) },
                      { label: 'Schüler:innen', value: de(accounts.students) },
                      { label: 'Eltern', value: de(accounts.parents) },
                      { label: 'Mit WebUntis', value: de(accounts.untis) },
                      { label: 'Push aktiv', value: percent(accounts.withPush, accounts.total) },
                      { label: 'Learn-Profile', value: de(accounts.withLearn) },
                      { label: 'Admins', value: de(accounts.admins) },
                    ]}
                  />
                </div>
                <h3 className="mb-5 mt-10 text-[14.5px] text-ink-3">Neue Konten pro Tag</h3>
                <Bars
                  values={data.daily.map((d) => d.signups)}
                  labels={data.daily.map((d) => shortDay(d.dayKey, data.days))}
                  titles={data.daily.map((d) => longDay(d.dayKey))}
                  unit="neue Konten"
                  tickEvery={data.days <= 7 ? 1 : data.days <= 30 ? 3 : 10}
                  height={96}
                  color={NEUTRAL}
                  ariaLabel={`Neue Konten je Tag, letzte ${data.days} Tage`}
                />
              </Section>
              <Section title="Aktivste Klassen" meta="aktiv von gesamt">
                <div className="mt-8">
                  <RankBars
                    items={data.classes.map((c) => ({ label: c.name, value: c.active, note: `von ${de(c.members)} (${percent(c.active, c.members)})` }))}
                    empty="Noch keine Klassen mit Aktivität."
                  />
                </div>
                <Explain>Schüler:innen-Konten einer Klasse, die im Zeitraum Pokyh genutzt haben.</Explain>
              </Section>
            </Pair>
          )}
        </div>
      </div>

      <div className="mt-[64px] flex max-w-[86ch] items-start gap-2.5 border-t border-line pt-6 text-[12.5px] leading-relaxed text-ink-3">
        <Info size={14} strokeWidth={1.7} className="mt-[2px] flex-shrink-0" />
        <div className="flex flex-col gap-2">
          <p>
            <strong className="font-medium text-ink-2">So wird gezählt:</strong> iPhone-App und Android-App sind nur die
            nativen Apps. Alles im Browser — am Computer oder am Handy, im Tab oder als installierte Web-App — zählt als Web.
          </p>
          <p>
            <strong className="font-medium text-ink-2">Quellen:</strong> Zeiten, Sitzungen und Tageszeiten messen die Apps selbst,
            solange Pokyh im Vordergrund ist; diese Besuche werden {de(platforms.visitRetentionDays)} Tage aufbewahrt.
            Damit auch noch nicht aktualisierte App-Versionen mitzählen, fließen zusätzlich die Server-Logs ein — die werden
            laut Datenschutzerklärung nach {de(platforms.requestLogRetentionDays)} Tagen gelöscht
            und reichen deshalb nicht weiter zurück.
          </p>
          <p>Tage und Stunden in {data.timezone}. Es werden nur Gesamtzahlen angezeigt.</p>
        </div>
      </div>

    </div>
  );
}
