import { AppError, ValidationError } from '../utils/errors';
import { config } from '../config';
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

function manualValidation(language: string, message: string): DictionaryWordValidation {
  return {
    provider: 'local',
    language,
    status: 'manual',
    definition: null,
    example: null,
    partOfSpeech: null,
    cached: false,
    stale: false,
    message,
  };
}

/**
 * Checks an English headword against the documented free Dictionary API. The
 * provider only documents `entries/en/<word>`, so German and Italian entries
 * receive an honest manual-review outcome rather than a guessed validation.
 * A network failure never blocks authoring: it returns an unavailable result
 * and lets the caller retain the word for later editorial review.
 */
export async function validateVocabularyWord({
  sourceText,
  sourceLanguage,
}: {
  sourceText: string;
  sourceLanguage: string;
}): Promise<DictionaryWordValidation> {
  const dictCfg = await getLearnConfig();
  const language = normalizedLanguage(sourceLanguage);
  const word = safeTranslation(sourceText);
  if (!word || word.length > 120 || !/^[\p{L}\s'-]+$/u.test(word)) {
    throw new ValidationError('Enter one plain word or phrase before requesting validation');
  }
  if (language !== 'en') {
    return manualValidation(language, 'This provider documents English headwords only; keep this entry for editorial review');
  }
  if (!dictCfg.dictionaryValidationEnabled) {
    return {
      ...manualValidation(language, 'English dictionary validation is currently disabled by the platform'),
      status: 'unavailable',
    };
  }
  if (dictCfg.dictionaryValidationProvider.toLocaleLowerCase('en-US') !== 'dictionaryapi') {
    return {
      ...manualValidation(language, 'The configured English validation provider is unavailable'),
      status: 'unavailable',
    };
  }

  let base: URL;
  try {
    base = safeProviderUrl(dictCfg.dictionaryValidationBaseUrl);
  } catch {
    return {
      ...manualValidation(language, 'English dictionary validation is not configured safely'),
      status: 'unavailable',
    };
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
    };
    storeValidation(key, value, dictCfg);
    return { ...value, cached: false, stale: false };
  } catch {
    // A stale prior success is more helpful than a hard failure, but it is
    // visibly marked stale and never treated as an automated grading result.
    if (cached) return { ...cached.value, stale: true, message: 'Showing the last cached result while the dictionary is unavailable' };
    return {
      ...manualValidation(language, 'The dictionary is temporarily unavailable; the word can still be saved for editorial review'),
      status: 'unavailable',
    };
  }
}
