import { untisError, type UntisResponse } from './client';

// Helpers for the WebUntis student absence endpoints (classic API,
// /api/classreg/absences/*), shaped like the official client's
// classreg/absences/widget/absence.ts.

/** 'YYYYMMDD' → 20261016 (the date format the classic API uses), or null. */
export function ymdNumber(value: unknown): number | null {
  const s = String(value ?? '');
  if (!/^\d{8}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(4, 6));
  const d = Number(s.slice(6, 8));
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return Number(s);
}

/** 'HHMM' / 'HMM' → 750 (hours × 100 + minutes), or null. */
export function hmNumber(value: unknown): number | null {
  const s = String(value ?? '');
  if (!/^\d{1,4}$/.test(s)) return null;
  const n = Number(s);
  const h = Math.floor(n / 100);
  const m = n % 100;
  if (h > 23 || m > 59) return null;
  return n;
}

export interface AbsenceWriteOutcome {
  ok: boolean;
  /** Overlaps WebUntis reports instead of saving (e.g. an existing absence). */
  conflicts: unknown[];
  error?: string;
  code?: string;
}

/**
 * Reads `{ data: { result, conflicts } }` / `{ errors }` the way the official
 * client does: saved only when there are no conflicts and no errors.
 */
export function absenceWriteOutcome(res: UntisResponse): AbsenceWriteOutcome {
  const json = (res.json ?? {}) as { data?: { conflicts?: unknown[] }; errors?: { code?: unknown }[] };
  if (Array.isArray(json.errors) && json.errors.length > 0) {
    return { ok: false, conflicts: [], error: untisError(json), code: String(json.errors[0]?.code ?? '') || undefined };
  }
  if (!res.ok) return { ok: false, conflicts: [], error: untisError(json) };
  const conflicts = Array.isArray(json.data?.conflicts) ? json.data.conflicts : [];
  return { ok: conflicts.length === 0, conflicts };
}

/** A short text per conflict, whatever shape WebUntis uses for it. */
export function conflictTexts(conflicts: unknown[]): string[] {
  return conflicts
    .map((c) => {
      if (typeof c === 'string') return c;
      const o = (c ?? {}) as Record<string, unknown>;
      const text = o.text ?? o.message ?? o.title ?? o.description ?? o.name;
      return typeof text === 'string' ? text : '';
    })
    .filter(Boolean)
    .slice(0, 5);
}
