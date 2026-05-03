import { useEffect, useState, useCallback } from 'react';
import { Activity, RefreshCw, XCircle, Loader2 } from 'lucide-react';
import { adminApi } from '../api';
import { useToast } from '../components/Toast';
import { useAutoRefresh } from '../hooks/useAutoRefresh';
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

const STATUS_STYLE: Record<SessionStatus, { bg: string; color: string; border: string; label: string }> = {
  active:  { bg: 'rgba(48,209,88,0.15)',  color: '#30d158', border: 'rgba(48,209,88,0.25)',  label: 'Active'  },
  expired: { bg: 'rgba(255,214,10,0.12)', color: '#ffd60a', border: 'rgba(255,214,10,0.2)',  label: 'Expired' },
  revoked: { bg: 'rgba(255,69,58,0.12)',  color: '#ff453a', border: 'rgba(255,69,58,0.2)',   label: 'Revoked' },
};

export function SessionsPage() {
  const { showToast } = useToast();
  const [sessions, setSessions] = useState<AdminSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState<string | null>(null);
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

  // Only show active sessions + non-active ones that aren't fading (fetched from DB)
  const visibleSessions = sessions.filter((s) => s.isActive || !fadingOut.has(s.id) || fadingOut.has(s.id));
  const activeSessions = sessions.filter((s) => s.isActive).length;

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: '#f0f0f5' }}>Sessions</h1>
          <p className="text-sm mt-1" style={{ color: '#8b8b9b' }}>
            Active refresh token sessions — revoke to force logout immediately
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
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.05)'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '#111116'; }}
        >
          <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {/* Stats */}
      <div className="flex items-center gap-4 flex-wrap">
        <div
          className="flex items-center gap-3 px-4 py-3 rounded-xl"
          style={{ background: '#111116', border: '1px solid rgba(255,255,255,0.07)' }}
        >
          <Activity size={16} style={{ color: '#30d158' }} />
          <span className="text-sm" style={{ color: '#8b8b9b' }}>
            <span className="font-semibold" style={{ color: '#f0f0f5' }}>{activeSessions}</span>
            {' '}active session{activeSessions !== 1 ? 's' : ''}
          </span>
        </div>
        <div className="text-xs" style={{ color: '#4a4a5e' }}>
          Auto-refreshes every 10s · Revoked sessions disappear automatically
        </div>
      </div>

      {/* Table */}
      <div
        className="rounded-2xl overflow-hidden"
        style={{
          background: '#111116',
          border: '1px solid rgba(255,255,255,0.07)',
          boxShadow: '0 1px 3px rgba(0,0,0,0.4), 0 8px 24px rgba(0,0,0,0.2)',
        }}
      >
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                {[
                  { label: 'User', cls: '' },
                  { label: 'Created', cls: 'hidden md:table-cell' },
                  { label: 'Expires', cls: 'hidden md:table-cell' },
                  { label: 'Status', cls: '' },
                  { label: 'Action', cls: '' },
                ].map(({ label, cls }) => (
                  <th
                    key={label}
                    className={`px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider ${cls}`}
                    style={{ color: '#4a4a5e' }}
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                    {[
                      { cls: '' },
                      { cls: 'hidden md:table-cell' },
                      { cls: 'hidden md:table-cell' },
                      { cls: '' },
                      { cls: '' },
                    ].map((col, j) => (
                      <td key={j} className={`px-4 py-4 ${col.cls}`}>
                        <div className="h-4 rounded animate-pulse" style={{ background: 'rgba(255,255,255,0.05)', width: '90px' }} />
                      </td>
                    ))}
                  </tr>
                ))
              ) : visibleSessions.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-sm" style={{ color: '#4a4a5e' }}>
                    No sessions found
                  </td>
                </tr>
              ) : (
                visibleSessions.map((session) => {
                  const status = getStatus(session);
                  const style = STATUS_STYLE[status];
                  const isFading = fadingOut.has(session.id);

                  return (
                    <tr
                      key={session.id}
                      style={{
                        borderBottom: '1px solid rgba(255,255,255,0.04)',
                        background: session.isActive ? 'rgba(48,209,88,0.02)' : undefined,
                        opacity: isFading ? 0 : 1,
                        transform: isFading ? 'translateX(20px)' : 'translateX(0)',
                        transition: isFading ? 'opacity 0.6s ease, transform 0.6s ease' : 'background 0.15s',
                        pointerEvents: isFading ? 'none' : undefined,
                      }}
                      onMouseEnter={(e) => { if (!isFading) (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.02)'; }}
                      onMouseLeave={(e) => { if (!isFading) (e.currentTarget as HTMLElement).style.background = session.isActive ? 'rgba(48,209,88,0.02)' : ''; }}
                    >
                      {/* User */}
                      <td className="px-4 py-3.5">
                        <div className="text-sm font-medium" style={{ color: '#f0f0f5' }}>{session.username}</div>
                        <div className="text-xs font-mono mt-0.5" style={{ color: '#4a4a5e' }}>{session.stableUid.slice(0, 10)}…</div>
                      </td>

                      {/* Created */}
                      <td className="px-4 py-3.5 hidden md:table-cell">
                        <div className="text-sm" style={{ color: '#8b8b9b' }}>{formatDate(session.createdAt)}</div>
                        <div className="text-xs mt-0.5" style={{ color: '#4a4a5e' }}>{relativeTime(session.createdAt)}</div>
                      </td>

                      {/* Expires */}
                      <td className="px-4 py-3.5 hidden md:table-cell">
                        <span className="text-sm" style={{ color: '#8b8b9b' }}>{formatDate(session.expiresAt)}</span>
                      </td>

                      {/* Status */}
                      <td className="px-4 py-3.5">
                        <span
                          className="text-xs px-2 py-1 rounded-full font-medium"
                          style={{
                            background: style.bg,
                            color: style.color,
                            border: `1px solid ${style.border}`,
                          }}
                        >
                          {isFading ? 'Logging out…' : style.label}
                        </span>
                      </td>

                      {/* Action */}
                      <td className="px-4 py-3.5">
                        {session.isActive && !isFading ? (
                          <button
                            onClick={() => void handleRevoke(session)}
                            disabled={revoking === session.id}
                            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-all font-medium"
                            style={{
                              background: 'transparent',
                              color: '#ff453a',
                              border: '1px solid rgba(255,69,58,0.25)',
                            }}
                            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,69,58,0.08)'; }}
                            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                          >
                            {revoking === session.id
                              ? <Loader2 size={12} className="animate-spin" />
                              : <XCircle size={12} />
                            }
                            {revoking === session.id ? 'Revoking…' : 'Revoke'}
                          </button>
                        ) : (
                          <span className="text-xs" style={{ color: '#4a4a5e' }}>—</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
