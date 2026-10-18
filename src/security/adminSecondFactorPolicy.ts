// Which second factors an admin panel login needs. The rules only, without
// the database, so they can be tested on their own; services/adminSecurity.ts
// applies them.
//
//   - The authenticator app (2FA) is required for every admin account. Only
//     the server can switch that off (ADMIN_REQUIRE_SECOND_FACTOR=false).
//   - A passkey is optional. Per account another admin can make it required;
//     accounts without their own setting follow ADMIN_REQUIRE_PASSKEY (off by
//     default). Server owners (ADMIN_USERNAMES) are managed in the .env and
//     always follow the server settings.
//   - Something required is missing: the password (or a passkey) still opens
//     the panel, but only far enough to set it up.
//   - A passkey required and set up: the login is confirmed with it; a code
//     from the app no longer does (a recovery code still does, for emergencies).
//   - What is required cannot be removed while it is the last of its kind.
//   - Lowering the passkey requirement takes another admin; an admin may only
//     raise their own.

export type FactorKind = 'totp' | 'passkey';
export type FactorState = Record<FactorKind, boolean>;
export type Requirements = Record<FactorKind, boolean>;

export type ServerRequirements = {
  // ADMIN_REQUIRE_SECOND_FACTOR: the authenticator app for every admin.
  totp: boolean;
  // ADMIN_REQUIRE_PASSKEY: a passkey for accounts without their own setting.
  passkey: boolean;
};

export function requirementsFor(passkeySetting: boolean | null | undefined, owner: boolean, server: ServerRequirements): Requirements {
  const passkey = owner || passkeySetting === null || passkeySetting === undefined ? server.passkey : passkeySetting;
  return { totp: server.totp, passkey };
}

export function missingFactors(required: Requirements, factors: FactorState): FactorKind[] {
  return (['totp', 'passkey'] as const).filter((kind) => required[kind] && !factors[kind]);
}

/** Signed in, but something required is not set up yet. */
export function setupPending(required: Requirements, factors: FactorState): boolean {
  return missingFactors(required, factors).length > 0;
}

/** May a factor of `kind` go when `remaining` is what is left afterwards? */
export function mayRemoveFactor(kind: FactorKind, required: Requirements, remaining: FactorState): boolean {
  return !required[kind] || remaining[kind];
}

/**
 * The ways a login is confirmed after the password: with a passkey only
 * when one is required and set up, otherwise whatever is set up. Nothing set
 * up: no second step (the session then sets up what is required).
 */
export function loginSteps(required: Requirements, factors: FactorState): FactorState {
  if (required.passkey && factors.passkey) return { totp: false, passkey: true };
  return { ...factors };
}

export type RequirementChange = 'ok' | 'owner' | 'self-lower';

/**
 * May the passkey requirement of `target` be set to `required` (null: back to
 * the server default, which counts as lowering when that default is off)?
 */
export function requirementChange(opts: {
  self: boolean;
  targetOwner: boolean;
  required: boolean | null;
  serverDefault: boolean;
}): RequirementChange {
  if (opts.targetOwner) return 'owner';
  const effective = opts.required ?? opts.serverDefault;
  if (opts.self && !effective) return 'self-lower';
  return 'ok';
}
