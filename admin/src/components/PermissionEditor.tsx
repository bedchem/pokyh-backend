import { useMemo } from 'react';
import { Check, Eye, Globe2, Lock, School, ShieldAlert } from 'lucide-react';
import { Tag, type Tone } from './kit';
import type { AccessCatalog, Permission, PermissionDef } from '../types';

// Choosing what an administrator may do, in one scope (all schools, or one
// school): start from a preset, adjust single rights, and see a summary of
// what the grant amounts to before saving. Rights the editing admin does not
// hold there are shown but cannot be ticked — the server refuses them anyway
// (nobody hands out more than they have).

export interface ScopeOption {
  value: string;
  label: string;
  kind: 'global' | 'school';
}

const ACTION: Record<PermissionDef['action'], { label: string; tone: Tone }> = {
  read: { label: 'Lesen', tone: 'sky' },
  create: { label: 'Anlegen', tone: 'mint' },
  update: { label: 'Ändern', tone: 'amber' },
  delete: { label: 'Löschen', tone: 'rose' },
  admin: { label: 'Verwalten', tone: 'violet' },
};

interface Props {
  catalog: AccessCatalog;
  scopes: ScopeOption[];
  scope: string;
  onScopeChange?: (scope: string) => void;
  value: Permission[];
  onChange: (next: Permission[], preset?: string) => void;
  // What the editing admin holds in a scope.
  own: (scope: string) => Set<Permission>;
}

export function PermissionEditor({ catalog, scopes, scope, onScopeChange, value, onChange, own }: Props) {
  const option = scopes.find((s) => s.value === scope);
  const isGlobal = option?.kind === 'global';
  const mine = own(scope);
  const chosen = useMemo(() => new Set(value), [value]);
  const available = catalog.permissions.filter((p) => isGlobal || p.scope === 'school');
  const groups = catalog.groups
    .map((g) => ({ ...g, items: available.filter((p) => p.group === g.key) }))
    .filter((g) => g.items.length > 0);
  const presets = catalog.presets.filter((p) => (p.scope === 'global') === isGlobal);
  const matching = presets.find((p) => p.permissions.length === chosen.size && p.permissions.every((k) => chosen.has(k)));

  const toggle = (key: Permission) => {
    if (!mine.has(key)) return;
    const next = new Set(chosen);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(catalog.permissions.map((p) => p.key).filter((k) => next.has(k)));
  };

  const applyPreset = (key: string) => {
    const preset = catalog.presets.find((p) => p.key === key);
    if (!preset) return;
    onChange(preset.permissions.filter((p) => mine.has(p)), key);
  };

  const byAction = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const p of catalog.permissions) if (chosen.has(p.key)) counts[p.action] = (counts[p.action] ?? 0) + 1;
    return counts;
  }, [catalog.permissions, chosen]);
  const readOnly = chosen.size > 0 && Object.keys(byAction).every((a) => a === 'read');
  const lacking = presets.find((p) => p.key === matching?.key)?.permissions.some((p) => !mine.has(p)) ?? false;

  return (
    <div className="flex flex-col gap-6">
      {/* Where the rights apply. */}
      {scopes.length > 0 && (
        <div>
          <div className="mb-2 text-[13px] text-ink-2">Gilt für</div>
          <div className="flex flex-wrap gap-2">
            {scopes.map((s) => (
              <button
                key={s.value}
                type="button"
                className="perm-scope"
                data-kind={s.kind}
                aria-pressed={s.value === scope}
                disabled={!onScopeChange}
                onClick={() => onScopeChange?.(s.value)}
              >
                {s.kind === 'global' ? <Globe2 size={15} strokeWidth={1.8} /> : <School size={15} strokeWidth={1.8} />}
                {s.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="mb-2 text-[13px] text-ink-2">Vorlage</div>
        <div className="flex flex-wrap gap-2">
          {presets.map((p) => (
            <button key={p.key} type="button" className="perm-preset" aria-pressed={matching?.key === p.key} onClick={() => applyPreset(p.key)} title={p.description}>
              {matching?.key === p.key && <Check size={14} strokeWidth={2.2} />}
              {p.label}
            </button>
          ))}
          <span className="perm-preset" data-static aria-pressed={!matching && chosen.size > 0}>{chosen.size === 0 ? 'Keine Rechte' : 'Eigene Auswahl'}</span>
        </div>
        {matching && <p className="mt-2 text-[12.5px] text-ink-3">{catalog.presets.find((p) => p.key === matching.key)?.description}</p>}
      </div>

      <div className="flex flex-col gap-5">
        {groups.map((g) => (
          <fieldset key={g.key} className="perm-group">
            <legend className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-4">{g.label}</legend>
            <div className="mt-2 flex flex-col">
              {g.items.map((p) => {
                const held = mine.has(p.key);
                const on = chosen.has(p.key);
                return (
                  <label key={p.key} className="perm-row" data-disabled={!held}>
                    <input type="checkbox" className="sr-only" checked={on} disabled={!held} onChange={() => toggle(p.key)} />
                    <span className="check" aria-hidden="true" data-on={on}><Check size={14} strokeWidth={2.4} /></span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-[14.5px] text-ink">{p.label}</span>
                        <Tag tone={ACTION[p.action].tone}>{ACTION[p.action].label}</Tag>
                        {p.scope === 'global' && <Tag tone="violet">nur global</Tag>}
                      </span>
                      <span className="mt-0.5 block text-[12.5px] leading-relaxed text-ink-3">
                        {p.description}{!held && ' — hast du hier selbst nicht, daher nicht vergebbar.'}
                      </span>
                    </span>
                    {!held && <Lock size={14} strokeWidth={1.8} className="mt-1 flex-shrink-0 text-ink-4" />}
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>

      {/* What saving amounts to. */}
      <div className="perm-summary" aria-live="polite">
        <div className="flex flex-wrap items-center gap-2 text-[14px] font-medium">
          {isGlobal ? <Globe2 size={16} strokeWidth={1.8} /> : <School size={16} strokeWidth={1.8} />}
          {chosen.size === 0 ? 'Keine Rechte — Speichern entzieht alle Rechte in diesem Bereich.' : `${chosen.size} ${chosen.size === 1 ? 'Recht' : 'Rechte'} für ${option?.label ?? ''}`}
        </div>
        {chosen.size > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {(['read', 'create', 'update', 'delete', 'admin'] as const).filter((a) => byAction[a]).map((a) => (
              <Tag key={a} tone={ACTION[a].tone}>{byAction[a]} × {ACTION[a].label}</Tag>
            ))}
          </div>
        )}
        <ul className="mt-3 flex flex-col gap-1.5 text-[12.5px] text-ink-2">
          {readOnly && <li className="flex items-center gap-2"><Eye size={13} strokeWidth={1.8} /> Nur Lesezugriff — kann nichts ändern oder löschen.</li>}
          {isGlobal && chosen.size > 0 && <li className="flex items-center gap-2"><Globe2 size={13} strokeWidth={1.8} /> Wirkt in allen Schulen, auch in künftigen.</li>}
          {(chosen.has('admins.manage') || chosen.has('admins.global.manage')) && <li className="flex items-center gap-2"><ShieldAlert size={13} strokeWidth={1.8} /> Darf selbst Admins ernennen — aber nie mehr Rechte vergeben, als er hat.</li>}
          {lacking && <li className="flex items-center gap-2"><Lock size={13} strokeWidth={1.8} /> Die Vorlage enthält Rechte, die du nicht hast; sie wurden weggelassen.</li>}
        </ul>
      </div>
    </div>
  );
}
