import { AppError, ValidationError } from '../utils/errors';
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

  let base: URL;
  try {
    base = new URL(dictCfg.dictionaryBaseUrl);
  } catch {
    throw new AppError('Dictionary provider is not configured correctly', 503);
  }
  if (base.protocol !== 'https:') {
    throw new AppError('Dictionary provider must use HTTPS', 503);
  }

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
