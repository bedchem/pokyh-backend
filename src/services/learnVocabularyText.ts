// Shared vocabulary-text helpers. These exact functions populate
// normalizedSource/normalizedTarget on every vocabulary entry and grade real
// quiz answers (see routes/learn.ts) — any other feature that needs to
// compare vocabulary text (e.g. an admin import's duplicate detection) must
// reuse them so its notion of "duplicate" matches the platform's own notion
// of "correct answer."

export function normalizeAnswer(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('de-DE')
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function expectedAnswers(value: string): string[] {
  // Semicolons, pipes and slashes are intentionally treated as author-provided
  // alternative translations; commas remain valid parts of a phrase.
  return value
    .split(/\s*(?:;|\||\/)\s*/)
    .map(normalizeAnswer)
    .filter(Boolean);
}

// LearnVocabularyEntry.tagsJson is a raw JSON string column; this is the
// safe read-side counterpart to `JSON.stringify(tags)` on write.
export function parseTags(tagsJson: string): string[] {
  try {
    const value = JSON.parse(tagsJson) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}
