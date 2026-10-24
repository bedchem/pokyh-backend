// What WebUntis' sign-in form (./webLogin.ts) answered. Pure, tested on its
// own (tests/webuntisWebLogin.test.mjs).

export type WebLoginState = 'success' | 'two_factor_required' | 'two_factor_invalid' | 'bad_credentials' | 'refused';

export function readWebLoginState(json: unknown, sentToken: boolean): WebLoginState {
  const j = (json ?? {}) as { state?: unknown; invalidToken?: unknown };
  switch (j.state) {
    case 'SUCCESS':
      return 'success';
    case 'TOKEN_REQUIRED':
      // Asked again for the code after one was sent: that one was wrong.
      return sentToken || j.invalidToken === true ? 'two_factor_invalid' : 'two_factor_required';
    case 'LOGIN_ERROR':
      return 'bad_credentials';
    default:
      // MUST_SET_PASSWORD, MUST_UPDATE_LEGACY_PASSWORD, a locked account …:
      // WebUntis wants something only its own website can ask for.
      return 'refused';
  }
}

/** A six-digit code of an authenticator app, spaces allowed; null otherwise. */
export function twoFactorCode(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const code = String(value).replace(/\s+/g, '');
  return /^\d{6}$/.test(code) ? code : null;
}
