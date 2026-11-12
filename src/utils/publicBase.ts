// Pictures the server keeps are named by path (/dishes/<id>/image,
// /popup-images/<id>), so a backup restored elsewhere still finds them. Clients
// get them with an address in front: PUBLIC_BASE_URL, or else the address the
// request came to. The apps cannot load a bare path.

// A host as it may stand in a URL: a name or IPv4, or [IPv6], with a port.
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOST = new RegExp(`^(?:${LABEL}(?:\\.${LABEL})*|\\[[0-9a-f:.]+\\])(?::\\d{1,5})?$`, 'i');

export interface RequestAddress {
  /** Whether the request came over HTTPS (Express: through TRUST_PROXY). */
  secure: boolean;
  /** Host and port it was sent to (Express: X-Forwarded-Host only through TRUST_PROXY). */
  host?: string | undefined;
}

/**
 * The hosts of the website's origins (CORS_ORIGIN), without a leading "www.":
 * the API has to lie on their site for the website's sign-in cookies, so only
 * a host that is one of them or below one is taken from a request.
 */
export function siteHostsOf(corsOrigin: string): string[] {
  const hosts = new Set<string>();
  for (const origin of corsOrigin.split(',')) {
    try {
      const url = new URL(origin.trim());
      if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
      hosts.add(url.hostname.toLowerCase().replace(/^www\./, ''));
    } catch {
      // Not an origin: CORS_ORIGIN's own parsing reports it.
    }
  }
  return [...hosts];
}

// PUBLIC_BASE_URL as it may go in front of a path: an http(s) address without
// credentials, query or fragment. Anything else names no address at all,
// rather than ending up inside the popups' HTML.
function configuredBase(configured: string): string {
  try {
    const url = new URL(configured);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.search || url.hash) return '';
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return '';
  }
}

/**
 * The address to put in front of a picture's path: `configured`
 * (PUBLIC_BASE_URL) when set, otherwise the HTTPS address of the request when
 * its host lies on the website's site (`siteHosts`); '' when there is none,
 * and the path stays (the website puts its API address in front itself).
 * Never plain http: the apps refuse it and the website would load it as mixed
 * content. Never a host outside the site: a proxy that passes on its upstream
 * (app:4000) or a forged X-Forwarded-Host would end up in the answer. It comes
 * from one request, so it never goes into a shared cache.
 */
export function requestBase(configured: string, req: RequestAddress, siteHosts: readonly string[]): string {
  if (configured) return configuredBase(configured);
  if (!req.secure) return '';
  const host = (req.host ?? '').trim().toLowerCase();
  if (!host || host.length > 255 || !HOST.test(host)) return '';
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:\d+$/, '');
  if (!siteHosts.some((site) => name === site || name.endsWith(`.${site}`))) return '';
  return `https://${host}`;
}

/** `url` with `base` in front when it is a path on this server ("/…", not "//…"). */
export function withBase(url: string, base: string): string {
  return base && url.startsWith('/') && !url.startsWith('//') ? `${base}${url}` : url;
}

/** A popup's HTML with `base` in front of its pictures' paths (/popup-images/<id>). */
export function withPopupPictureBase(html: string, base: string): string {
  if (!base) return html;
  return html.replace(/(<img\b[^>]*\bsrc=")(\/popup-images\/)/g, (_, tag: string, path: string) => `${tag}${base}${path}`);
}
