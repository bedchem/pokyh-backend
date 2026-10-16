import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './helpers/loadTs.mjs';

const P = await loadTs('src/security/permissions.ts');
const { accessFrom, can, mayGrant, mayManageTarget, mayRemoveAdmin, normalizeGrant, permissionsIn, accessibleSchools, presetByKey, presetFor, GLOBAL_SCOPE, SCHOOL_PERMISSIONS, ALL_PERMISSIONS, GLOBAL_ONLY_PERMISSIONS } = P;

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const schoolAdmin = (school) => accessFrom(false, [{ scope: school, permissions: presetByKey('school_admin').permissions }]);
const viewer = (school) => accessFrom(false, [{ scope: school, permissions: presetByKey('viewer').permissions }]);
const globalAdmin = accessFrom(false, [{ scope: GLOBAL_SCOPE, permissions: ALL_PERMISSIONS }]);
const owner = accessFrom(true, []);

test('nothing granted, nothing allowed (deny by default)', () => {
  const none = accessFrom(false, []);
  for (const p of ALL_PERMISSIONS) {
    assert.equal(can(none, p, null), false, p);
    assert.equal(can(none, p, A), false, p);
  }
  assert.deepEqual(accessibleSchools(none), []);
});

test('a viewer reads and never writes', () => {
  const v = viewer(A);
  assert.equal(can(v, 'users.view', A), true);
  assert.equal(can(v, 'users.update', A), false);
  assert.equal(can(v, 'users.delete', A), false);
  assert.equal(can(v, 'comments.moderate', A), false);
  assert.equal(can(v, 'mensa.manage', A), false);
});

test('school rights hold in that school only, never across schools or globally', () => {
  const a = schoolAdmin(A);
  assert.equal(can(a, 'users.delete', A), true);
  assert.equal(can(a, 'users.delete', B), false);
  assert.equal(can(a, 'users.view', null), false, 'the all-schools view needs a global grant');
  assert.deepEqual(accessibleSchools(a), [A]);
});

test('a school grant can never carry a global-only permission', () => {
  const tampered = accessFrom(false, [{ scope: A, permissions: ['cluster.manage', 'schools.manage', 'admins.global.manage', 'users.view'] }]);
  for (const p of GLOBAL_ONLY_PERMISSIONS) assert.equal(can(tampered, p, A), false, p);
  assert.equal(can(tampered, 'users.view', A), true);
  const check = normalizeGrant(A, ['users.view', 'backups.manage']);
  assert.equal(check.ok, false);
  assert.equal(check.status, 400);
});

test('unknown permission keys are rejected on save and ignored when read', () => {
  assert.equal(normalizeGrant(A, ['users.view', 'root']).ok, false);
  const access = accessFrom(false, [{ scope: A, permissions: ['root', 'users.view'] }]);
  assert.deepEqual([...permissionsIn(access, A)], ['users.view']);
});

test('a global grant applies to every school; owners hold everything', () => {
  assert.equal(can(globalAdmin, 'mensa.manage', B), true);
  assert.equal(can(globalAdmin, 'cluster.manage', null), true);
  assert.equal(accessibleSchools(globalAdmin), 'all');
  for (const p of ALL_PERMISSIONS) assert.equal(can(owner, p, A), true);
});

test('a school admin cannot create a global admin or grant global rights', () => {
  const a = schoolAdmin(A);
  const check = mayGrant(a, GLOBAL_SCOPE, ['users.view']);
  assert.equal(check.ok, false);
  assert.equal(check.status, 403);
});

test('a school admin cannot grant rights in another school', () => {
  assert.equal(mayGrant(schoolAdmin(A), B, ['users.view']).ok, false);
});

test('nobody hands out more than they hold (no privilege escalation)', () => {
  // A moderator with the right to manage admins, but no Mensa right.
  const limited = accessFrom(false, [{ scope: A, permissions: ['admins.manage', 'comments.view', 'comments.moderate'] }]);
  assert.equal(mayGrant(limited, A, ['comments.view']).ok, true);
  const beyond = mayGrant(limited, A, ['comments.view', 'mensa.manage']);
  assert.equal(beyond.ok, false);
  assert.match(beyond.error, /selbst hast/);
});

test('without the right to manage admins, no grant at all', () => {
  assert.equal(mayGrant(viewer(A), A, ['users.view']).ok, false);
});

test('a school admin cannot strip a global admin or an owner', () => {
  assert.equal(mayManageTarget(schoolAdmin(A), globalAdmin, GLOBAL_SCOPE).ok, false);
  assert.equal(mayManageTarget(globalAdmin, owner, GLOBAL_SCOPE).ok, false);
  // Equal rights in the same school: may manage.
  assert.equal(mayManageTarget(schoolAdmin(A), schoolAdmin(A), A).ok, true);
  // A target with more rights in that school than the actor: may not.
  const moderatorManager = accessFrom(false, [{ scope: A, permissions: ['admins.manage', 'comments.view'] }]);
  assert.equal(mayManageTarget(moderatorManager, schoolAdmin(A), A).ok, false);
  assert.equal(mayRemoveAdmin(schoolAdmin(A), globalAdmin, [GLOBAL_SCOPE]).ok, false);
});

test('presets: school presets hold school permissions only; the catalog is complete', () => {
  for (const key of ['viewer', 'moderator', 'mensa_manager', 'school_admin']) {
    for (const p of presetByKey(key).permissions) assert.ok(SCHOOL_PERMISSIONS.includes(p), `${key}: ${p}`);
  }
  assert.equal(presetFor(A, presetByKey('school_admin').permissions), 'school_admin');
  assert.equal(presetFor(GLOBAL_SCOPE, ALL_PERMISSIONS), 'global_admin');
  assert.equal(presetFor(A, ['users.view']), 'custom');
});
