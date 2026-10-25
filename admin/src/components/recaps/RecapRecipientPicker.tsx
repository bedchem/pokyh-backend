import { useEffect, useMemo, useState } from 'react';
import { Check, GraduationCap, Plus, School, Search, UserRound, X } from 'lucide-react';
import { adminApi } from '../../api';
import type { RecapTargetClass, RecapTargetSchool, RecapTargetUser } from '../../types';
import { InfoTip } from '../cluster/explain';

// Who a recap is for: whole schools, classes of a school and single
// students, any number of each and in any mix. A recap that belongs to one
// school (every recap made in a school's view) picks inside that school only.

interface Props {
  /** The recap's own school: classes and students come from it, schools are not offered. */
  lockedSchool: { id: string; name: string } | null;
  schools: RecapTargetSchool[];
  classes: RecapTargetClass[];
  users: RecapTargetUser[];
  onSchools: (next: RecapTargetSchool[]) => void;
  onClasses: (next: RecapTargetClass[]) => void;
  onUsers: (next: RecapTargetUser[]) => void;
  invalid?: boolean;
}

const dimText = { color: 'rgb(var(--ink-rgb) / 0.62)' };
const chipOn = { background: 'var(--sky-wash)', color: 'var(--sky-deep)' };
const chipOff = { background: 'rgb(var(--ink-rgb) / calc(0.06 * var(--veil)))', color: 'rgb(var(--ink-rgb) / 0.86)' };
const classKey = (c: { schoolId: string; id: number }) => `${c.schoolId}:${c.id}`;

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on}
      className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] transition-colors"
      style={on ? chipOn : chipOff}>
      {on ? <Check size={13} strokeWidth={2} /> : <Plus size={13} strokeWidth={1.8} />}
      {children}
    </button>
  );
}

function Picked({ label, onRemove, children }: { label: string; onRemove: () => void; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full py-1 pl-3 pr-1.5 text-[12.5px]" style={chipOn}>
      {children}
      <button type="button" aria-label={`${label} entfernen`} onClick={onRemove}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full hover:bg-ink/[0.1]">
        <X size={12} strokeWidth={2} />
      </button>
    </span>
  );
}

export function RecapRecipientPicker({ lockedSchool, schools, classes, users, onSchools, onClasses, onUsers, invalid = false }: Props) {
  const [allSchools, setAllSchools] = useState<RecapTargetSchool[]>([]);
  // The school whose classes are listed.
  const [classSchool, setClassSchool] = useState<string | null>(lockedSchool?.id ?? null);
  const [schoolClasses, setSchoolClasses] = useState<RecapTargetClass[]>([]);
  const [classFilter, setClassFilter] = useState('');
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<RecapTargetUser[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    adminApi.getRecapTargets('', lockedSchool?.id).then((res) => {
      setAllSchools(res.schools);
      if (!lockedSchool && res.schools.length === 1) setClassSchool(res.schools[0]!.id);
    }).catch(() => setAllSchools([]));
  }, [lockedSchool]);

  useEffect(() => {
    if (!classSchool) { setSchoolClasses([]); return; }
    let alive = true;
    adminApi.getRecapTargets('', classSchool).then((res) => { if (alive) setSchoolClasses(res.classes); }).catch(() => { if (alive) setSchoolClasses([]); });
    return () => { alive = false; };
  }, [classSchool]);

  // Search as you type, a moment after the last key.
  useEffect(() => {
    const term = query.trim();
    if (!term) { setFound([]); return; }
    setSearching(true);
    const handle = window.setTimeout(() => {
      adminApi.getRecapTargets(term, lockedSchool?.id)
        .then((res) => setFound(res.users))
        .catch(() => setFound([]))
        .finally(() => setSearching(false));
    }, 250);
    return () => window.clearTimeout(handle);
  }, [query, lockedSchool]);

  const visibleClasses = useMemo(() => {
    const term = classFilter.trim().toLowerCase();
    return term ? schoolClasses.filter((entry) => entry.name.toLowerCase().includes(term)) : schoolClasses;
  }, [schoolClasses, classFilter]);
  const chosenSchools = new Set(schools.map((s) => s.id));
  const chosenClasses = new Set(classes.map(classKey));
  const chosenUsers = new Set(users.map((u) => u.stableUid));
  const multiSchool = !lockedSchool && allSchools.length > 1;

  function toggleSchool(s: RecapTargetSchool) {
    onSchools(chosenSchools.has(s.id) ? schools.filter((x) => x.id !== s.id) : [...schools, s]);
  }

  function toggleClass(c: RecapTargetClass) {
    onClasses(chosenClasses.has(classKey(c)) ? classes.filter((x) => classKey(x) !== classKey(c)) : [...classes, c]);
  }

  return (
    <div className="flex flex-col gap-5 rounded-[14px] p-4" style={{ background: 'rgb(var(--ink-rgb) / calc(0.04 * var(--veil)))', boxShadow: invalid ? 'inset 0 0 0 1.5px var(--rose-deep)' : undefined }}>
      {multiSchool && (
        <div>
          <span className="mb-2 flex items-center gap-1.5 text-[12.5px]" style={dimText}>
            <School size={14} /> Schulen {schools.length > 0 && `· ${schools.length} ausgewählt`}
            <InfoTip>Jeder Schüler dieser Schulen bekommt die Recap. Die Zahl zeigt, wie viele Schülerkonten die Schule gerade hat.</InfoTip>
          </span>
          <div className="flex max-h-[160px] flex-wrap gap-1.5 overflow-y-auto">
            {allSchools.map((s) => (
              <Chip key={s.id} on={chosenSchools.has(s.id)} onClick={() => toggleSchool(s)}>
                {s.name}
                <span style={{ opacity: 0.6 }}>{s.users ?? 0}</span>
              </Chip>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-[12.5px]" style={dimText}>
            <GraduationCap size={14} /> Klassen {classes.length > 0 && `· ${classes.length} ausgewählt`}
            <InfoTip>Alle Schüler, die mit dieser Klasse (WebUntis) angemeldet sind. Klassen gehören immer zu einer Schule — im globalen Bereich erst die Schule wählen.</InfoTip>
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {multiSchool && (
              <select value={classSchool ?? ''} onChange={(e) => setClassSchool(e.target.value || null)}
                className="field h-9 px-3 text-[12.5px]" aria-label="Schule der Klassen">
                <option value="">Schule wählen…</option>
                {allSchools.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            )}
            {schoolClasses.length > 12 && (
              <input value={classFilter} onChange={(e) => setClassFilter(e.target.value)} placeholder="Klasse suchen"
                className="field h-9 w-36 px-3 text-[12.5px]" aria-label="Klasse suchen" />
            )}
          </div>
        </div>
        {classes.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {classes.map((c) => (
              <Picked key={classKey(c)} label={c.name} onRemove={() => toggleClass(c)}>
                {c.name}{multiSchool && c.schoolName && <span style={{ opacity: 0.7 }}>· {c.schoolName}</span>}
              </Picked>
            ))}
          </div>
        )}
        {!classSchool ? (
          <p className="text-[12.5px]" style={dimText}>Schule wählen, um ihre Klassen zu sehen.</p>
        ) : schoolClasses.length === 0 ? (
          <p className="text-[12.5px]" style={dimText}>Noch keine Klassen bekannt — sie erscheinen, sobald sich Schüler angemeldet haben.</p>
        ) : (
          <div className="flex max-h-[180px] flex-wrap gap-1.5 overflow-y-auto">
            {visibleClasses.map((c) => (
              <Chip key={classKey(c)} on={chosenClasses.has(classKey(c))} onClick={() => toggleClass(c)}>
                {c.name || `Klasse ${c.id}`}
                <span style={{ opacity: 0.6 }}>{c.users ?? 0}</span>
              </Chip>
            ))}
          </div>
        )}
      </div>

      <div>
        <span className="mb-2 flex items-center gap-1.5 text-[12.5px]" style={dimText}>
          <UserRound size={14} /> Einzelne Schüler {users.length > 0 && `· ${users.length} ausgewählt`}
          <InfoTip>Nach dem Benutzernamen suchen und hinzufügen. Sie bekommen die Recap zusätzlich zu den gewählten Schulen und Klassen. Eltern-Konten nur so, einzeln gewählt.</InfoTip>
        </span>
        {users.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {users.map((u) => (
              <Picked key={u.stableUid} label={u.username} onRemove={() => onUsers(users.filter((x) => x.stableUid !== u.stableUid))}>
                {u.username}{u.klasseName && <span style={{ opacity: 0.7 }}>· {u.klasseName}</span>}
              </Picked>
            ))}
          </div>
        )}
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2" style={dimText} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Benutzername suchen…"
            className="field h-10 w-full pl-9 pr-4 text-[13px]" aria-label="Schüler suchen" spellCheck={false} autoCapitalize="off" />
        </div>
        {query.trim() && (
          <div className="mt-2 flex max-h-[200px] flex-col overflow-y-auto rounded-[12px]" style={{ background: 'rgb(var(--ink-rgb) / calc(0.04 * var(--veil)))' }}>
            {searching && found.length === 0 ? (
              <span className="px-3 py-2 text-[12.5px]" style={dimText}>Suche…</span>
            ) : found.length === 0 ? (
              <span className="px-3 py-2 text-[12.5px]" style={dimText}>Niemand gefunden.</span>
            ) : found.map((u) => {
              const on = chosenUsers.has(u.stableUid);
              return (
                <button key={u.stableUid} type="button" disabled={on}
                  onClick={() => onUsers([...users, u])}
                  className="flex items-center justify-between gap-3 px-3 py-2 text-left text-[13px] hover:bg-ink/[0.06] disabled:opacity-50">
                  <span className="min-w-0 truncate">
                    {u.username}
                    <span style={dimText}>
                      {u.klasseName && ` · ${u.klasseName}`}
                      {multiSchool && u.schoolName && ` · ${u.schoolName}`}
                      {u.role === 'parent' && ' · Eltern'}
                    </span>
                  </span>
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
