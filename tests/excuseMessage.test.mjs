import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './helpers/loadTs.mjs';

const { absenceSpan, composeExcuse, excuseLocale, parseExcuseSubject } = await loadTs('src/webuntis/excuseMessage.ts');

const wednesday = { startDate: 20251217, startTime: 750, endDate: 20251217, endTime: 1305 };

test('a German excuse names the day, the times, the reason and the note', () => {
  const { subject, text } = composeExcuse({ absences: [wednesday], locale: 'de', reasonName: 'Krankheit', note: 'Fieber', signature: 'Muster Max' });
  assert.equal(subject, 'Entschuldigung: 17.12.2025, 07:50-13:05');
  assert.match(text, /^Guten Tag,\n\nhiermit entschuldige ich meine Abwesenheit am Mittwoch, 17\.12\.2025, von 07:50 bis 13:05\./);
  assert.match(text, /\nGrund: Krankheit\nBemerkung: Fieber\n/);
  assert.match(text, /Mit freundlichen Grüßen\nMuster Max$/);
});

test('a guardian writes about the child', () => {
  const { text } = composeExcuse({ absences: [wednesday], locale: 'de', reasonName: 'Arzttermin', childName: 'Muster Max' });
  assert.match(text, /die Abwesenheit meines Kindes Muster Max am Mittwoch/);
});

test('Italian and English use their own words and day/month order', () => {
  const it = composeExcuse({ absences: [wednesday], locale: 'it', reasonName: 'Malattia' });
  assert.equal(it.subject, 'Giustificazione: 17/12/2025, 07:50-13:05');
  assert.match(it.text, /la mia assenza di mercoledì 17\/12\/2025 dalle 07:50 alle 13:05\./);
  assert.match(it.text, /Motivo: Malattia/);
  const en = composeExcuse({ absences: [wednesday], locale: 'en', reasonName: 'Illness' });
  assert.equal(en.subject, 'Absence excuse: 17/12/2025, 07:50-13:05');
  assert.match(en.text, /my absence on Wednesday, 17\/12\/2025, from 07:50 to 13:05\./);
});

test('an empty note leaves its line out', () => {
  const { text } = composeExcuse({ absences: [wednesday], locale: 'de', reasonName: 'Krankheit', note: '   ' });
  assert.doesNotMatch(text, /Bemerkung/);
});

test('several days and several absences', () => {
  const multi = { startDate: 20251215, startTime: 750, endDate: 20251217, endTime: 1305 };
  assert.equal(composeExcuse({ absences: [multi], locale: 'de' }).subject, 'Entschuldigung: 15.12.2025, 07:50 - 17.12.2025, 13:05');
  assert.match(composeExcuse({ absences: [multi], locale: 'de' }).text, /vom Montag, 15\.12\.2025, 07:50 bis Mittwoch, 17\.12\.2025, 13:05/);

  const later = { startDate: 20251218, startTime: 1000, endDate: 20251218, endTime: 1150 };
  const both = composeExcuse({ absences: [later, wednesday], locale: 'de', reasonName: 'Krankheit' });
  assert.equal(both.subject, 'Entschuldigung: 17.12.2025, 07:50 - 18.12.2025, 11:50');
  assert.match(both.text, /folgenden Abwesenheiten:\n- am Mittwoch, 17\.12\.2025, von 07:50 bis 13:05\n- am Donnerstag, 18\.12\.2025, von 10:00 bis 11:50/);
});

test('the subject reads back as the span of the absences, in every language', () => {
  for (const locale of ['de', 'it', 'en']) {
    const { subject } = composeExcuse({ absences: [wednesday], locale });
    assert.deepEqual(parseExcuseSubject(subject), absenceSpan(wednesday), locale);
  }
  const multi = { startDate: 20251215, startTime: 750, endDate: 20251217, endTime: 1305 };
  assert.deepEqual(parseExcuseSubject(composeExcuse({ absences: [multi], locale: 'it' }).subject), { start: 202512150750, end: 202512171305 });
});

test('times given as minutes of the day read the same as HHMM', () => {
  const minutes = { startDate: 20251217, startTime: 470, endDate: 20251217, endTime: 785 };
  assert.equal(composeExcuse({ absences: [minutes], locale: 'de' }).subject, 'Entschuldigung: 17.12.2025, 07:50-13:05');
  assert.deepEqual(absenceSpan(minutes), absenceSpan(wednesday));
});

test('a whole day without times covers the day', () => {
  const day = { startDate: 20251217, startTime: 0, endDate: 20251217, endTime: 0 };
  const { subject, text } = composeExcuse({ absences: [day], locale: 'de' });
  assert.equal(subject, 'Entschuldigung: 17.12.2025');
  assert.match(text, /am Mittwoch, 17\.12\.2025 \(ganztägig\)/);
  assert.deepEqual(parseExcuseSubject(subject), { start: 202512170000, end: 202512172359 });
});

test('other subjects are not excuses', () => {
  assert.equal(parseExcuseSubject('Schularbeit 17.12.2025, 07:50-13:05'), null);
  assert.equal(parseExcuseSubject('Entschuldigung'), null);
  assert.equal(parseExcuseSubject('Entschuldigung: morgen'), null);
  assert.equal(parseExcuseSubject(undefined), null);
  assert.deepEqual(parseExcuseSubject('entschuldigung: 17.12.2025, 07:50-13:05'), { start: 202512170750, end: 202512171305 });
});

test('an unknown language falls back to German', () => {
  assert.equal(excuseLocale('lld'), 'de');
  assert.equal(excuseLocale('it'), 'it');
  assert.equal(excuseLocale(undefined), 'de');
});
