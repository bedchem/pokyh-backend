import { useLayoutEffect, useRef, useState, FormEvent } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { ArrowLeft, Eye, EyeOff, KeyRound, Loader2 } from 'lucide-react';
import gsap from 'gsap';
import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';
import { adminApi } from '../api';
import { useAuth } from '../hooks/useAuth';
import { prefersReducedMotion } from '../motion';
import { Wordmark } from '../components/Layout';
import type { SecondFactorChallenge } from '../types';

// The browser's own message for a cancelled or timed-out passkey prompt is
// technical English; a cancel is not an error worth explaining.
export function passkeyErrorMessage(err: unknown): string {
  if (err instanceof Error && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
    return 'Passkey-Abfrage abgebrochen';
  }
  return err instanceof Error ? err.message : 'Passkey fehlgeschlagen';
}

export function LoginPage() {
  const { login, acceptToken, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  const [error, setError] = useState('');
  const [challenge, setChallenge] = useState<SecondFactorChallenge | null>(null);
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const passkeysSupported = browserSupportsWebAuthn();

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

  function finish(token: string) {
    acceptToken(token);
    navigate('/dashboard');
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await login(username, password);
      if ('token' in result) {
        navigate('/dashboard');
      } else {
        setPassword('');
        setCode('');
        setUseRecovery(!result.methods.totp);
        setChallenge(result);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Anmeldung fehlgeschlagen');
    } finally {
      setLoading(false);
    }
  }

  async function handleCode(e: FormEvent) {
    e.preventDefault();
    if (!challenge) return;
    setError('');
    setLoading(true);
    try {
      finish(await adminApi.loginWithCode(challenge.ticket, code));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Anmeldung fehlgeschlagen');
    } finally {
      setLoading(false);
    }
  }

  // Without a ticket: the passkey alone signs in. With one: it is the
  // second factor after the password.
  async function handlePasskey() {
    setError('');
    setPasskeyLoading(true);
    try {
      if (challenge) {
        const { options, challengeToken } = await adminApi.secondFactorPasskeyOptions(challenge.ticket);
        const response = await startAuthentication({ optionsJSON: options });
        finish(await adminApi.loginWithSecondFactorPasskey(challenge.ticket, challengeToken, response));
      } else {
        const { options, challengeToken } = await adminApi.passkeyLoginOptions();
        const response = await startAuthentication({ optionsJSON: options });
        finish(await adminApi.loginWithPasskey(challengeToken, response));
      }
    } catch (err) {
      setError(passkeyErrorMessage(err));
    } finally {
      setPasskeyLoading(false);
    }
  }

  function backToPassword() {
    setChallenge(null);
    setCode('');
    setError('');
  }

  const errorBox = error && (
    <div role="alert" className="animate-fadeInUp rounded-[14px] bg-rose-wash px-[18px] py-3 text-[13.5px] text-rose-deep">
      {error}
    </div>
  );

  if (challenge) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas p-4">
        <div
          className="w-full max-w-[440px] rounded-sheet bg-sheet px-7 pb-10 pt-9 sm:px-11 sm:pb-12 sm:pt-11"
          style={{ boxShadow: 'var(--sheet-shadow)' }}
        >
          <Wordmark />

          <h1 className="mt-11 text-[28px] font-semibold leading-tight">Bestätigen</h1>
          <p className="mt-2 text-[15px] text-ink-3">
            {challenge.methods.totp && challenge.methods.passkey
              ? 'Gib den Code aus deiner Authenticator-App ein oder nutze deinen Passkey.'
              : challenge.methods.totp
                ? 'Gib den Code aus deiner Authenticator-App ein.'
                : 'Bestätige die Anmeldung mit deinem Passkey.'}
          </p>

          <div className="mt-9 flex flex-col gap-5">
            {challenge.methods.passkey && (
              <button
                type="button"
                onClick={() => void handlePasskey()}
                disabled={passkeyLoading || !passkeysSupported}
                className={`${challenge.methods.totp ? 'btn-quiet transition-colors hover:text-ink' : 'btn-primary'} flex h-[52px] w-full items-center justify-center gap-2 text-[15px]`}
              >
                {passkeyLoading ? <Loader2 size={16} className="animate-spin" /> : <KeyRound size={17} strokeWidth={1.7} />}
                {passkeysSupported ? 'Mit Passkey bestätigen' : 'Dieser Browser kann keine Passkeys'}
              </button>
            )}

            {challenge.methods.totp && (
              <form onSubmit={(e) => void handleCode(e)} className="flex flex-col gap-5">
                <div className="flex flex-col gap-2">
                  <label htmlFor="login-code" className="text-[13px] text-ink-2">
                    {useRecovery ? 'Recovery-Code' : '6-stelliger Code'}
                  </label>
                  <input
                    id="login-code"
                    type="text"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder={useRecovery ? 'xxxxx-xxxxx' : '123456'}
                    autoComplete="one-time-code"
                    inputMode={useRecovery ? 'text' : 'numeric'}
                    autoCapitalize="none"
                    spellCheck={false}
                    autoFocus
                    required
                    className="field h-[52px] w-full px-[18px] font-mono text-[17px] tracking-[0.2em]"
                  />
                  <button
                    type="button"
                    onClick={() => { setUseRecovery(!useRecovery); setCode(''); }}
                    className="self-start text-[13px] text-ink-3 transition-colors hover:text-ink"
                  >
                    {useRecovery ? 'Code aus der App verwenden' : 'Handy nicht da? Recovery-Code verwenden'}
                  </button>
                </div>

                {errorBox}

                <button
                  type="submit"
                  disabled={loading}
                  className="btn-primary flex h-[52px] w-full items-center justify-center gap-2 text-[15px]"
                >
                  {loading ? <><Loader2 size={16} className="animate-spin" />Prüfe…</> : 'Bestätigen'}
                </button>
              </form>
            )}

            {!challenge.methods.totp && errorBox}

            <button
              type="button"
              onClick={backToPassword}
              className="flex items-center justify-center gap-1.5 self-center text-[13.5px] text-ink-3 transition-colors hover:text-ink"
            >
              <ArrowLeft size={14} strokeWidth={1.7} /> Zurück
            </button>
          </div>
        </div>
      </div>
    );
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

          {errorBox}

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

          {passkeysSupported && (
            <button
              data-rise
              type="button"
              onClick={() => void handlePasskey()}
              disabled={passkeyLoading}
              className="btn-quiet flex h-[52px] w-full items-center justify-center gap-2 text-[15px] transition-colors hover:text-ink"
            >
              {passkeyLoading ? <Loader2 size={16} className="animate-spin" /> : <KeyRound size={17} strokeWidth={1.7} />}
              Mit Passkey anmelden
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
