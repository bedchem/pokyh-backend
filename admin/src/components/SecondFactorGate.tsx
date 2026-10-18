import { LogOut, ShieldAlert } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { useAccess } from '../access';
import { AccountSecurity } from './AccountSecurity';
import { Notice } from './kit';

// Signed in, but something required is not set up yet (the authenticator app,
// always; a passkey where it is required): the panel shows only this until it
// is (the server refuses everything else meanwhile). Each step reloads the own
// access, which opens the panel once nothing is missing.
export function SecondFactorGate() {
  const { me, refresh } = useAccess();
  const { logout } = useAuth();
  const missing = me?.secondFactorMissing ?? ['totp'];
  const what = missing.length === 2
    ? 'die Authenticator-App und einen Passkey'
    : missing[0] === 'passkey' ? 'einen Passkey' : 'die Authenticator-App';
  return (
    <div className="min-h-screen bg-canvas px-5 py-12 md:py-20">
      <div className="mx-auto max-w-[720px]">
        <h1 className="text-[26px] font-semibold tracking-[-0.02em]">Anmeldung absichern</h1>
        <div className="mt-5">
          <Notice tone="amber" icon={ShieldAlert}>
            Für Admin-Konten ist die Zwei-Faktor-Anmeldung Pflicht. Richte für <span className="font-medium">{me?.username}</span> jetzt {what} ein;
            danach öffnet sich das Panel.
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
