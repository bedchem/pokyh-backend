import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './helpers/loadTs.mjs';

const { readHolidays, isPlaceholderName } = await loadTs('src/webuntis/holidays.ts');

// As one school really has them: placeholder names, overlapping entries.
const SCHOOL = [
  { id: 1, name: 'Ferien1', longName: '31.10.2022-31.10.2022', startDate: 20261101, endDate: 20261108 },
  { id: 2, name: '1.11.', longName: '1.11.2026', startDate: 20261101, endDate: 20261101 },
  { id: 3, name: 'Ferien8', longName: '23.12.2023-23.12.2023', startDate: 20261207, endDate: 20261208 },
  { id: 4, name: '8.12.', longName: '8.12.2022', startDate: 20261208, endDate: 20261208 },
  { id: 5, name: 'Ferien5', longName: '24.12.2026-24.12.2026', startDate: 20261224, endDate: 20270106 },
  { id: 6, name: '6.1.', longName: '6.1.2027', startDate: 20270106, endDate: 20270106 },
  { id: 7, name: 'Faschingsferien', longName: 'Faschingsferien', startDate: 20270208, endDate: 20270214 },
  { id: 8, name: 'Ferien1', longName: 'x', startDate: 20251027, endDate: 20251102 },
];

test('placeholder names are told from real ones', () => {
  for (const name of ['Ferien1', 'Ferien', '8.12.', '25/5/2026', '31.10.2022-31.10.2022', 'Feiertag 2', '']) {
    assert.equal(isPlaceholderName(name), true, name);
  }
  for (const name of ['Weihnachtsferien', 'Faschingsferien', 'Tag der Republik']) {
    assert.equal(isPlaceholderName(name), false, name);
  }
});

test('overlapping entries become one break, past ones are left out', () => {
  const holidays = readHolidays(SCHOOL, '2026-09-01');
  assert.deepEqual(holidays.map((h) => [h.start, h.end]), [
    ['2026-11-01', '2026-11-08'],
    ['2026-12-07', '2026-12-08'],
    ['2026-12-24', '2027-01-06'],
    ['2027-02-08', '2027-02-14'],
  ]);
  assert.deepEqual(holidays[0].names, []);
  assert.deepEqual(holidays[3].names, ['Faschingsferien']);
});

test('adjoining days join, a gap does not', () => {
  const holidays = readHolidays([
    { name: 'A', startDate: 20270101, endDate: 20270102 },
    { name: 'B', startDate: 20270103, endDate: 20270103 },
    { name: 'C', startDate: 20270105, endDate: 20270105 },
  ], '2026-01-01');
  assert.deepEqual(holidays.map((h) => [h.start, h.end, h.names.join('+')]), [
    ['2027-01-01', '2027-01-03', 'A+B'],
    ['2027-01-05', '2027-01-05', 'C'],
  ]);
  assert.deepEqual(readHolidays(null, '2026-01-01'), []);
});
