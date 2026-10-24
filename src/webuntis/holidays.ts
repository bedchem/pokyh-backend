// The school's holidays (JSON-RPC getHolidays) as the website shows them:
// days as YYYY-MM-DD, overlapping and adjoining entries merged into one break.
// Schools often name them only "Ferien3" or "8.12."; the name WebUntis has is
// passed on, and the website names the break itself when it is one of those.
// Pure, tested on its own (tests/webuntisHolidays.test.mjs).

export interface Holiday {
  /** YYYY-MM-DD, first day off. */
  start: string;
  /** YYYY-MM-DD, last day off. */
  end: string;
  /** The names WebUntis gives the merged entries, the most telling first. */
  names: string[];
}

const ymd = (n: number) => {
  const s = String(n);
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
};

const nextDay = (iso: string) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

// "Ferien3", "Feiertag", "8.12.", "25/5/2026": a placeholder, not a name.
export function isPlaceholderName(name: string): boolean {
  const n = name.trim();
  return !n || /^(ferien|feiertag|holiday|vacanz[ae]|frei)\s*\d*$/i.test(n) || /^[\d.\/\s-]+$/.test(n);
}

export function readHolidays(result: unknown, fromIso: string): Holiday[] {
  if (!Array.isArray(result)) return [];
  const entries = result
    .map((item) => {
      const r = (item ?? {}) as { startDate?: unknown; endDate?: unknown; name?: unknown; longName?: unknown };
      const start = ymd(Number(r.startDate));
      const end = ymd(Number(r.endDate));
      const names = [...new Set([r.longName, r.name]
        .filter((v): v is string => typeof v === 'string')
        .map((v) => v.trim())
        .filter((v) => v && !isPlaceholderName(v)))];
      return start && end && end >= start ? { start, end, names } : null;
    })
    .filter((h): h is Holiday => h !== null && h.end >= fromIso)
    .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));

  const merged: Holiday[] = [];
  for (const h of entries) {
    const last = merged[merged.length - 1];
    if (last && h.start <= nextDay(last.end)) {
      if (h.end > last.end) last.end = h.end;
      for (const n of h.names) if (!last.names.includes(n)) last.names.push(n);
    } else {
      merged.push({ ...h, names: [...h.names] });
    }
  }
  return merged;
}
