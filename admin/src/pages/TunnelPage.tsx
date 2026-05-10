import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Globe,
  RefreshCw,
  CheckCircle,
  XCircle,
  Terminal,
  ChevronRight,
  Copy,
  Loader2,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { setupApi } from '../api';
import { useToast } from '../components/Toast';
import type { SetupStatus } from '../types';

type LogLine = { type: 'log' | 'error' | 'done'; message: string };

function TerminalOutput({ lines, scrollRef }: { lines: LogLine[]; scrollRef?: React.RefObject<HTMLDivElement | null> }) {
  const innerRef = useRef<HTMLDivElement>(null);
  const ref = scrollRef ?? innerRef;
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines, ref]);

  if (lines.length === 0) return null;
  return (
    <div
      ref={ref}
      className="rounded-xl p-4 font-mono text-xs overflow-y-auto max-h-52 mt-4"
      style={{ background: '#05060f', border: '1px solid rgba(10,132,255,0.15)' }}
    >
      {lines.map((l, i) => (
        <div
          key={i}
          className="leading-relaxed whitespace-pre-wrap break-words"
          style={{ color: l.type === 'error' ? '#f87171' : l.type === 'done' ? '#34d399' : 'rgba(235,235,245,0.55)' }}
        >
          <span style={{ color: '#4b5563', userSelect: 'none' }}>{'> '}</span>
          {l.message}
        </div>
      ))}
    </div>
  );
}

function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2">
      {ok
        ? <CheckCircle size={15} style={{ color: '#30d158' }} />
        : <XCircle size={15} style={{ color: '#ff453a' }} />}
      <span className="text-sm" style={{ color: ok ? '#30d158' : '#ff453a' }}>{label}</span>
    </div>
  );
}

function CopyBox({ text }: { text: string }) {
  const { showToast } = useToast();
  return (
    <div
      className="flex items-center gap-3 px-4 py-3 rounded-xl font-mono text-sm mt-3"
      style={{ background: '#05060f', border: '1px solid rgba(255,255,255,0.08)' }}
    >
      <span style={{ color: '#0a84ff', flex: 1 }}>{text}</span>
      <button
        onClick={() => { void navigator.clipboard.writeText(text); showToast('Copied!', 'success'); }}
        className="p-1 rounded"
        title="Copy"
        style={{ color: 'rgba(235,235,245,0.3)' }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#0a84ff'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'rgba(235,235,245,0.3)'; }}
      >
        <Copy size={14} />
      </button>
    </div>
  );
}

export function TunnelPage() {
  const { showToast } = useToast();
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Login step state
  const [loginRunning, setLoginRunning] = useState(false);
  const [loginLines, setLoginLines] = useState<LogLine[]>([]);
  const loginEsRef = useRef<EventSource | null>(null);

  // Tunnel step state
  const [hostname, setHostname] = useState('');
  const [tunnelRunning, setTunnelRunning] = useState(false);
  const [tunnelLines, setTunnelLines] = useState<LogLine[]>([]);
  const tunnelEsRef = useRef<EventSource | null>(null);

  const fetchStatus = useCallback(async (silent = false) => {
    if (!silent) setLoadingStatus(true);
    try {
      const s = await setupApi.status();
      setStatus(s);
      if (s.tunnelHostname) setHostname(s.tunnelHostname);
    } catch {
      if (!silent) showToast('Failed to load status', 'error');
    } finally {
      setLoadingStatus(false);
    }
  }, [showToast]);

  useEffect(() => { void fetchStatus(); }, [fetchStatus]);

  async function handleRefresh() {
    setRefreshing(true);
    await fetchStatus(true);
    setRefreshing(false);
  }

  function startLogin() {
    if (loginRunning) return;
    setLoginLines([]);
    setLoginRunning(true);
    const token = setupApi.getToken() ?? '';
    const es = setupApi.loginStream(token);
    loginEsRef.current = es;

    es.onmessage = (ev) => {
      try {
        const d = JSON.parse(ev.data as string) as { type: string; message: string };
        setLoginLines(prev => [...prev, { type: d.type as LogLine['type'], message: d.message }]);
        if (d.type === 'done' || d.type === 'error') {
          setLoginRunning(false);
          es.close();
          void fetchStatus(true);
        }
      } catch { /* ignore */ }
    };
    es.onerror = () => {
      setLoginLines(prev => [...prev, { type: 'error', message: 'Connection lost' }]);
      setLoginRunning(false);
      es.close();
    };
  }

  function startTunnel() {
    if (tunnelRunning || !hostname.trim()) return;
    setTunnelLines([]);
    setTunnelRunning(true);
    const token = setupApi.getToken() ?? '';
    const es = setupApi.tunnelStream(token, hostname.trim());
    tunnelEsRef.current = es;

    es.onmessage = (ev) => {
      try {
        const d = JSON.parse(ev.data as string) as { type: string; message: string };
        setTunnelLines(prev => [...prev, { type: d.type as LogLine['type'], message: d.message }]);
        if (d.type === 'done' || d.type === 'error') {
          setTunnelRunning(false);
          es.close();
          void fetchStatus(true);
        }
      } catch { /* ignore */ }
    };
    es.onerror = () => {
      setTunnelLines(prev => [...prev, { type: 'error', message: 'Connection lost' }]);
      setTunnelRunning(false);
      es.close();
    };
  }

  useEffect(() => () => {
    loginEsRef.current?.close();
    tunnelEsRef.current?.close();
  }, []);

  const card = {
    background: '#1c1c1e',
    border: '1px solid rgba(255,255,255,0.07)',
    borderRadius: '16px',
    padding: '24px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.4), 0 8px 24px rgba(0,0,0,0.2)',
  } as const;

  const btnPrimary = {
    background: 'rgba(10,132,255,0.9)',
    color: '#fff',
    border: 'none',
    borderRadius: '8px',
    padding: '10px 20px',
    fontSize: '14px',
    fontWeight: 600,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  } as const;

  const btnSecondary = {
    background: 'rgba(255,255,255,0.06)',
    color: 'rgba(235,235,245,0.6)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: '8px',
    padding: '10px 20px',
    fontSize: '14px',
    fontWeight: 500,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  } as const;

  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{ background: 'rgba(10,132,255,0.15)', border: '1px solid rgba(10,132,255,0.2)' }}
          >
            <Globe size={20} style={{ color: '#0a84ff' }} />
          </div>
          <div>
            <h1 className="text-xl font-bold" style={{ color: '#ffffff' }}>Cloudflare Tunnel</h1>
            <p className="text-sm mt-0.5" style={{ color: 'rgba(235,235,245,0.6)' }}>Expose your server to the internet securely</p>
          </div>
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          style={btnSecondary}
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {/* Status overview */}
      <div style={card}>
        <h2 className="text-sm font-semibold uppercase tracking-wider mb-4" style={{ color: 'rgba(235,235,245,0.3)' }}>Current Status</h2>
        {loadingStatus ? (
          <div className="flex items-center gap-2" style={{ color: 'rgba(235,235,245,0.3)' }}>
            <Loader2 size={14} className="animate-spin" />
            <span className="text-sm">Loading...</span>
          </div>
        ) : status ? (
          <div className="flex flex-col gap-3">
            <StatusBadge ok={!!status.cloudflaredInstalled} label={status.cloudflaredInstalled ? 'cloudflared installed' : 'cloudflared not installed'} />
            <StatusBadge ok={!!status.cloudflareAuthed} label={status.cloudflareAuthed ? 'Authenticated with Cloudflare' : 'Not authenticated with Cloudflare'} />
            <StatusBadge ok={!!status.tunnelConfigured} label={status.tunnelConfigured ? `Tunnel configured` : 'Tunnel not configured'} />
            {status.tunnelHostname && (
              <div className="flex items-center gap-2 mt-1 pt-3" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                <Wifi size={15} style={{ color: '#30d158' }} />
                <span className="text-sm font-mono" style={{ color: '#30d158' }}>
                  https://{status.tunnelHostname}
                </span>
              </div>
            )}
            {status.tunnelConfigured && !status.tunnelHostname && (
              <div className="flex items-center gap-2 mt-1">
                <WifiOff size={15} style={{ color: '#ffd60a' }} />
                <span className="text-sm" style={{ color: '#ffd60a' }}>Tunnel configured but hostname unknown</span>
              </div>
            )}
          </div>
        ) : (
          <span className="text-sm" style={{ color: '#ff453a' }}>Failed to load status</span>
        )}
      </div>

      {/* Step 1: Install cloudflared */}
      <div style={card}>
        <div className="flex items-center gap-3 mb-4">
          <div
            className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
            style={{
              background: status?.cloudflaredInstalled ? 'rgba(48,209,88,0.2)' : 'rgba(10,132,255,0.2)',
              color: status?.cloudflaredInstalled ? '#30d158' : '#0a84ff',
              border: `1px solid ${status?.cloudflaredInstalled ? 'rgba(48,209,88,0.3)' : 'rgba(10,132,255,0.3)'}`,
            }}
          >
            {status?.cloudflaredInstalled ? '✓' : '1'}
          </div>
          <h2 className="text-base font-semibold" style={{ color: '#ffffff' }}>Install cloudflared</h2>
        </div>
        {status?.cloudflaredInstalled ? (
          <p className="text-sm" style={{ color: '#30d158' }}>cloudflared is installed and ready.</p>
        ) : (
          <>
            <p className="text-sm mb-3" style={{ color: 'rgba(235,235,245,0.6)' }}>
              Install cloudflared using Homebrew (macOS) or your system's package manager:
            </p>
            <CopyBox text="brew install cloudflare/cloudflare/cloudflared" />
            <p className="text-xs mt-3" style={{ color: 'rgba(235,235,245,0.3)' }}>
              After installing, click Refresh above to update the status.
            </p>
          </>
        )}
      </div>

      {/* Step 2: Cloudflare login */}
      <div style={{ ...card, opacity: status?.cloudflaredInstalled ? 1 : 0.5, pointerEvents: status?.cloudflaredInstalled ? 'auto' : 'none' }}>
        <div className="flex items-center gap-3 mb-4">
          <div
            className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
            style={{
              background: status?.cloudflareAuthed ? 'rgba(48,209,88,0.2)' : 'rgba(10,132,255,0.2)',
              color: status?.cloudflareAuthed ? '#30d158' : '#0a84ff',
              border: `1px solid ${status?.cloudflareAuthed ? 'rgba(48,209,88,0.3)' : 'rgba(10,132,255,0.3)'}`,
            }}
          >
            {status?.cloudflareAuthed ? '✓' : '2'}
          </div>
          <h2 className="text-base font-semibold" style={{ color: '#ffffff' }}>Connect to Cloudflare</h2>
        </div>
        {status?.cloudflareAuthed ? (
          <p className="text-sm" style={{ color: '#30d158' }}>Already authenticated with your Cloudflare account.</p>
        ) : (
          <>
            <p className="text-sm mb-4" style={{ color: 'rgba(235,235,245,0.6)' }}>
              Opens a browser window where you'll authorize this server to manage your Cloudflare tunnels.
            </p>
            <button
              onClick={startLogin}
              disabled={loginRunning}
              style={btnPrimary}
            >
              {loginRunning ? <Loader2 size={14} className="animate-spin" /> : <Terminal size={14} />}
              {loginRunning ? 'Waiting for authorization...' : 'Connect to Cloudflare'}
            </button>
          </>
        )}
        <TerminalOutput lines={loginLines} />
      </div>

      {/* Step 3: Create tunnel */}
      <div style={{ ...card, opacity: status?.cloudflareAuthed ? 1 : 0.5, pointerEvents: status?.cloudflareAuthed ? 'auto' : 'none' }}>
        <div className="flex items-center gap-3 mb-4">
          <div
            className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
            style={{
              background: status?.tunnelConfigured ? 'rgba(48,209,88,0.2)' : 'rgba(10,132,255,0.2)',
              color: status?.tunnelConfigured ? '#30d158' : '#0a84ff',
              border: `1px solid ${status?.tunnelConfigured ? 'rgba(48,209,88,0.3)' : 'rgba(10,132,255,0.3)'}`,
            }}
          >
            {status?.tunnelConfigured ? '✓' : '3'}
          </div>
          <h2 className="text-base font-semibold" style={{ color: '#ffffff' }}>
            {status?.tunnelConfigured ? 'Tunnel configured' : 'Create tunnel'}
          </h2>
        </div>

        {status?.tunnelConfigured && !tunnelLines.length ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm" style={{ color: '#30d158' }}>
              Tunnel is active at{' '}
              <span className="font-mono">{status.tunnelHostname ? `https://${status.tunnelHostname}` : 'configured hostname'}</span>
            </p>
            <p className="text-xs" style={{ color: 'rgba(235,235,245,0.3)' }}>
              You can reconfigure the tunnel by entering a new hostname and clicking the button below.
            </p>
          </div>
        ) : null}

        <div className="flex flex-col gap-3 mt-3">
          <div>
            <label className="text-xs font-medium block mb-1.5" style={{ color: 'rgba(235,235,245,0.6)' }}>
              Hostname (e.g. api.yourdomain.com)
            </label>
            <input
              type="text"
              value={hostname}
              onChange={(e) => setHostname(e.target.value)}
              placeholder="api.yourdomain.com"
              className="w-full py-2.5 px-3 rounded-lg text-sm outline-none"
              style={{
                background: '#1c1c1e',
                border: '1px solid rgba(255,255,255,0.08)',
                color: '#ffffff',
              }}
              onFocus={(e) => { (e.target as HTMLElement).style.borderColor = 'rgba(10,132,255,0.5)'; }}
              onBlur={(e) => { (e.target as HTMLElement).style.borderColor = 'rgba(255,255,255,0.08)'; }}
            />
          </div>
          <div className="flex items-start gap-3">
            <button
              onClick={startTunnel}
              disabled={tunnelRunning || !hostname.trim()}
              style={{
                ...btnPrimary,
                opacity: tunnelRunning || !hostname.trim() ? 0.5 : 1,
                cursor: tunnelRunning || !hostname.trim() ? 'not-allowed' : 'pointer',
              }}
            >
              {tunnelRunning ? <Loader2 size={14} className="animate-spin" /> : <ChevronRight size={14} />}
              {tunnelRunning ? 'Setting up...' : status?.tunnelConfigured ? 'Reconfigure tunnel' : 'Create & start tunnel'}
            </button>
          </div>
          <p className="text-xs" style={{ color: 'rgba(235,235,245,0.3)' }}>
            This will create the tunnel, configure DNS, and start routing traffic automatically. Your domain must be on Cloudflare.
          </p>
        </div>

        <TerminalOutput lines={tunnelLines} />
      </div>
    </div>
  );
}
