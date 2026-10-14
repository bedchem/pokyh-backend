import { randomBytes } from 'crypto';

// Invite codes. Pure encoding with no dependency beyond Node itself, so it is
// tested on its own (tests/clusterInvite).
//
// A code carries everything the joining node needs: where the inviting node
// is reached, which node it is (so nobody else can stand in for it), a
// one-time secret both sides prove knowledge of during pairing, and when the
// code stops working. It is a bearer secret — whoever holds it while it is
// valid can join and receive all data — so it is shown once, valid for
// minutes, and usable once.

const PREFIX = 'pokyh1.';
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const NODE_ID = /^[A-Za-z0-9-]{8,36}$/;

export interface Invite {
  address: string;
  nodeId: string;
  name: string;
  secret: string;
  expiresAt: Date;
}

export function newInviteSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function encodeInvite(invite: Invite): string {
  const body = {
    v: 1,
    // Address of the inviting node, as the joining node reaches it.
    a: invite.address,
    n: invite.nodeId,
    m: invite.name,
    s: invite.secret,
    // Expiry, seconds since the epoch.
    e: Math.floor(invite.expiresAt.getTime() / 1000),
  };
  return PREFIX + Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
}

export type DecodedInvite = { ok: true; invite: Invite } | { ok: false; error: string };

const damaged: DecodedInvite = { ok: false, error: 'Invite code is damaged or incomplete' };

export function decodeInvite(code: string, now = Date.now()): DecodedInvite {
  const trimmed = code.replace(/\s+/g, '');
  if (!trimmed.startsWith(PREFIX)) return { ok: false, error: 'This is not a Pokyh invite code' };
  if (trimmed.length > 2048) return { ok: false, error: 'Invite code is too long' };
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(Buffer.from(trimmed.slice(PREFIX.length), 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return damaged;
    body = parsed as Record<string, unknown>;
  } catch {
    return damaged;
  }
  const { v, a, n, m, s, e } = body;
  if (v !== 1) return { ok: false, error: 'Invite code comes from a different Pokyh version' };
  if (typeof a !== 'string' || a.length === 0 || a.length > 255) return damaged;
  if (typeof n !== 'string' || !NODE_ID.test(n)) return damaged;
  if (typeof m !== 'string' || m.length > 120) return damaged;
  if (typeof s !== 'string' || !SECRET.test(s)) return damaged;
  if (typeof e !== 'number' || !Number.isInteger(e) || e <= 0) return damaged;
  const expiresAt = new Date(e * 1000);
  if (expiresAt.getTime() <= now) return { ok: false, error: 'Invite code has expired — create a new one' };
  return { ok: true, invite: { address: a, nodeId: n, name: m, secret: s, expiresAt } };
}
