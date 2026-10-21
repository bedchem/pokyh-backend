// Whether the sealed sign-in of the renewal cookie may renew the request's
// WebUntis session. Pure (the school parser and the default school are passed
// in), tested on its own (tests/webuntisRenewal.test.mjs).

export interface RenewalSchool {
  loginName: string;
  server: string;
  name?: string;
}

export interface SavedSignIn {
  username: string;
  password: string;
  school: RenewalSchool;
}

export interface RenewalRules {
  now: number;
  /** How long a session lives; an older one cannot be renewed. */
  maxAgeMs: number;
  parseSchool: (value: unknown) => RenewalSchool | null;
  /** The school of sessions from before schools existed. */
  defaultSchool: RenewalSchool;
}

type Sealed = { kind?: unknown; u?: unknown; p?: unknown; s?: unknown };
type SessionPart = { username?: unknown; school?: RenewalSchool; loginAt?: unknown };

/** What the renewal cookie holds for this session, or null: none, another account or school, or a session too old. */
export function matchRenewal(saved: Sealed | null, session: SessionPart | null, rules: RenewalRules): SavedSignIn | null {
  if (saved?.kind !== 'renewal' || typeof saved.u !== 'string' || typeof saved.p !== 'string' || !session) return null;
  if (typeof session.loginAt === 'number' && rules.now - session.loginAt > rules.maxAgeMs) return null;
  const school = rules.parseSchool(saved.s);
  const sessionSchool = session.school ?? rules.defaultSchool;
  if (!school || session.username !== saved.u || sessionSchool.loginName !== school.loginName) return null;
  return { username: saved.u, password: saved.p, school };
}

/** What the renewal cookie seals (./seal.ts). */
export function renewalPayload(signIn: SavedSignIn): object {
  return { kind: 'renewal', u: signIn.username, p: signIn.password, s: signIn.school };
}
