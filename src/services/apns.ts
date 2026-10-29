import http2 from 'node:http2';
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';

// Apple Push Notification service over HTTP/2 with token (.p8) auth. Only Node
// built-ins on purpose, so the tests can load it without a database.

export type ApnsEnvironment = 'sandbox' | 'production';

export interface ApnsOptions {
  keyId: string;
  teamId: string;
  // The .p8 file's PEM text.
  key: string;
  // The app's bundle id.
  topic: string;
  hosts: Record<ApnsEnvironment, string>;
  timeoutMs: number;
  // How long one provider token is reused (Apple: 20 to 60 minutes).
  tokenTtlMs: number;
  now?: () => number;
}

export interface ApnsDeviceRef {
  token: string;
  environment: ApnsEnvironment;
}

// What the app shows. Keys are looked up in the app's own strings, so the
// text comes out in the phone's language; the plain title/body are only there
// for anything that can't localize.
export interface ApnsAlert {
  title: string;
  titleKey: string;
  titleArgs?: string[];
  body: string;
  bodyKey?: string;
  bodyArgs?: string[];
  thread: string;
  url: string;
}

export type SendOutcome =
  | { kind: 'sent' }
  | { kind: 'gone'; reason: string }
  | { kind: 'refreshToken'; reason: string }
  | { kind: 'retryLater'; reason: string }
  | { kind: 'failed'; reason: string };

const MAX_PAYLOAD_BYTES = 4096;
const MAX_ARG_CHARS = 240;

const TOKEN_PATTERN = /^[0-9a-f]{64,200}$/i;

export function isDeviceToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

export function isEnvironment(value: unknown): value is ApnsEnvironment {
  return value === 'sandbox' || value === 'production';
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function providerToken(keyId: string, teamId: string, key: KeyObject, nowMs: number): string {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const claims = base64url(JSON.stringify({ iss: teamId, iat: Math.floor(nowMs / 1000) }));
  const signingInput = `${header}.${claims}`;
  // APNs wants the raw r||s signature, not DER.
  const signature = sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${base64url(signature)}`;
}

function clip(text: string, max = MAX_ARG_CHARS): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function buildPayload(alert: ApnsAlert): string {
  const titleArgs = alert.titleArgs?.map((a) => clip(a));
  const bodyArgs = alert.bodyArgs?.map((a) => clip(a));
  const apsAlert: Record<string, unknown> = {
    title: clip(alert.title),
    'title-loc-key': alert.titleKey,
    ...(titleArgs?.length ? { 'title-loc-args': titleArgs } : {}),
    body: clip(alert.body, 1000),
    ...(alert.bodyKey ? { 'loc-key': alert.bodyKey } : {}),
    ...(alert.bodyKey && bodyArgs?.length ? { 'loc-args': bodyArgs } : {}),
  };
  const payload = {
    aps: { alert: apsAlert, sound: 'default', 'thread-id': alert.thread },
    url: alert.url,
  };
  let json = JSON.stringify(payload);
  // Long reminder texts are the only thing that can get near the limit.
  if (Buffer.byteLength(json) > MAX_PAYLOAD_BYTES) {
    apsAlert.body = clip(alert.body, 200);
    json = JSON.stringify(payload);
  }
  return json;
}

export function classify(status: number, reason: string): SendOutcome {
  if (status === 200) return { kind: 'sent' };
  if (status === 410) return { kind: 'gone', reason: reason || 'Unregistered' };
  if (status === 400 && (reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic')) {
    return { kind: 'gone', reason };
  }
  if (status === 403 && reason === 'ExpiredProviderToken') return { kind: 'refreshToken', reason };
  if (status === 429 || status >= 500) return { kind: 'retryLater', reason: reason || `HTTP ${status}` };
  return { kind: 'failed', reason: reason || `HTTP ${status}` };
}

export class ApnsClient {
  private readonly key: KeyObject;
  private readonly hosts: Record<ApnsEnvironment, string>;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly sessions = new Map<string, http2.ClientHttp2Session>();
  private cached: { value: string; issuedAt: number } | null = null;

  constructor(private readonly options: ApnsOptions) {
    this.key = createPrivateKey(options.key);
    this.hosts = options.hosts;
    this.timeoutMs = options.timeoutMs;
    this.now = options.now ?? Date.now;
  }

  private token(): string {
    const now = this.now();
    if (!this.cached || now - this.cached.issuedAt >= this.options.tokenTtlMs) {
      this.cached = { value: providerToken(this.options.keyId, this.options.teamId, this.key, now), issuedAt: now };
    }
    return this.cached.value;
  }

  private session(host: string): http2.ClientHttp2Session {
    const open = this.sessions.get(host);
    if (open && !open.closed && !open.destroyed) return open;
    const session = http2.connect(host);
    const forget = () => {
      if (this.sessions.get(host) === session) this.sessions.delete(host);
    };
    session.on('error', forget);
    session.on('goaway', forget);
    session.on('close', forget);
    // Don't keep the process alive just for an idle push connection.
    session.unref();
    this.sessions.set(host, session);
    return session;
  }

  private post(device: ApnsDeviceRef, body: string, collapseId?: string): Promise<SendOutcome> {
    const host = this.hosts[device.environment];
    return new Promise((resolve) => {
      let settled = false;
      const done = (outcome: SendOutcome) => {
        if (!settled) {
          settled = true;
          resolve(outcome);
        }
      };
      let req: http2.ClientHttp2Stream;
      try {
        req = this.session(host).request({
          ':method': 'POST',
          ':path': `/3/device/${device.token}`,
          authorization: `bearer ${this.token()}`,
          'apns-topic': this.options.topic,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          ...(collapseId ? { 'apns-collapse-id': collapseId } : {}),
          'content-type': 'application/json',
        });
      } catch (err) {
        done({ kind: 'retryLater', reason: err instanceof Error ? err.message : String(err) });
        return;
      }
      let status = 0;
      let text = '';
      req.setEncoding('utf8');
      req.on('response', (headers) => {
        status = Number(headers[':status'] ?? 0);
      });
      req.on('data', (chunk: string) => {
        text += chunk;
      });
      req.on('end', () => {
        let reason = '';
        try {
          reason = text ? String((JSON.parse(text) as { reason?: unknown }).reason ?? '') : '';
        } catch {
          // Not JSON, keep the status alone.
        }
        done(classify(status, reason));
      });
      req.on('error', (err) => done({ kind: 'retryLater', reason: err.message }));
      req.setTimeout(this.timeoutMs, () => {
        req.close(http2.constants.NGHTTP2_CANCEL);
        done({ kind: 'retryLater', reason: 'timeout' });
      });
      req.end(body);
    });
  }

  async send(device: ApnsDeviceRef, alert: ApnsAlert, collapseId?: string): Promise<SendOutcome> {
    const body = buildPayload(alert);
    const first = await this.post(device, body, collapseId);
    if (first.kind !== 'refreshToken') return first;
    // Our token went stale before the TTL said so (clock skew); one retry with a fresh one.
    this.cached = null;
    const second = await this.post(device, body, collapseId);
    return second.kind === 'refreshToken' ? { kind: 'failed', reason: second.reason } : second;
  }

  close(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }
}
