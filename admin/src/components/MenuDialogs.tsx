import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Check, School, UtensilsCrossed } from 'lucide-react';
import { adminApi } from '../api';
import type { AdminSchool, MensaMenu } from '../types';
import { useToast } from './Toast';
import { Dialog, FieldLabel, Notice, SearchField, Segmented, Spinner, Tag } from './kit';
import { Highlight } from './Highlight';
import { num } from './format';

// Creating, renaming and deleting a Mensa plan, and choosing the schools it
// serves — the same dialogs on the Speiseplan and the Schulen page.

export function MenuNameDialog({ menu, onClose, onSaved }: {
  menu: MensaMenu | null;
  onClose: () => void;
  // The plan's id (a new one's, to select it and assign schools next).
  onSaved: (menuId: string) => void;
}) {
  const { showToast } = useToast();
  const [name, setName] = useState(menu?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (menu) {
        await adminApi.renameMenu(menu.id, name.trim());
        showToast('Mensaplan umbenannt', 'success');
        onSaved(menu.id);
      } else {
        const created = await adminApi.createMenu(name.trim());
        showToast('Mensaplan angelegt — jetzt Schulen zuweisen', 'success');
        onSaved(created.menu.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Speichern fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={menu ? 'Mensaplan umbenennen' : 'Neuer Mensaplan'} subtitle={menu ? menu.name : 'Danach wählst du die Schulen, die ihn zeigen.'} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-5">
        <FieldLabel label="Name"><input className="field h-12 px-4 text-[14.5px]" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} autoFocus /></FieldLabel>
        {error && <Notice tone="rose">{error}</Notice>}
        <div className="flex gap-3">
          <button type="button" onClick={onClose} className="btn btn-quiet flex-1">Abbrechen</button>
          <button type="submit" disabled={busy || !name.trim()} className="btn btn-primary flex-1">{busy ? <Spinner /> : null}{menu ? 'Speichern' : 'Anlegen'}</button>
        </div>
      </form>
    </Dialog>
  );
}

export function MenuDeleteDialog({ menu, onClose, onDeleted }: { menu: MensaMenu; onClose: () => void; onDeleted: () => void }) {
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await adminApi.deleteMenu(menu.id);
      showToast('Mensaplan gelöscht', 'success');
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Löschen fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="Mensaplan löschen" subtitle={menu.name} onClose={onClose}>
      <p className="text-[14px] leading-relaxed text-ink-2">
        Löscht den Plan mit allen {num(menu.dishes)} Gerichten und ihren Bildern. Bewertungen und Kommentare bleiben gespeichert, sind aber keinem Plan mehr zugeordnet.
      </p>
      {error && <div className="mt-4"><Notice tone="rose">{error}</Notice></div>}
      <div className="mt-6 flex gap-3">
        <button type="button" className="btn btn-quiet flex-1" onClick={onClose}>Abbrechen</button>
        <button type="button" className="btn btn-danger flex-1" disabled={busy} onClick={() => void remove()}>{busy ? <Spinner /> : null}Löschen</button>
      </div>
    </Dialog>
  );
}

type Filter = 'all' | 'this' | 'none' | 'other';

// Which schools show a plan: tick them. A school shows one plan, so ticking
// one that shows another moves it here; unticking one leaves it without a
// Mensa. Everything is applied in one step on "Speichern".
export function MenuSchoolsDialog({ menu, onClose, onSaved }: { menu: MensaMenu; onClose: () => void; onSaved: () => void }) {
  const { showToast } = useToast();
  const [schools, setSchools] = useState<AdminSchool[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(menu.schools.map((s) => s.id)));
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminApi.schools()
      .then(({ schools: list }) => {
        setSchools(list);
        // The server's current state is the starting point.
        setSelected(new Set(list.filter((s) => s.menu?.id === menu.id).map((s) => s.id)));
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Schulen konnten nicht geladen werden'));
  }, [menu.id]);

  const original = useMemo(() => new Set((schools ?? []).filter((s) => s.menu?.id === menu.id).map((s) => s.id)), [schools, menu.id]);
  const byId = useMemo(() => new Map((schools ?? []).map((s) => [s.id, s])), [schools]);

  const counts = useMemo(() => {
    const list = schools ?? [];
    return {
      all: list.length,
      this: list.filter((s) => s.menu?.id === menu.id).length,
      none: list.filter((s) => !s.menu).length,
      other: list.filter((s) => s.menu && s.menu.id !== menu.id).length,
    };
  }, [schools, menu.id]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (schools ?? [])
      .filter((s) => filter === 'all'
        || (filter === 'this' && s.menu?.id === menu.id)
        || (filter === 'none' && !s.menu)
        || (filter === 'other' && !!s.menu && s.menu.id !== menu.id))
      .filter((s) => !q || [s.name, s.shortName, s.slug, s.webuntisSchool ?? ''].some((v) => v.toLowerCase().includes(q)))
      .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }, [schools, query, filter, menu.id]);

  const added = [...selected].filter((id) => !original.has(id));
  const removed = [...original].filter((id) => !selected.has(id));
  const moved = added.filter((id) => !!byId.get(id)?.menu);
  const changed = added.length + removed.length > 0;
  const allVisibleSelected = visible.length > 0 && visible.every((s) => selected.has(s.id));

  function toggle(id: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
  }

  function toggleVisible() {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const s of visible) {
        if (allVisibleSelected) next.delete(s.id); else next.add(s.id);
      }
      return next;
    });
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await adminApi.setMenuSchools(menu.id, [...selected]);
      const parts = [
        res.added.length > 0 && `${res.added.length} ${res.added.length === 1 ? 'Schule zeigt' : 'Schulen zeigen'} ihn jetzt`,
        res.removed.length > 0 && `${res.removed.length} ohne Mensa`,
      ].filter(Boolean);
      showToast(parts.length > 0 ? `„${menu.name}“: ${parts.join(', ')}` : 'Keine Änderung', 'success');
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Zuweisen fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  }

  function status(s: AdminSchool): { text: string; tone: 'mint' | 'amber' | 'rose' | 'ink' | 'sky' } {
    const isOn = selected.has(s.id);
    const wasOn = original.has(s.id);
    if (isOn && wasOn) return { text: 'zeigt diesen Plan', tone: 'sky' };
    if (isOn && s.menu) return { text: `wechselt von „${s.menu.name}“`, tone: 'amber' };
    if (isOn) return { text: 'bekommt diesen Plan', tone: 'mint' };
    if (wasOn) return { text: 'zeigt danach keine Mensa', tone: 'rose' };
    if (s.menu) return { text: `zeigt „${s.menu.name}“`, tone: 'ink' };
    return { text: 'kein Mensaplan', tone: 'ink' };
  }

  return (
    <Dialog title="Schulen zuweisen" subtitle={`Welche Schulen „${menu.name}“ zeigen`} onClose={onClose} width={640}>
      {!schools ? (
        error ? <Notice tone="rose">{error}</Notice> : <div className="py-10"><Spinner /></div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <SearchField value={query} onChange={setQuery} placeholder="Schule suchen" className="w-full sm:flex-1" />
          </div>
          <div className="-mx-1 overflow-x-auto px-1 pb-1">
            <Segmented
              label="Schulen filtern"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: <>Alle <span className="opacity-60">{counts.all}</span></> },
                { value: 'this', label: <>Dieser Plan <span className="opacity-60">{counts.this}</span></> },
                { value: 'none', label: <>Ohne Plan <span className="opacity-60">{counts.none}</span></> },
                { value: 'other', label: <>Anderer Plan <span className="opacity-60">{counts.other}</span></> },
              ]}
            />
          </div>

          <div className="flex items-center justify-between gap-3 text-[13px] text-ink-3">
            <span>{num(selected.size)} von {num(schools.length)} ausgewählt</span>
            {visible.length > 0 && (
              <button type="button" className="font-medium text-sky-deep hover:underline" onClick={toggleVisible}>
                {allVisibleSelected ? 'Angezeigte abwählen' : 'Angezeigte auswählen'}
              </button>
            )}
          </div>

          <ul className="menu-school-list" aria-label="Schulen">
            {visible.map((s) => {
              const st = status(s);
              const on = selected.has(s.id);
              return (
                <li key={s.id}>
                  <label className="menu-school-row" data-on={on}>
                    <input type="checkbox" className="sr-only" checked={on} onChange={(e) => toggle(s.id, e.target.checked)} />
                    <span className="check" aria-hidden="true"><Check size={14} strokeWidth={2.4} /></span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-[14.5px] font-medium"><Highlight text={s.name} query={query} /></span>
                        {!s.active && <Tag tone="rose">deaktiviert</Tag>}
                      </span>
                      <span className="mt-0.5 block truncate text-[12.5px]" style={{ color: st.tone === 'ink' ? 'var(--ink-3)' : `var(--${st.tone}-deep)` }}>
                        {st.text}{s.users !== undefined ? <span className="text-ink-3"> · {num(s.users)} Konten</span> : null}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
            {visible.length === 0 && <li className="px-3 py-6 text-center text-[13.5px] text-ink-3">Keine Schule passt.</li>}
          </ul>

          {removed.length > 0 && (
            <Notice tone="rose" icon={UtensilsCrossed}>
              {removed.length === 1 ? `${byId.get(removed[0]!)?.name ?? 'Eine Schule'} zeigt` : `${removed.length} Schulen zeigen`} danach keine Mensa mehr.
            </Notice>
          )}
          {moved.length > 0 && (
            <Notice tone="amber" icon={School}>
              {moved.length === 1 ? `${byId.get(moved[0]!)?.name} wechselt` : `${moved.length} Schulen wechseln`} von ihrem bisherigen Plan zu „{menu.name}“.
            </Notice>
          )}
          {error && <Notice tone="rose">{error}</Notice>}

          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center">
            <span className="flex-1 text-[13px] text-ink-3">
              {changed
                ? [added.length > 0 && `${added.length} dazu`, removed.length > 0 && `${removed.length} weg`].filter(Boolean).join(' · ')
                : 'Noch keine Änderung'}
            </span>
            <button type="button" onClick={onClose} className="btn btn-quiet">Abbrechen</button>
            <button type="button" disabled={busy || !changed} onClick={() => void save()} className="btn btn-primary">
              {busy ? <Spinner /> : <Check size={16} strokeWidth={2} />}
              Speichern
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
