import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './helpers/loadTs.mjs';

const { adminRoleChoices, adminSetPasswords } = await loadTs('src/utils/roleChoices.ts');

const at = (minute) => new Date(Date.UTC(2026, 9, 1, 8, minute));
const row = (targetId, action, detail, minute) => ({ targetId, action, detail: JSON.stringify(detail), createdAt: at(minute) });

test('an admin\'s latest role decision per account wins, in whatever order the rows come', () => {
  const choices = adminRoleChoices([
    row('u1', 'user.role', { from: 'student', to: 'parent' }, 5),
    row('u1', 'user.role', { from: 'parent', to: 'student' }, 2),
    row('u2', 'user.role', { from: 'student', to: 'none' }, 1),
  ]);
  assert.equal(choices.get('u1'), 'parent');
  assert.equal(choices.get('u2'), 'none');
});

test('a parent or role-less account an admin made is a decision; a new student is not', () => {
  const choices = adminRoleChoices([
    row('u1', 'user.create', { role: 'parent', admin: false, local: false }, 1),
    row('u2', 'user.create', { role: 'student' }, 1),
    row('u3', 'user.create', { role: 'none' }, 1),
  ]);
  assert.deepEqual([...choices.entries()].sort(), [['u1', 'parent'], ['u3', 'none']]);
});

test('"back to WebUntis" drops the choice; a broken or unknown detail is no decision', () => {
  const choices = adminRoleChoices([
    row('u1', 'user.role', { to: 'parent' }, 1),
    row('u1', 'user.role', { from: 'parent', to: 'parent', locked: false }, 2),
    { targetId: 'u2', action: 'user.role', detail: 'not json', createdAt: at(1) },
    row('u3', 'user.role', { to: 'admin' }, 1),
    row('', 'user.role', { to: 'parent' }, 1),
  ]);
  assert.equal(choices.size, 0);
});

test('passwords an admin set: accounts made with one, and every password set in the panel', () => {
  const set = adminSetPasswords([
    row('u1', 'user.create', { role: 'student', local: true }, 1),
    row('u2', 'user.create', { role: 'student', local: false }, 1),
    row('u3', 'user.password', { admin: false }, 1),
  ]);
  assert.deepEqual([...set].sort(), ['u1', 'u3']);
});
