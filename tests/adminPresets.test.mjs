import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './helpers/loadTs.mjs';

const P = await loadTs('src/security/permissions.ts');
const all = new Set(P.ALL_PERMISSIONS);

test('an own preset needs a name, a scope and at least one known right', () => {
  assert.equal(P.normalizePreset({ label: '  ', scope: 'school', permissions: ['users.view'] }, all).ok, false);
  assert.equal(P.normalizePreset({ label: 'X', scope: 'class', permissions: ['users.view'] }, all).ok, false);
  assert.equal(P.normalizePreset({ label: 'X', scope: 'school', permissions: [] }, all).ok, false);
  const unknown = P.normalizePreset({ label: 'X', scope: 'school', permissions: ['users.fly'] }, all);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.status, 400);
  const ok = P.normalizePreset({ label: '  Mensa  Team ', description: ' Plan\n pflegen ', scope: 'school', permissions: ['mensa.manage', 'mensa.view'] }, all);
  assert.equal(ok.ok, true);
  assert.equal(ok.label, 'Mensa Team');
  assert.equal(ok.description, 'Plan pflegen');
  assert.deepEqual(ok.permissions, ['mensa.view', 'mensa.manage'], 'catalog order');
});

test('a school preset holds no global-only right', () => {
  const check = P.normalizePreset({ label: 'X', scope: 'school', permissions: ['users.view', 'backups.manage'] }, all);
  assert.equal(check.ok, false);
  assert.equal(P.normalizePreset({ label: 'X', scope: 'global', permissions: ['users.view', 'backups.manage'] }, all).ok, true);
});

test('a preset never holds more than its author has', () => {
  const own = new Set(['users.view', 'comments.view']);
  const check = P.normalizePreset({ label: 'X', scope: 'school', permissions: ['users.view', 'users.delete'] }, own);
  assert.equal(check.ok, false);
  assert.equal(check.status, 403);
  assert.equal(P.normalizePreset({ label: 'X', scope: 'school', permissions: ['users.view'] }, own).ok, true);
});

test('own preset keys are readable, unique and never a built-in one', () => {
  assert.equal(P.customPresetKey('Mensa-Team Süd', new Set()), 'custom_mensa_team_sud');
  assert.equal(P.customPresetKey('Mensa-Team Süd', new Set(['custom_mensa_team_sud'])), 'custom_mensa_team_sud_2');
  assert.equal(P.customPresetKey('!!!', new Set()), 'custom_vorlage');
  const long = P.customPresetKey('x'.repeat(200), new Set());
  assert.ok(long.length <= P.PRESET_KEY_MAX);
  assert.equal(P.isBuiltInPreset('viewer'), true);
  assert.equal(P.isBuiltInPreset(long), false);
});

test('grants are recognised as an own preset too', () => {
  const own = { key: 'custom_mensa', label: 'Mensa', description: '', scope: 'school', permissions: ['mensa.view', 'mensa.manage'], custom: true };
  const presets = [...P.PRESETS, own];
  assert.equal(P.presetFor('school-a', ['mensa.view', 'mensa.manage'], presets), 'custom_mensa');
  assert.equal(P.presetFor('school-a', ['mensa.view', 'mensa.manage']), 'custom', 'without it: own selection');
  assert.equal(P.presetFor(P.GLOBAL_SCOPE, ['mensa.view', 'mensa.manage'], presets), 'custom', 'a school preset does not name a global grant');
  assert.equal(P.presetByKey('custom_mensa', presets), own);
});
