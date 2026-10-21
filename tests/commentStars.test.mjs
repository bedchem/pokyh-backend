import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './helpers/loadTs.mjs';

const { withStars } = await loadTs('src/utils/commentStars.ts');

const S = 'school-a';
const comment = (stableUid, username, schoolId = S) => ({ id: `${stableUid}-c`, stableUid, username, schoolId, body: 'x' });
const vote = (stableUid, username, stars, schoolId = S) => ({ stableUid, username, schoolId, stars });

test('a comment gets the stars of its author’s vote', () => {
  const [c] = withStars([comment('u1', 'anna')], [vote('u1', 'anna', 4)]);
  assert.equal(c.stars, 4);
  assert.equal(c.body, 'x');
});

test('without a vote the stars are null', () => {
  const [c] = withStars([comment('u1', 'anna')], [vote('u2', 'ben', 5)]);
  assert.equal(c.stars, null);
});

test('a comment from before the stableUid changed finds the vote by name, case-insensitively', () => {
  const [c] = withStars([comment('old-uid', 'Anna.Muster')], [vote('new-uid', 'anna.muster', 2)]);
  assert.equal(c.stars, 2);
});

test('the same name at another school is another person', () => {
  const [c] = withStars([comment('old-uid', 'anna')], [vote('new-uid', 'anna', 2, 'school-b')]);
  assert.equal(c.stars, null);
});

test('the account match wins over the name', () => {
  const [c] = withStars([comment('u1', 'anna')], [vote('u9', 'anna', 1), vote('u1', 'anna', 5)]);
  assert.equal(c.stars, 5);
});

test('a vote without a stored name only matches by account', () => {
  const comments = withStars([comment('u1', 'anna'), comment('u2', 'ben')], [vote('u1', null, 3)]);
  assert.deepEqual(comments.map((c) => c.stars), [3, null]);
});
