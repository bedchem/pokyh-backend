// Pure helpers behind the device list of an account (services/sessions.ts):
// what a sign-in's request says about the device it came from. Deliberately
// free of imports so they are unit-testable without a database — see
// tests/sessionDevice.test.mjs.
//
// The website is recognised by its browser's User-Agent, the apps by their
// own one ("POKYH-Android/2.1.0 (Android 15; samsung SM-S918B)"), which the
// apps send together with a device id of their own (X-Pokyh-Device).

type HeaderValue = string | string[] | undefined;

function firstHeader(value: HeaderValue): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' ? raw : '';
}

/** "app": a native app; "pwa": the website installed to the home screen; "web": a browser; "other": anything else (the Learn BFF, scripts). */
export type SessionClient = 'app' | 'pwa' | 'web' | 'other';

/** "android" | "ios" | "windows" | "macos" | "linux" | "chromeos" | "other" */
export type SessionPlatform = 'android' | 'ios' | 'windows' | 'macos' | 'linux' | 'chromeos' | 'other';

export interface DeviceInfo {
  client: SessionClient;
  platform: SessionPlatform;
  /** Operating system with its version where known: "Android 15", "Windows", "iOS 18.1". */
  os: string;
  /** Browser with its major version, or the app with its version: "Chrome 130", "POKYH App 2.1.0". */
  browser: string;
  /** The device model where the app names it: "samsung SM-S918B"; "" otherwise. */
  model: string;
}

const clean = (text: string, max: number) => text.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

// The apps' own User-Agent: "POKYH-Android/2.1.0 (Android 15; samsung SM-S918B)".
const APP_AGENT = /^POKYH-(Android|iOS)\/([\w.+-]{1,32})(?:\s*\(([^)]*)\))?/i;

function appDevice(match: RegExpMatchArray): DeviceInfo {
  const isAndroid = match[1].toLowerCase() === 'android';
  const [osPart = '', modelPart = ''] = (match[3] ?? '').split(';').map((part) => clean(part, 60));
  return {
    client: 'app',
    platform: isAndroid ? 'android' : 'ios',
    os: osPart || (isAndroid ? 'Android' : 'iOS'),
    browser: `POKYH App ${clean(match[2], 32)}`,
    model: modelPart,
  };
}

function browserOf(ua: string): string {
  const version = (re: RegExp) => ua.match(re)?.[1] ?? '';
  // Order matters: Edge, Opera, Samsung Internet and Brave-free Chromium
  // forks all name Chrome too; Chrome on iOS names Safari.
  const named: [string, RegExp][] = [
    ['Edge', /Edg(?:e|A|iOS)?\/(\d+)/],
    ['Opera', /(?:OPR|Opera)\/(\d+)/],
    ['Samsung Internet', /SamsungBrowser\/(\d+)/],
    ['Firefox', /(?:Firefox|FxiOS)\/(\d+)/],
    ['Chrome', /(?:Chrome|CriOS)\/(\d+)/],
  ];
  for (const [name, re] of named) {
    const v = version(re);
    if (v) return `${name} ${v}`;
  }
  if (/Safari\//.test(ua)) {
    const v = version(/Version\/(\d+(?:\.\d+)?)/);
    return v ? `Safari ${v}` : 'Safari';
  }
  return '';
}

function systemOf(ua: string): { platform: SessionPlatform; os: string } {
  let m: RegExpMatchArray | null;
  if ((m = ua.match(/Android\s+([\d.]+)/))) return { platform: 'android', os: `Android ${m[1].split('.')[0]}` };
  if (/Android/.test(ua)) return { platform: 'android', os: 'Android' };
  if ((m = ua.match(/(?:iPhone|iPad|iPod).*?OS (\d+)(?:_(\d+))?/))) return { platform: 'ios', os: `iOS ${m[1]}${m[2] ? `.${m[2]}` : ''}` };
  if (/iPhone|iPad|iPod/.test(ua)) return { platform: 'ios', os: 'iOS' };
  if (/CrOS/.test(ua)) return { platform: 'chromeos', os: 'ChromeOS' };
  // Windows 11 still reports "Windows NT 10.0" in its User-Agent.
  if (/Windows NT/.test(ua)) return { platform: 'windows', os: 'Windows' };
  if (/Mac OS X|Macintosh/.test(ua)) return { platform: 'macos', os: 'macOS' };
  if (/Linux|X11/.test(ua)) return { platform: 'linux', os: 'Linux' };
  return { platform: 'other', os: '' };
}

/**
 * What the request's User-Agent says about the device. `clientHint` is the
 * website's own X-Pokyh-Client header ("pwa" when it runs installed to the
 * home screen); only a browser can be one.
 */
export function deviceFromRequest(userAgent: HeaderValue, clientHint?: HeaderValue): DeviceInfo {
  const ua = clean(firstHeader(userAgent), 500);
  const app = ua.match(APP_AGENT);
  if (app) return appDevice(app);
  const browser = browserOf(ua);
  const { platform, os } = systemOf(ua);
  if (!browser) {
    // Apps from before they named themselves (okhttp, Dart, …) and servers.
    if (/okhttp/i.test(ua)) return { client: 'app', platform: 'android', os: 'Android', browser: 'POKYH App', model: '' };
    return { client: 'other', platform, os, browser: '', model: '' };
  }
  const client: SessionClient = firstHeader(clientHint).trim().toLowerCase() === 'pwa' ? 'pwa' : 'web';
  return { client, platform, os, browser, model: '' };
}

/** A device id the app or the website's device cookie sent, or null when there is none or it is malformed. */
export function deviceIdFrom(value: HeaderValue): string | null {
  const id = firstHeader(value).trim();
  return /^[A-Za-z0-9_-]{16,64}$/.test(id) ? id : null;
}

/** A short name of the device for a list: "Android · POKYH App 2.1.0", "Windows · Chrome 130". */
export function deviceLabel(device: Pick<DeviceInfo, 'os' | 'browser' | 'model'>): string {
  const system = device.model ? `${device.os || 'Unbekannt'} (${device.model})` : device.os || 'Unbekannt';
  return device.browser ? `${system} · ${device.browser}` : system;
}

/** "Brixen, Trentino-Südtirol, IT": the place a sign-in came from, as far as the edge told; "" when unknown. */
export function placeLabel(place: { city?: string | null; region?: string | null; country?: string | null }): string {
  return [place.city, place.region, place.country].filter((part): part is string => typeof part === 'string' && part.trim() !== '').join(', ');
}
