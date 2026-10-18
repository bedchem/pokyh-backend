import { LogOut, ShieldAlert } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { useAccess } from '../access';
import { AccountSecurity } from './AccountSecurity';
import { Notice } from './kit';

// Signed in, but a second factor is required and none is set up yet: the
// panel shows only this until an authenticator app or a passkey is set up
// (the server refuses everything else meanwhile). Setting one up reloads the
// own access, which then opens the panel.
export function SecondFactorGate() {
  const { me, refresh } = useAccess();
  const { logout } = useAuth();
  return (
    <div className="min-h-screen bg-canvas px-5 py-12 md:py-20">
      <div className="mx-auto max-w-[720px]">
        <h1 className="text-[26px] font-semibold tracking-[-0.02em]">Zweiten Faktor einrichten</h1>
        <div className="mt-5">
          <Notice tone="amber" icon={ShieldAlert}>
            Für das Admin-Konto <span className="font-medium">{me?.username}</span> ist eine Zwei-Faktor-Anmeldung Pflicht.
            Richte eine Authenticator-App oder einen Passkey ein; danach öffnet sich das Panel.
          </Notice>
        </div>
        <div className="mt-8">
          <AccountSecurity factorsOnly onChange={() => { void refresh(); }} />
        </div>
        <button
          type="button"
          className="btn btn-quiet mt-8"
          onClick={() => { logout(); window.location.assign(`${import.meta.env.BASE_URL}login`); }}
        >
          <LogOut size={16} strokeWidth={1.7} /> Abmelden
        </button>
      </div>
    </div>
  );
}
