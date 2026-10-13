import { useEffect, useState, useCallback } from 'react';
import { Activity, RefreshCw, LogOut, Trash2, MonitorSmartphone, TimerReset, ShieldX } from 'lucide-react';
import { adminApi } from '../api';
import { useToast } from '../components/Toast';
import { useAutoRefresh } from '../hooks/useAutoRefresh';
import { useLive } from '../live';
import { Avatar, Delta, Dialog, Empty, Figures, IconButton, PageHeader, Section, Spinner, Status, type Tone } from '../components/kit';
import { Bars, SplitBar } from '../components/charts';
import type { AdminSession } from '../types';

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

type SessionStatus = 'active' | 'expired' | 'revoked';

function getStatus(session: AdminSession): SessionStatus {
  if (session.revokedAt) return 'revoked';
  if (new Date(session.expiresAt) < new Date()) return 'expired';
  return 'active';
}

const STATUS: Record<SessionStatus, { tone: Tone; label: string }> = {
  active:  { tone: 'mint',  label: 'Active' },
  expired: { tone: 'amber', label: 'Expired' },
  revoked: { tone: 'rose',  label: 'Revoked' },
};

const WEEK = 7 * 86400000;

export function SessionsPage() {
  const { showToast } = useToast();
  const [sessions, setSessions] = useState<AdminSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [clearingAll, setClearingAll] = useState(false);
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const [deletingInactive, setDeletingInactive] = useState(false);
  // IDs currently fading out (just revoked)
  const [fadingOut, setFadingOut] = useState<Set<string>>(new Set());

  const fetchSessions = useCallback(async () => {
    try {
      const data = await adminApi.sessions();
      // Don't re-add sessions that are currently fading out
      setSessions((prev) => {
        const fading = new Set(prev.filter((s) => s.revokedAt && !data.find((d) => d.id === s.id)).map((s) => s.id));
        if (fading.size === 0) return data;
        // Keep fading ones in their current state, merge rest
        const fadingMap = new Map(prev.filter((s) => fading.has(s.id)).map((s) => [s.id, s]));
        const merged = data.filter((s) => !fading.has(s.id));
        return [...merged, ...Array.from(fadingMap.values())];
      });
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to load sessions', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { void fetchSessions(); }, [fetchSessions]);

  const { refresh, refreshing } = useAutoRefresh(fetchSessions, 10000);
  useLive(['sessions', 'users'], () => { void fetchSessions(); });

  async function handleDeleteInactive() {
    setDeletingInactive(true);
    try {
      await adminApi.deleteInactiveSessions();
      showToast('Old sessions deleted', 'success');
      await fetchSessions();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to delete sessions', 'error');
    } finally {
      setDeletingInactive(false);
    }
  }

  async function handleClearAll() {
    setClearingAll(true);
    try {
      await adminApi.revokeAllSessions();
      showToast('All sessions cleared', 'success');
      setConfirmClearAll(false);
      await fetchSessions();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to clear sessions', 'error');
    } finally {
      setClearingAll(false);
    }
  }

  async function handleRevoke(session: AdminSession) {
    setRevoking(session.id);
    try {
      await adminApi.revokeSession(session.id);
      showToast(`${session.username} has been logged out`, 'success');

      // Mark as revoked instantly in the list
      setSessions((prev) =>
        prev.map((s) =>
          s.id === session.id
            ? { ...s, revokedAt: new Date().toISOString(), isActive: false }
            : s
        )
      );

      // Start fade-out animation, then remove from list after 3s
      setFadingOut((prev) => new Set([...prev, session.id]));
      setTimeout(() => {
        setSessions((prev) => prev.filter((s) => s.id !== session.id));
        setFadingOut((prev) => { const n = new Set(prev); n.delete(session.id); return n; });
      }, 3000);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to revoke session', 'error');
    } finally {
      setRevoking(null);
    }
  }

  const counts = { active: 0, expired: 0, revoked: 0 };
  for (const s of sessions) counts[getStatus(s)] += 1;
  const activeSessions = sessions.filter((s) => s.isActive).length;
  const expiringSoon = sessions.filter((s) => s.isActive && new Date(s.expiresAt).getTime() - Date.now() < WEEK).length;
  const signedInUsers = new Set(sessions.filter((s) => s.isActive).map((s) => s.stableUid)).size;

  // Sign-ins per day over the last two weeks, from the sessions' creation dates.
  const days = Array.from({ length: 14 }, (_, i) => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - (13 - i));
    return d;
  });
  const perDay = days.map((day) => sessions.filter((s) => new Date(s.createdAt).toDateString() === day.toDateString()).length);

  return (
    <div>
      {confirmClearAll && (
        <Dialog
          title="Sign everyone out?"
          subtitle={`This revokes all ${activeSessions} active session${activeSessions !== 1 ? 's' : ''}. Every user has to log in again.`}
          onClose={() => { if (!clearingAll) setConfirmClearAll(false); }}
        >
          <div className="flex gap-3">
            <button type="button" className="btn btn-quiet flex-1" disabled={clearingAll} onClick={() => setConfirmClearAll(false)}>Cancel</button>
            <button type="button" className="btn btn-danger flex-1" disabled={clearingAll} onClick={() => void handleClearAll()}>
              {clearingAll ? <Spinner /> : <ShieldX size={16} strokeWidth={1.7} />}
              Revoke all
            </button>
          </div>
        </Dialog>
      )}

      <PageHeader title="Sessions" subtitle="Active refresh token sessions — revoke one to force a logout immediately.">
        <IconButton icon={RefreshCw} label="Refresh" size={42} busy={refreshing} onClick={() => void refresh()} />
        <button type="button" className="btn btn-quiet" disabled={deletingInactive} onClick={() => void handleDeleteInactive()}>
          {deletingInactive ? <Spinner /> : <Trash2 size={16} strokeWidth={1.7} />}
          Delete old
        </button>
        <button type="button" className="btn btn-danger" disabled={clearingAll || activeSessions === 0} onClick={() => setConfirmClearAll(true)}>
          <ShieldX size={16} strokeWidth={1.7} />
          Clear all
        </button>
      </PageHeader>

      <Figures
        className="mt-10"
        items={[
          { label: 'Active sessions', value: activeSessions, icon: Activity, note: <Delta>live</Delta> },
          { label: 'Signed-in users', value: signedInUsers, icon: MonitorSmartphone },
          {
            label: 'Expiring in 7 days',
            value: expiringSoon,
            icon: TimerReset,
            note: expiringSoon > 0 ? <Delta tone="amber">renew on next use</Delta> : undefined,
          },
        ]}
      />

      <div className="mt-[46px] grid gap-x-16 gap-y-12 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <Section title="Sign-ins" meta="Last 14 days">
          <div className="mt-8">
            <Bars
              values={perDay}
              labels={days.map((d) => String(d.getDate()).padStart(2, '0'))}
              titles={days.map((d) => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }))}
              unit="sessions"
              tickEvery={2}
              ariaLabel="Sessions created per day over the last 14 days"
            />
          </div>
        </Section>
        <Section title="Status">
          <div className="mt-9">
            <SplitBar
              ariaLabel="Sessions by status"
              parts={[
                { label: 'Active',  value: counts.active,  color: 'var(--mint)' },
                { label: 'Expired', value: counts.expired, color: 'var(--amber)' },
                { label: 'Revoked', value: counts.revoked, color: 'var(--rose)' },
              ]}
            />
          </div>
        </Section>
      </div>

      <Section className="mt-[52px]" title="All sessions" meta="Refreshes every 10 s">
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
        ) : sessions.length === 0 ? (
          <Empty icon={MonitorSmartphone}>No sessions yet.</Empty>
        ) : (
          <div className="tbl-scroll mt-7">
            <table className="tbl">
              <thead>
                <tr>
                  <th>User</th>
                  <th className="hidden sm:table-cell">Created</th>
                  <th className="hidden md:table-cell">Expires</th>
                  <th>Status</th>
                  <th><span className="sr-only">Action</span></th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((session) => {
                  const status = STATUS[getStatus(session)];
                  const isFading = fadingOut.has(session.id);
                  return (
                    <tr key={session.id} style={{ opacity: isFading ? 0 : 1, transition: 'opacity 0.6s ease' }}>
                      <td>
                        <div className="flex items-center gap-4">
                          <Avatar name={session.username} size={44} />
                          <div className="min-w-0">
                            <div className="truncate font-medium">{session.username}</div>
                            <div className="truncate font-mono text-[11.5px] text-ink-3">{session.stableUid.slice(0, 10)}…</div>
                          </div>
                        </div>
                      </td>
                      <td className="hidden sm:table-cell">
                        <div className="whitespace-nowrap text-ink-2">{formatDate(session.createdAt)}</div>
                        <div className="mt-0.5 text-[12.5px] text-ink-3">{relativeTime(session.createdAt)}</div>
                      </td>
                      <td className="hidden whitespace-nowrap text-ink-2 md:table-cell">{formatDate(session.expiresAt)}</td>
                      <td><Status tone={status.tone}>{status.label}</Status></td>
                      <td>
                        <div className="row-actions">
                          {session.isActive && !isFading && (
                            <IconButton
                              icon={LogOut}
                              tone="rose"
                              label={`Revoke session of ${session.username}`}
                              busy={revoking === session.id}
                              onClick={() => void handleRevoke(session)}
                            />
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}
