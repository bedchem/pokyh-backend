import type { Tone } from './components/kit';
import type { AccountRole } from './types';

// The account roles as the panel names them. "none" is for accounts that are
// neither student nor parent, e.g. an admin outside any class; making
// someone admin never changes their role.
export const ROLE_OPTIONS: Array<{ value: AccountRole; label: string; hint: string; tone: Tone }> = [
  { value: 'student', label: 'Schüler:in', hint: 'In der Klasse aus WebUntis, mit Erinnerungen.', tone: 'mint' },
  { value: 'parent', label: 'Elternteil', hint: 'Eigene Todos, keine Klasse und keine Erinnerungen.', tone: 'violet' },
  { value: 'none', label: 'Keine Rolle', hint: 'Weder Schüler:in noch Elternteil, keine Klasse — z. B. für Admins.', tone: 'ink' },
];

function option(role: string) {
  return ROLE_OPTIONS.find((o) => o.value === role) ?? ROLE_OPTIONS[0]!;
}

export function roleLabel(role: string): string {
  return option(role).label;
}

export function roleTone(role: string): Tone {
  return option(role).tone;
}
