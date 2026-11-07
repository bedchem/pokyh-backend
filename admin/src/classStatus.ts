import type { Tone } from './components/kit';
import type { AdminUser, ClassNote, ClassSource } from './types';

// How the panel says where an account's class came from, or why it has none
// (the backend's utils/accountClass.ts ClassSource and ClassNote).

export const CLASS_SOURCE_LABEL: Record<ClassSource, string> = {
  authenticate: 'aus der WebUntis-Anmeldung',
  pageconfig: 'aus dem eigenen Stundenplan',
  students: 'aus der Schülerliste',
  'app-data': 'aus den WebUntis-Kontodaten',
  'weekly-data': 'aus den Stunden der Woche',
  timetable: 'aus dem Stundenplan',
  'filter-single': 'einzige freigegebene Klasse',
  kept: 'zuletzt von WebUntis bestätigt',
};

export const CLASS_NOTE: Record<ClassNote, { label: string; hint: string; review?: boolean }> = {
  role_parent: { label: 'Elternkonto', hint: 'Elternkonten sind in keiner Klasse.' },
  role_none: { label: 'Keine Rolle', hint: 'Konten ohne Rolle sind in keiner Klasse.' },
  not_student: { label: 'Keine Schüler:in', hint: 'WebUntis führt das Konto als Lehrkraft oder Personal.' },
  appdata_unreadable: {
    label: 'WebUntis-Daten fehlten',
    hint: 'Bei der letzten Anmeldung kamen die Kontodaten von WebUntis nicht rechtzeitig. Ohne sie lässt sich ein Schüler nicht von einem Eltern-Login unterscheiden. Die nächste Anmeldung prüft neu.',
  },
  no_class_found: {
    label: 'WebUntis nennt keine Klasse',
    hint: 'Weder die Anmeldung noch der Stundenplan noch die Kontodaten nennen eine Klasse. Die nächste Anmeldung prüft neu.',
  },
  candidate_rejected: {
    label: 'Unbekannte Klasse',
    hint: 'WebUntis nannte eine Klasse, die nicht in der Klassenliste der Schule steht.',
  },
  webuntis_unavailable: { label: 'WebUntis nicht erreichbar', hint: 'WebUntis hat bei der Anmeldung nicht geantwortet. Die nächste Anmeldung prüft neu.' },
  shared_person: {
    label: 'Teilt einen Schülerdatensatz',
    hint: 'Ein älteres Konto meldet sich auf demselben WebUntis-Schüler an. Eines der beiden ist vermutlich ein Eltern-Login auf dem Datensatz des Kindes. Lege fest, welches das Elternkonto ist.',
    review: true,
  },
  student_record_on_parent: {
    label: 'Eltern-Login auf Schülerdatensatz',
    hint: 'WebUntis meldet dieses Elternkonto als Schüler:in. Es bleibt ein Elternkonto ohne Klasse, bis du die Rolle änderst.',
    review: true,
  },
  no_session: { label: 'Noch nicht geprüft', hint: 'Die Anmeldung brachte keine WebUntis-Sitzung mit.' },
};

export interface ClassStatus {
  /** What the class column shows. */
  text: string;
  /** The longer explanation (tooltip, detail view). */
  hint: string;
  tone: Tone;
  /** An admin should look at this account. */
  review: boolean;
}

/** The class column of an account: the class with its source, or why there is none. */
export function classStatus(user: Pick<AdminUser, 'role' | 'isUntisUser' | 'webuntisKlasseName' | 'webuntisKlasseId' | 'classSource' | 'classNote' | 'classCheckPending' | 'sharedRecord'>): ClassStatus {
  const review = Boolean(user.sharedRecord?.needsReview) || Boolean(user.classNote && CLASS_NOTE[user.classNote]?.review);
  if ((user.webuntisKlasseId ?? 0) > 0) {
    const source = user.classSource ? CLASS_SOURCE_LABEL[user.classSource] : '';
    return { text: user.webuntisKlasseName || `Klasse ${user.webuntisKlasseId}`, hint: source ? `Klasse ${source}` : '', tone: 'mint', review };
  }
  if (user.role === 'parent') return { text: 'Keine (Elternkonto)', hint: (user.classNote && CLASS_NOTE[user.classNote]?.hint) || CLASS_NOTE.role_parent.hint, tone: 'ink', review };
  if (user.role === 'none') return { text: 'Keine (ohne Rolle)', hint: CLASS_NOTE.role_none.hint, tone: 'ink', review };
  if (user.isUntisUser === false) return { text: '—', hint: 'Ein lokales Konto bekommt seine Klasse von einem Admin.', tone: 'ink', review };
  if (user.classCheckPending) {
    return { text: 'Wird geprüft', hint: 'Die Klasse wird bei der nächsten Anmeldung oder Sitzungs-Erneuerung bei WebUntis geprüft.', tone: 'sky', review };
  }
  const note = user.classNote ? CLASS_NOTE[user.classNote] : null;
  return { text: note?.label ?? 'Keine Klasse', hint: note?.hint ?? '', tone: 'amber', review };
}
