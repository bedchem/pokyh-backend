import { useState, FormEvent } from 'react';
import { Check, Clock, Copy, Shield, Wand2 } from 'lucide-react';
import { adminApi } from '../api';
import { Dialog, FieldLabel, Notice, Spinner } from './kit';

// Easy to read aloud and to type: no 0/O, 1/l/I.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function randomPassword(length = 12): string {
  const bytes = crypto.getRandomValues(new Uint32Array(length));
  return Array.from(bytes, (n) => ALPHABET[n % ALPHABET.length]).join('');
}

/**
 * "Admin vergeben" for a WebUntis account: the panel never uses the WebUntis
 * password, so the granting admin sets a one-time password and passes it on.
 * The new admin replaces it at the first login; without that login within 15
 * minutes the grant lapses.
 */
export function GrantAdminDialog({ stableUid, username, onClose, onGranted }: {
  stableUid: string;
  username: string;
  onClose: () => void;
  onGranted: (adminSetupExpiresAt: string | null) => void;
}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password.length < 8) {
      setError('Das Einmal-Passwort braucht mindestens 8 Zeichen');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await adminApi.grantAdmin(stableUid, password);
      onGranted(result.adminSetupExpiresAt);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Admin vergeben fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="Admin vergeben" subtitle={username} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-5">
        <p className="text-[14px] leading-relaxed text-ink-2">
          <span className="font-medium text-ink">{username}</span> meldet sich mit WebUntis an — das WebUntis-Passwort gilt im
          Admin-Panel nicht. Leg ein Einmal-Passwort fest und gib es weiter.
        </p>
        <FieldLabel label="Einmal-Passwort" hint="Mindestens 8 Zeichen.">
          <div className="flex gap-2">
            <input
              type="text"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setCopied(false); }}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={200}
              required
              className="field h-12 min-w-0 flex-1 px-4 font-mono text-[14.5px]"
            />
            <button type="button" onClick={() => { setPassword(randomPassword()); setCopied(false); }} className="btn btn-quiet" title="Zufälliges Passwort erzeugen">
              <Wand2 size={16} strokeWidth={1.7} />
              Generieren
            </button>
            <button type="button" onClick={() => void copy()} disabled={!password} className="btn btn-quiet" aria-label="Kopieren" title="Kopieren">
              {copied ? <Check size={16} strokeWidth={1.8} /> : <Copy size={16} strokeWidth={1.7} />}
            </button>
          </div>
        </FieldLabel>
        <Notice tone="amber" icon={Clock}>
          Gilt 15 Minuten. Beim ersten Login muss {username} ein eigenes Passwort festlegen. Ohne Login in dieser Zeit
          werden die Admin-Rechte und das Einmal-Passwort automatisch wieder entfernt.
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
