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
