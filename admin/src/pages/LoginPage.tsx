import { useLayoutEffect, useRef, useState, FormEvent } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import gsap from 'gsap';
import { useAuth } from '../hooks/useAuth';
import { prefersReducedMotion } from '../motion';
import { Wordmark } from '../components/Layout';

export function LoginPage() {
  const { login, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const sheetRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!sheetRef.current || prefersReducedMotion()) return;
    const ctx = gsap.context(() => {
      gsap.timeline({ defaults: { ease: 'power3.out' } })
        .from(sheetRef.current, { y: 36, autoAlpha: 0, duration: 0.9 })
        // The mark assembles: its four pieces fly out from the centre.
        .from('svg[aria-hidden] > *', { scale: 0, transformOrigin: '50% 50%', duration: 0.8, ease: 'back.out(2.2)', stagger: 0.07 }, 0.25)
        .from('[data-rise]', { y: 18, autoAlpha: 0, duration: 0.7, stagger: 0.07 }, 0.3);
    }, sheetRef);
    return () => ctx.revert();
  }, []);

  if (isAuthenticated) return <Navigate to="/dashboard" replace />;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(username, password);
      navigate('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Anmeldung fehlgeschlagen');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas p-4">
      <div
        ref={sheetRef}
        className="w-full max-w-[440px] rounded-sheet bg-sheet px-7 pb-10 pt-9 sm:px-11 sm:pb-12 sm:pt-11"
        style={{ boxShadow: 'var(--sheet-shadow)' }}
      >
        <Wordmark />

        <h1 data-rise className="mt-11 text-[28px] font-semibold leading-tight">Willkommen zurück</h1>
        <p data-rise className="mt-2 text-[15px] text-ink-3">Melde dich in deinem Panel an.</p>

        <form onSubmit={(e) => void handleSubmit(e)} className="mt-9 flex flex-col gap-5">
          <div data-rise className="flex flex-col gap-2">
            <label htmlFor="login-username" className="text-[13px] text-ink-2">Benutzername</label>
            <input
              id="login-username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="admin"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              className="field h-[52px] w-full px-[18px] text-[15px]"
            />
          </div>

          <div data-rise className="flex flex-col gap-2">
            <label htmlFor="login-password" className="text-[13px] text-ink-2">Passwort</label>
            <div className="relative">
              <input
                id="login-password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
                required
                className="field h-[52px] w-full pl-[18px] pr-14 text-[15px]"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? 'Passwort verbergen' : 'Passwort anzeigen'}
                aria-pressed={showPassword}
                className="absolute right-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full text-ink-3 transition-colors hover:text-ink"
              >
                {showPassword ? <EyeOff size={17} strokeWidth={1.7} /> : <Eye size={17} strokeWidth={1.7} />}
              </button>
            </div>
          </div>

          {error && (
            <div role="alert" className="animate-fadeInUp rounded-[14px] bg-rose-wash px-[18px] py-3 text-[13.5px] text-rose-deep">
              {error}
            </div>
          )}

          <button
            data-rise
            type="submit"
            disabled={loading}
            className="btn-primary mt-2 flex h-[52px] w-full items-center justify-center gap-2 text-[15px]"
          >
            {loading ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                Anmelden…
              </>
            ) : (
              'Anmelden'
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
