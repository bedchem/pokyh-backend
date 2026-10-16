import { useEffect, useState } from 'react';
import { Code2, Gavel, Lock, School, Settings2 } from 'lucide-react';
import { adminApi } from '../api';
import { Notice, PageHeader, Section, Spinner, Tag, type Tone } from '../components/kit';
import { SplitBar } from '../components/charts';
import { num } from '../components/format';
import type { PrivacyOverview } from '../types';

// What the installation stores, why, how long and who sees it — read from
// the running configuration — and the points the software cannot settle on
// its own. A working aid for the data controller (GDPR, Codice Privacy and
// the Garante's guidance in Italy), not a statement of compliance.

const KIND: Record<PrivacyOverview['openPoints'][number]['kind'], { label: string; tone: Tone; icon: typeof Lock }> = {
  code: { label: 'Code', tone: 'sky', icon: Code2 },
  operational: { label: 'Betrieb', tone: 'amber', icon: Settings2 },
  controller: { label: 'Schule / Verantwortlicher', tone: 'violet', icon: School },
  legal: { label: 'Rechtliche Prüfung', tone: 'rose', icon: Gavel },
};

export function PrivacyPage() {
  const [data, setData] = useState<PrivacyOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminApi.privacyOverview().then(setData).catch((err) => setError(err instanceof Error ? err.message : 'Nicht verfügbar'));
  }, []);

  if (!data) return <div className="mt-10">{error ? <Notice tone="rose">{error}</Notice> : <Spinner />}</div>;

  return (
    <div>
      <PageHeader title="Datenschutz" subtitle="Welche Daten Pokyh speichert, wofür, wie lange und wer sie sieht — aus der laufenden Konfiguration. Eine Arbeitshilfe für Schule und Verantwortliche, keine Zusicherung der Rechtskonformität." />

      <div className="mt-8">
        <Notice tone="amber" icon={Gavel}>
          Software allein macht keine Verarbeitung rechtmäßig. Die offenen Punkte unten brauchen Entscheidungen der Schulen, betriebliche Maßnahmen oder eine rechtliche Prüfung (DSGVO, Codice Privacy, Vorgaben des Garante).
        </Notice>
      </div>

      <Section className="mt-[46px]" title="Offene Punkte" meta={`${data.openPoints.length}`}>
        <ul className="mt-6 flex flex-col gap-4">
          {data.openPoints.map((p, i) => {
            const k = KIND[p.kind];
            return (
              <li key={i} className="flex items-start gap-4">
                <span className="orb h-10 w-10 flex-shrink-0"><k.icon size={17} strokeWidth={1.7} /></span>
                <div className="min-w-0">
                  <Tag tone={k.tone}>{k.label}</Tag>
                  <p className="mt-1.5 text-[14px] leading-relaxed">{p.text}</p>
                </div>
              </li>
            );
          })}
        </ul>
      </Section>

      <Section className="mt-[52px]" title="Datenkategorien">
        <div className="tbl-scroll mt-6">
          <table className="tbl">
            <thead>
              <tr><th>Daten</th><th className="hidden md:table-cell">Zweck</th><th>Rechtsgrundlage</th><th className="hidden lg:table-cell">Aufbewahrung</th><th className="hidden xl:table-cell">Wer sieht sie</th></tr>
            </thead>
            <tbody>
              {data.categories.map((c) => (
                <tr key={c.key}>
                  <td className="font-medium">{c.label}</td>
                  <td className="hidden text-ink-2 md:table-cell">{c.purpose}</td>
                  <td className="text-[13.5px] text-ink-2">{c.basis}</td>
                  <td className="hidden text-ink-2 lg:table-cell">{c.retention}</td>
                  <td className="hidden text-[13.5px] text-ink-2 xl:table-cell">{c.access}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <div className="mt-[52px] grid gap-[52px] lg:grid-cols-2">
        <Section title="Aufbewahrung">
          <ul className="mt-6 flex flex-col">
            {data.retention.map((r) => (
              <li key={r.key} className="flex items-start justify-between gap-4 border-t border-line py-3 first:border-t-0">
                <div className="min-w-0">
                  <div className="text-[14px]">{r.label}</div>
                  <div className="text-[12.5px] text-ink-3">{r.note}</div>
                </div>
                <span className="tabular flex-shrink-0 text-[14px] font-medium">{r.days === null ? '–' : `${num(r.days)} Tage`}</span>
              </li>
            ))}
          </ul>
        </Section>
        <Section title="Einwilligung Nutzungsstatistik" meta={`${num(data.consents.accounts)} Konten`}>
          <div className="mt-8">
            <SplitBar
              ariaLabel="Einwilligungen in die Nutzungsstatistik"
              parts={[
                { label: 'eingewilligt', value: data.consents.usageStats, color: 'var(--mint)' },
                { label: 'abgelehnt', value: data.consents.refused, color: 'var(--rose)' },
                { label: 'noch nicht entschieden', value: data.consents.undecided, color: 'var(--well-3)' },
              ]}
            />
          </div>
          <p className="mt-5 text-[13px] leading-relaxed text-ink-3">
            Ohne Einwilligung bleibt die Nutzung anonym (Tageszählung ohne Konto). Die Einwilligung ist freiwillig, nie voreingestellt und jederzeit im Profil widerrufbar.
          </p>
        </Section>
      </div>
    </div>
  );
}
