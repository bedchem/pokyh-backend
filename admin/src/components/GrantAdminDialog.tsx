import { useEffect, useState, FormEvent } from 'react';
import { Check, Clock, Copy, Shield, Wand2 } from 'lucide-react';
import { adminApi } from '../api';
import { AdminCountdown, clockOffset } from './AdminCountdown';
import { Dialog, FieldLabel, Notice, Spinner } from './kit';
import { randomPassword } from './PasswordInput';

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => { setCopied(false); }, [text]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <button type="button" onClick={() => void copy()} disabled={!text} className="btn btn-quiet" title="In die Zwischenablage kopieren">
      {copied ? <Check size={16} strokeWidth={1.8} /> : <Copy size={16} strokeWidth={1.7} />}
      {copied ? 'Kopiert' : 'Kopieren'}
    </button>
  );
}

/**
 * A pending grant's one-time password with its live countdown. When the time
 * is up the password disappears with the grant.
 */
function OneTimePasswordView({ username, password, expiresAt, offset, onLapsed }: {
  username: string;
  password: string;
  expiresAt: string;
  offset: number;
  onLapsed?: () => void;
}) {
  const [lapsed, setLapsed] = useState(false);

  if (lapsed) {
    return (
      <Notice tone="rose" icon={Clock}>
        Abgelaufen: {username} hat sich nicht rechtzeitig angemeldet. Admin-Rechte und Einmal-Passwort wurden entfernt.
      </Notice>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-[14px] leading-relaxed text-ink-2">
        Gib <span className="font-medium text-ink">{username}</span> dieses Einmal-Passwort weiter. Beim ersten Login muss ein
        eigenes Passwort festgelegt werden.
      </p>
      <div className="flex flex-wrap items-center gap-3 rounded-[18px] bg-well px-5 py-4">
        <span className="min-w-0 flex-1 break-all font-mono text-[19px] tracking-[0.04em] text-ink">{password}</span>
        <CopyButton text={password} />
      </div>
      <div className="flex items-center gap-2 text-[13.5px] text-ink-2">
        <Clock size={15} strokeWidth={1.7} />
        Gültig für den ersten Login:
        <AdminCountdown expiresAt={expiresAt} offset={offset} onExpired={() => { setLapsed(true); onLapsed?.(); }} />
      </div>
      <p className="text-[12.5px] leading-relaxed text-ink-3">
        Nur du kannst es bis dahin hier nochmal aufrufen. Ohne Login in dieser Zeit werden Admin-Rechte und Einmal-Passwort
        automatisch entfernt.
      </p>
    </div>
  );
}

/**
 * "Admin vergeben" for a WebUntis account. Step one: the granting admin sets
 * (or generates) a one-time password — the WebUntis password never opens the
 * panel. Step two: the password with its countdown, to pass on.
 */
export function GrantAdminDialog({ stableUid, username, onClose, onGranted, onLapsed }: {
  stableUid: string;
  username: string;
  onClose: () => void;
  // The grant is made; the dialog stays open on the password.
  onGranted: (adminSetupExpiresAt: string | null) => void;
  onLapsed?: () => void;
}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [granted, setGranted] = useState<{ expiresAt: string; offset: number } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password.length < 8 || password.length > 100) {
      setError('Das Einmal-Passwort braucht 8 bis 100 Zeichen');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await adminApi.grantAdmin(stableUid, password);
      if (result.adminSetupExpiresAt) setGranted({ expiresAt: result.adminSetupExpiresAt, offset: clockOffset(result.serverTime) });
      onGranted(result.adminSetupExpiresAt);
      if (!result.adminSetupExpiresAt) onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Admin vergeben fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  }

  if (granted) {
    return (
      <Dialog title="Admin vergeben" subtitle={username} onClose={onClose}>
        <OneTimePasswordView username={username} password={password} expiresAt={granted.expiresAt} offset={granted.offset} onLapsed={onLapsed} />
        <button type="button" onClick={onClose} className="btn btn-primary mt-6 w-full">Fertig</button>
      </Dialog>
    );
  }

  return (
    <Dialog title="Admin vergeben" subtitle={username} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-5">
        <p className="text-[14px] leading-relaxed text-ink-2">
          <span className="font-medium text-ink">{username}</span> meldet sich mit WebUntis an — das WebUntis-Passwort gilt im
          Admin-Panel nicht. Leg ein Einmal-Passwort fest oder lass eines generieren.
        </p>
        <FieldLabel label="Einmal-Passwort" hint="8 bis 100 Zeichen.">
          <div className="flex gap-2">
            <input
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={100}
              required
              className="field h-12 min-w-0 flex-1 px-4 font-mono text-[14.5px]"
            />
            <button type="button" onClick={() => setPassword(randomPassword())} className="btn btn-quiet" title="Zufälliges Passwort erzeugen">
              <Wand2 size={16} strokeWidth={1.7} />
              Generieren
            </button>
          </div>
        </FieldLabel>
        <Notice tone="amber" icon={Clock}>
          Gilt 15 Minuten für den ersten Login. Bis dahin kannst nur du es nochmal anzeigen; ohne Login werden Admin-Rechte und
          Einmal-Passwort automatisch entfernt.
        </Notice>
        {error && <Notice tone="rose">{error}</Notice>}
        <div className="flex gap-3">
          <button type="button" onClick={onClose} className="btn btn-quiet flex-1">Abbrechen</button>
          <button type="submit" disabled={busy} className="btn btn-primary flex-1">
            {busy ? <Spinner /> : <Shield size={16} strokeWidth={1.7} />}
            Admin vergeben
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * A pending grant's one-time password again, for the admin who granted it.
 * `known` skips the request when the password was just typed (new account).
 */
export function OneTimePasswordDialog({ stableUid, username, onClose, onLapsed, known }: {
  stableUid: string;
  username: string;
  onClose: () => void;
  onLapsed?: () => void;
  known?: { password: string; expiresAt: string; offset: number };
}) {
  const [data, setData] = useState(known ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (known) return;
    let alive = true;
    adminApi.oneTimePassword(stableUid)
      .then((res) => {
        if (alive) setData({ password: res.password, expiresAt: res.adminSetupExpiresAt, offset: clockOffset(res.serverTime) });
      })
      .catch((err) => { if (alive) setError(err instanceof Error ? err.message : 'Nicht verfügbar'); });
    return () => { alive = false; };
  }, [stableUid, known]);

  return (
    <Dialog title="Einmal-Passwort" subtitle={username} onClose={onClose}>
      {error && <Notice tone="amber" icon={Clock}>{error}</Notice>}
      {!error && !data && <Spinner />}
      {data && <OneTimePasswordView username={username} password={data.password} expiresAt={data.expiresAt} offset={data.offset} onLapsed={onLapsed} />}
      <button type="button" onClick={onClose} className="btn btn-primary mt-6 w-full">Fertig</button>
    </Dialog>
  );
}
