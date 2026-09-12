// Pure server-side learning policy helpers. These functions deliberately work
// only from durable review counters and timestamps; they never inspect answer
// text, a learner's identity outside the current request, or another user's
// activity. Keeping the logic here makes the schedule auditable and testable.

export type LearnReviewPolicy = {
  initialIntervalDays: number;
  maxIntervalDays: number;
  minimumEase: number;
  maximumEase: number;
  correctEaseStep: number;
  incorrectEasePenalty: number;
  wrongDelayMinutes: number;
};

export type ExistingReviewState = {
  intervalDays: number;
  easeFactor: number;
  correctCount: number;
  incorrectCount: number;
  lastWasCorrect?: boolean;
} | null;

export type NextReviewState = {
  intervalDays: number;
  easeFactor: number;
  dueAt: Date;
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function safePolicy(policy: LearnReviewPolicy) {
  const minimumEase = clamp(policy.minimumEase, 1, 5);
  const maximumEase = Math.max(minimumEase, clamp(policy.maximumEase, 1, 5));
  const initialIntervalDays = clamp(Math.round(policy.initialIntervalDays), 1, 30);
  const maxIntervalDays = Math.max(initialIntervalDays, clamp(Math.round(policy.maxIntervalDays), 1, 3650));
  return {
    initialIntervalDays,
    maxIntervalDays,
    minimumEase,
    maximumEase,
    correctEaseStep: clamp(policy.correctEaseStep, 0, 1),
    incorrectEasePenalty: clamp(policy.incorrectEasePenalty, 0, 1),
    wrongDelayMinutes: clamp(Math.round(policy.wrongDelayMinutes), 0, 1440),
  };
}

/**
 * Calculate the next review from the learner's own previous outcomes.
 *
 * This is adaptive scheduling, not a global AI model: a frequently missed
 * word recovers more cautiously, while repeated success expands its interval.
 * All bounds come from configured policy and the result is persisted with the
 * graded attempt in one database transaction.
 */
export function nextAdaptiveReview(
  previous: ExistingReviewState,
  correct: boolean,
  policyInput: LearnReviewPolicy,
  now = new Date(),
): NextReviewState {
  const policy = safePolicy(policyInput);
  const priorInterval = Math.max(0, previous?.intervalDays ?? 0);
  const priorEase = clamp(previous?.easeFactor ?? 2.5, policy.minimumEase, policy.maximumEase);
  const priorCorrect = Math.max(0, previous?.correctCount ?? 0);
  const priorIncorrect = Math.max(0, previous?.incorrectCount ?? 0);

  if (!correct) {
    const dueAt = new Date(now.getTime() + policy.wrongDelayMinutes * 60 * 1000);
    return {
      intervalDays: 0,
      easeFactor: clamp(priorEase - policy.incorrectEasePenalty, policy.minimumEase, policy.maximumEase),
      dueAt,
    };
  }

  // A word with a history of misses gets a shorter recovery interval than one
  // with the same raw interval but a reliable success history. This is bounded
  // and explainable; it can never make a word disappear from the queue.
  const totalPriorAnswers = priorCorrect + priorIncorrect;
  const lapseRatio = totalPriorAnswers > 0 ? priorIncorrect / totalPriorAnswers : 0;
  const recoveryMultiplier = clamp(1 - lapseRatio * 0.35, 0.65, 1);
  const unconstrainedInterval = priorInterval === 0
    ? policy.initialIntervalDays
    : Math.round(priorInterval * priorEase * recoveryMultiplier);
  const intervalDays = clamp(unconstrainedInterval, policy.initialIntervalDays, policy.maxIntervalDays);
  const easeFactor = clamp(priorEase + policy.correctEaseStep, policy.minimumEase, policy.maximumEase);

  return {
    intervalDays,
    easeFactor,
    dueAt: new Date(now.getTime() + intervalDays * 24 * 60 * 60 * 1000),
  };
}

function partsForDate(date: Date, timezone: string): Record<string, string> | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  } catch {
    return null;
  }
}

/** Returns an ISO-like calendar date for the supplied IANA timezone. */
export function learningDayKey(date: Date, timezone: string): string {
  const parts = partsForDate(date, timezone) ?? partsForDate(date, 'UTC');
  if (!parts?.year || !parts.month || !parts.day) return date.toISOString().slice(0, 10);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** A complete, ordered local-day axis for a bounded analytics view. */
export function learningDayKeys(days: number, timezone: string, now = new Date()): string[] {
  const count = clamp(Math.round(days), 1, 366);
  const keys = new Set<string>();
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    keys.add(learningDayKey(new Date(now.getTime() - offset * 24 * 60 * 60 * 1000), timezone));
  }
  return [...keys].sort();
}

export function asPercent(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}
