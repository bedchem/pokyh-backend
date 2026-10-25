import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, AppWindow, ChevronDown, History, LogOut, Monitor, MonitorSmartphone, RefreshCw, ShieldX, Smartphone, Trash2, Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { adminApi } from '../api';
import { useToast } from '../components/Toast';
import { useAutoRefresh } from '../hooks/useAutoRefresh';
import { useLive } from '../live';
import { Avatar, Collapse, Dialog, Empty, Figures, IconButton, PageHeader, SearchField, Section, Spinner, Tag, type Tone } from '../components/kit';
import { Bars, SplitBar } from '../components/charts';
import type { AdminLoginEvent, AdminSessionDevice, AdminSessionPerson, AdminSessionsResponse, SessionClient } from '../types';

// Who is signed in where. One row per person; opening it lists their devices
// (phone app, website, installed website) with place, address and last use,
// each signed out on its own — or all of them at once — and their sign-ins.

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function relativeTime(dateStr: string): string {
  const secs = Math.max(0, Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  const days = Math.floor(hrs / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

const CLIENT: Record<SessionClient, { label: string; tone: Tone }> = {
  app: { label: 'App', tone: 'violet' },
  web: { label: 'Website', tone: 'sky' },
  pwa: { label: 'Installed website', tone: 'mint' },
  other: { label: 'Other', tone: 'ink' },
};

function deviceIcon(device: Pick<AdminSessionDevice, 'client' | 'platform'>): LucideIcon {
  if (device.client === 'pwa') return AppWindow;
  if (device.client === 'app' || device.platform === 'android' || device.platform === 'ios') return Smartphone;
  return Monitor;
}

const METHOD: Record<AdminLoginEvent['method'], string> = {
  webuntis: 'WebUntis password',
  office: 'Office 365 key',
  local: 'POKYH password',
  register: 'Registered',
  qr: 'POKYH app (QR code)',
  passkey: 'Device lock (Face ID, fingerprint, PIN)',
};

function LoginHistory({ stableUid }: { stableUid: string }) {
  const [logins, setLogins] = useState<AdminLoginEvent[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    adminApi.userLogins(stableUid).then((r) => setLogins(r.logins)).catch(() => setFailed(true));
  }, [stableUid]);

  if (failed) return <p className="text-[13.5px] text-ink-3">The sign-ins could not be loaded.</p>;
  if (!logins) return <div className="shimmer h-4 w-48 rounded-full" />;
  if (logins.length === 0) return <p className="text-[13.5px] text-ink-3">No sign-ins recorded yet.</p>;
  return (
    <ul className="flex flex-col gap-2.5">
      {logins.map((login) => (
        <li key={login.id} className="grid grid-cols-[minmax(0,140px)_minmax(0,1fr)] gap-x-4 text-[13.5px] sm:grid-cols-[150px_minmax(0,1.3fr)_minmax(0,1fr)_140px]">
          <span className="tabular whitespace-nowrap text-ink-2">{formatDate(login.at)}</span>
          <span className="truncate">{login.label}</span>
          <span className="hidden truncate text-ink-3 sm:block">{[login.place, login.ip].filter(Boolean).join(' · ') || 'Unknown place'}</span>
          <span className="hidden truncate text-ink-3 sm:block">{METHOD[login.method] ?? login.method}</span>
        </li>
      ))}
    </ul>
  );
}

function DeviceRow({ device, busy, onRevoke }: { device: AdminSessionDevice; busy: boolean; onRevoke: () => void }) {
  const Icon = deviceIcon(device);
  const client = CLIENT[device.client] ?? CLIENT.other;
  return (
    <li className="flex items-center gap-4 py-3.5">
      <span className="orb h-11 w-11"><Icon size={18} strokeWidth={1.6} /></span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[14.5px] font-medium">{device.label}</span>
          <Tag tone={client.tone}>{client.label}</Tag>
        </div>
        <div className="mt-1 truncate text-[13px] text-ink-3">
          {device.place || 'Unknown place'}
          {device.ip && <> · <span className="font-mono text-[12.5px]">{device.ip}</span></>}
        </div>
        <div className="mt-0.5 truncate text-[13px] text-ink-3">
          Active {relativeTime(device.lastUsedAt)} · signed in {formatDate(device.createdAt)}
        </div>
      </div>
      <IconButton icon={LogOut} tone="rose" label={`Sign out ${device.label}`} busy={busy} onClick={onRevoke} />
    </li>
  );
}

export function SessionsPage() {
  const { showToast } = useToast();
  const [data, setData] = useState<AdminSessionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [historyOpen, setHistoryOpen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmPerson, setConfirmPerson] = useState<string | null>(null);
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const [clearingAll, setClearingAll] = useState(false);
  const [deletingInactive, setDeletingInactive] = useState(false);

  const fetchSessions = useCallback(async () => {
    try {
      setData(await adminApi.sessions());
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to load sessions', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { void fetchSessions(); }, [fetchSessions]);
  const { refresh, refreshing } = useAutoRefresh(fetchSessions, 15000);
  useLive(['sessions', 'users'], () => { void fetchSessions(); });

  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  };

  // A device or person gone from the list at once; the next refresh confirms.
  function dropDevice(stableUid: string, deviceId: string | null) {
    setData((prev) => {
      if (!prev) return prev;
      const people = prev.people
        .map((p) => (p.stableUid !== stableUid ? p : { ...p, devices: deviceId ? p.devices.filter((d) => d.id !== deviceId) : [] }))
        .filter((p) => p.devices.length > 0);
      return { ...prev, people };
    });
  }

  async function handleRevokeDevice(person: AdminSessionPerson, device: AdminSessionDevice) {
    setBusy(device.id);
    try {
      await adminApi.revokeSession(device.id);
      showToast(`${person.username} signed out on ${device.label}`, 'success');
      dropDevice(person.stableUid, device.id);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to sign out the device', 'error');
    } finally {
      setBusy(null);
    }
  }

  async function handleRevokePerson(person: AdminSessionPerson) {
    if (confirmPerson !== person.stableUid) {
      setConfirmPerson(person.stableUid);
      return;
    }
    setBusy(person.stableUid);
    try {
      await adminApi.revokeUserSessions(person.stableUid);
      showToast(`${person.username} signed out on all devices`, 'success');
      dropDevice(person.stableUid, null);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to sign out', 'error');
    } finally {
      setBusy(null);
      setConfirmPerson(null);
    }
  }

  async function handleClearAll() {
    setClearingAll(true);
    try {
      await adminApi.revokeAllSessions();
      showToast('Everyone has been signed out', 'success');
      setConfirmClearAll(false);
      await fetchSessions();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to sign everyone out', 'error');
    } finally {
      setClearingAll(false);
    }
  }

  async function handleDeleteInactive() {
    setDeletingInactive(true);
    try {
      await adminApi.deleteInactiveSessions();
      showToast('Unused devices removed', 'success');
      await fetchSessions();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to remove devices', 'error');
    } finally {
      setDeletingInactive(false);
    }
  }

  const people = data?.people ?? [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return people;
    return people.filter((p) =>
      p.username.toLowerCase().includes(q)
      || p.className.toLowerCase().includes(q)
      || p.devices.some((d) => d.label.toLowerCase().includes(q) || d.place.toLowerCase().includes(q) || (d.ip ?? '').includes(q)));
  }, [people, query]);

  const byClient = data?.totals.byClient ?? { app: 0, web: 0, pwa: 0, other: 0 };
  const multiDevice = people.filter((p) => p.devices.length > 1).length;

  const days = Array.from({ length: 14 }, (_, i) => {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - (13 - i));
    return d;
  });
  const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const perDay = days.map((d) => data?.signInsPerDay[dayKey(d)] ?? 0);

  return (
    <div>
      {confirmClearAll && (
        <Dialog
          title="Sign everyone out?"
          subtitle={`This signs out all ${data?.totals.devices ?? 0} device${data?.totals.devices === 1 ? '' : 's'} of ${data?.totals.people ?? 0} people. Everyone has to sign in again.`}
          onClose={() => { if (!clearingAll) setConfirmClearAll(false); }}
        >
          <div className="flex gap-3">
            <button type="button" className="btn btn-quiet flex-1" disabled={clearingAll} onClick={() => setConfirmClearAll(false)}>Cancel</button>
            <button type="button" className="btn btn-danger flex-1" disabled={clearingAll} onClick={() => void handleClearAll()}>
              {clearingAll ? <Spinner /> : <ShieldX size={16} strokeWidth={1.7} />}
              Sign everyone out
            </button>
          </div>
        </Dialog>
      )}

      <PageHeader title="Sessions" subtitle="Who is signed in where. Open a person to see their devices and sign out one or all of them.">
        <IconButton icon={RefreshCw} label="Refresh" size={42} busy={refreshing} onClick={() => void refresh()} />
        <button type="button" className="btn btn-quiet" disabled={deletingInactive} onClick={() => void handleDeleteInactive()}>
          {deletingInactive ? <Spinner /> : <Trash2 size={16} strokeWidth={1.7} />}
          Remove unused
        </button>
        <button type="button" className="btn btn-danger" disabled={clearingAll || !data?.totals.devices} onClick={() => setConfirmClearAll(true)}>
          <ShieldX size={16} strokeWidth={1.7} />
          Sign everyone out
        </button>
      </PageHeader>

      <Figures
        className="mt-10"
        items={[
          { label: 'Signed-in people', value: data?.totals.people ?? 0, icon: Users },
          { label: 'Devices', value: data?.totals.devices ?? 0, icon: MonitorSmartphone },
          { label: 'On more than one device', value: multiDevice, icon: Activity },
        ]}
      />

      <div className="mt-[46px] grid gap-x-16 gap-y-12 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <Section title="Sign-ins" meta="Last 14 days">
          <div className="mt-8">
            <Bars
              values={perDay}
              labels={days.map((d) => String(d.getDate()).padStart(2, '0'))}
              titles={days.map((d) => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }))}
              unit="sign-ins"
              tickEvery={2}
              ariaLabel="Sign-ins per day over the last 14 days"
            />
          </div>
        </Section>
        <Section title="Devices">
          <div className="mt-9">
            <SplitBar
              ariaLabel="Devices by kind"
              parts={[
                { label: 'App', value: byClient.app ?? 0, color: 'var(--violet-solid)' },
                { label: 'Website', value: byClient.web ?? 0, color: 'var(--sky)' },
                { label: 'Installed', value: byClient.pwa ?? 0, color: 'var(--mint)' },
                { label: 'Other', value: byClient.other ?? 0, color: 'var(--amber)' },
              ]}
            />
          </div>
        </Section>
      </div>

      <Section
        className="mt-[52px]"
        title="People"
        meta={data ? `Devices unused for ${data.idleDays} days drop out` : undefined}
        action={<SearchField value={query} onChange={setQuery} placeholder="Name, class, device, place or IP" className="w-full sm:w-[320px]" />}
      >
        {loading ? (
          <div className="mt-7 flex flex-col gap-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4">
                <div className="shimmer h-11 w-11 rounded-full" />
                <div className="shimmer h-4 flex-1 rounded-full" />
                <div className="shimmer h-4 w-24 rounded-full" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <Empty icon={MonitorSmartphone}>{query ? 'Nobody matches.' : 'Nobody is signed in.'}</Empty>
        ) : (
          <ul className="stack mt-5">
            {filtered.map((person) => {
              const open = expanded.has(person.stableUid);
              const kinds = (['app', 'pwa', 'web', 'other'] as SessionClient[])
                .map((kind) => ({ kind, count: person.devices.filter((d) => d.client === kind).length }))
                .filter((k) => k.count > 0);
              const confirming = confirmPerson === person.stableUid;
              return (
                <li key={person.stableUid}>
                  <div
                    role="button"
                    tabIndex={0}
                    aria-expanded={open}
                    className="spot flex cursor-pointer items-center gap-4 py-4"
                    onClick={() => setExpanded((s) => toggle(s, person.stableUid))}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded((s) => toggle(s, person.stableUid)); } }}
                  >
                    <Avatar name={person.username} size={44} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[14.5px] font-medium">{person.username}</div>
                      <div className="mt-0.5 truncate text-[13px] text-ink-3">
                        {[person.className, person.role === 'parent' ? 'Parent' : ''].filter(Boolean).join(' · ') || 'No class'}
                        {' · '}active {relativeTime(person.lastUsedAt)}
                      </div>
                    </div>
                    <span className="hidden items-center gap-1.5 md:flex">
                      {kinds.map(({ kind, count }) => (
                        <Tag key={kind} tone={CLIENT[kind].tone}>{CLIENT[kind].label}{count > 1 ? ` ×${count}` : ''}</Tag>
                      ))}
                    </span>
                    <span
                      className="tabular flex h-7 min-w-7 items-center justify-center rounded-full px-2 text-[13px] font-semibold"
                      style={{ background: 'rgb(var(--ink-rgb) / calc(0.07 * var(--veil)))' }}
                      title={`${person.devices.length} device${person.devices.length === 1 ? '' : 's'}`}
                    >
                      {person.devices.length}
                    </span>
                    <span className="flex flex-shrink-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                      {confirming ? (
                        <button type="button" className="btn btn-sm btn-danger" disabled={busy === person.stableUid} onClick={() => void handleRevokePerson(person)}>
                          {busy === person.stableUid ? <Spinner /> : null}
                          Sign out all?
                        </button>
                      ) : (
                        <IconButton icon={LogOut} tone="rose" label={`Sign ${person.username} out everywhere`} onClick={() => void handleRevokePerson(person)} />
                      )}
                    </span>
                    <ChevronDown size={18} strokeWidth={1.6} className={`flex-shrink-0 text-ink-3 transition-transform ${open ? 'rotate-180' : ''}`} />
                  </div>
                  <Collapse open={open}>
                    <div className="pb-5 pl-0 sm:pl-[60px]">
                      <ul className="stack">
                        {person.devices.map((device) => (
                          <DeviceRow
                            key={device.id}
                            device={device}
                            busy={busy === device.id}
                            onRevoke={() => void handleRevokeDevice(person, device)}
                          />
                        ))}
                      </ul>
                      <button
                        type="button"
                        className="btn btn-sm btn-quiet mt-3"
                        aria-expanded={historyOpen.has(person.stableUid)}
                        onClick={() => setHistoryOpen((s) => toggle(s, person.stableUid))}
                      >
                        <History size={15} strokeWidth={1.7} />
                        {historyOpen.has(person.stableUid) ? 'Hide sign-ins' : 'Show sign-ins'}
                      </button>
                      <Collapse open={historyOpen.has(person.stableUid)}>
                        <div className="mt-4">
                          <LoginHistory stableUid={person.stableUid} />
                        </div>
                      </Collapse>
                    </div>
                  </Collapse>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </div>
  );
}
