import { useCallback, useEffect, useRef, useState, FormEvent } from 'react';
import { AlertTriangle, Check, Copy, KeyRound, Lock, Pencil, ShieldCheck, Smartphone, Trash2 } from 'lucide-react';
import { browserSupportsWebAuthn, startRegistration } from '@simplewebauthn/browser';
import { adminApi } from '../api';
import { passkeyErrorMessage } from '../pages/LoginPage';
import type { AdminSecurityStatus, TotpSetup } from '../types';
import { FieldLabel, FormSection, Notice, Spinner, Status } from './kit';
import { PasswordInput } from './PasswordInput';

const dateFormat = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

function formatDate(iso: string | null): string {
  return iso ? dateFormat.format(new Date(iso)) : '—';
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

// A reasonable default name: the platform the passkey is being made on.
function suggestedPasskeyName(): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPad/.test(ua)) return 'iPhone / iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac OS X/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  return 'Passkey';
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="mt-5 max-w-[60ch]">
      <Notice tone="amber" icon={AlertTriangle}>
        Speichere diese Recovery-Codes jetzt, zum Beispiel im Passwort-Manager. Jeder funktioniert genau einmal,
        falls du dein Handy nicht hast. Angezeigt werden sie nur dieses eine Mal.
      </Notice>
      <ul className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-[16px] bg-well px-5 py-4 font-mono text-[14px]">
        {codes.map((code) => <li key={code}>{code}</li>)}
      </ul>
      <div className="mt-4 flex flex-wrap gap-2.5">
        <button type="button" onClick={() => void copy()} className="btn btn-quiet">
          {copied ? <Check size={15} strokeWidth={1.8} /> : <Copy size={15} strokeWidth={1.7} />}
          {copied ? 'Kopiert' : 'Kopieren'}
        </button>
        <button type="button" onClick={onDone} className="btn btn-primary">Ich habe sie gespeichert</button>
      </div>
    </div>
  );
}

// The password the panel login checks. A configured one (server
// configuration) cannot be changed here; for a WebUntis admin this is the
// panel password chosen after the one-time password, not the WebUntis one.
function PasswordChange({ status }: { status: AdminSecurityStatus }) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function reset() {
    setOpen(false);
    setCurrent('');
    setNext('');
    setRepeat('');
    setError(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next.length < 8) { setError('Das neue Passwort braucht mindestens 8 Zeichen'); return; }
    if (next !== repeat) { setError('Die beiden neuen Passwörter stimmen nicht überein'); return; }
    setBusy(true);
    setError(null);
    try {
      await adminApi.changePassword(current, next);
      reset();
      setDone(true);
    } catch (err) {
      setError(errorText(err, 'Passwort ändern fehlgeschlagen'));
    } finally {
      setBusy(false);
    }
  }

  const field = 'field h-[46px] w-full max-w-[320px] px-4 text-[14.5px]';

  return (
    <div className="mb-10">
      <span className="flex items-center gap-2.5 text-[15px] font-medium"><Lock size={17} strokeWidth={1.7} /> Passwort</span>
      <p className="mt-2 max-w-[60ch] text-[13.5px] leading-relaxed text-ink-3">
        {status.password === 'config'
          ? 'Dein Passwort kommt aus der Server-Konfiguration und lässt sich nur dort ändern.'
          : status.password === 'account'
            ? 'Gilt auch für deine Anmeldung in der Pokyh-App.'
            : 'Gilt nur fürs Admin-Panel — ein WebUntis-Passwort bleibt unverändert.'}
      </p>

      {done && !open && <div className="mt-4 max-w-[60ch]"><Notice tone="mint" icon={Check}>Passwort geändert.</Notice></div>}

      {status.password !== 'config' && !open && (
        <button type="button" onClick={() => { setOpen(true); setDone(false); }} className="btn btn-quiet mt-5">
          <Lock size={15} strokeWidth={1.7} /> Passwort ändern
        </button>
      )}

      {open && (
        <form onSubmit={(e) => void submit(e)} className="mt-5 flex max-w-[60ch] flex-col gap-4">
          <FieldLabel label="Aktuelles Passwort">
            <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" maxLength={200} required autoFocus className={field} />
          </FieldLabel>
          <FieldLabel label="Neues Passwort" hint="Mindestens 8 Zeichen.">
            <div className="max-w-[440px]">
              <PasswordInput value={next} onChange={setNext} onGenerated={setRepeat} required />
            </div>
          </FieldLabel>
          <FieldLabel label="Neues Passwort wiederholen">
            <input type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" maxLength={200} required className={field} />
          </FieldLabel>
          {error && <Notice tone="rose" icon={AlertTriangle}>{error}</Notice>}
          <div className="flex flex-wrap gap-2.5">
            <button type="submit" disabled={busy} className="btn btn-primary">{busy ? <Spinner /> : null}Passwort ändern</button>
            <button type="button" onClick={reset} className="btn btn-quiet">Abbrechen</button>
          </div>
        </form>
      )}
    </div>
  );
}

type CodeAction = 'disable' | 'renew';

function AuthenticatorApp({ status, reload }: { status: AdminSecurityStatus; reload: () => Promise<void> }) {
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [action, setAction] = useState<CodeAction | null>(null);

  async function begin() {
    setBusy(true);
    setError(null);
    try {
      setSetup(await adminApi.startTotpSetup());
      setCode('');
    } catch (err) {
      setError(errorText(err, 'Einrichtung fehlgeschlagen'));
    } finally {
      setBusy(false);
    }
  }

  async function enable(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { recoveryCodes: codes } = await adminApi.enableTotp(code);
      setSetup(null);
      setCode('');
      setRecoveryCodes(codes);
      await reload();
    } catch (err) {
      setError(errorText(err, 'Code stimmt nicht'));
    } finally {
      setBusy(false);
    }
  }

  async function confirmAction(e: FormEvent) {
    e.preventDefault();
    if (!action) return;
    setBusy(true);
    setError(null);
    try {
      if (action === 'disable') {
        await adminApi.disableTotp(code);
      } else {
        setRecoveryCodes((await adminApi.renewRecoveryCodes(code)).recoveryCodes);
      }
      setAction(null);
      setCode('');
      await reload();
    } catch (err) {
      setError(errorText(err, 'Code stimmt nicht'));
    } finally {
      setBusy(false);
    }
  }

  const codeInput = (
    <input
      type="text"
      value={code}
      onChange={(e) => setCode(e.target.value)}
      placeholder="123456"
      autoComplete="one-time-code"
      inputMode="numeric"
      spellCheck={false}
      autoFocus
      required
      className="field h-[46px] w-full max-w-[220px] px-4 font-mono text-[16px] tracking-[0.2em]"
    />
  );

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="flex items-center gap-2.5 text-[15px] font-medium"><Smartphone size={17} strokeWidth={1.7} /> Authenticator-App</span>
        {status.totpEnabled
          ? <Status tone="mint">Aktiv · {status.recoveryCodesLeft} Recovery-Codes übrig</Status>
          : <Status tone="ink">Nicht eingerichtet</Status>}
      </div>
      <p className="mt-2 max-w-[60ch] text-[13.5px] leading-relaxed text-ink-3">
        Zum Beispiel Google Authenticator, Microsoft Authenticator, 1Password oder Aegis. Nach dem Passwort fragt das Panel dann nach einem 6-stelligen Code.
      </p>

      {error && <div className="mt-4 max-w-[60ch]"><Notice tone="rose" icon={AlertTriangle}>{error}</Notice></div>}

      {recoveryCodes && <RecoveryCodes codes={recoveryCodes} onDone={() => setRecoveryCodes(null)} />}

      {!status.totpEnabled && !setup && (
        <button type="button" onClick={() => void begin()} disabled={busy} className="btn btn-primary mt-5">
          {busy ? <Spinner /> : <ShieldCheck size={16} strokeWidth={1.7} />}
          Einrichten
        </button>
      )}

      {setup && (
        <form onSubmit={(e) => void enable(e)} className="mt-5 flex max-w-[60ch] flex-col gap-5">
          <div className="flex flex-wrap items-start gap-6">
            {/* The QR code keeps its own white ground so it scans in dark mode too. */}
            <img
              src={`data:image/svg+xml;utf8,${encodeURIComponent(setup.qrSvg)}`}
              alt="QR-Code für die Authenticator-App"
              width={176}
              height={176}
              className="rounded-[12px] bg-white p-2"
            />
            <div className="min-w-0 flex-1 text-[13.5px] leading-relaxed text-ink-2">
              <p>1. Scanne den QR-Code mit deiner Authenticator-App.</p>
              <p className="mt-2">Oder gib den Schlüssel von Hand ein:</p>
              <p className="mt-1 break-all font-mono text-[13px] text-ink">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</p>
              <p className="mt-3">2. Gib den Code ein, den die App jetzt zeigt.</p>
            </div>
          </div>
          <FieldLabel label="Code aus der App">{codeInput}</FieldLabel>
          <div className="flex flex-wrap gap-2.5">
            <button type="submit" disabled={busy} className="btn btn-primary">{busy ? <Spinner /> : null}Aktivieren</button>
            <button type="button" onClick={() => { setSetup(null); setError(null); }} className="btn btn-quiet">Abbrechen</button>
          </div>
        </form>
      )}

      {status.totpEnabled && !action && !recoveryCodes && (
        <div className="mt-5 flex flex-wrap gap-2.5">
          <button type="button" onClick={() => { setAction('renew'); setCode(''); setError(null); }} className="btn btn-quiet">Neue Recovery-Codes</button>
          <button type="button" onClick={() => { setAction('disable'); setCode(''); setError(null); }} className="btn btn-danger">Deaktivieren</button>
        </div>
      )}

      {action && (
        <form onSubmit={(e) => void confirmAction(e)} className="mt-5 flex max-w-[60ch] flex-col gap-4">
          <FieldLabel
            label={action === 'disable' ? 'Code zum Deaktivieren' : 'Code für neue Recovery-Codes'}
            hint="Ein Code aus der App oder ein Recovery-Code."
          >
            {codeInput}
          </FieldLabel>
          <div className="flex flex-wrap gap-2.5">
            <button type="submit" disabled={busy} className={action === 'disable' ? 'btn btn-danger' : 'btn btn-primary'}>
              {busy ? <Spinner /> : null}
              {action === 'disable' ? 'Deaktivieren' : 'Neue Codes erzeugen'}
            </button>
            <button type="button" onClick={() => { setAction(null); setError(null); }} className="btn btn-quiet">Abbrechen</button>
          </div>
        </form>
      )}
    </div>
  );
}

function Passkeys({ status, reload }: { status: AdminSecurityStatus; reload: () => Promise<void> }) {
  const supported = browserSupportsWebAuthn();
  const [adding, setAdding] = useState(false);
  const [password, setPassword] = useState('');
  const [name, setName] = useState(suggestedPasskeyName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { options, challengeToken } = await adminApi.passkeyRegistrationOptions(password);
      const response = await startRegistration({ optionsJSON: options });
      await adminApi.addPasskey(challengeToken, response, name);
      setAdding(false);
      setPassword('');
      await reload();
    } catch (err) {
      setError(err instanceof Error && err.name === 'InvalidStateError'
        ? 'Dieser Passkey ist auf diesem Gerät schon gespeichert'
        : passkeyErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function rename(e: FormEvent, id: string) {
    e.preventDefault();
    setError(null);
    try {
      await adminApi.renamePasskey(id, editName);
      setEditing(null);
      await reload();
    } catch (err) {
      setError(errorText(err, 'Umbenennen fehlgeschlagen'));
    }
  }

  async function remove(id: string, label: string) {
    if (!window.confirm(`Passkey „${label}“ entfernen? Damit kannst du dich danach nicht mehr anmelden.`)) return;
    setError(null);
    try {
      await adminApi.deletePasskey(id);
      await reload();
    } catch (err) {
      setError(errorText(err, 'Entfernen fehlgeschlagen'));
    }
  }

  return (
    <div className="mt-10">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="flex items-center gap-2.5 text-[15px] font-medium"><KeyRound size={17} strokeWidth={1.7} /> Passkeys</span>
        <Status tone={status.passkeys.length > 0 ? 'mint' : 'ink'}>
          {status.passkeys.length === 0 ? 'Keine' : status.passkeys.length === 1 ? '1 Passkey' : `${status.passkeys.length} Passkeys`}
        </Status>
      </div>
      <p className="mt-2 max-w-[60ch] text-[13.5px] leading-relaxed text-ink-3">
        Anmelden mit Fingerabdruck, Gesicht oder Geräte-PIN, ganz ohne Passwort. Nach einem Passwort-Login zählt ein Passkey auch als zweiter Faktor.
        Ein Passkey gilt nur für die Adresse, unter der er erstellt wurde.
      </p>

      {error && <div className="mt-4 max-w-[60ch]"><Notice tone="rose" icon={AlertTriangle}>{error}</Notice></div>}

      {status.passkeys.length > 0 && (
        <ul className="mt-5 flex max-w-[60ch] flex-col divide-y divide-line rounded-[16px] bg-well">
          {status.passkeys.map((key) => (
            <li key={key.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5">
              {editing === key.id ? (
                <form onSubmit={(e) => void rename(e, key.id)} className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                  <input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    maxLength={100}
                    autoFocus
                    required
                    className="field h-[38px] min-w-0 flex-1 px-3.5 text-[14px]"
                  />
                  <button type="submit" className="btn btn-sm btn-primary">Speichern</button>
                  <button type="button" onClick={() => setEditing(null)} className="btn btn-sm btn-quiet">Abbrechen</button>
                </form>
              ) : (
                <>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14.5px] font-medium">{key.name}</p>
                    <p className="mt-0.5 text-[12.5px] text-ink-3">
                      {key.rpId} · erstellt {formatDate(key.createdAt)} · zuletzt benutzt {formatDate(key.lastUsedAt)}
                      {key.backedUp ? ' · synchronisiert' : ''}
                    </p>
                  </div>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={() => { setEditing(key.id); setEditName(key.name); }}
                      aria-label={`Passkey ${key.name} umbenennen`}
                      className="flex h-9 w-9 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-sheet hover:text-ink"
                    >
                      <Pencil size={15} strokeWidth={1.7} />
                    </button>
                    <button
                      type="button"
                      onClick={() => void remove(key.id, key.name)}
                      aria-label={`Passkey ${key.name} entfernen`}
                      className="flex h-9 w-9 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-rose-wash hover:text-rose-deep"
                    >
                      <Trash2 size={15} strokeWidth={1.7} />
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {!supported && <div className="mt-5 max-w-[60ch]"><Notice tone="amber" icon={AlertTriangle}>Dieser Browser unterstützt keine Passkeys.</Notice></div>}

      {supported && !adding && (
        <button type="button" onClick={() => { setAdding(true); setError(null); }} className="btn btn-primary mt-5">
          <KeyRound size={16} strokeWidth={1.7} /> Passkey hinzufügen
        </button>
      )}

      {supported && adding && (
        <form onSubmit={(e) => void add(e)} className="mt-5 flex max-w-[60ch] flex-col gap-4">
          <FieldLabel label="Name" hint="Damit du den Passkey später wiedererkennst.">
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required className="field h-[46px] w-full max-w-[320px] px-4 text-[14.5px]" />
          </FieldLabel>
          <FieldLabel label="Dein Passwort" hint="Zur Sicherheit: ein neuer Passkey ist ein neuer Weg ins Panel.">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              className="field h-[46px] w-full max-w-[320px] px-4 text-[14.5px]"
            />
          </FieldLabel>
          <div className="flex flex-wrap gap-2.5">
            <button type="submit" disabled={busy} className="btn btn-primary">{busy ? <Spinner /> : null}Weiter</button>
            <button type="button" onClick={() => { setAdding(false); setPassword(''); setError(null); }} className="btn btn-quiet">Abbrechen</button>
          </div>
        </form>
      )}
    </div>
  );
}

// `onChange` runs after a factor was added or removed (the required set-up
// screen then checks whether the panel may open); `factorsOnly` leaves out the
// password change there.
export function AccountSecurity({ onChange, factorsOnly = false }: { onChange?: () => void; factorsOnly?: boolean } = {}) {
  const [status, setStatus] = useState<AdminSecurityStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setStatus(await adminApi.securityStatus());
      setLoadError(null);
    } catch (err) {
      setLoadError(errorText(err, 'Laden fehlgeschlagen'));
    }
  }, []);

  // After a factor changed: reload, then tell the caller (kept in a ref, so a
  // new callback on every render of the caller does not reload in a loop).
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  const changed = useCallback(async () => {
    await reload();
    onChangeRef.current?.();
  }, [reload]);

  useEffect(() => { void reload(); }, [reload]);

  return (
    <FormSection
      icon={ShieldCheck}
      title="Anmeldung & Sicherheit"
      hint={
        <>
          Gilt für dein Admin-Konto{status ? <> <span className="font-medium text-ink-2">{status.username}</span></> : null}.
          Sobald ein zweiter Faktor eingerichtet ist, reicht das Passwort allein nicht mehr.
          {status?.secondFactor?.required ? <> Für dieses Konto ist ein zweiter Faktor Pflicht; der letzte lässt sich daher nicht entfernen.</> : null}
        </>
      }
    >
      {loadError && <Notice tone="rose" icon={AlertTriangle}>{loadError}</Notice>}
      {!status && !loadError && <Spinner />}
      {status && (
        <>
          {!factorsOnly && <PasswordChange status={status} />}
          <AuthenticatorApp status={status} reload={changed} />
          <Passkeys status={status} reload={changed} />
        </>
      )}
    </FormSection>
  );
}
