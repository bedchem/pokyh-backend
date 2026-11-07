// Where a browser's web-push subscription may point. The server POSTs to
// that address whenever the account has something new, so an address of the
// subscriber's own choosing would let any account make the server send
// requests into the internal network (a blind SSRF). Only the browsers' push
// services are accepted. Pure, tested on its own (tests/pushEndpoint.test.mjs).

const PUSH_SERVICES: RegExp[] = [
  // Chrome, Edge (Chromium), Opera, Brave, Samsung Internet
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  // Firefox
  /^updates\.push\.services\.mozilla\.com$/,
  /^push\.services\.mozilla\.com$/,
  // Safari (macOS, iOS 16.4+)
  /^web\.push\.apple\.com$/,
  // Windows (legacy Edge, some PWAs)
  /^[a-z0-9-]+\.notify\.windows\.com$/,
];

/** Why this is no push service's address; null when it is one. */
export function pushEndpointProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'Keine gültige Adresse';
  }
  if (url.protocol !== 'https:') return 'Nur https';
  if (url.username || url.password) return 'Keine Zugangsdaten in der Adresse';
  if (url.port && url.port !== '443') return 'Kein eigener Port';
  const host = url.hostname.toLowerCase();
  if (!PUSH_SERVICES.some((pattern) => pattern.test(host))) return 'Kein bekannter Push-Dienst';
  return null;
}
