import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import tls from 'tls';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { connectTarget, parseEndpoint, parsePathWay } from './endpoints';
import { ownIdentity } from './mtls';
import { CLUSTER_PATH } from './protocol';
import type { ReachKind } from './reach';
import { certificatePin } from './x509';

// "Test this way" in the admin panel: this node connects to one of its own
// ways — through the proxy, the relay, the VPN, whatever the way is — and
// checks that it arrives at this very node:
//
//   pinned ways: the certificate presented at the end is this node's own;
//   a way through the web proxy: the answer to a fresh challenge carries a
//   MAC only this node can compute.
//
// Nothing secret travels; the challenge's key exists only in this process.

const NONCE = /^[A-Za-z0-9_-]{22,64}$/;

// Random per process and never shared: not even another node of the same
// cluster (which knows the shared secrets) can give the right answer.
const PROBE_KEY = randomBytes(32);

function probeAnswer(nonce: string): Buffer {
  return createHmac('sha256', PROBE_KEY).update(`pokyh-cluster/way-probe/v1:${nonce}`).digest();
}

export function handleProbe(req: Request, res: Response): void {
  const parsed = z.object({ n: z.string().regex(NONCE) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Rejected' });
    return;
  }
  res.json({ m: probeAnswer(parsed.data.n).toString('base64url') });
}

export interface WayTestResult {
  ok: boolean;
  ms: number;
  message: string;
}

function pinnedWay(endpointText: string, timeoutMs: number): Promise<WayTestResult> {
  const endpoint = parseEndpoint(endpointText);
  const own = ownIdentity();
  if (!endpoint) return Promise.resolve({ ok: false, ms: 0, message: 'The address is not valid' });
  if (!own) return Promise.resolve({ ok: false, ms: 0, message: 'This node has no certificate yet' });
  const target = connectTarget(endpoint);
  const started = Date.now();
  return new Promise((resolve) => {
    const socket = tls.connect({
      host: target.host,
      port: target.port,
      servername: target.servername,
      minVersion: 'TLSv1.3',
      rejectUnauthorized: false,
    });
    const done = (result: WayTestResult) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => done({ ok: false, ms: Date.now() - started, message: 'No answer in time' }), timeoutMs);
    socket.once('secureConnect', () => {
      const cert = socket.getPeerX509Certificate();
      const ms = Date.now() - started;
      if (!cert) { done({ ok: false, ms, message: 'No certificate was presented' }); return; }
      if (certificatePin(cert) !== own.pin) {
        done({ ok: false, ms, message: 'Something else answers there — not this node (another certificate)' });
        return;
      }
      done({ ok: true, ms, message: 'Arrives at this node (its own certificate)' });
    });
    socket.once('error', (err) => done({ ok: false, ms: Date.now() - started, message: err.message.split('\n')[0]!.slice(0, 200) }));
  });
}

async function proxyPathWay(wayText: string, timeoutMs: number): Promise<WayTestResult> {
  const way = parsePathWay(wayText);
  if (!way) return { ok: false, ms: 0, message: 'The address is not valid' };
  const nonce = randomBytes(24).toString('base64url');
  const started = Date.now();
  try {
    const response = await fetch(`${way}${CLUSTER_PATH}/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ n: nonce }),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ms = Date.now() - started;
    if (response.status === 404) return { ok: false, ms, message: 'The proxy answers, but does not pass this path on (404) — check its configuration' };
    if (!response.ok) return { ok: false, ms, message: `The proxy answered HTTP ${response.status}` };
    const body = await response.json().catch(() => null) as { m?: unknown } | null;
    const expected = probeAnswer(nonce);
    const got = typeof body?.m === 'string' ? Buffer.from(body.m, 'base64url') : Buffer.alloc(0);
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
      return { ok: false, ms, message: 'Something else answers there — not this node' };
    }
    return { ok: true, ms, message: 'Arrives at this node' };
  } catch (err) {
    const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
    const text = cause instanceof Error ? cause.message : err instanceof Error ? err.message : String(err);
    return { ok: false, ms: Date.now() - started, message: text.slice(0, 200) };
  }
}

export function testWay(kind: ReachKind, endpoint: string, timeoutMs = 8_000): Promise<WayTestResult> {
  return kind === 'proxy-path' ? proxyPathWay(endpoint, timeoutMs) : pinnedWay(endpoint, timeoutMs);
}
