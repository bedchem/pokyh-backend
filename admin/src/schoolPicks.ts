// Which schools an admin opens, and how often: the view switcher offers them
// first. Each pick adds one point to a score that halves every HALF_LIFE, so
// a school opened daily this week ranks above one opened often months ago
// ("frecency"). Kept per admin in this browser only — a convenience, nothing
// the server needs to know.

const HALF_LIFE_MS = 7 * 86_400_000;
const MAX_ENTRIES = 50;

interface Entry { score: number; at: number }

const keyFor = (username: string) => `pokyh_admin_school_picks:${username}`;

function read(username: string): Record<string, Entry> {
  try {
    const raw = localStorage.getItem(keyFor(username));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, Entry> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const e = value as Partial<Entry>;
      if (typeof e?.score === 'number' && typeof e.at === 'number' && Number.isFinite(e.score) && Number.isFinite(e.at)) out[id] = { score: e.score, at: e.at };
    }
    return out;
  } catch {
    return {};
  }
}

const decayed = (entry: Entry, now: number) => entry.score * 0.5 ** (Math.max(0, now - entry.at) / HALF_LIFE_MS);

export function recordSchoolPick(username: string, schoolId: string): void {
  const now = Date.now();
  const entries = read(username);
  const prev = entries[schoolId];
  entries[schoolId] = { score: (prev ? decayed(prev, now) : 0) + 1, at: now };
  // Only the strongest few are kept.
  const kept = Object.entries(entries)
    .sort(([, a], [, b]) => decayed(b, now) - decayed(a, now))
    .slice(0, MAX_ENTRIES);
  try {
    localStorage.setItem(keyFor(username), JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // private mode or full storage: the ranking just isn't learnt
  }
}

// The ids among `available`, most picked (recently) first; never-picked ones
// are left out.
export function rankedSchoolPicks(username: string, available: string[], limit: number): string[] {
  const now = Date.now();
  const entries = read(username);
  return available
    .filter((id) => entries[id])
    .sort((a, b) => decayed(entries[b]!, now) - decayed(entries[a]!, now) || entries[b]!.at - entries[a]!.at)
    .slice(0, limit);
}
