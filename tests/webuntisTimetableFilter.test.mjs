import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './helpers/loadTs.mjs';

const { readTimetableFilter } = await loadTs('src/webuntis/timetableFilter.ts');

test('classes nested per entry, departments left out, sorted by name', () => {
  const items = readTimetableFilter({
    departments: [{ id: 9, name: 'Informatik' }],
    preSelected: { id: 1962, shortName: '4.BFS-FI', longName: '4. Fachschule Informatik' },
    classes: [
      { class: { id: 1970, shortName: '10.B', longName: '' }, department: { id: 9, name: 'Informatik' } },
      { class: { id: 1962, shortName: '4.BFS-FI', longName: '4. Fachschule Informatik' } },
      { class: { id: 1963, shortName: '2.A', displayName: '2.A' } },
    ],
  });
  assert.deepEqual(items.map((i) => i.name), ['2.A', '4.BFS-FI', '10.B']);
  assert.equal(items.find((i) => i.id === 1962).longName, '4. Fachschule Informatik');
  assert.equal(items.some((i) => i.id === 9), false);
});

test('nothing usable gives an empty list', () => {
  assert.deepEqual(readTimetableFilter(null), []);
  assert.deepEqual(readTimetableFilter({ classes: [] }), []);
  assert.deepEqual(readTimetableFilter([{ id: 'x', name: 'y' }]), []);
});
