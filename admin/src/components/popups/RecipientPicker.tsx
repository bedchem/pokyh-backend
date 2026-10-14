import { useEffect, useMemo, useState } from 'react';
import { Check, GraduationCap, Plus, Search, UserRound, X } from 'lucide-react';
import { adminApi } from '../../api';
import type { PopupTargetClass, PopupTargetUser } from '../../types';
import { InfoTip } from '../cluster/explain';

// Who a popup is meant for: whole classes and/or single users, any number of
// each. Nothing chosen = everybody the platform and audience allow.

interface Props {
  users: PopupTargetUser[];
  classes: number[];
  onUsers: (next: PopupTargetUser[]) => void;
  onClasses: (next: number[]) => void;
  invalid?: boolean;
}

const dimText = { color: 'rgb(var(--ink-rgb) / 0.62)' };

export function RecipientPicker({ users, classes, onUsers, onClasses, invalid = false }: Props) {
  const [allClasses, setAllClasses] = useState<PopupTargetClass[]>([]);
  const [classFilter, setClassFilter] = useState('');
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<PopupTargetUser[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    adminApi.getPopupTargets('').then((res) => setAllClasses(res.classes)).catch(() => setAllClasses([]));
  }, []);

  // Search as you type, a moment after the last key.
  useEffect(() => {
    const term = query.trim();
    if (!term) { setFound([]); return; }
    setSearching(true);
    const handle = window.setTimeout(() => {
      adminApi.getPopupTargets(term)
        .then((res) => setFound(res.users))
        .catch(() => setFound([]))
        .finally(() => setSearching(false));
    }, 250);
    return () => window.clearTimeout(handle);
  }, [query]);

  const visibleClasses = useMemo(() => {
    const term = classFilter.trim().toLowerCase();
    return term ? allClasses.filter((entry) => entry.name.toLowerCase().includes(term)) : allClasses;
  }, [allClasses, classFilter]);
  const chosen = new Set(classes);
  const chosenUsers = new Set(users.map((user) => user.stableUid));

  function toggleClass(id: number) {
    onClasses(chosen.has(id) ? classes.filter((value) => value !== id) : [...classes, id]);
  }

  return (
    <div className="flex flex-col gap-4 rounded-[14px] p-4" style={{ background: 'rgb(var(--ink-rgb) / calc(0.04 * var(--veil)))', boxShadow: invalid ? 'inset 0 0 0 1.5px var(--rose-deep)' : undefined }}>
      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-[12.5px]" style={dimText}>
            <GraduationCap size={14} /> Klassen {classes.length > 0 && `· ${classes.length} ausgewählt`}
            <InfoTip>Alle angemeldeten Schüler, die mit dieser Klasse (WebUntis) angemeldet sind, sehen das Popup. Die Zahl zeigt, wie viele Konten die Klasse gerade hat.</InfoTip>
          </span>
          {allClasses.length > 12 && (
            <input value={classFilter} onChange={(e) => setClassFilter(e.target.value)} placeholder="Klasse suchen"
              className="field h-9 w-40 px-3 text-[12.5px]" aria-label="Klasse suchen" />
          )}
        </div>
        {allClasses.length === 0 ? (
          <p className="text-[12.5px]" style={dimText}>Noch keine Klassen bekannt — sie erscheinen, sobald sich Schüler angemeldet haben.</p>
        ) : (
          <div className="flex max-h-[180px] flex-wrap gap-1.5 overflow-y-auto">
            {visibleClasses.map((entry) => {
              const on = chosen.has(entry.id);
              return (
                <button key={entry.id} type="button" onClick={() => toggleClass(entry.id)} aria-pressed={on}
                  className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] transition-colors"
                  style={on
                    ? { background: 'var(--sky-wash)', color: 'var(--sky-deep)' }
                    : { background: 'rgb(var(--ink-rgb) / calc(0.06 * var(--veil)))', color: 'rgb(var(--ink-rgb) / 0.86)' }}>
                  {on ? <Check size={13} strokeWidth={2} /> : <Plus size={13} strokeWidth={1.8} />}
                  {entry.name || `Klasse ${entry.id}`}
                  <span style={{ opacity: 0.6 }}>{entry.users}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div>
        <span className="mb-2 flex items-center gap-1.5 text-[12.5px]" style={dimText}>
          <UserRound size={14} /> Einzelne Benutzer {users.length > 0 && `· ${users.length} ausgewählt`}
          <InfoTip>Nach dem Benutzernamen suchen und hinzufügen. Diese Personen sehen das Popup zusätzlich zu den gewählten Klassen — auch wenn sie in keiner davon sind.</InfoTip>
        </span>
        {users.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {users.map((user) => (
              <span key={user.stableUid} className="inline-flex items-center gap-1.5 rounded-full py-1 pl-3 pr-1.5 text-[12.5px]"
                style={{ background: 'var(--sky-wash)', color: 'var(--sky-deep)' }}>
                {user.username}{user.klasseName && <span style={{ opacity: 0.7 }}>· {user.klasseName}</span>}
                <button type="button" aria-label={`${user.username} entfernen`} onClick={() => onUsers(users.filter((entry) => entry.stableUid !== user.stableUid))}
                  className="inline-flex h-5 w-5 items-center justify-center rounded-full hover:bg-ink/[0.1]">
                  <X size={12} strokeWidth={2} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2" style={dimText} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Benutzername suchen…"
            className="field h-10 w-full pl-9 pr-4 text-[13px]" aria-label="Benutzer suchen" spellCheck={false} autoCapitalize="off" />
        </div>
        {query.trim() && (
          <div className="mt-2 flex max-h-[200px] flex-col overflow-y-auto rounded-[12px]" style={{ background: 'rgb(var(--ink-rgb) / calc(0.04 * var(--veil)))' }}>
            {searching && found.length === 0 ? (
              <span className="px-3 py-2 text-[12.5px]" style={dimText}>Suche…</span>
            ) : found.length === 0 ? (
              <span className="px-3 py-2 text-[12.5px]" style={dimText}>Niemand gefunden.</span>
            ) : found.map((user) => {
              const on = chosenUsers.has(user.stableUid);
              return (
                <button key={user.stableUid} type="button" disabled={on}
                  onClick={() => onUsers([...users, user])}
                  className="flex items-center justify-between gap-3 px-3 py-2 text-left text-[13px] hover:bg-ink/[0.06] disabled:opacity-50">
                  <span className="min-w-0 truncate">{user.username}{user.klasseName && <span style={dimText}> · {user.klasseName}</span>}</span>
                  {on ? <Check size={14} strokeWidth={2} style={{ color: 'var(--mint-deep)' }} /> : <Plus size={14} strokeWidth={1.8} />}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
