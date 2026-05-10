import { useState, useRef, useEffect, FormEvent } from 'react';
import { Shield, Terminal, Globe, CheckCircle, ChevronRight, Eye, EyeOff, Loader2, AlertCircle, ExternalLink, SkipForward } from 'lucide-react';
import { setupApi } from '../api';

// ─── Types ────────────────────────────────────────────────────────────────────

type Step = 'welcome' | 'credentials' | 'cloudflare' | 'done';
type LogLine = { type: 'log' | 'error' | 'done'; message: string };

interface SetupPageProps {
  onComplete: () => void;
  initialStatus: {
    cloudflaredInstalled: boolean;
    cloudflareAuthed: boolean;
    tunnelConfigured: boolean;
    tunnelHostname: string | null;
  };
}

// ─── Step indicator ────────────────────────────────────────────────────────────

const STEPS: { id: Step; label: string }[] = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'credentials', label: 'Admin Password' },
  { id: 'cloudflare', label: 'Cloudflare Tunnel' },
  { id: 'done', label: 'Done' },
];

function StepBar({ current }: { current: Step }) {
  const idx = STEPS.findIndex(s => s.id === current);
  return (
    <div className="flex items-center gap-2 mb-8 justify-center">
      {STEPS.map((s, i) => (
        <div key={s.id} className="flex items-center gap-2">
          <div className="flex flex-col items-center gap-1">
            <div
              className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all"
              style={{
                background: i < idx ? '#10b981' : i === idx ? 'rgba(10,132,255,0.9)' : 'rgba(255,255,255,0.06)',
                color: i <= idx ? '#fff' : '#475569',
                border: i === idx ? '2px solid #0a84ff' : '2px solid transparent',
              }}
            >
              {i < idx ? '✓' : i + 1}
            </div>
            <span className="text-xs hidden sm:block" style={{ color: i === idx ? '#a5b4fc' : '#475569' }}>{s.label}</span>
          </div>
          {i < STEPS.length - 1 && (
            <div className="w-8 h-px mb-4" style={{ background: i < idx ? '#10b981' : 'rgba(255,255,255,0.08)' }} />
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Terminal output component ─────────────────────────────────────────────────

function TerminalOutput({ lines }: { lines: LogLine[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines]);

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
          style={{
            color: l.type === 'error' ? '#f87171' : l.type === 'done' ? '#34d399' : 'rgba(235,235,245,0.55)',
          }}
        >
          <span style={{ color: '#4b5563', userSelect: 'none' }}>{'> '}</span>
          {l.message}
        </div>
      ))}
    </div>
  );
}

// ─── Card wrapper ──────────────────────────────────────────────────────────────

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="w-full max-w-lg mx-auto"
      style={{
        background: 'rgba(14,15,28,0.95)',
        backdropFilter: 'blur(20px)',
        border: '1px solid rgba(10,132,255,0.2)',
        borderRadius: '20px',
        padding: '40px',
      }}
    >
      {children}
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────

export function SetupPage({ onComplete, initialStatus }: SetupPageProps) {
  const [step, setStep] = useState<Step>('welcome');
  const [token, setToken] = useState('');
  const [hostname, setHostname] = useState('api.pokyh.com');

  // Credentials step
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [credError, setCredError] = useState('');
  const [credLoading, setCredLoading] = useState(false);

  // Cloudflare step
  const [cfPhase, setCfPhase] = useState<'idle' | 'login' | 'tunnel' | 'done'>('idle');
  const [cfLogs, setCfLogs] = useState<LogLine[]>([]);
  const [cfDone, setCfDone] = useState(false);

  const appendLog = (l: LogLine) => setCfLogs(prev => [...prev, l]);

  // ── Welcome ──────────────────────────────────────────────────────────────────

  if (step === 'welcome') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6" style={{ background: '#000000' }}>
        <div
          className="absolute rounded-full pointer-events-none"
          style={{ width: 600, height: 600, background: 'radial-gradient(circle, rgba(10,132,255,0.07) 0%, transparent 70%)', top: -100, left: -100 }}
        />
        <Card>
          <StepBar current="welcome" />
          <div className="flex flex-col items-center text-center gap-6">
            <div
              className="w-20 h-20 rounded-3xl flex items-center justify-center"
              style={{ background: 'rgba(10,132,255,0.12)', border: '1px solid rgba(10,132,255,0.25)', boxShadow: '0 0 60px rgba(10,132,255,0.12)' }}
            >
              <Shield size={40} className="text-[#0a84ff]" />
            </div>
            <div>
              <h1 className="text-3xl font-bold text-white mb-2">Welcome to Pokyh</h1>
              <p className="text-slate-400">Let's get your backend set up in a few simple steps.</p>
            </div>
            <div className="w-full flex flex-col gap-3 text-left">
              {[
                { icon: <Shield size={16} />, label: 'Create admin credentials' },
                { icon: <Globe size={16} />, label: 'Configure Cloudflare Tunnel (optional)' },
                { icon: <CheckCircle size={16} />, label: 'Your API goes live' },
              ].map((item, i) => (
                <div key={i} className="flex items-center gap-3 px-4 py-3 rounded-xl" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}>
                  <span className="text-[#0a84ff] flex-shrink-0">{item.icon}</span>
                  <span className="text-sm text-slate-300">{item.label}</span>
                </div>
              ))}
            </div>
            <button
              onClick={() => setStep('credentials')}
              className="w-full py-3 px-6 rounded-xl font-semibold text-white flex items-center justify-center gap-2 transition-all"
              style={{ background: 'linear-gradient(135deg, #0a84ff 0%, #0a84ff 100%)', boxShadow: '0 4px 24px rgba(10,132,255,0.3)' }}
            >
              Start Setup <ChevronRight size={18} />
            </button>
          </div>
        </Card>
      </div>
    );
  }

  // ── Credentials ───────────────────────────────────────────────────────────────

  if (step === 'credentials') {
    const handleSubmit = async (e: FormEvent) => {
      e.preventDefault();
      setCredError('');
      if (password !== confirmPassword) { setCredError('Passwords do not match'); return; }
      if (password.length < 8) { setCredError('Password must be at least 8 characters'); return; }
      setCredLoading(true);
      try {
        const t = await setupApi.setPassword(username, password);
        setToken(t);
        setStep('cloudflare');
      } catch (err) {
        setCredError(err instanceof Error ? err.message : 'Failed');
      } finally {
        setCredLoading(false);
      }
    };

    const inputStyle = {
      background: 'rgba(255,255,255,0.04)',
      border: '1px solid rgba(255,255,255,0.08)',
    };
    const inputClass = 'w-full px-4 py-3 rounded-xl text-slate-200 placeholder-slate-600 outline-none transition-all';

    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6" style={{ background: '#000000' }}>
        <Card>
          <StepBar current="credentials" />
          <h2 className="text-2xl font-bold text-white mb-1">Create Admin Account</h2>
          <p className="text-slate-500 text-sm mb-6">This is the account you'll use to log in to the admin panel.</p>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-slate-400 uppercase tracking-wide">Username</label>
              <input
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                className={inputClass}
                style={inputStyle}
                required
                minLength={3}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-slate-400 uppercase tracking-wide">Password</label>
              <div className="relative">
                <input
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className={`${inputClass} pr-12`}
                  style={inputStyle}
                  placeholder="Min. 8 characters"
                  required
                  minLength={8}
                />
                <button type="button" onClick={() => setShowPw(!showPw)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300">
                  {showPw ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-slate-400 uppercase tracking-wide">Confirm Password</label>
              <input
                type={showPw ? 'text' : 'password'}
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                className={inputClass}
                style={inputStyle}
                placeholder="Repeat password"
                required
              />
            </div>
            {credError && (
              <div className="flex items-center gap-2 px-4 py-3 rounded-xl text-sm text-red-400" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}>
                <AlertCircle size={16} className="flex-shrink-0" /> {credError}
              </div>
            )}
            <button
              type="submit"
              disabled={credLoading}
              className="w-full py-3 px-6 rounded-xl font-semibold text-white flex items-center justify-center gap-2 mt-2"
              style={{ background: credLoading ? 'rgba(10,132,255,0.5)' : 'linear-gradient(135deg, #0a84ff 0%, #0a84ff 100%)', cursor: credLoading ? 'not-allowed' : 'pointer', boxShadow: credLoading ? 'none' : '0 4px 24px rgba(10,132,255,0.3)' }}
            >
              {credLoading ? <><Loader2 size={18} className="animate-spin" /> Saving...</> : <>Continue <ChevronRight size={18} /></>}
            </button>
          </form>
        </Card>
      </div>
    );
  }

  // ── Cloudflare ────────────────────────────────────────────────────────────────

  if (step === 'cloudflare') {
    const startLogin = () => {
      setCfPhase('login');
      setCfLogs([]);
      const src = setupApi.loginStream(token);
      src.onmessage = (e: MessageEvent) => {
        const d = JSON.parse(e.data as string) as { type: string; message: string };
        appendLog({ type: d.type as 'log' | 'error' | 'done', message: d.message });
        if (d.type === 'done') { src.close(); setCfPhase('tunnel'); startTunnelSetup(); }
        if (d.type === 'error') { src.close(); setCfPhase('idle'); }
      };
      src.onerror = () => { src.close(); appendLog({ type: 'error', message: 'Connection lost' }); setCfPhase('idle'); };
    };

    const startTunnelSetup = () => {
      setCfPhase('tunnel');
      const src = setupApi.tunnelStream(token, hostname);
      src.onmessage = (e: MessageEvent) => {
        const d = JSON.parse(e.data as string) as { type: string; message: string };
        appendLog({ type: d.type as 'log' | 'error' | 'done', message: d.message });
        if (d.type === 'done') { src.close(); setCfPhase('done'); setCfDone(true); }
        if (d.type === 'error') { src.close(); setCfPhase('idle'); }
      };
      src.onerror = () => { src.close(); appendLog({ type: 'error', message: 'Connection lost' }); setCfPhase('idle'); };
    };

    const isRunning = cfPhase === 'login' || cfPhase === 'tunnel';

    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6" style={{ background: '#000000' }}>
        <Card>
          <StepBar current="cloudflare" />
          <div className="flex items-center gap-3 mb-1">
            <Globe size={20} className="text-[#0a84ff]" />
            <h2 className="text-2xl font-bold text-white">Cloudflare Tunnel</h2>
          </div>
          <p className="text-slate-500 text-sm mb-6">
            Expose your API to the internet securely via Cloudflare Tunnel. This step is optional.
          </p>

          {!initialStatus.cloudflaredInstalled && (
            <div className="px-4 py-3 rounded-xl text-sm mb-4" style={{ background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.2)', color: '#fbbf24' }}>
              <div className="font-semibold mb-1">cloudflared not installed</div>
              <div className="font-mono text-xs opacity-80">brew install cloudflare/cloudflare/cloudflared</div>
              <a href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 mt-1 text-xs opacity-60 hover:opacity-100">
                Docs <ExternalLink size={10} />
              </a>
            </div>
          )}

          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-slate-400 uppercase tracking-wide">Your Domain / Hostname</label>
              <input
                type="text"
                value={hostname}
                onChange={e => setHostname(e.target.value)}
                disabled={isRunning || cfDone}
                className="w-full px-4 py-3 rounded-xl text-slate-200 placeholder-slate-600 outline-none"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}
                placeholder="api.example.com"
              />
            </div>

            {!cfDone ? (
              <button
                onClick={startLogin}
                disabled={isRunning || !hostname}
                className="w-full py-3 px-6 rounded-xl font-semibold text-white flex items-center justify-center gap-2"
                style={{
                  background: isRunning ? 'rgba(10,132,255,0.5)' : 'linear-gradient(135deg, #0a84ff 0%, #0a84ff 100%)',
                  cursor: isRunning || !hostname ? 'not-allowed' : 'pointer',
                  boxShadow: isRunning ? 'none' : '0 4px 24px rgba(10,132,255,0.3)',
                }}
              >
                {isRunning ? (
                  <><Loader2 size={18} className="animate-spin" /> {cfPhase === 'login' ? 'Authenticating...' : 'Setting up tunnel...'}</>
                ) : (
                  <><Globe size={18} /> Connect to Cloudflare</>
                )}
              </button>
            ) : (
              <div className="flex items-center gap-3 px-4 py-3 rounded-xl" style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)' }}>
                <CheckCircle size={18} className="text-emerald-400 flex-shrink-0" />
                <span className="text-sm text-emerald-400 font-medium">Tunnel is live at https://{hostname}</span>
              </div>
            )}

            {cfLogs.length > 0 && (
              <div className="flex items-center gap-2 text-xs text-slate-500 mt-1">
                <Terminal size={12} />
                <span>Live output</span>
              </div>
            )}
            <TerminalOutput lines={cfLogs} />
          </div>

          <div className="flex items-center gap-3 mt-6 pt-6" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
            <button
              onClick={() => setStep('done')}
              disabled={isRunning}
              className="flex items-center gap-2 text-sm text-slate-500 hover:text-slate-300 transition-colors disabled:opacity-40"
            >
              <SkipForward size={16} />
              {cfDone ? 'Continue' : 'Skip for now'}
            </button>
            {cfDone && (
              <button
                onClick={() => setStep('done')}
                className="ml-auto py-2 px-5 rounded-xl font-semibold text-white text-sm flex items-center gap-2"
                style={{ background: 'linear-gradient(135deg, #0a84ff 0%, #0a84ff 100%)', boxShadow: '0 4px 20px rgba(10,132,255,0.3)' }}
              >
                Continue <ChevronRight size={16} />
              </button>
            )}
          </div>
        </Card>
      </div>
    );
  }

  // ── Done ──────────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6" style={{ background: '#000000' }}>
      <Card>
        <StepBar current="done" />
        <div className="flex flex-col items-center text-center gap-6">
          <div
            className="w-20 h-20 rounded-3xl flex items-center justify-center"
            style={{ background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.25)', boxShadow: '0 0 60px rgba(16,185,129,0.1)' }}
          >
            <CheckCircle size={40} className="text-emerald-400" />
          </div>
          <div>
            <h2 className="text-3xl font-bold text-white mb-2">You're all set!</h2>
            <p className="text-slate-400">Pokyh Backend is ready to go.</p>
          </div>
          <div className="w-full flex flex-col gap-2 text-left text-sm">
            <div className="flex items-center gap-3 px-4 py-3 rounded-xl" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}>
              <CheckCircle size={16} className="text-emerald-400 flex-shrink-0" />
              <span className="text-slate-300">Admin account created</span>
            </div>
            {cfDone ? (
              <div className="flex items-center gap-3 px-4 py-3 rounded-xl" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}>
                <CheckCircle size={16} className="text-emerald-400 flex-shrink-0" />
                <span className="text-slate-300">Cloudflare Tunnel active — <span className="text-[#0a84ff]">https://{hostname}</span></span>
              </div>
            ) : (
              <div className="flex items-center gap-3 px-4 py-3 rounded-xl" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}>
                <AlertCircle size={16} className="text-amber-400 flex-shrink-0" />
                <span className="text-slate-400">Cloudflare Tunnel — not configured (run setup again from Settings)</span>
              </div>
            )}
          </div>
          <button
            onClick={onComplete}
            className="w-full py-3 px-6 rounded-xl font-semibold text-white flex items-center justify-center gap-2"
            style={{ background: 'linear-gradient(135deg, #0a84ff 0%, #0a84ff 100%)', boxShadow: '0 4px 24px rgba(10,132,255,0.3)' }}
          >
            Open Admin Dashboard
          </button>
        </div>
      </Card>
    </div>
  );
}
