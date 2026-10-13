import { FormEvent, type ReactNode, useState } from 'react';
import { AlertCircle, CheckCircle, ChevronRight, Eye, EyeOff, Globe, Shield } from 'lucide-react';
import { setupApi } from '../api';
import { Wordmark } from '../components/Layout';

type Step = 'welcome' | 'credentials' | 'done';

const STEPS: { id: Step; label: string }[] = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'credentials', label: 'Admin password' },
  { id: 'done', label: 'Done' },
];

function StepBar({ current }: { current: Step }) {
  const index = STEPS.findIndex((step) => step.id === current);
  return (
    <ol className="mb-10 mt-9 flex items-center gap-3">
      {STEPS.map((step, stepIndex) => (
        <li key={step.id} className={`flex items-center gap-3 ${stepIndex < STEPS.length - 1 ? 'flex-1' : ''}`} aria-current={stepIndex === index ? 'step' : undefined}>
          <span
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-[13px] font-medium transition-colors duration-500"
            style={{
              background: stepIndex < index ? 'var(--mint-wash)' : stepIndex === index ? 'var(--ink)' : 'var(--well)',
              color: stepIndex < index ? 'var(--mint-deep)' : stepIndex === index ? 'var(--sheet)' : 'var(--ink-3)',
            }}
          >
            {stepIndex < index ? '✓' : stepIndex + 1}
          </span>
          <span className="hidden whitespace-nowrap text-[13px] sm:block" style={{ color: stepIndex === index ? 'var(--ink)' : 'var(--ink-3)' }}>{step.label}</span>
          {stepIndex < STEPS.length - 1 && <span className="h-px min-w-3 flex-1 bg-line" />}
        </li>
      ))}
    </ol>
  );
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div
      className="animate-scaleIn mx-auto w-full max-w-[520px] rounded-sheet bg-sheet px-7 pb-10 pt-9 sm:px-11 sm:pb-12 sm:pt-11"
      style={{ boxShadow: 'var(--sheet-shadow)' }}
    >
      <Wordmark />
      {children}
    </div>
  );
}

export function SetupPage({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState<Step>('welcome');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  if (step === 'welcome') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-canvas p-4">
        <Card>
          <StepBar current="welcome" />
          <h1 className="text-[28px] font-semibold leading-tight">Welcome to Pokyh</h1>
          <p className="mt-2 text-[15px] text-ink-3">Create the first administrator account to finish the backend setup.</p>
          <ul className="mt-8 flex flex-col gap-4">
            <li className="flex items-center gap-4"><span className="orb h-11 w-11"><Shield size={18} strokeWidth={1.6} /></span><span className="text-[14.5px]">Create administrator credentials</span></li>
            <li className="flex items-center gap-4"><span className="orb h-11 w-11"><Globe size={18} strokeWidth={1.6} /></span><span className="text-[14.5px]">Configure TLS and ingress outside this container</span></li>
          </ul>
          <button onClick={() => setStep('credentials')} className="btn-primary mt-10 flex h-[52px] w-full items-center justify-center gap-2 text-[15px]">Start setup <ChevronRight size={18} /></button>
        </Card>
      </main>
    );
  }

  if (step === 'credentials') {
    const submit = async (event: FormEvent) => {
      event.preventDefault();
      setError('');
      if (password !== confirmPassword) return setError('Passwords do not match');
      if (password.length < 8) return setError('Password must be at least 8 characters');
      setSaving(true);
      try {
        await setupApi.setPassword(username, password);
        setStep('done');
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Unable to save the administrator account');
      } finally {
        setSaving(false);
      }
    };
    const inputClass = 'field h-[52px] w-full px-[18px] text-[15px]';
    const labelClass = 'flex flex-col gap-2 text-[13px] text-ink-2';
    return (
      <main className="flex min-h-screen items-center justify-center bg-canvas p-4">
        <Card>
          <StepBar current="credentials" />
          <h2 className="text-[28px] font-semibold leading-tight">Create admin account</h2>
          <p className="mt-2 text-[15px] text-ink-3">Use this account for the administrator console.</p>
          <form onSubmit={submit} className="mt-8 flex flex-col gap-5">
            <label className={labelClass}>Username<input className={inputClass} value={username} onChange={(event) => setUsername(event.target.value)} minLength={3} autoComplete="username" autoCapitalize="none" spellCheck={false} required /></label>
            <label className={labelClass}>Password<div className="relative"><input className={`${inputClass} pr-14`} type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} autoComplete="new-password" required /><button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword} className="absolute right-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full text-ink-3 transition-colors hover:text-ink">{showPassword ? <EyeOff size={17} strokeWidth={1.7} /> : <Eye size={17} strokeWidth={1.7} />}</button></div></label>
            <label className={labelClass}>Confirm password<input className={inputClass} type={showPassword ? 'text' : 'password'} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" required /></label>
            {error && <p role="alert" className="flex items-center gap-2.5 rounded-[14px] bg-rose-wash px-[18px] py-3 text-[13.5px] text-rose-deep"><AlertCircle size={16} strokeWidth={1.7} />{error}</p>}
            <button type="submit" disabled={saving} className="btn-primary mt-2 flex h-[52px] w-full items-center justify-center gap-2 text-[15px]">Continue <ChevronRight size={18} /></button>
          </form>
        </Card>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas p-4">
      <Card>
        <StepBar current="done" />
        <span className="orb h-14 w-14" style={{ background: 'var(--mint-wash)', color: 'var(--mint-deep)' }}><CheckCircle size={24} strokeWidth={1.6} /></span>
        <h2 className="mt-6 text-[28px] font-semibold leading-tight">You’re all set</h2>
        <p className="mt-2 text-[15px] text-ink-3">Pokyh Backend is ready. Configure HTTPS and public ingress in your infrastructure.</p>
        <button onClick={onComplete} className="btn-primary mt-10 flex h-[52px] w-full items-center justify-center text-[15px]">Open admin dashboard</button>
      </Card>
    </main>
  );
}
