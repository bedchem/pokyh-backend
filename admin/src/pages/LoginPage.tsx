import { useState, FormEvent } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';

export function LoginPage() {
  const { login, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

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
    <div
      className="min-h-screen flex items-center justify-center relative overflow-hidden"
      style={{ background: '#000000' }}
    >
      {/* Subtle ambient light — very restrained, Apple-like */}
      <div
        className="absolute pointer-events-none"
        style={{
          width: '700px',
          height: '700px',
          background: 'radial-gradient(circle at center, rgba(10,132,255,0.055) 0%, transparent 65%)',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -62%)',
        }}
      />
      <div
        className="absolute pointer-events-none"
        style={{
          width: '500px',
          height: '500px',
          background: 'radial-gradient(circle at center, rgba(10,132,255,0.03) 0%, transparent 65%)',
          bottom: '-80px',
          right: '10%',
          animation: 'orbit2 14s ease-in-out infinite',
        }}
      />

      {/* Card */}
      <div
        className="relative z-10 w-full max-w-[360px] mx-5 animate-scaleIn"
        style={{
          background: 'rgba(28,28,30,0.88)',
          backdropFilter: 'blur(32px) saturate(180%)',
          WebkitBackdropFilter: 'blur(32px) saturate(180%)',
          border: '1px solid rgba(255,255,255,0.09)',
          borderRadius: '20px',
          padding: '44px 36px 36px',
          boxShadow: '0 32px 80px rgba(0,0,0,0.65), 0 1px 0 rgba(255,255,255,0.06) inset',
        }}
      >
        {/* App icon */}
        <div className="flex flex-col items-center mb-8">
          <div
            className="w-[56px] h-[56px] rounded-[14px] flex items-center justify-center mb-5"
            style={{
              background: 'linear-gradient(145deg, rgba(10,132,255,0.22) 0%, rgba(10,132,255,0.1) 100%)',
              border: '1px solid rgba(10,132,255,0.3)',
              boxShadow: '0 4px 20px rgba(10,132,255,0.18)',
            }}
          >
            <svg width="26" height="26" viewBox="0 0 14 14" fill="none">
              <rect x="1"   y="1"   width="5.5" height="5.5" rx="1.5" fill="#0a84ff"/>
              <rect x="7.5" y="1"   width="5.5" height="5.5" rx="1.5" fill="#0a84ff" opacity="0.65"/>
              <rect x="1"   y="7.5" width="5.5" height="5.5" rx="1.5" fill="#0a84ff" opacity="0.65"/>
              <rect x="7.5" y="7.5" width="5.5" height="5.5" rx="1.5" fill="#0a84ff"/>
            </svg>
          </div>
          <h1
            className="text-[22px] font-semibold text-white"
            style={{ letterSpacing: '-0.025em' }}
          >
            Pokyh Admin
          </h1>
          <p className="text-[14px] mt-1" style={{ color: 'rgba(235,235,245,0.45)' }}>
            Melde dich in deinem Panel an
          </p>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-3">
          {/* Username */}
          <div className="flex flex-col gap-1.5">
            <label
              className="text-[12px] font-semibold"
              style={{ color: 'rgba(235,235,245,0.5)', letterSpacing: '0.02em', textTransform: 'uppercase' }}
            >
              Benutzername
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="admin"
              autoComplete="username"
              required
              className="apple-input w-full px-4 py-3 text-[15px]"
            />
          </div>

          {/* Password */}
          <div className="flex flex-col gap-1.5">
            <label
              className="text-[12px] font-semibold"
              style={{ color: 'rgba(235,235,245,0.5)', letterSpacing: '0.02em', textTransform: 'uppercase' }}
            >
              Passwort
            </label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
                required
                className="apple-input w-full px-4 py-3 pr-12 text-[15px]"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 transition-colors"
                style={{ color: 'rgba(235,235,245,0.35)' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'rgba(235,235,245,0.7)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'rgba(235,235,245,0.35)'; }}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          {/* Error */}
          {error && (
            <div
              className="px-4 py-3 rounded-[10px] text-[13px]"
              style={{
                background: 'rgba(255,69,58,0.1)',
                border: '1px solid rgba(255,69,58,0.2)',
                color: '#ff453a',
              }}
            >
              {error}
            </div>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={loading}
            className="apple-btn w-full py-3 text-[15px] mt-1 flex items-center justify-center gap-2"
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
