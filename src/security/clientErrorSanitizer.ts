import { createHash } from 'crypto';

// Error reports from the web app and the native apps (POST /client-errors)
// are untrusted input from the internet. Before anything is stored it is cut
// to size and stripped of what must never end up in a log: credentials,
// tokens, e-mail addresses, query strings (they carry tokens and search
// terms) and full URLs (only the path is kept). Pure, so it is tested on its
// own (tests/clientErrors.test.mjs).

export const CLIENT_ERROR_SOURCES = ['web', 'android', 'ios', 'admin'] as const;
export type ClientErrorSource = typeof CLIENT_ERROR_SOURCES[number];

export const LIMITS = {
  message: 500,
  name: 100,
  stack: 4000,
  stackLines: 30,
  page: 200,
  release: 40,
} as const;

const REDACTED = '[redacted]';

const PATTERNS: Array<[RegExp, string]> = [
  // JSON Web Tokens (also inside URLs and stacks).
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`],
  // key=value pairs naming a secret.
  [/\b(authorization|cookie|password|passwort|secret|token|api[_-]?key|session|jsessionid|refresh[_-]?token)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi, `$1$2${REDACTED}`],
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]'],
  // Long opaque strings: keys, hashes, session ids.
  [/\b[A-Fa-f0-9]{32,}\b/g, REDACTED],
  [/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, REDACTED],
];

// Full URLs become their path: "https://pokyh.com/de/x?token=…#y" → "/de/x".
function stripUrls(text: string): string {
  return text.replace(/\b(?:https?|wss?):\/\/[^\s'"()<>]+/gi, (url) => {
    try {
      const parsed = new URL(url.replace(/[),.;]+$/, ''));
      return parsed.pathname || '/';
    } catch {
      return '[url]';
    }
  });
}

export function scrub(text: string): string {
  let out = stripUrls(text);
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  // Control characters (except newlines and tabs) would corrupt log viewers.
  // eslint-disable-next-line no-control-regex
  return out.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function cleanPage(page: unknown): string {
  if (typeof page !== 'string') return '';
  let path = page.trim();
  try {
    if (/^[a-z]+:\/\//i.test(path)) path = new URL(path).pathname;
  } catch {
    return '';
  }
  path = path.split('?')[0]!.split('#')[0]!;
  if (!path.startsWith('/')) return '';
  return clip(scrub(path), LIMITS.page);
}

export function cleanStack(stack: unknown): string | null {
  if (typeof stack !== 'string' || !stack.trim()) return null;
  const lines = stack.split('\n').slice(0, LIMITS.stackLines).map((line) => scrub(line).trimEnd());
  return clip(lines.join('\n'), LIMITS.stack);
}

// A coarse browser or app family from the user agent — never the string
// itself, which together with other details can single a person out.
export function browserFamily(userAgent: string | undefined): string {
  const ua = userAgent ?? '';
  const v = (re: RegExp) => re.exec(ua)?.[1] ?? '';
  if (/^okhttp\//i.test(ua)) return 'Android-App';
  if (/CFNetwork\/|Darwin\//.test(ua) && !/Mozilla\//.test(ua)) return 'iOS-App';
  if (/Edg\/(\d+)/.test(ua)) return `Edge ${v(/Edg\/(\d+)/)}`;
  if (/Firefox\/(\d+)/.test(ua)) return `Firefox ${v(/Firefox\/(\d+)/)}`;
  if (/Chrome\/(\d+)/.test(ua)) return `Chrome ${v(/Chrome\/(\d+)/)}`;
  if (/Version\/(\d+)[.\d]* .*Safari\//.test(ua)) return `Safari ${v(/Version\/(\d+)/)}`;
  return ua ? 'Andere' : '';
}

export function fingerprintOf(name: string, message: string, stack: string | null): string {
  // Numbers vary between occurrences of one error (ids, positions, counts).
  const normalized = message.replace(/\d+/g, '#');
  const topFrame = (stack ?? '').split('\n').find((line) => /\bat\b|@/.test(line))?.replace(/:\d+:\d+/g, '') ?? '';
  return createHash('sha256').update(`${name}|${normalized}|${topFrame}`).digest('hex').slice(0, 16);
}

export interface CleanReport {
  source: ClientErrorSource;
  level: 'error' | 'warning';
  name: string;
  message: string;
  stack: string | null;
  page: string;
  release: string;
  requestId: string | null;
  fingerprint: string;
}

// Validates and cleans one report; null when it is not a usable report.
export function cleanReport(input: unknown, forcedSource?: ClientErrorSource): CleanReport | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  // "admin" is set by the server for the panel's own reports; the public
  // endpoint accepts the apps' sources only.
  const claimed = raw['source'];
  const source: ClientErrorSource | null = forcedSource
    ?? (claimed === 'web' || claimed === 'android' || claimed === 'ios' ? claimed : null);
  if (!source) return null;
  const messageRaw = typeof raw['message'] === 'string' ? raw['message'] : '';
  if (!messageRaw.trim()) return null;
  const message = clip(scrub(messageRaw.trim()), LIMITS.message);
  const name = clip(scrub(typeof raw['name'] === 'string' ? raw['name'].trim() : 'Error').replace(/[^\w.$ -]/g, ''), LIMITS.name) || 'Error';
  const stack = cleanStack(raw['stack']);
  const release = typeof raw['release'] === 'string' && /^[0-9A-Za-z.+_-]{0,40}$/.test(raw['release']) ? raw['release'] : '';
  const requestId = typeof raw['requestId'] === 'string' && /^[0-9A-Za-z-]{8,64}$/.test(raw['requestId']) ? raw['requestId'] : null;
  return {
    source,
    level: raw['level'] === 'warning' ? 'warning' : 'error',
    name,
    message,
    stack,
    page: cleanPage(raw['page']),
    release,
    requestId,
    fingerprint: fingerprintOf(name, message, stack),
  };
}
