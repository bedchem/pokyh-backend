import { FormEvent, type ReactNode, useState } from 'react';
import { AlertCircle, CheckCircle, ChevronRight, Eye, EyeOff, Globe, Shield } from 'lucide-react';
import { setupApi } from '../api';

type Step = 'welcome' | 'credentials' | 'done';

const STEPS: { id: Step; label: string }[] = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'credentials', label: 'Admin password' },
  { id: 'done', label: 'Done' },
];

function StepBar({ current }: { current: Step }) {
  const index = STEPS.findIndex((step) => step.id === current);
  return (
    <div className="mb-8 flex items-center justify-center gap-2">
      {STEPS.map((step, stepIndex) => (
        <div key={step.id} className="flex items-center gap-2">
          <div className="flex flex-col items-center gap-1">
            <div
              className="flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold"
              style={{
                background: stepIndex < index ? '#10b981' : stepIndex === index ? '#0a84ff' : 'rgba(255,255,255,0.06)',
                color: stepIndex <= index ? '#fff' : '#475569',
              }}
            >
              {stepIndex < index ? '✓' : stepIndex + 1}
            </div>
            <span className="hidden text-xs sm:block" style={{ color: stepIndex === index ? '#a5b4fc' : '#475569' }}>{step.label}</span>
          </div>
          {stepIndex < STEPS.length - 1 && <div className="mb-4 h-px w-8" style={{ background: stepIndex < index ? '#10b981' : 'rgba(255,255,255,0.08)' }} />}
        </div>
      ))}
    </div>
  );
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-lg rounded-[20px] border p-10" style={{ background: '#0e0f1c', borderColor: 'rgba(10,132,255,0.2)' }}>
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
      <main className="flex min-h-screen items-center justify-center bg-black p-6">
        <Card>
          <StepBar current="welcome" />
          <div className="flex flex-col items-center gap-6 text-center">
            <div className="flex h-20 w-20 items-center justify-center rounded-3xl" style={{ background: 'rgba(10,132,255,0.12)', border: '1px solid rgba(10,132,255,0.25)' }}>
              <Shield size={40} className="text-[#0a84ff]" />
            </div>
            <div>
              <h1 className="mb-2 text-3xl font-bold text-white">Welcome to Pokyh</h1>
              <p className="text-slate-400">Create the first administrator account to finish the backend setup.</p>
            </div>
            <div className="flex w-full flex-col gap-3 text-left">
              <div className="flex items-center gap-3 rounded-xl border px-4 py-3" style={{ borderColor: 'rgba(255,255,255,0.05)', background: 'rgba(255,255,255,0.03)' }}><Shield size={16} className="text-[#0a84ff]" /><span className="text-sm text-slate-300">Create administrator credentials</span></div>
              <div className="flex items-center gap-3 rounded-xl border px-4 py-3" style={{ borderColor: 'rgba(255,255,255,0.05)', background: 'rgba(255,255,255,0.03)' }}><Globe size={16} className="text-[#0a84ff]" /><span className="text-sm text-slate-300">Configure TLS and ingress outside this container</span></div>
            </div>
            <button onClick={() => setStep('credentials')} className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#0a84ff] px-6 py-3 font-semibold text-white">Start setup <ChevronRight size={18} /></button>
          </div>
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
    const inputClass = 'w-full rounded-xl border bg-transparent px-4 py-3 text-slate-200 outline-none';
    const inputStyle = { borderColor: 'rgba(255,255,255,0.08)' };
    return (
      <main className="flex min-h-screen items-center justify-center bg-black p-6">
        <Card>
          <StepBar current="credentials" />
          <h2 className="mb-1 text-2xl font-bold text-white">Create admin account</h2>
          <p className="mb-6 text-sm text-slate-500">Use this account for the administrator console.</p>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-slate-400">Username<input className={inputClass} style={inputStyle} value={username} onChange={(event) => setUsername(event.target.value)} minLength={3} required /></label>
            <label className="flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-slate-400">Password<div className="relative"><input className={`${inputClass} pr-12`} style={inputStyle} type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} required /><button type="button" onClick={() => setShowPassword((value) => !value)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500">{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button></div></label>
            <label className="flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-slate-400">Confirm password<input className={inputClass} style={inputStyle} type={showPassword ? 'text' : 'password'} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required /></label>
            {error && <p className="flex items-center gap-2 rounded-xl border px-4 py-3 text-sm text-red-400" style={{ borderColor: 'rgba(239,68,68,0.2)', background: 'rgba(239,68,68,0.08)' }}><AlertCircle size={16} />{error}</p>}
            <button type="submit" disabled={saving} className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-[#0a84ff] px-6 py-3 font-semibold text-white disabled:opacity-50">Continue <ChevronRight size={18} /></button>
          </form>
        </Card>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-black p-6">
      <Card>
        <StepBar current="done" />
        <div className="flex flex-col items-center gap-6 text-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-3xl" style={{ background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.25)' }}><CheckCircle size={40} className="text-emerald-400" /></div>
          <div><h2 className="mb-2 text-3xl font-bold text-white">You’re all set</h2><p className="text-slate-400">Pokyh Backend is ready. Configure HTTPS and public ingress in your infrastructure.</p></div>
          <button onClick={onComplete} className="w-full rounded-xl bg-[#0a84ff] px-6 py-3 font-semibold text-white">Open admin dashboard</button>
        </div>
      </Card>
    </main>
  );
}
