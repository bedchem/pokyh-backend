import { useEffect, useMemo, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { adminApi } from '../api';
import { manageableScopes, ownPermissions, useAccess } from '../access';
import { Dialog, Notice, Spinner } from './kit';
import { PermissionEditor } from './PermissionEditor';
import { GrantAdminDialog } from './GrantAdminDialog';
import type { AccessCatalog, GrantInput, Permission } from '../types';

// Making an account an admin: first what they may do and where (a preset
// to start from, adjustable), then — for a WebUntis account, which has no
// password the panel accepts — a one-time password. Nothing is created
// before the rights are chosen, and the server checks every right again.

interface Props {
  stableUid: string;
  username: string;
  schoolId: string | null;
  needsOneTimePassword: boolean;
  onClose: () => void;
  onDone: (adminSetupExpiresAt: string | null) => void;
}

export function AppointAdminDialog({ stableUid, username, schoolId, needsOneTimePassword, onClose, onDone }: Props) {
  const { me, view } = useAccess();
  const [catalog, setCatalog] = useState<AccessCatalog | null>(null);
  const scopes = useMemo(() => manageableScopes(me), [me]);
  const initialScope = (view?.kind === 'school' && scopes.some((s) => s.value === view.school.id) ? view.school.id : null)
    ?? (schoolId && scopes.some((s) => s.value === schoolId) ? schoolId : null)
    ?? scopes[0]?.value ?? '';
  const [scope, setScope] = useState(initialScope);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [preset, setPreset] = useState<string | undefined>();
  const [step, setStep] = useState<'rights' | 'password'>('rights');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminApi.accessCatalog().then((c) => {
      setCatalog(c);
      // Least privilege: a school starts from read-only, the global scope
      // from nothing — every global right is a deliberate choice.
      const viewer = initialScope === 'global' ? undefined : c.presets.find((p) => p.key === 'viewer');
      if (viewer) { setPermissions(viewer.permissions.filter((p) => ownPermissions(me, c, initialScope).has(p))); setPreset(viewer.key); }
    }).catch((err) => setError(err instanceof Error ? err.message : 'Rechte konnten nicht geladen werden'));
  }, [me, initialScope]);

  const grant: GrantInput = { scope, permissions, preset };

  async function next() {
    if (permissions.length === 0) {
      setError('Wähle mindestens ein Recht — sonst kann sich das Konto anmelden, aber nichts tun.');
      return;
    }
    if (needsOneTimePassword) {
      setStep('password');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await adminApi.grantAdmin(stableUid, undefined, grant);
      onDone(result.adminSetupExpiresAt);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Admin ernennen fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  }

  if (step === 'password') {
    return <GrantAdminDialog stableUid={stableUid} username={username} grant={grant} onClose={onClose} onGranted={onDone} />;
  }

  return (
    <Dialog title="Admin ernennen" subtitle={username} onClose={onClose} width={640}>
      {scopes.length === 0 ? (
        <Notice tone="amber">Du darfst in keiner Schule Admins ernennen.</Notice>
      ) : !catalog ? (
        <Spinner />
      ) : (
        <div className="flex flex-col gap-6">
          <PermissionEditor
            catalog={catalog}
            scopes={scopes}
            scope={scope}
            onScopeChange={(next) => {
              setScope(next);
              const own = ownPermissions(me, catalog, next);
              setPermissions((current) => current.filter((p) => own.has(p) && (next === 'global' || catalog.permissions.find((d) => d.key === p)?.scope === 'school')));
              setPreset(undefined);
            }}
            value={permissions}
            onChange={(nextPermissions, nextPreset) => { setPermissions(nextPermissions); setPreset(nextPreset); setError(null); }}
            own={(s) => ownPermissions(me, catalog, s)}
          />
          {error && <Notice tone="rose">{error}</Notice>}
          <div className="flex gap-3">
            <button type="button" onClick={onClose} className="btn btn-quiet flex-1">Abbrechen</button>
            <button type="button" disabled={busy} onClick={() => void next()} className="btn btn-primary flex-1">
              {busy ? <Spinner /> : <ShieldCheck size={16} strokeWidth={1.7} />}
              {needsOneTimePassword ? 'Weiter zum Einmal-Passwort' : 'Admin ernennen'}
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
