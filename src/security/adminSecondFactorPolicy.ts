// When an admin panel login needs a second factor (authenticator app or
// passkey). The rules only, without the database, so they can be tested on
// their own; services/adminSecurity.ts applies them.
//
//   - Every admin account follows the installation default
//     (ADMIN_REQUIRE_SECOND_FACTOR, on unless set to false) until another
//     admin sets it for that account. Server owners (ADMIN_USERNAMES) are
//     managed in the .env and always follow the default.
//   - Required and nothing set up yet: the password still opens the panel,
//     but only far enough to set up a second factor.
//   - Required: the last factor cannot be removed.
//   - Lowering the requirement takes another admin; an admin may only raise
//     their own.

export type FactorState = { totp: boolean; passkey: boolean };

export function secondFactorRequired(setting: boolean | null | undefined, owner: boolean, installationDefault: boolean): boolean {
  if (owner || setting === null || setting === undefined) return installationDefault;
  return setting;
}

export function hasSecondFactor(factors: FactorState): boolean {
  return factors.totp || factors.passkey;
}

/** Signed in although a second factor is required and none is set up yet. */
export function secondFactorSetupPending(required: boolean, factors: FactorState): boolean {
  return required && !hasSecondFactor(factors);
}

/** May a factor go when `remaining` is what is left afterwards? */
export function mayRemoveFactor(required: boolean, remaining: FactorState): boolean {
  return !required || hasSecondFactor(remaining);
}

export type RequirementChange = 'ok' | 'owner' | 'self-lower';

/**
 * May the requirement of `target` be set to `required` (null: back to the
 * installation default, which counts as lowering when that default is off)?
 */
export function requirementChange(opts: {
  self: boolean;
  targetOwner: boolean;
  required: boolean | null;
  installationDefault: boolean;
}): RequirementChange {
  if (opts.targetOwner) return 'owner';
  const effective = opts.required ?? opts.installationDefault;
  if (opts.self && !effective) return 'self-lower';
  return 'ok';
}
