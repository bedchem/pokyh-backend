// Country names and groups for the visitor statistics; free of the map code
// so the Analytics page can name countries without loading the map.

let regionNames: Intl.DisplayNames | null | undefined;

/** "IT" → "Italien"; "" → "Unbekannt". */
export function countryName(code: string): string {
  if (!code) return 'Unbekannt';
  if (code === 'XK') return 'Kosovo';
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(['de'], { type: 'region' });
    } catch {
      regionNames = null;
    }
  }
  try {
    return regionNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

/** The map opens on Europe when at least three quarters of the views come from there. */
export function frameFor(countries: Array<{ country: string; views: number }>): 'world' | 'europe' {
  const known = countries.filter((c) => c.country !== '');
  const total = known.reduce((sum, c) => sum + c.views, 0);
  const european = known.filter((c) => EUROPE.has(c.country)).reduce((sum, c) => sum + c.views, 0);
  return total > 0 && european / total >= 0.75 ? 'europe' : 'world';
}

// Countries counted as Europe when the map decides whether to open on it.
// Russia and Turkey reach far beyond and would pull the frame with them.
export const EUROPE = new Set([
  'AD', 'AL', 'AT', 'BA', 'BE', 'BG', 'BY', 'CH', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GB', 'GR', 'HR', 'HU',
  'IE', 'IS', 'IT', 'LI', 'LT', 'LU', 'LV', 'MC', 'MD', 'ME', 'MK', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'RS', 'SE', 'SI',
  'SK', 'SM', 'UA', 'VA', 'XK',
]);
