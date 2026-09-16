import { AppError, ValidationError } from '../utils/errors';
import { config } from '../config';
import { prisma } from '../db';
import { getLearnConfig, type LearnConfigValues } from './learnConfig';

export type DictionarySuggestion = {
  provider: string;
  sourceLanguage: string;
  targetLanguage: string;
  translation: string;
  quality: number | null;
  cached: boolean;
};

type CachedSuggestion = Omit<DictionarySuggestion, 'cached'> & { expiresAt: number };

const cache = new Map<string, CachedSuggestion>();

// reasonCode is machine-readable so the frontend can render it in the
// viewer's own locale; message is the English fallback/audit-log string.
// similarWord is only set for reasonCode 'near_duplicate'.
export type DictionaryValidationReasonCode =
  | 'no_vowel'
  | 'triple_repeat'
  | 'consonant_run'
  | 'near_duplicate'
  | 'no_issue_found';

export type DictionaryWordValidation = {
  provider: 'dictionaryapi' | 'local';
  language: string;
  status: 'verified' | 'not_found' | 'manual' | 'unavailable';
  definition: string | null;
  example: string | null;
  partOfSpeech: string | null;
  cached: boolean;
  stale: boolean;
  message: string | null;
  reasonCode: DictionaryValidationReasonCode | null;
  similarWord: string | null;
};

type CachedValidation = Omit<DictionaryWordValidation, 'cached' | 'stale'> & {
  expiresAt: number;
  staleUntil: number;
};

const validationCache = new Map<string, CachedValidation>();

function normalizedLanguage(value: string): string {
  const lower = value.trim().toLocaleLowerCase('en-US');
  const aliases: Record<string, string> = {
    italian: 'it',
    italienisch: 'it',
    english: 'en',
    englisch: 'en',
    german: 'de',
    deutsch: 'de',
  };
  return aliases[lower] ?? lower.split(/[-_]/, 1)[0] ?? '';
}

function safeTranslation(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}

function cachedValue(key: string): DictionarySuggestion | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return { ...entry, cached: true };
}

function storeValue(key: string, value: Omit<DictionarySuggestion, 'cached'>, dictCfg: LearnConfigValues) {
  const maxEntries = Math.max(1, dictCfg.dictionaryMaxCacheEntries);
  while (cache.size >= maxEntries) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
  cache.set(key, { ...value, expiresAt: Date.now() + Math.max(1_000, dictCfg.dictionaryCacheTtlMs) });
}

function safeProviderUrl(value: string): URL {
  let base: URL;
  try {
    base = new URL(value);
  } catch {
    throw new AppError('Dictionary provider is not configured correctly', 503);
  }
  const hostname = base.hostname.toLocaleLowerCase('en-US');
  if (base.protocol !== 'https:' || !config.learnDictionaryAllowedHosts.includes(hostname) || base.username || base.password || base.hash) {
    throw new AppError('Dictionary provider is not configured correctly', 503);
  }
  return base;
}

function validationCacheValue(key: string): { value: DictionaryWordValidation; fresh: boolean } | null {
  const entry = validationCache.get(key);
  if (!entry) return null;
  const now = Date.now();
  if (entry.staleUntil <= now) {
    validationCache.delete(key);
    return null;
  }
  const fresh = entry.expiresAt > now;
  return {
    fresh,
    value: { ...entry, cached: true, stale: !fresh },
  };
}

function storeValidation(key: string, value: Omit<DictionaryWordValidation, 'cached' | 'stale'>, dictCfg: LearnConfigValues) {
  const maxEntries = Math.max(1, dictCfg.dictionaryValidationMaxCacheEntries);
  while (validationCache.size >= maxEntries) {
    const oldestKey = validationCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    validationCache.delete(oldestKey);
  }
  const ttl = Math.max(1_000, dictCfg.dictionaryValidationCacheTtlMs);
  validationCache.set(key, {
    ...value,
    expiresAt: Date.now() + ttl,
    // A previous verified result is safe to show as stale context for one
    // additional bounded period when the free service is briefly offline.
    staleUntil: Date.now() + Math.max(ttl * 2, 60 * 60 * 1000),
  });
}

/**
 * Fetches one configured translation-memory suggestion. It intentionally does
 * not persist or grade anything: only a human author can save an answer that
 * will later be used by the quiz engine.
 */
export async function getDictionarySuggestion({
  sourceText,
  sourceLanguage,
  targetLanguage,
}: {
  sourceText: string;
  sourceLanguage: string;
  targetLanguage: string;
}): Promise<DictionarySuggestion> {
  const dictCfg = await getLearnConfig();
  if (!dictCfg.dictionaryEnabled) {
    throw new ValidationError('Dictionary lookup is disabled by the platform configuration');
  }
  if (dictCfg.dictionaryProvider !== 'mymemory') {
    throw new AppError('The configured dictionary provider is unavailable', 503);
  }

  const source = normalizedLanguage(sourceLanguage);
  const target = normalizedLanguage(targetLanguage);
  const pair = `${source}:${target}`;
  if (!dictCfg.dictionaryAllowedPairs.includes(pair)) {
    throw new ValidationError('This language pair is not enabled for dictionary lookup');
  }

  const base = safeProviderUrl(dictCfg.dictionaryBaseUrl);

  const cleanSource = sourceText.trim().replace(/\s+/g, ' ');
  const key = `${source}:${target}:${cleanSource.toLocaleLowerCase('en-US')}`;
  const existing = cachedValue(key);
  if (existing) return existing;

  const url = new URL('get', `${base.toString().replace(/\/$/, '')}/`);
  url.searchParams.set('q', cleanSource);
  url.searchParams.set('langpair', `${source}|${target}`);
  // Keep the provider's optional machine-translation fallback off. A learning
  // platform must show a suggestion from the translation memory, not silently
  // turn an external model output into an answer key.
  url.searchParams.set('mt', '0');
  if (dictCfg.dictionaryContactEmail) url.searchParams.set('de', dictCfg.dictionaryContactEmail);

  let payload: {
    responseData?: { translatedText?: unknown; match?: unknown };
    responseStatus?: unknown;
  };
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(Math.max(500, dictCfg.dictionaryTimeoutMs)),
    });
    if (!response.ok) throw new Error(`Provider returned ${response.status}`);
    payload = await response.json() as typeof payload;
  } catch {
    throw new AppError('Dictionary provider could not be reached', 503);
  }

  const translation = safeTranslation(payload.responseData?.translatedText);
  if (!translation) throw new ValidationError('No dictionary suggestion was found for this word');
  const rawQuality = payload.responseData?.match;
  const quality = typeof rawQuality === 'number' && Number.isFinite(rawQuality)
    ? Math.max(0, Math.min(1, rawQuality))
    : null;
  const suggestion: Omit<DictionarySuggestion, 'cached'> = {
    provider: dictCfg.dictionaryProvider,
    sourceLanguage: source,
    targetLanguage: target,
    translation,
    quality,
  };
  storeValue(key, suggestion, dictCfg);
  return { ...suggestion, cached: false };
}

// ─── Self-contained local spelling check ────────────────────────────────────
// Deliberately does not bundle a third-party word list: the well-known npm
// Hunspell dictionaries for German/Italian ship under GPL, which is not a
// license this platform's own code can casually absorb without the same
// license/provenance review this repo's CLAUDE.md already requires before
// adding any bundled lexical source. This runs entirely on structural,
// language-agnostic heuristics plus a same-course near-duplicate check
// against this platform's own already-curated vocabulary — no network call,
// no bundled dictionary data, so it always works, including for German and
// Italian (which the external API below never covered at all) and as a
// fallback when that external API is disabled or unreachable.

const VOWELS_BY_LANGUAGE: Record<string, string> = {
  de: 'aeiouäöü',
  it: 'aeiouàèéìòù',
  en: 'aeiou',
};

// Longest plausible run of consonants in ordinary vocabulary. German
// compounds legitimately run long at morpheme boundaries — "Herbstpflicht"
// alone has a 7-consonant run — so its threshold is deliberately generous;
// Italian is comparatively vowel-heavy, English sits in between.
const MAX_CONSONANT_RUN: Record<string, number> = { de: 8, it: 4, en: 5 };

function localNormalize(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isPlausibleSpelling(word: string, language: string): { plausible: boolean; reasonCode: DictionaryValidationReasonCode | null; message: string | null } {
  const letters = word.toLocaleLowerCase('en-US').replace(/[^\p{L}]/gu, '');
  if (!letters) return { plausible: true, reasonCode: null, message: null };

  const vowels = VOWELS_BY_LANGUAGE[language] ?? VOWELS_BY_LANGUAGE['en']!;
  if (letters.length >= 3 && ![...letters].some((char) => vowels.includes(char))) {
    return { plausible: false, reasonCode: 'no_vowel', message: 'No vowel found in this word — check for a typo' };
  }

  if (/(\p{L})\1\1/u.test(letters)) {
    return { plausible: false, reasonCode: 'triple_repeat', message: 'A letter repeats three or more times in a row — check for a typo' };
  }

  const maxRun = MAX_CONSONANT_RUN[language] ?? MAX_CONSONANT_RUN['en']!;
  let run = 0;
  for (const char of letters) {
    if (vowels.includes(char)) {
      run = 0;
      continue;
    }
    run += 1;
    if (run > maxRun) {
      return { plausible: false, reasonCode: 'consonant_run', message: 'An unusually long run of consonants was found — check for a typo' };
    }
  }

  return { plausible: true, reasonCode: null, message: null };
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previousRow = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i += 1) {
    const currentRow = [i + 1];
    for (let j = 0; j < b.length; j += 1) {
      const cost = a[i] === b[j] ? 0 : 1;
      currentRow.push(Math.min(
        currentRow[j]! + 1,
        previousRow[j + 1]! + 1,
        previousRow[j]! + cost,
      ));
    }
    previousRow = currentRow;
  }
  return previousRow[b.length]!;
}

// A near-miss (edit distance 1) against this course's own already-saved
// vocabulary is a stronger, more relevant typo signal for a curated
// vocabulary platform than a generic dictionary lookup would be — it only
// ever compares against this platform's own data, never a third-party word
// list, and is scoped to one course so it can never leak another team's
// vocabulary (see resolveCourseAccess's team-scoping in routes/learn.ts).
async function findNearDuplicate(courseId: string, sourceLanguage: string, normalizedWord: string): Promise<string | null> {
  if (normalizedWord.length < 3) return null;
  const existing = await prisma.learnVocabularyEntry.findMany({
    where: { courseId, sourceLanguage, normalizedSource: { not: '' } },
    select: { normalizedSource: true },
    take: 500,
  });
  for (const entry of existing) {
    if (entry.normalizedSource === normalizedWord) continue;
    if (Math.abs(entry.normalizedSource.length - normalizedWord.length) > 1) continue;
    if (levenshteinDistance(normalizedWord, entry.normalizedSource) === 1) return entry.normalizedSource;
  }
  return null;
}

async function localSpellingCheck(word: string, language: string, courseId?: string): Promise<DictionaryWordValidation> {
  const structural = isPlausibleSpelling(word, language);
  if (!structural.plausible) {
    return {
      provider: 'local', language, status: 'not_found',
      definition: null, example: null, partOfSpeech: null,
      cached: false, stale: false,
      message: structural.message, reasonCode: structural.reasonCode, similarWord: null,
    };
  }
  if (courseId) {
    const similar = await findNearDuplicate(courseId, language, localNormalize(word));
    if (similar) {
      return {
        provider: 'local', language, status: 'not_found',
        definition: null, example: null, partOfSpeech: null,
        cached: false, stale: false,
        message: `This looks similar to the already-saved word "${similar}" in this course — check for a typo`,
        reasonCode: 'near_duplicate', similarWord: similar,
      };
    }
  }
  return {
    provider: 'local', language, status: 'manual',
    definition: null, example: null, partOfSpeech: null,
    cached: false, stale: false,
    message: 'No obvious spelling issue found by the local check — this is not a full dictionary verification',
    reasonCode: 'no_issue_found', similarWord: null,
  };
}

/**
 * Checks an English headword against the documented free Dictionary API when
 * it's enabled and reachable — the richer, authoritative path. German and
 * Italian never had any check at all before; both now always go through the
 * self-contained localSpellingCheck above, and English falls back to it too
 * whenever the external API is disabled, misconfigured, or unreachable, so
 * authoring is never left with only a bare "unavailable" response.
 */
export async function validateVocabularyWord({
  sourceText,
  sourceLanguage,
  courseId,
}: {
  sourceText: string;
  sourceLanguage: string;
  courseId?: string;
}): Promise<DictionaryWordValidation> {
  const dictCfg = await getLearnConfig();
  const language = normalizedLanguage(sourceLanguage);
  const word = safeTranslation(sourceText);
  if (!word || word.length > 120 || !/^[\p{L}\s'-]+$/u.test(word)) {
    throw new ValidationError('Enter one plain word or phrase before requesting validation');
  }
  if (language !== 'en') {
    return localSpellingCheck(word, language, courseId);
  }
  if (!dictCfg.dictionaryValidationEnabled) {
    return localSpellingCheck(word, language, courseId);
  }
  if (dictCfg.dictionaryValidationProvider.toLocaleLowerCase('en-US') !== 'dictionaryapi') {
    return localSpellingCheck(word, language, courseId);
  }

  let base: URL;
  try {
    base = safeProviderUrl(dictCfg.dictionaryValidationBaseUrl);
  } catch {
    return localSpellingCheck(word, language, courseId);
  }
  const key = `${base.origin}${base.pathname}:en:${word.toLocaleLowerCase('en-US')}`;
  const cached = validationCacheValue(key);
  if (cached?.fresh) return cached.value;

  try {
    const url = new URL(`entries/en/${encodeURIComponent(word)}`, `${base.toString().replace(/\/$/, '')}/`);
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(Math.max(500, Math.min(dictCfg.dictionaryValidationTimeoutMs, 10_000))),
    });
    if (response.status === 404) {
      return {
        provider: 'dictionaryapi',
        language,
        status: 'not_found',
        definition: null,
        example: null,
        partOfSpeech: null,
        cached: false,
        stale: false,
        message: 'No English dictionary entry was found; check spelling or keep it for editorial review',
        reasonCode: null,
        similarWord: null,
      };
    }
    if (!response.ok) throw new Error('Dictionary response failed');
    const payload = await response.json() as unknown;
    if (!Array.isArray(payload) || !payload[0] || typeof payload[0] !== 'object') throw new Error('Malformed dictionary response');
    const entry = payload[0] as { meanings?: unknown };
    const meanings = Array.isArray(entry.meanings) ? entry.meanings : [];
    let definition = '';
    let example = '';
    let partOfSpeech = '';
    for (const rawMeaning of meanings) {
      if (!rawMeaning || typeof rawMeaning !== 'object') continue;
      const meaning = rawMeaning as { partOfSpeech?: unknown; definitions?: unknown };
      const definitions = Array.isArray(meaning.definitions) ? meaning.definitions : [];
      const candidate = definitions.find((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object');
      if (!candidate) continue;
      definition = safeTranslation(candidate.definition);
      example = safeTranslation(candidate.example);
      partOfSpeech = safeTranslation(meaning.partOfSpeech).slice(0, 80);
      if (definition) break;
    }
    if (!definition) throw new Error('Dictionary response has no definition');
    const value: Omit<DictionaryWordValidation, 'cached' | 'stale'> = {
      provider: 'dictionaryapi',
      language,
      status: 'verified',
      definition,
      example: example || null,
      partOfSpeech: partOfSpeech || null,
      message: 'Verified against the configured English dictionary',
      reasonCode: null,
      similarWord: null,
    };
    storeValidation(key, value, dictCfg);
    return { ...value, cached: false, stale: false };
  } catch {
    // A stale prior success is more helpful than a hard failure, but it is
    // visibly marked stale and never treated as an automated grading result.
    if (cached) return { ...cached.value, stale: true, message: 'Showing the last cached result while the dictionary is unavailable' };
    // The external API is down — fall back to the local, dependency-free
    // check rather than leaving authoring with only an "unavailable" result.
    const fallback = await localSpellingCheck(word, language, courseId);
    return { ...fallback, stale: true, message: `${fallback.message} (the online dictionary was unreachable)` };
  }
}
