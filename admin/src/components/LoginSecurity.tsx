import { useState } from 'react';
import { KeyRound, ShieldAlert, ShieldCheck, ShieldOff, Smartphone } from 'lucide-react';
import { adminApi } from '../api';
import { useToast } from './Toast';
import { Tag, Toggle } from './kit';
import { dateTime, relative } from './format';
import type { AdminLoginSecurity } from '../types';

// How an admin panel account signs in: second factor set up or missing,
// whether one is required, and the last panel login. Used by the admin list
// and the account drawer.

const METHOD_LABEL: Record<string, string> = {
  password: 'Passwort',
  'one-time-password': 'Einmal-Passwort',
  'password+totp': 'Passwort + App',
  'password+recovery-code': 'Passwort + Wiederherstellungscode',
  'password+passkey': 'Passwort + Passkey',
  passkey: 'Passkey',
};

export function loginMethodLabel(method: string | null): string | null {
  return method ? METHOD_LABEL[method] ?? method : null;
}

/** "2FA aktiv" (with what), "2FA fehlt" (required but not set up) or "ohne 2FA". */
export function SecondFactorBadge({ security }: { security: AdminLoginSecurity }) {
  const parts = [security.totp ? 'App' : null, security.passkeys > 0 ? `${security.passkeys} Passkey${security.passkeys === 1 ? '' : 's'}` : null].filter(Boolean);
  if (parts.length > 0) {
    return (
      <Tag tone="mint">
        <ShieldCheck size={12} strokeWidth={2} /> 2FA aktiv · {parts.join(' + ')}
      </Tag>
    );
  }
  return security.required
    ? <Tag tone="rose"><ShieldAlert size={12} strokeWidth={2} /> 2FA fehlt</Tag>
    : <Tag tone="ink"><ShieldOff size={12} strokeWidth={2} /> ohne 2FA</Tag>;
}

/** The factors as icons with their names, for the drawer. */
export function FactorList({ security }: { security: AdminLoginSecurity }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <Tag tone={security.totp ? 'mint' : 'ink'}><Smartphone size={12} strokeWidth={2} /> Authenticator-App {security.totp ? 'aktiv' : 'nicht eingerichtet'}</Tag>
      <Tag tone={security.passkeys > 0 ? 'mint' : 'ink'}><KeyRound size={12} strokeWidth={2} /> {security.passkeys > 0 ? `${security.passkeys} Passkey${security.passkeys === 1 ? '' : 's'}` : 'kein Passkey'}</Tag>
    </div>
  );
}

/** "vor 3 Tagen" with the exact time and the way in on hover. */
export function LastLogin({ iso, method, never = 'noch nie' }: { iso: string | null | undefined; method?: string | null; never?: string }) {
  if (!iso) return <span className="text-ink-4">{never}</span>;
  const how = loginMethodLabel(method ?? null);
  return <span title={`${dateTime(iso)}${how ? ` · ${how}` : ''}`}>{relative(iso)}</span>;
}

/**
 * The switch "2FA Pflicht" for one admin. Another admin who may manage the
 * account sets it either way; for the own account it can only be switched on
 * (the server checks the same). Owners follow the .env and get no switch.
 */
export function RequirementSwitch({
  username,
  security,
  self,
  owner,
  mayManage,
  onChanged,
}: {
  username: string;
  security: AdminLoginSecurity;
  self: boolean;
  owner: boolean;
  mayManage: boolean;
  onChanged: () => void;
}) {
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);
  const locked = owner || (!self && !mayManage) || (self && security.required) || busy;

  async function change(required: boolean) {
    setBusy(true);
    try {
      await adminApi.setSecondFactorRequired(username, required);
      showToast(required ? `2FA ist für ${username} jetzt Pflicht` : `2FA ist für ${username} keine Pflicht mehr`, 'success');
      onChanged();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Ändern fehlgeschlagen', 'error');
    } finally {
      setBusy(false);
    }
  }

  const hint = owner ? 'aus der .env' : security.source === 'default' ? 'Standard' : null;
  return (
    <span className="inline-flex items-center gap-2 text-[13px] text-ink-3" title={owner ? 'Server-Admins folgen ADMIN_REQUIRE_SECOND_FACTOR' : self && security.required ? 'Die eigene Pflicht kann nur ein anderer Admin aufheben' : undefined}>
      <Toggle checked={security.required} onChange={(next) => void change(next)} label={`2FA Pflicht für ${username}`} disabled={locked} />
      <span>Pflicht{hint ? <span className="text-ink-4"> · {hint}</span> : null}</span>
    </span>
  );
}
