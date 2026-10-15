import { useState } from 'react';
import { Eye, EyeOff, Wand2 } from 'lucide-react';

// Easy to read aloud and to type: no 0/O, 1/l/I.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function randomPassword(length = 12): string {
  const bytes = crypto.getRandomValues(new Uint32Array(length));
  return Array.from(bytes, (n) => ALPHABET[n % ALPHABET.length]).join('');
}

/**
 * A new password: hidden by default, with an eye to show it and a
 * "Generieren" button. A generated password is shown, so it can be passed on.
 */
export function PasswordInput({ value, onChange, onGenerated, placeholder = '••••••••', required = false, autoFocus = false, id }: {
  value: string;
  onChange: (next: string) => void;
  // Also told about a generated password, e.g. to fill a repeat field.
  onGenerated?: (password: string) => void;
  placeholder?: string;
  required?: boolean;
  autoFocus?: boolean;
  id?: string;
}) {
  const [visible, setVisible] = useState(false);

  function generate() {
    const password = randomPassword();
    onChange(password);
    onGenerated?.(password);
    setVisible(true);
  }

  return (
    <div className="flex gap-2">
      <div className="relative min-w-0 flex-1">
        <input
          id={id}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete="new-password"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={200}
          required={required}
          autoFocus={autoFocus}
          className={`field h-12 w-full pl-4 pr-12 text-[14.5px] ${visible ? 'font-mono' : ''}`}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Passwort verbergen' : 'Passwort anzeigen'}
          aria-pressed={visible}
          className="absolute right-1.5 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full text-ink-3 transition-colors hover:text-ink"
        >
          {visible ? <EyeOff size={16} strokeWidth={1.7} /> : <Eye size={16} strokeWidth={1.7} />}
        </button>
      </div>
      <button type="button" onClick={generate} className="btn btn-quiet" title="Zufälliges Passwort erzeugen">
        <Wand2 size={16} strokeWidth={1.7} />
        Generieren
      </button>
    </div>
  );
}
