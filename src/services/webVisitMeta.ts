// Pure helpers behind the website-visitor statistics (routes/activityLog.ts,
// the "Website-Besucher" figures and the visitor map on the admin Analytics
// page). Deliberately free of imports so they are unit-testable without a
// database — see tests/webVisits.test.mjs.

type HeaderValue = string | string[] | undefined;

function firstHeader(value: HeaderValue): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' ? raw : null;
}

/**
 * An address as the statistics keep it: trimmed, lower case, an IPv4 address
 * mapped into IPv6 written as plain IPv4. Null for anything that is not an
 * address (an empty value, "unknown", a header full of something else).
 */
export function normaliseIp(value: string | null | undefined): string | null {
  if (!value) return null;
  let text = value.trim().toLowerCase();
  if (text.startsWith('::ffff:') && /^\d{1,3}(\.\d{1,3}){3}$/.test(text.slice(7))) text = text.slice(7);
  if (!text || text.length > 45) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) {
    return text.split('.').every((part) => Number(part) <= 255) ? text : null;
  }
  return /^[0-9a-f:]+$/.test(text) && text.includes(':') ? text : null;
}

/** Loopback, private, link-local and unique-local addresses: never a visitor's own. */
export function isInternalIp(ip: string): boolean {
  if (ip.includes(':')) {
    return ip === '::1' || ip === '::' || /^f[cd][0-9a-f]{2}:/.test(ip) || /^fe[89ab][0-9a-f]:/.test(ip);
  }
  const [a = 0, b = 0] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254)
    || (a === 100 && b >= 64 && b <= 127);
}

/**
 * The visitor's address. `direct` is the client address Express settled on
 * (TRUST_PROXY decides whether forwarded headers count). When that is an
 * internal address the request came through a proxy on the same machine or
 * network — Cloudflare Tunnel's connector — and Cloudflare's own
 * CF-Connecting-IP names the visitor. A forged header can only mislabel a
 * statistic: nothing here decides access or rate limits.
 */
export function visitorIp(direct: string | null | undefined, connectingIp: HeaderValue): string | null {
  const own = normaliseIp(direct);
  if (own && !isInternalIp(own)) return own;
  return normaliseIp(firstHeader(connectingIp)) ?? own;
}

/** The visitor's country (ISO 3166-1 alpha-2) as the edge reports it, or "" when unknown. */
export function countryFromHeader(value: HeaderValue): string {
  const code = (firstHeader(value) ?? '').trim().toUpperCase();
  // "XX" means unknown; Tor ("T1") and others with digits are no country.
  return /^[A-Z]{2}$/.test(code) && code !== 'XX' ? code : '';
}

/**
 * A region or city name from the edge's visitor location headers, or null.
 * Node reads header bytes as Latin-1 while Cloudflare sends UTF-8, so a name
 * such as "Brixen/Bressanone" with an umlaut arrives garbled and is decoded
 * back here.
 */
export function placeFromHeader(value: HeaderValue): string | null {
  let text = (firstHeader(value) ?? '').trim();
  if (!text) return null;
  if ([...text].every((char) => char.charCodeAt(0) < 256) && /[\u0080-ÿ]/.test(text)) {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(text, (char) => char.charCodeAt(0)));
    } catch {
      // Already plain Latin-1 text.
    }
  }
  text = text.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return text ? text.slice(0, 80) : null;
}

/** Whether the browser sent the Global Privacy Control signal (Sec-GPC: 1). */
export function sendsGpc(value: HeaderValue): boolean {
  return (firstHeader(value) ?? '').trim() === '1';
}

/**
 * A website page as the statistics keep it: without query, fragment and
 * language prefix, ids folded into ":id", no trailing slash — "/de/messages/123/"
 * and "/it/messages/456" are both "/messages/:id".
 */
export function visitPage(value: unknown): string {
  if (typeof value !== 'string') return '';
  const path = value.split('?')[0]?.split('#')[0]?.trim() ?? '';
  if (!path.startsWith('/')) return '';
  const page = path
    .replace(/^\/(de|it|en|lld)(?=\/|$)/, '')
    .replace(/\/[0-9a-f-]{6,}(?=\/|$)/gi, '/:id')
    .replace(/\/\d+(?=\/|$)/g, '/:id')
    .replace(/\/+$/, '');
  return (page || '/').slice(0, 200);
}
