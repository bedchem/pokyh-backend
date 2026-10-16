import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Pencil, Plus, School, Trash2, UtensilsCrossed, Users, ShieldCheck, Sparkles } from 'lucide-react';
import { adminApi } from '../api';
import { useAccess } from '../access';
import { useLive } from '../live';
import { useToast } from '../components/Toast';
import { Dialog, Empty, FieldLabel, Figures, IconButton, Notice, PageHeader, SearchField, Section, Spinner, Status, Tag, Toggle, useTableLabels } from '../components/kit';
import { dateTime, num } from '../components/format';
import type { AdminSchool, MensaMenu } from '../types';
import { MenuDeleteDialog, MenuNameDialog, MenuSchoolsDialog } from '../components/MenuDialogs';

// Every school using Pokyh, and the menus (Mensapläne) they show. Schools are
// not created here: any school on WebUntis joins on the first sign-in of one
// of its accounts, and arrives without a menu (its app shows none until one
// is assigned). A menu can serve several schools.

// Joined within this many days: marked as new.
const NEW_DAYS = 14;

export function SchoolsPage() {
  const { can, me, setView, refresh } = useAccess();
  const { showToast } = useToast();
  const [schools, setSchools] = useState<AdminSchool[] | null>(null);
  const [menus, setMenus] = useState<MensaMenu[]>([]);
  const [editing, setEditing] = useState<AdminSchool | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'nomenu' | 'inactive'>('all');
  const [menuDialog, setMenuDialog] = useState<MensaMenu | 'new' | null>(null);
  const [deletingMenu, setDeletingMenu] = useState<MensaMenu | null>(null);
  const [assigning, setAssigning] = useState<MensaMenu | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  useTableLabels(tableRef);
  const manage = can('schools.manage');

  const load = useCallback(async () => {
    try {
      const [s, m] = await Promise.all([adminApi.schools(), adminApi.menus()]);
      setSchools(s.schools);
      setMenus(m.menus);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Schulen konnten nicht geladen werden', 'error');
    }
  }, [showToast]);

  useEffect(() => { void load(); }, [load]);
  useLive(['schools', 'users', 'access'], () => { void load(); });

  async function assign(school: AdminSchool, menuId: string) {
    try {
      await adminApi.assignMenu(school.id, menuId || null);
      showToast(menuId ? 'Mensaplan zugewiesen' : 'Mensaplan entfernt — die Schule zeigt keinen Speiseplan', 'success');
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Zuweisen fehlgeschlagen', 'error');
    }
  }

  function open(school: AdminSchool) {
    const entry = me?.schools.find((s) => s.id === school.id);
    if (entry) setView({ kind: 'school', school: entry });
  }

  const totalUsers = (schools ?? []).reduce((sum, s) => sum + (s.users ?? 0), 0);
  const withoutMenu = (schools ?? []).filter((s) => !s.menu && s.active).length;
  const isNew = (s: AdminSchool) => s.origin === 'webuntis' && Date.now() - new Date(s.createdAt).getTime() < NEW_DAYS * 86_400_000;

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (schools ?? [])
      .filter((s) => filter === 'all' || (filter === 'nomenu' ? !s.menu : !s.active))
      .filter((s) => !q || [s.name, s.shortName, s.slug, s.webuntisSchool ?? ''].some((v) => v.toLowerCase().includes(q)))
      // Newest arrivals first, then by name.
      .sort((a, b) => Number(isNew(b)) - Number(isNew(a)) || a.name.localeCompare(b.name, 'de'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schools, search, filter]);

  return (
    <div>
      <PageHeader title="Schulen" subtitle="Jede Schule auf WebUntis kann Pokyh nutzen: Sie erscheint hier von selbst, sobald sich das erste Konto der Schule anmeldet. Daten, Rechte und Statistiken sind pro Schule getrennt." />

      {manage && withoutMenu > 0 && (
        <div className="mt-8 max-w-[760px]">
          <Notice tone="amber" icon={UtensilsCrossed}>
            {withoutMenu === 1 ? 'Eine aktive Schule hat' : `${withoutMenu} aktive Schulen haben`} keinen Mensaplan — ihre App zeigt deshalb keine Mensa. Weise unten einen Plan zu, sobald es einen gibt.
          </Notice>
        </div>
      )}

      <Figures
        className="mt-8"
        items={[
          { label: 'Schulen', value: schools?.length ?? 0, icon: School, note: <span className="text-[12.5px] text-ink-3">{(schools ?? []).filter((s) => !s.active).length} deaktiviert</span> },
          { label: 'Konten', value: totalUsers, icon: Users },
          { label: 'Mensapläne', value: menus.length, icon: UtensilsCrossed, note: <span className="text-[12.5px] text-ink-3">{(schools ?? []).filter((s) => !s.menu).length} Schulen ohne</span> },
        ]}
      />

      <Section
        className="mt-[46px]"
        title="Schulen"
        meta={shown.length === (schools?.length ?? 0) ? undefined : `${shown.length} von ${schools?.length ?? 0}`}
        action={(
          <>
            {(schools?.length ?? 0) > 6 && <SearchField value={search} onChange={setSearch} placeholder="Name oder WebUntis-Kennung" className="w-full sm:w-[240px]" />}
            <select className="field h-11 px-4 text-[14px]" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} aria-label="Schulen filtern">
              <option value="all">Alle</option>
              <option value="nomenu">Ohne Mensaplan</option>
              <option value="inactive">Deaktiviert</option>
            </select>
          </>
        )}
      >
        {!schools ? (
          <div className="mt-8"><Spinner /></div>
        ) : shown.length === 0 ? (
          <Empty icon={School}>{schools.length === 0 ? 'Noch keine Schule — sie erscheint mit der ersten Anmeldung.' : 'Keine Schule passt zum Filter.'}</Empty>
        ) : (
          <div ref={tableRef} className="tbl-scroll mt-6">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Schule</th>
                  <th className="hidden md:table-cell">WebUntis</th>
                  <th className="text-right">Konten</th>
                  <th className="hidden text-right sm:table-cell">Admins</th>
                  <th>Mensaplan</th>
                  <th><span className="sr-only">Aktionen</span></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2 font-medium">
                          {s.name}
                          {s.isDefault && <Tag>Standard</Tag>}
                          {isNew(s) && <Tag tone="mint"><Sparkles size={11} /> neu</Tag>}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-3">
                          <span title={dateTime(s.createdAt)}>{s.origin === 'webuntis' ? `dabei seit ${new Date(s.createdAt).toLocaleDateString('de-AT', { day: 'numeric', month: 'short', year: 'numeric' })}` : 'Schule der Installation'}</span>
                          {!s.active && <Status tone="rose">deaktiviert</Status>}
                        </div>
                      </div>
                    </td>
                    <td className="hidden font-mono text-[13px] text-ink-2 md:table-cell">{s.webuntisSchool ?? '–'}</td>
                    <td className="tabular text-right">{num(s.users ?? 0)}</td>
                    <td className="tabular hidden text-right sm:table-cell">{num(s.admins ?? 0)}</td>
                    <td>
                      {manage ? (
                        <select
                          className="field h-10 max-w-[220px] px-3 text-[13.5px]"
                          value={s.menu?.id ?? ''}
                          onChange={(e) => void assign(s, e.target.value)}
                          aria-label={`Mensaplan von ${s.name}`}
                        >
                          <option value="">Kein Mensaplan</option>
                          {menus.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                        </select>
                      ) : (s.menu?.name ?? <span className="text-ink-3">kein Plan</span>)}
                    </td>
                    <td>
                      <div className="row-actions">
                        {manage && <IconButton icon={Pencil} label={`${s.name} bearbeiten`} onClick={() => setEditing(s)} />}
                        {me?.schools.some((x) => x.id === s.id) && <IconButton icon={ArrowRight} label={`Zu ${s.name} wechseln`} onClick={() => open(s)} />}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section
        className="mt-[52px]"
        title="Mensapläne"
        meta={`${menus.length}`}
        action={manage ? <button type="button" className="btn btn-quiet btn-sm" onClick={() => setMenuDialog('new')}><Plus size={14} strokeWidth={1.8} /> Mensaplan anlegen</button> : undefined}
      >
        {menus.length === 0 ? (
          <Empty icon={UtensilsCrossed}>Noch kein Mensaplan.</Empty>
        ) : (
          <ul className="mt-6 flex flex-col">
            {menus.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-line py-4 first:border-t-0">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 font-medium">{m.name}{m.isDefault && <Tag>Standard</Tag>}</div>
                  <div className="mt-1 text-[13px] text-ink-3">
                    {num(m.dishes)} Gerichte · {m.schools.length === 0 ? 'keiner Schule zugewiesen — wird nirgends angezeigt' : m.schools.map((s) => s.name).join(', ')}
                  </div>
                </div>
                {manage && (
                  <div className="row-actions">
                    <button type="button" className="btn btn-sm btn-line" onClick={() => setAssigning(m)}><School size={14} strokeWidth={1.8} /> Schulen zuweisen</button>
                    <IconButton icon={Pencil} label={`${m.name} umbenennen`} onClick={() => setMenuDialog(m)} />
                    <IconButton icon={Trash2} tone="rose" label={`${m.name} löschen`} disabled={m.schools.length > 0} onClick={() => setDeletingMenu(m)} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {editing && <SchoolDialog school={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); void refresh(); }} />}
      {menuDialog && (
        <MenuNameDialog
          menu={menuDialog === 'new' ? null : menuDialog}
          onClose={() => setMenuDialog(null)}
          onSaved={(id) => {
            const created = menuDialog === 'new';
            setMenuDialog(null);
            void (async () => {
              await load();
              // A new plan serves nobody yet: its schools come next.
              if (created) {
                const { menus: list } = await adminApi.menus();
                setAssigning(list.find((m) => m.id === id) ?? null);
              }
            })();
          }}
        />
      )}
      {assigning && <MenuSchoolsDialog menu={assigning} onClose={() => setAssigning(null)} onSaved={() => { setAssigning(null); void load(); void refresh(); }} />}
      {deletingMenu && <MenuDeleteDialog menu={deletingMenu} onClose={() => setDeletingMenu(null)} onDeleted={() => { setDeletingMenu(null); void load(); }} />}
    </div>
  );
}

function SchoolDialog({ school, onClose, onSaved }: { school: AdminSchool; onClose: () => void; onSaved: () => void }) {
  const { showToast } = useToast();
  const [name, setName] = useState(school.name);
  const [shortName, setShortName] = useState(school.shortName);
  const [slug, setSlug] = useState(school.slug);
  const [active, setActive] = useState(school.active);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await adminApi.updateSchool(school.id, {
        name: name.trim(),
        shortName: shortName.trim(),
        ...(slug.trim() && slug.trim().toLowerCase() !== school.slug ? { slug: slug.trim().toLowerCase() } : {}),
        ...(school.isDefault || active === school.active ? {} : { active }),
      });
      showToast('Schule gespeichert', 'success');
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Speichern fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="Schule bearbeiten" subtitle={school.name} onClose={onClose} width={560}>
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-5">
        <FieldLabel label="Name" hint="So erscheint die Schule im Panel. Kommt beim ersten Login aus WebUntis.">
          <input className="field h-12 px-4 text-[14.5px]" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={160} />
        </FieldLabel>
        <div className="grid gap-5 sm:grid-cols-2">
          <FieldLabel label="Kurzname" hint="Für knappe Stellen, wo der volle Name zu lang ist."><input className="field h-12 px-4 text-[14.5px]" value={shortName} onChange={(e) => setShortName(e.target.value)} maxLength={60} /></FieldLabel>
          <FieldLabel label="Kennung" hint="Kleinbuchstaben, Ziffern, -; in Links (?school=)."><input className="field h-12 px-4 font-mono text-[14px]" value={slug} onChange={(e) => setSlug(e.target.value)} pattern="[a-z0-9][a-z0-9-]{1,62}" required /></FieldLabel>
        </div>
        <dl className="grid gap-x-6 gap-y-3 rounded-[16px] bg-well px-4 py-3.5 text-[13.5px] sm:grid-cols-2">
          <div className="min-w-0"><dt className="text-[12px] text-ink-3">WebUntis-Schule</dt><dd className="truncate font-mono">{school.webuntisSchool ?? '–'}</dd></div>
          <div className="min-w-0"><dt className="text-[12px] text-ink-3">WebUntis-Server</dt><dd className="truncate font-mono">{school.webuntisBase ? school.webuntisBase.replace(/^https:\/\//, '').replace(/\/WebUntis$/, '') : '–'}</dd></div>
          <p className="text-[12px] text-ink-3 sm:col-span-2">Kommt von WebUntis und lässt sich hier nicht ändern.</p>
        </dl>
        {!school.isDefault && (
          <div className="flex items-center justify-between gap-4 rounded-[16px] bg-well px-4 py-3">
            <div>
              <div className="text-[14.5px]">Aktiv</div>
              <div className="text-[12.5px] text-ink-3">Deaktiviert: keine Anmeldungen mehr aus dieser Schule, Daten bleiben.</div>
            </div>
            <Toggle checked={active} onChange={setActive} label="Schule aktiv" />
          </div>
        )}
        {school.isDefault && <Notice tone="sky" icon={ShieldCheck}>Die Schule der Installation (WEBUNTIS_SCHOOL) bleibt immer aktiv.</Notice>}
        {error && <Notice tone="rose">{error}</Notice>}
        <div className="flex gap-3">
          <button type="button" onClick={onClose} className="btn btn-quiet flex-1">Abbrechen</button>
          <button type="submit" disabled={busy} className="btn btn-primary flex-1">{busy ? <Spinner /> : null}Speichern</button>
        </div>
      </form>
    </Dialog>
  );
}
