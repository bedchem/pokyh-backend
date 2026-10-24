import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './helpers/loadTs.mjs';

const { readAbsenceTimes, absenceBySubject, absenceTotals } = await loadTs('src/webuntis/absenceTimes.ts');

const row = (over) => ({
  absenceId: 1, absenceReasonId: 31, absenceReasonName: 'Krank', counting: true, date: 20260921, startTime: 1315, endTime: 1405,
  excuseStatusId: 1, excuseStatusName: 'entschuldigt', excused: true, klasseId: 1, klasseName: '4A',
  missedDays: 0, missedHours: 1, missedMins: 50, subjectId: 1, subjectName: 'IKE', teacherId: 1, teacherName: 'Ra-We', text: '',
  ...over,
});

test('the rows of WebUntis\' answer, in lesson order', () => {
  const times = readAbsenceTimes({ data: { absenceTimes: [row({ date: 20260922, subjectName: 'D' }), row({})] } });
  assert.equal(times.length, 2);
  assert.equal(times[0].subject, 'IKE');
  assert.equal(times[0].minutes, 50);
  assert.equal(times[0].excused, true);
  assert.equal(times[1].date, 20260922);
  assert.equal(readAbsenceTimes({ data: {} }), null);
  assert.equal(readAbsenceTimes(null), null);
});

test('summed per subject, the most missed first', () => {
  const times = readAbsenceTimes({ data: { absenceTimes: [
    row({}),
    row({ startTime: 1405, endTime: 1455 }),
    row({ subjectName: 'D', teacherName: 'Gi-Wo', excused: false }),
    row({ subjectName: 'D', teacherName: 'Gi-Wo', counting: false, missedMins: 50, missedDays: 1 }),
    row({ subjectName: 'M', missedMins: 45 }),
  ] } });
  const bySubject = absenceBySubject(times);
  assert.deepEqual(bySubject.map((s) => s.subject), ['D', 'IKE', 'M']);
  const d = bySubject[0];
  assert.equal(d.minutes, 100);
  assert.equal(d.lessons, 2);
  assert.equal(d.countingMinutes, 50);
  assert.equal(d.unexcusedMinutes, 50);
  assert.equal(d.teacher, 'Gi-Wo');

  const totals = absenceTotals(times);
  assert.equal(totals.minutes, 245);
  assert.equal(totals.hours, 5);
  assert.equal(totals.days, 1);
  assert.equal(totals.lessons, 5);
});
