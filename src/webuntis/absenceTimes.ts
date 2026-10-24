// The missed lessons of a student as WebUntis counts them ("Fehlzeiten",
// GET /api/classreg/absencetimes/student): one row per missed lesson with the
// minutes and lesson hours it cost, and whether it counts. Summed here per
// subject, so the website shows the school's own figures instead of working
// them out from the timetable. Pure, tested on its own
// (tests/webuntisAbsenceTimes.test.mjs).

export interface AbsenceTime {
  absenceId: number;
  /** YYYYMMDD */
  date: number;
  /** HHMM */
  startTime: number;
  endTime: number;
  subject: string;
  teacher: string;
  /** Minutes of the lesson missed. */
  minutes: number;
  /** Lesson hours missed (usually 1). */
  hours: number;
  /** 1 on the lesson that completes a missed day. */
  days: number;
  /** Whether the school counts it (Fehlzeiten that count towards the limit). */
  counting: boolean;
  excused: boolean;
  excuseStatus: string;
  reason: string;
  text: string;
}

export interface SubjectAbsence {
  subject: string;
  teacher: string;
  minutes: number;
  hours: number;
  lessons: number;
  /** Minutes that count towards the school's limit. */
  countingMinutes: number;
  /** Minutes not excused (yet). */
  unexcusedMinutes: number;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export function readAbsenceTimes(json: unknown): AbsenceTime[] | null {
  const root = (json ?? {}) as { data?: { absenceTimes?: unknown } ; absenceTimes?: unknown };
  const list = root.data?.absenceTimes ?? root.absenceTimes;
  if (!Array.isArray(list)) return null;
  return list.map((item) => {
    const r = (item ?? {}) as Record<string, unknown>;
    return {
      absenceId: num(r.absenceId),
      date: num(r.date),
      startTime: num(r.startTime),
      endTime: num(r.endTime),
      subject: text(r.subjectName),
      teacher: text(r.teacherName),
      minutes: Math.max(0, num(r.missedMins)),
      hours: Math.max(0, num(r.missedHours)),
      days: Math.max(0, num(r.missedDays)),
      counting: r.counting !== false,
      excused: r.excused === true,
      excuseStatus: text(r.excuseStatusName),
      reason: text(r.absenceReasonName),
      text: text(r.text),
    };
  }).sort((a, b) => a.date - b.date || a.startTime - b.startTime);
}

/** Per subject, the most missed first. */
export function absenceBySubject(times: AbsenceTime[]): SubjectAbsence[] {
  const bySubject = new Map<string, SubjectAbsence>();
  for (const t of times) {
    const key = t.subject || '—';
    const entry = bySubject.get(key) ?? {
      subject: key, teacher: t.teacher, minutes: 0, hours: 0, lessons: 0, countingMinutes: 0, unexcusedMinutes: 0,
    };
    entry.minutes += t.minutes;
    entry.hours += t.hours;
    entry.lessons += 1;
    if (t.counting) entry.countingMinutes += t.minutes;
    if (!t.excused) entry.unexcusedMinutes += t.minutes;
    if (!entry.teacher && t.teacher) entry.teacher = t.teacher;
    bySubject.set(key, entry);
  }
  return [...bySubject.values()].sort((a, b) => b.minutes - a.minutes || a.subject.localeCompare(b.subject));
}

export function absenceTotals(times: AbsenceTime[]) {
  let minutes = 0, hours = 0, days = 0, countingMinutes = 0, unexcusedMinutes = 0;
  for (const t of times) {
    minutes += t.minutes;
    hours += t.hours;
    days += t.days;
    if (t.counting) countingMinutes += t.minutes;
    if (!t.excused) unexcusedMinutes += t.minutes;
  }
  return { minutes, hours, days, countingMinutes, unexcusedMinutes, lessons: times.length };
}
