/**
 * Returns a configured browser origin plus its conventional `www`/apex
 * counterpart. The counterpart is deliberately derived only from an origin
 * that an operator already trusted; this prevents a deployment that lists
 * `https://pokyh.com` from unexpectedly rejecting `https://www.pokyh.com`.
 */
export function withWwwOriginAlias(value: string): string[] {
  const configured = value.trim();
  if (!configured) return [];

  try {
    const url = new URL(configured);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return [configured];

    const origin = url.origin;
    const alias = new URL(origin);
    alias.hostname = url.hostname.startsWith('www.')
      ? url.hostname.slice('www.'.length)
      : `www.${url.hostname}`;

    return alias.origin === origin ? [origin] : [origin, alias.origin];
  } catch {
    // Preserve the old exact-match behavior for malformed operator input. It
    // will not match a normal browser Origin and therefore does not widen CORS.
    return [configured];
  }
}

/**
 * Whether a browser Origin is the server's own address, i.e. the request is
 * same-origin (the admin panel served by this very server, reached under any
 * name: localhost, 127.0.0.1, a LAN address or a domain). Browsers send an
 * Origin on same-origin POSTs too; CORS exists to limit *other* origins and
 * must never block those. A page on another origin cannot make its Origin
 * equal the Host of the server it calls, so this admits nothing cross-origin.
 */
export function isSameOrigin(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return url.host.toLowerCase() === host.trim().toLowerCase();
  } catch {
    return false;
  }
}
