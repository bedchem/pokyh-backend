import { totpCode, totpStep } from '../security/totp';

// Signing in with the account's app key instead of its password: the way in
// for people whose school signs them in with Office 365, who have no WebUntis
// password to give. WebUntis hands every account such a key under Profil →
// Freigaben → App-Zugang ("Schlüssel", the same one its QR code gives Untis
// Mobile); with it, a client signs in with the one-time code of the moment
// (TOTP, RFC 6238, as the official app does) through WebUntis' mobile
// interface. Pure (the network call is the sign-in route's), tested on its own
// (tests/webuntisAppKey.test.mjs).

const BASE32_KEY = /^[A-Z2-7]{16,128}$/;

/** The key as WebUntis shows it, normalised; '' when it is not one. */
export function normaliseAppKey(value: unknown): string {
  if (typeof value !== 'string') return '';
  const key = value.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  return BASE32_KEY.test(key) ? key : '';
}

/** The JSON-RPC body that signs in with the key at `nowMs` (POST jsonrpc_intern.do?m=getUserData2017). */
export function appKeyRequest(username: string, key: string, nowMs: number): object {
  return {
    id: 'pokyh-app',
    method: 'getUserData2017',
    params: [{ auth: { clientTime: nowMs, user: username, otp: totpCode(key, totpStep(nowMs)) } }],
    jsonrpc: '2.0',
  };
}

// WebUntis' element types (its JSON-RPC numbers them like this).
const PERSON_TYPES: Record<string, number> = { TEACHER: 2, STUDENT: 5, PARENT: 12, LEGAL_GUARDIAN: 12 };

export interface AppKeyAccount {
  /** 0 when the answer names nobody. */
  personId: number;
  personType?: number;
  /** The class when the answer names exactly one, else 0. */
  klasseId: number;
}

/** Whom the key signed in, from the answer's `userData` (what `authenticate` answers for a password). */
export function readAppKeyAccount(result: unknown): AppKeyAccount {
  const raw = (result as { userData?: unknown } | null)?.userData;
  const user = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const personId = Number(user.elemId);
  const personType = typeof user.elemType === 'string' ? PERSON_TYPES[user.elemType.toUpperCase()] : undefined;
  const klassen = Array.isArray(user.klassenIds)
    ? user.klassenIds.map(Number).filter((id) => Number.isInteger(id) && id > 0)
    : [];
  return {
    personId: Number.isInteger(personId) && personId > 0 ? personId : 0,
    ...(personType ? { personType } : {}),
    klasseId: klassen.length === 1 ? klassen[0] : 0,
  };
}
