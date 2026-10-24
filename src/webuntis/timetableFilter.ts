// The entries of WebUntis' "Weitere Stundenpläne" picker (GET
// /api/rest/view/v1/timetable/filter): classes, teachers, rooms or subjects,
// each with an id, a short and a long name. Read tolerantly — the answer nests
// them under keys that differ by kind and version (`classes[].class`, …) — and
// without the departments the picker groups them by. Pure, tested on its own
// (tests/webuntisTimetableFilter.test.mjs).

export interface TimetableResource {
  id: number;
  /** "4.BFS-FI" */
  name: string;
  /** "4. Klasse Fachschule Informatik"; "" when WebUntis has none. */
  longName: string;
}

const SKIP = new Set(['departments', 'department', 'departmentIds']);

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export function readTimetableFilter(json: unknown): TimetableResource[] {
  const found = new Map<number, TimetableResource>();
  const visit = (node: unknown, depth: number) => {
    if (depth > 6 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    const o = node as Record<string, unknown>;
    const id = typeof o.id === 'number' ? o.id : Number.NaN;
    const name = text(o.shortName) || text(o.displayName) || text(o.name);
    if (Number.isInteger(id) && id > 0 && name && !found.has(id)) {
      const longName = text(o.longName) || (text(o.displayName) !== name ? text(o.displayName) : '');
      found.set(id, { id, name, longName });
    }
    for (const [key, value] of Object.entries(o)) {
      if (!SKIP.has(key)) visit(value, depth + 1);
    }
  };
  visit(json, 0);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true }));
}
