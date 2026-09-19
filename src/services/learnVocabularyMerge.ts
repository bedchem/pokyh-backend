import { expectedAnswers, normalizeAnswer } from './learnVocabularyText';
import { levenshteinDistance } from './learnDictionary';

// A single-word English/Italian import batch is expected to touch this
// ambiguous branch rarely (most rows are either exact duplicates or clearly
// new words) — this bounds worst-case outbound calls to the optional
// dictionary provider for one import request, independent of how many
// entries the whole file contains.
const MAX_DICTIONARY_LOOKUPS_PER_MERGE = 50;

export interface VocabularyMergePoolEntry {
  sourceText: string;
  targetText: string;
  normalizedSource: string;
  normalizedTarget: string;
}

export interface VocabularyMergeIncomingEntry {
  sourceLanguage: string;
  targetLanguage: string;
  sourceText: string;
  targetText: string;
  article: string;
  partOfSpeech: string;
  notes: string;
  tags: string[];
}

export type VocabularyMergeOutcome =
  | 'added'
  | 'synonym_added'
  | 'duplicate_exact'
  | 'duplicate_near_translation'
  | 'duplicate_near_source'
  | 'skipped_missing_translation';

export interface VocabularyMergeResultRow {
  sourceText: string;
  targetText: string;
  outcome: VocabularyMergeOutcome;
  matchedExisting: { sourceText: string; targetText: string } | null;
  possibleTypoOf: string | null;
  dictionaryAdvisory: { translation: string; matchesIncoming: boolean } | null;
}

export interface VocabularyMergeRow {
  sourceLanguage: string;
  targetLanguage: string;
  sourceText: string;
  targetText: string;
  normalizedSource: string;
  normalizedTarget: string;
  article: string;
  partOfSpeech: string;
  notes: string;
  tagsJson: string;
  verificationStatus: 'UNVERIFIED';
  verificationSource: string;
  createdBy: string;
}

export interface VocabularyMergeSummary {
  totalIncoming: number;
  added: number;
  synonymAdded: number;
  duplicateExact: number;
  duplicateNearTranslation: number;
  duplicateNearSource: number;
  skippedMissingTranslation: number;
}

export interface VocabularyMergeResult {
  toCreate: VocabularyMergeRow[];
  results: VocabularyMergeResultRow[];
  summary: VocabularyMergeSummary;
}

type DictionaryLookup = (entry: {
  sourceText: string;
  sourceLanguage: string;
  targetLanguage: string;
}) => Promise<{ translation: string } | null>;

// Exact match short-circuits; otherwise the same guards as the existing
// authoring-time findNearDuplicate() in learnDictionary.ts — minimum word
// length 3, length difference at most 1, Levenshtein distance exactly 1.
// Reusing these constants keeps "near duplicate" meaning the same thing
// everywhere in this codebase.
function matchLevel(a: string, b: string): 'exact' | 'near' | 'none' {
  if (!a || !b) return 'none';
  if (a === b) return 'exact';
  if (a.length < 3 || b.length < 3) return 'none';
  if (Math.abs(a.length - b.length) > 1) return 'none';
  return levenshteinDistance(a, b) === 1 ? 'near' : 'none';
}

// Splits an existing entry's stored target text into its individual accepted
// alternatives (the same ";"/"|"/"/" convention already used to grade real
// quiz answers), so a multi-answer existing entry like "groß; riesig" is
// compared alternative-by-alternative instead of as one unsplit string.
function targetAlternatives(targetText: string): string[] {
  return expectedAnswers(targetText);
}

export async function mergeVocabularyEntries(params: {
  existing: VocabularyMergePoolEntry[];
  incoming: VocabularyMergeIncomingEntry[];
  createdBy: string;
  dictionaryLookup?: DictionaryLookup;
}): Promise<VocabularyMergeResult> {
  // The pool starts as the course's already-saved vocabulary and grows with
  // every word this run decides to add, so two colliding/synonymous words
  // inside the same import file correctly dedupe against each other too,
  // not only against what was already in the database.
  const pool: VocabularyMergePoolEntry[] = [...params.existing];
  const toCreate: VocabularyMergeRow[] = [];
  const results: VocabularyMergeResultRow[] = [];
  const summary: VocabularyMergeSummary = {
    totalIncoming: params.incoming.length,
    added: 0,
    synonymAdded: 0,
    duplicateExact: 0,
    duplicateNearTranslation: 0,
    duplicateNearSource: 0,
    skippedMissingTranslation: 0,
  };
  let dictionaryLookupsUsed = 0;

  async function dictionaryAdvisoryFor(
    incoming: VocabularyMergeIncomingEntry,
    normalizedTarget: string,
  ): Promise<VocabularyMergeResultRow['dictionaryAdvisory']> {
    if (!params.dictionaryLookup || dictionaryLookupsUsed >= MAX_DICTIONARY_LOOKUPS_PER_MERGE) return null;
    dictionaryLookupsUsed += 1;
    try {
      const suggestion = await params.dictionaryLookup({
        sourceText: incoming.sourceText,
        sourceLanguage: incoming.sourceLanguage,
        targetLanguage: incoming.targetLanguage,
      });
      if (!suggestion?.translation) return null;
      return {
        translation: suggestion.translation,
        matchesIncoming: normalizeAnswer(suggestion.translation) === normalizedTarget,
      };
    } catch {
      // Advisory only — provider disabled/unreachable/rate-limited must never
      // block or fail the import.
      return null;
    }
  }

  function accept(
    incoming: VocabularyMergeIncomingEntry,
    outcome: 'added' | 'synonym_added',
    matchedExisting: VocabularyMergePoolEntry | null,
    possibleTypoOf: string | null,
    dictionaryAdvisory: VocabularyMergeResultRow['dictionaryAdvisory'],
    normalizedSource: string,
    normalizedTarget: string,
  ) {
    const row: VocabularyMergeRow = {
      sourceLanguage: incoming.sourceLanguage,
      targetLanguage: incoming.targetLanguage,
      sourceText: incoming.sourceText,
      targetText: incoming.targetText,
      normalizedSource,
      normalizedTarget,
      article: incoming.article,
      partOfSpeech: incoming.partOfSpeech,
      notes: incoming.notes,
      tagsJson: JSON.stringify(incoming.tags),
      verificationStatus: 'UNVERIFIED',
      verificationSource: 'admin-list-import',
      createdBy: params.createdBy,
    };
    toCreate.push(row);
    pool.push({ sourceText: incoming.sourceText, targetText: incoming.targetText, normalizedSource, normalizedTarget });
    results.push({
      sourceText: incoming.sourceText,
      targetText: incoming.targetText,
      outcome,
      matchedExisting: matchedExisting ? { sourceText: matchedExisting.sourceText, targetText: matchedExisting.targetText } : null,
      possibleTypoOf,
      dictionaryAdvisory,
    });
    if (outcome === 'added') summary.added += 1;
    else summary.synonymAdded += 1;
  }

  function reject(
    incoming: VocabularyMergeIncomingEntry,
    outcome: 'duplicate_exact' | 'duplicate_near_translation' | 'duplicate_near_source',
    matchedExisting: VocabularyMergePoolEntry,
  ) {
    results.push({
      sourceText: incoming.sourceText,
      targetText: incoming.targetText,
      outcome,
      matchedExisting: { sourceText: matchedExisting.sourceText, targetText: matchedExisting.targetText },
      possibleTypoOf: null,
      dictionaryAdvisory: null,
    });
    if (outcome === 'duplicate_exact') summary.duplicateExact += 1;
    else if (outcome === 'duplicate_near_translation') summary.duplicateNearTranslation += 1;
    else summary.duplicateNearSource += 1;
  }

  for (const incoming of params.incoming) {
    // A row that never got a translation (e.g. a learner-flagged word from
    // the source course) must never be persisted with a blank targetText —
    // real quiz grading needs an actual accepted answer. Skip it here rather
    // than at the schema boundary, so the rest of a real-world export still
    // imports instead of the whole file failing on a handful of such rows.
    if (incoming.targetText.trim() === '') {
      results.push({
        sourceText: incoming.sourceText,
        targetText: incoming.targetText,
        outcome: 'skipped_missing_translation',
        matchedExisting: null,
        possibleTypoOf: null,
        dictionaryAdvisory: null,
      });
      summary.skippedMissingTranslation += 1;
      continue;
    }

    const normalizedSource = normalizeAnswer(incoming.sourceText);
    const normalizedTarget = normalizeAnswer(incoming.targetText);

    // 1. The exact German headword is already known. Whether this is a true
    // duplicate, a typo of an already-known translation, or a genuinely new
    // synonym depends only on the target side from here on.
    const exactSourceMatches = pool.filter((entry) => entry.normalizedSource === normalizedSource);
    if (exactSourceMatches.length > 0) {
      let exactMatch: VocabularyMergePoolEntry | null = null;
      let nearMatch: VocabularyMergePoolEntry | null = null;
      for (const candidate of exactSourceMatches) {
        for (const alternative of targetAlternatives(candidate.targetText)) {
          const level = matchLevel(normalizedTarget, alternative);
          if (level === 'exact') { exactMatch = candidate; break; }
          if (level === 'near' && !nearMatch) nearMatch = candidate;
        }
        if (exactMatch) break;
      }
      if (exactMatch) {
        reject(incoming, 'duplicate_exact', exactMatch);
        continue;
      }
      if (nearMatch) {
        reject(incoming, 'duplicate_near_translation', nearMatch);
        continue;
      }
      // Same German word, a genuinely different translation: a synonym worth
      // keeping — the existing entry/entries are never touched.
      const advisory = await dictionaryAdvisoryFor(incoming, normalizedTarget);
      accept(incoming, 'synonym_added', exactSourceMatches[0]!, null, advisory, normalizedSource, normalizedTarget);
      continue;
    }

    // 2. No exact source match. A near-duplicate source is only treated as
    // "the same row, just misspelled" when the target corroborates it too —
    // Levenshtein-distance-1 German word pairs are very often genuinely
    // different words (e.g. "Recht"/"Reich"), so spelling similarity alone
    // must never cause a silent skip.
    let possibleTypoOf: string | null = null;
    let corroboratedTypo: VocabularyMergePoolEntry | null = null;
    for (const candidate of pool) {
      if (matchLevel(normalizedSource, candidate.normalizedSource) !== 'near') continue;
      if (!possibleTypoOf) possibleTypoOf = candidate.sourceText;
      const corroborated = targetAlternatives(candidate.targetText)
        .some((alternative) => matchLevel(normalizedTarget, alternative) !== 'none');
      if (corroborated) { corroboratedTypo = candidate; break; }
    }
    if (corroboratedTypo) {
      reject(incoming, 'duplicate_near_source', corroboratedTypo);
      continue;
    }

    // 3. A genuinely new word (possibly flagged with a spelling hint for the
    // admin to eyeball, never auto-rejected on spelling similarity alone).
    accept(incoming, 'added', null, possibleTypoOf, null, normalizedSource, normalizedTarget);
  }

  return { toCreate, results, summary };
}
