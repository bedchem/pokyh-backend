import { readPageConfig } from './client';
import { schoolCookieValue, type UntisSchool } from './schools';
import { readWebLoginState, type WebLoginState } from './webLoginState';

// Signing in through WebUntis' own sign-in form (POST /j_spring_security_check),
// as its website does — the way that knows the second factor. An account with
// two-factor authentication answers TOKEN_REQUIRED until the six-digit code of
// its authenticator app is sent along (`token`).
//
// The form wants an anonymous session and its CSRF token first, which the
// school's sign-in page hands out (as for the password reset).

export type WebLoginResult =
  | { ok: true; sessionId: string }
  | { ok: false; code: Exclude<WebLoginState, 'success'> | 'unavailable' };

const sessionOf = (setCookie: string | null) => (setCookie ?? '').match(/JSESSIONID=([^;]+)/)?.[1];

export async function webFormLogin(base: string, school: UntisSchool, username: string, password: string, token?: string): Promise<WebLoginResult> {
  try {
    const page = await fetch(`${base}/?school=${encodeURIComponent(school.loginName)}`, {
      headers: { Accept: 'text/html' },
      signal: AbortSignal.timeout(12_000),
    });
    const anonymous = sessionOf(page.headers.get('set-cookie'));
    const pageConfig = readPageConfig(await page.text());
    if (!anonymous) return { ok: false, code: 'unavailable' };

    const form = new URLSearchParams({ school: school.loginName, j_username: username, j_password: password });
    if (token) form.set('token', token);
    const r = await fetch(`${base}/j_spring_security_check`, {
      method: 'POST',
      headers: {
        Cookie: `JSESSIONID=${anonymous}; schoolname="${schoolCookieValue(school)}"`,
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(pageConfig.csrf ? { 'X-CSRF-TOKEN': pageConfig.csrf } : {}),
        ...(pageConfig.tenant ? { 'Tenant-Id': pageConfig.tenant } : {}),
      },
      body: form.toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
    let json: unknown = null;
    try { json = JSON.parse(await r.text()); } catch { json = null; }
    if (!json) return { ok: false, code: r.status >= 500 ? 'unavailable' : 'refused' };

    const state = readWebLoginState(json, Boolean(token));
    if (state !== 'success') return { ok: false, code: state };
    // A successful sign-in usually starts a new session (its id changes).
    return { ok: true, sessionId: sessionOf(r.headers.get('set-cookie')) ?? anonymous };
  } catch {
    return { ok: false, code: 'unavailable' };
  }
}
