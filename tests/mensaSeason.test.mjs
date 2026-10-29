import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './helpers/loadTs.mjs';

const { lastSundayUtc, seasonOfWeek, isInSeason, snapForwardToSeason, servedDishes, toUtcIso } = await loadTs('src/utils/mensaSeason.ts');

const day = (iso) => new Date(`${iso}T00:00:00Z`);

test('the clocks change on the last Sunday of March and October', () => {
  assert.equal(toUtcIso(lastSundayUtc(2026, 2)), '2026-03-29');
  assert.equal(toUtcIso(lastSundayUtc(2026, 9)), '2026-10-25');
  assert.equal(toUtcIso(lastSundayUtc(2027, 2)), '2027-03-28');
  // The 31st itself is the last Sunday.
  assert.equal(toUtcIso(lastSundayUtc(2024, 2)), '2024-03-31');
  assert.equal(toUtcIso(lastSundayUtc(2027, 9)), '2027-10-31');
});

test('the winter plan takes over the week after the switch to winter time', () => {
  assert.equal(seasonOfWeek(day('2026-10-19')), 'summer');
  // Sunday of the switch still ends the summer week.
  assert.equal(seasonOfWeek(day('2026-10-25')), 'summer');
  assert.equal(seasonOfWeek(day('2026-10-26')), 'winter');
  // Still October, already winter.
  assert.equal(seasonOfWeek(day('2026-10-29')), 'winter');
  assert.equal(seasonOfWeek(day('2026-11-02')), 'winter');
  // The 31st as the switch day: the week before stays summer, even into November.
  assert.equal(seasonOfWeek(day('2027-10-25')), 'summer');
  assert.equal(seasonOfWeek(day('2027-10-31')), 'summer');
  assert.equal(seasonOfWeek(day('2027-11-01')), 'winter');
});

test('the summer plan takes over the week after the switch to summer time', () => {
  assert.equal(seasonOfWeek(day('2027-03-22')), 'winter');
  assert.equal(seasonOfWeek(day('2027-03-28')), 'winter');
  assert.equal(seasonOfWeek(day('2027-03-29')), 'summer');
  // Still March, already summer.
  assert.equal(seasonOfWeek(day('2027-03-31')), 'summer');
  // The 31st as the switch day: summer starts on Monday, April 1.
  assert.equal(seasonOfWeek(day('2024-03-25')), 'winter');
  assert.equal(seasonOfWeek(day('2024-03-31')), 'winter');
  assert.equal(seasonOfWeek(day('2024-04-01')), 'summer');
});

test('a week across the new year is winter', () => {
  assert.equal(seasonOfWeek(day('2026-12-28')), 'winter');
  assert.equal(seasonOfWeek(day('2027-01-01')), 'winter');
  assert.equal(seasonOfWeek(day('2027-01-03')), 'winter');
  assert.equal(isInSeason(day('2027-01-01'), 'winter'), true);
  assert.equal(isInSeason(day('2027-01-01'), 'summer'), false);
});

test('rotated weeks snap to the first week of their season', () => {
  assert.equal(toUtcIso(snapForwardToSeason(day('2026-11-02'), 'summer')), '2027-03-29');
  assert.equal(toUtcIso(snapForwardToSeason(day('2026-10-26'), 'summer')), '2027-03-29');
  assert.equal(toUtcIso(snapForwardToSeason(day('2026-03-30'), 'winter')), '2026-10-26');
  assert.equal(toUtcIso(snapForwardToSeason(day('2026-10-19'), 'summer')), '2026-10-19');
  assert.equal(toUtcIso(snapForwardToSeason(day('2026-10-19'), 'winter')), '2026-10-26');
});

const dish = (name, plan, iso) => ({ name, plan, date: day(iso) });
const names = (list) => list.map((d) => d.name);

test('each week is served from the plan of its season', () => {
  const served = servedDishes([
    dish('summer-mo', 'summer', '2026-10-19'),
    dish('winter-mo', 'winter', '2026-10-19'),
    dish('summer-next', 'summer', '2026-10-26'),
    dish('winter-next', 'winter', '2026-10-26'),
    dish('winter-next-tu', 'winter', '2026-10-27'),
  ]);
  assert.deepEqual(names(served), ['summer-mo', 'winter-next', 'winter-next-tu']);
});

test('a week the plan of its season has nothing for is served from the other plan', () => {
  const served = servedDishes([
    dish('summer-a', 'summer', '2026-10-26'),
    dish('summer-b', 'summer', '2026-10-29'),
    dish('winter-a', 'winter', '2026-11-02'),
    dish('summer-c', 'summer', '2027-03-22'),
  ]);
  assert.deepEqual(names(served), ['summer-a', 'summer-b', 'winter-a', 'summer-c']);
});

test('end of October: next week is the winter plan, not April', () => {
  // The live menu on 29.10.2026: the summer plan's current week, its next
  // weeks rotated to April, the winter plan starting on 2.11.
  const dishes = [
    ...['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'].map((iso) => dish(`s ${iso}`, 'summer', iso)),
    ...['2026-11-02', '2026-11-03', '2026-11-09'].map((iso) => dish(`w ${iso}`, 'winter', iso)),
    ...['2027-04-05', '2027-04-06'].map((iso) => dish(`s ${iso}`, 'summer', iso)),
  ].sort((a, b) => a.date - b.date);
  const served = servedDishes(dishes);
  const upcoming = served.filter((d) => toUtcIso(d.date) >= '2026-10-29').map((d) => toUtcIso(d.date));
  assert.deepEqual(upcoming, ['2026-10-29', '2026-10-30', '2026-11-02', '2026-11-03', '2026-11-09', '2027-04-05', '2027-04-06']);
  assert.equal(served.find((d) => toUtcIso(d.date) === '2026-11-02').plan, 'winter');
});

test('the order of the dishes is kept', () => {
  const list = [
    dish('b', 'winter', '2026-11-02'),
    dish('a', 'winter', '2026-11-02'),
    dish('c', 'summer', '2026-11-02'),
    dish('d', 'winter', '2026-11-03'),
  ];
  assert.deepEqual(names(servedDishes(list)), ['b', 'a', 'd']);
  assert.deepEqual(servedDishes([]), []);
});
