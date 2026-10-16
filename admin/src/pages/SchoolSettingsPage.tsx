import { FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Info, School, ShieldCheck, UtensilsCrossed } from 'lucide-react';
import { adminApi } from '../api';
import { useAccess } from '../access';
import { useToast } from '../components/Toast';
import { FieldLabel, FormSection, Notice, PageHeader, Spinner } from '../components/kit';
import type { AdminSchool } from '../types';

// The school's own settings, for its admins: the name it is shown with.
// Its WebUntis connection, status and menu belong to the installation and
// are changed by global admins under "Schulen".

export function SchoolSettingsPage() {
  const { view, can, refresh } = useAccess();
  const { showToast } = useToast();
  const schoolId = view?.kind === 'school' ? view.school.id : null;
  const [school, setSchool] = useState<AdminSchool | null>(null);
  const [name, setName] = useState('');
  const [shortName, setShortName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editable = can('school.settings.manage');

  useEffect(() => {
    if (!schoolId) return;
    adminApi.school(schoolId)
      .then(({ school: s }) => { setSchool(s); setName(s.name); setShortName(s.shortName); })
      .catch((err) => setError(err instanceof Error ? err.message : 'Schule konnte nicht geladen werden'));
  }, [schoolId]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!school) return;
    setBusy(true);
    setError(null);
    try {
      const { school: s } = await adminApi.updateSchool(school.id, { name: name.trim(), shortName: shortName.trim() });
      setSchool(s);
      showToast('Gespeichert', 'success');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Speichern fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  }

  if (!school) return <div className="mt-10">{error ? <Notice tone="rose">{error}</Notice> : <Spinner />}</div>;

  return (
    <div>
      <PageHeader title="Schule" subtitle={`Einstellungen von ${school.name}.`} />

      <form onSubmit={(e) => void save(e)}>
        <FormSection icon={School} title="Name" hint="So erscheint die Schule im Panel und in den Apps.">
          <div className="grid max-w-[560px] gap-5">
            <FieldLabel label="Name"><input className="field h-12 px-4 text-[14.5px]" value={name} onChange={(e) => setName(e.target.value)} disabled={!editable} required minLength={2} maxLength={160} /></FieldLabel>
            <FieldLabel label="Kurzname"><input className="field h-12 px-4 text-[14.5px]" value={shortName} onChange={(e) => setShortName(e.target.value)} disabled={!editable} maxLength={60} /></FieldLabel>
            {error && <Notice tone="rose">{error}</Notice>}
            {editable
              ? <button type="submit" disabled={busy} className="btn btn-primary w-fit">{busy ? <Spinner /> : null}Speichern</button>
              : <p className="text-[13px] text-ink-3">Nur lesen: dir fehlt das Recht „Schuleinstellungen ändern“.</p>}
          </div>
        </FormSection>
      </form>

      <FormSection icon={Info} title="Anbindung" hint="Von den Global-Admins verwaltet.">
        <dl className="grid max-w-[560px] gap-4 text-[14px] sm:grid-cols-2">
          <div><dt className="text-[12.5px] text-ink-3">Kennung</dt><dd className="font-mono">{school.slug}</dd></div>
          <div><dt className="text-[12.5px] text-ink-3">WebUntis-Schule</dt><dd className="font-mono">{school.webuntisSchool ?? '–'}</dd></div>
          <div><dt className="text-[12.5px] text-ink-3">Status</dt><dd>{school.active ? 'aktiv' : 'deaktiviert'}</dd></div>
          <div><dt className="text-[12.5px] text-ink-3">Standardschule</dt><dd>{school.isDefault ? 'ja' : 'nein'}</dd></div>
        </dl>
      </FormSection>

      <FormSection icon={UtensilsCrossed} title="Mensaplan" hint="Welcher Speiseplan in den Apps dieser Schule erscheint.">
        <p className="text-[14px]">{school.menu ? school.menu.name : 'Kein Mensaplan zugewiesen — die Apps zeigen keinen Speiseplan.'}</p>
        {can('mensa.view') && <Link to="/dishes" className="mt-3 inline-block text-[14px] underline-offset-4 hover:underline">Zum Speiseplan</Link>}
      </FormSection>

      {can('admins.view') && (
        <FormSection icon={ShieldCheck} title="Admins" hint="Wer diese Schule verwaltet.">
          <Link to="/admins" className="text-[14px] underline-offset-4 hover:underline">Admins & Rechte öffnen</Link>
        </FormSection>
      )}
    </div>
  );
}
