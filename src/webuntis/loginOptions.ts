// How a school's people sign in to WebUntis, as its own sign-in page offers
// it: with user name and password, with the school's Microsoft account
// ("Office 365 Anmeldung"), or both. WebUntis announces it nowhere else than
// in the configuration it embeds in that page (`loginServiceConfig`). Pure,
// tested on its own (tests/webuntisLoginOptions.test.mjs); ./schools.ts
// fetches the page.

export interface LoginOptions {
  /** User name and password. */
  password: boolean;
  /** Office 365: signing in with the account's app key (./appKey.ts). */
  office365: boolean;
}

function flag(html: string, name: string): boolean | undefined {
  const value = html.match(new RegExp(`"${name}"\\s*:\\s*(true|false)\\b`))?.[1];
  return value === undefined ? undefined : value === 'true';
}

/** The options of a WebUntis page; null when it has none (not a sign-in page). */
export function readLoginOptions(html: string): LoginOptions | null {
  const office365 = flag(html, 'ssoOffice365');
  const hidden = flag(html, 'hideWuLogin');
  if (office365 === undefined && hidden === undefined) return null;
  // WebUntis hides the password form only next to another way in; without
  // Office 365 the form stays, so a school is never left without one.
  return { office365: office365 === true, password: hidden !== true || office365 !== true };
}
