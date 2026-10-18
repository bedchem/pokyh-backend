import { useState } from 'react';
import { AlertTriangle, Globe2, Pencil, Plus, School, Trash2 } from 'lucide-react';
import { adminApi } from '../api';
import { ownPermissions, useAccess } from '../access';
import { useToast } from './Toast';
import { Dialog, IconButton, Notice, Section, Segmented, Spinner, Tag } from './kit';
import { PermissionEditor } from './PermissionEditor';
import { relative } from './format';
import type { AccessCatalog, Permission, PermissionPreset } from '../types';

// The presets ("Vorlagen") for admin rights: the built-in ones, and the ones
// admins make themselves. Making, changing and removing them takes the right
// to manage global admins, and a preset only holds rights its author has
// (the server checks both). Grants keep their own rights, so changing or
// removing a preset never changes anyone's rights.

type Editing = { preset: PermissionPreset | null };

export function PresetManager({ catalog, onChanged }: { catalog: AccessCatalog; onChanged: () => void }) {
  const { me, canGlobal } = useAccess();
  const { showToast } = useToast();
  const mayManage = (me?.owner ?? false) || canGlobal('admins.global.manage');
  const [editing, setEditing] = useState<Editing | null>(null);
  const [removing, setRemoving] = useState<PermissionPreset | null>(null);
  const [busy, setBusy] = useState(false);

  async function remove(preset: PermissionPreset) {
    setBusy(true);
    try {
      await adminApi.deletePreset(preset.key);
      showToast(`Vorlage „${preset.label}“ gelöscht`, 'success');
      setRemoving(null);
      onChanged();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Löschen fehlgeschlagen', 'error');
    } finally {
      setBusy(false);
    }
  }

  const builtIn = catalog.presets.filter((p) => !p.custom);
  const own = catalog.presets.filter((p) => p.custom);

  return (
    <Section
      className="mt-[52px]"
      title="Vorlagen"
      meta={`${catalog.presets.length}`}
      action={mayManage ? (
        <button type="button" className="btn" onClick={() => setEditing({ preset: null })}>
          <Plus size={16} strokeWidth={1.8} /> Vorlage erstellen
        </button>
      ) : undefined}
    >
      <div className="mt-6 grid gap-x-10 gap-y-6 sm:grid-cols-2">
        {[...own, ...builtIn].map((p) => (
          <div key={p.key} className="min-w-0">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2 text-[15px] font-medium">
                {p.scope === 'global' ? <Globe2 size={15} strokeWidth={1.8} /> : <School size={15} strokeWidth={1.8} />}
                <span className="truncate">{p.label}</span>
                {p.custom ? <Tag tone="sky">eigene</Tag> : <Tag>eingebaut</Tag>}
              </div>
              {p.custom && mayManage && (
                <div className="flex shrink-0 gap-1">
                  <IconButton icon={Pencil} size={32} label={`Vorlage ${p.label} bearbeiten`} onClick={() => setEditing({ preset: p })} />
                  <IconButton icon={Trash2} size={32} tone="rose" label={`Vorlage ${p.label} löschen`} onClick={() => setRemoving(p)} />
                </div>
              )}
            </div>
            {p.description && <p className="mt-1 text-[13.5px] text-ink-3">{p.description}</p>}
            <p className="mt-1 text-[12.5px] text-ink-4">
              {p.permissions.length} Rechte · {p.scope === 'global' ? 'global' : 'für eine Schule'}
              {p.custom && p.createdBy ? ` · von ${p.createdBy}` : ''}
              {p.custom && p.updatedAt ? ` · geändert ${relative(p.updatedAt)}` : ''}
            </p>
          </div>
        ))}
      </div>

      {editing && (
        <PresetDialog
          catalog={catalog}
          preset={editing.preset}
          // A preset holds only rights its author has across the installation.
          own={() => ownPermissions(me, catalog, 'global')}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); onChanged(); }}
        />
      )}

      {removing && (
        <Dialog title="Vorlage löschen" subtitle={removing.label} onClose={() => setRemoving(null)}>
          <p className="text-[14px] leading-relaxed text-ink-2">
            Die Vorlage verschwindet aus der Auswahl. Admins, deren Rechte damit vergeben wurden, behalten genau diese Rechte;
            bei ihnen steht dann „Eigene Auswahl“.
          </p>
          <div className="mt-6 flex gap-3">
            <button type="button" className="btn btn-quiet flex-1" onClick={() => setRemoving(null)}>Abbrechen</button>
            <button type="button" className="btn btn-danger flex-1" disabled={busy} onClick={() => void remove(removing)}>
              {busy ? <Spinner /> : null}Löschen
            </button>
          </div>
        </Dialog>
      )}
    </Section>
  );
}

// Scope choices of a preset: one school (any) or the whole installation.
const SCHOOL_TEMPLATE = 'school-template';

function PresetDialog({ catalog, preset, own, onClose, onSaved }: {
  catalog: AccessCatalog;
  preset: PermissionPreset | null;
  own: (scope: string) => Set<Permission>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { showToast } = useToast();
  const [label, setLabel] = useState(preset?.label ?? '');
  const [description, setDescription] = useState(preset?.description ?? '');
  const [scope, setScope] = useState<'school' | 'global'>(preset?.scope ?? 'school');
  const [permissions, setPermissions] = useState<Permission[]>(preset?.permissions ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Global-only rights do not exist in a school preset.
  function changeScope(next: 'school' | 'global') {
    setScope(next);
    if (next === 'school') {
      const schoolOnly = new Set(catalog.permissions.filter((p) => p.scope === 'school').map((p) => p.key));
      setPermissions((current) => current.filter((p) => schoolOnly.has(p)));
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    const draft = { label, description, scope, permissions };
    try {
      if (preset) await adminApi.updatePreset(preset.key, draft);
      else await adminApi.createPreset(draft);
      showToast(preset ? `Vorlage „${label.trim()}“ gespeichert` : `Vorlage „${label.trim()}“ erstellt`, 'success');
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Speichern fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  }

  const editorScope = scope === 'global' ? 'global' : SCHOOL_TEMPLATE;
  return (
    <Dialog title={preset ? 'Vorlage bearbeiten' : 'Vorlage erstellen'} subtitle={preset?.label} onClose={onClose} width={640} sheet>
      <div className="flex flex-col gap-6">
        <label className="flex flex-col gap-2">
          <span className="text-[13px] text-ink-2">Name</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} required className="field h-[46px] w-full px-4 text-[14.5px]" placeholder="z. B. Mensa-Team" />
        </label>
        <label className="flex flex-col gap-2">
          <span className="text-[13px] text-ink-2">Beschreibung <span className="text-ink-4">(freiwillig)</span></span>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} rows={2} className="field w-full px-4 py-3 text-[14.5px]" placeholder="Wofür die Vorlage gedacht ist" />
        </label>
        <div className="flex flex-col gap-2">
          <span className="text-[13px] text-ink-2">Gilt</span>
          <Segmented
            label="Gültigkeit der Vorlage"
            value={scope}
            onChange={changeScope}
            options={[{ value: 'school', label: 'in einer Schule' }, { value: 'global', label: 'global (alle Schulen)' }]}
          />
        </div>

        <PermissionEditor
          catalog={catalog}
          scopes={[]}
          scope={editorScope}
          value={permissions}
          onChange={(next) => setPermissions(next)}
          own={own}
          kind={scope}
        />

        {preset && (
          <p className="text-[12.5px] text-ink-3">Wer Rechte mit dieser Vorlage bekommen hat, behält sie unverändert; neue Rechte gelten nur für künftige Vergaben.</p>
        )}
        {error && <Notice tone="rose" icon={AlertTriangle}>{error}</Notice>}
        <div className="flex gap-3">
          <button type="button" className="btn btn-quiet flex-1" onClick={onClose}>Abbrechen</button>
          <button type="button" className="btn btn-primary flex-1" disabled={busy || !label.trim() || permissions.length === 0} onClick={() => void save()}>
            {busy ? <Spinner /> : null}{preset ? 'Speichern' : 'Erstellen'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
