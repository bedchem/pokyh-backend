import { prisma } from '../db';
import { config, isSecurePublicUrl } from '../config';

// Admin-editable Learn configuration, backed by the LearnConfig singleton row
// (id 1) with a short in-memory cache. Every field falls back to the LEARN_*
// environment default in src/config.ts when the row — or a field on it — is
// null, so behaviour is unchanged until an admin explicitly saves a value.
// LEARN_ALLOWED_ORIGINS is deliberately not part of this: it is a security-
// boundary value and stays environment-only.
export interface LearnConfigValues {
  legalGateEnabled: boolean;
  legalGateReady: boolean;
  webUntisAuthorizationReference: string;
  privacyNoticeUrl: string;
  privacyNoticeVersion: string;
  dictionaryEnabled: boolean;
  dictionaryProvider: string;
  dictionaryBaseUrl: string;
  dictionaryContactEmail: string;
  dictionaryAllowedPairs: string[];
  dictionaryTimeoutMs: number;
  dictionaryCacheTtlMs: number;
  dictionaryMaxCacheEntries: number;
  dictionaryValidationEnabled: boolean;
  dictionaryValidationProvider: string;
  dictionaryValidationBaseUrl: string;
  dictionaryValidationTimeoutMs: number;
  dictionaryValidationCacheTtlMs: number;
  dictionaryValidationMaxCacheEntries: number;
  reviewInitialIntervalDays: number;
  reviewMaxIntervalDays: number;
  reviewMinimumEase: number;
  reviewMaximumEase: number;
  reviewCorrectEaseStep: number;
  reviewIncorrectEasePenalty: number;
  reviewWrongDelayMinutes: number;
  analyticsRetentionDays: number;
  importMaxCourses: number;
  importMaxSectionsPerCourse: number;
  importMaxVocabularyPerCourse: number;
}

const SINGLETON_ID = 1;
const CACHE_TTL_MS = 30_000;

let cached: LearnConfigValues | null = null;
let cachedAt = 0;

type LearnConfigRow = Awaited<ReturnType<typeof prisma.learnConfig.findUnique>>;

function resolve(row: LearnConfigRow): LearnConfigValues {
  const legalGateEnabled = row?.legalGateEnabled ?? config.learnLegal.gateEnabled;
  const webUntisAuthorizationReference = row?.webUntisAuthorizationReference ?? config.learnLegal.webUntisAuthorizationReference;
  const privacyNoticeUrl = row?.privacyNoticeUrl ?? config.learnLegal.privacyNoticeUrl;
  const privacyNoticeVersion = row?.privacyNoticeVersion ?? config.learnLegal.privacyNoticeVersion;
  const dictionaryAllowedPairsRaw = row?.dictionaryAllowedPairs ?? config.learnDictionary.allowedPairs.join(',');

  return {
    legalGateEnabled,
    // Mirrors src/config.ts's own gate-readiness derivation, recomputed
    // against whatever values are actually in effect right now.
    legalGateReady: !legalGateEnabled || Boolean(
      webUntisAuthorizationReference
      && privacyNoticeVersion
      && (config.isProd ? isSecurePublicUrl(privacyNoticeUrl) : Boolean(privacyNoticeUrl)),
    ),
    webUntisAuthorizationReference,
    privacyNoticeUrl,
    privacyNoticeVersion,
    dictionaryEnabled: row?.dictionaryEnabled ?? config.learnDictionary.enabled,
    dictionaryProvider: row?.dictionaryProvider ?? config.learnDictionary.provider,
    dictionaryBaseUrl: row?.dictionaryBaseUrl ?? config.learnDictionary.baseUrl,
    dictionaryContactEmail: row?.dictionaryContactEmail ?? config.learnDictionary.contactEmail,
    dictionaryAllowedPairs: dictionaryAllowedPairsRaw.split(',').map((p) => p.trim()).filter(Boolean),
    dictionaryTimeoutMs: row?.dictionaryTimeoutMs ?? config.learnDictionary.timeoutMs,
    dictionaryCacheTtlMs: row?.dictionaryCacheTtlMs ?? config.learnDictionary.cacheTtlMs,
    dictionaryMaxCacheEntries: row?.dictionaryMaxCacheEntries ?? config.learnDictionary.maxCacheEntries,
    dictionaryValidationEnabled: row?.dictionaryValidationEnabled ?? config.learnDictionaryValidation.enabled,
    dictionaryValidationProvider: row?.dictionaryValidationProvider ?? config.learnDictionaryValidation.provider,
    dictionaryValidationBaseUrl: row?.dictionaryValidationBaseUrl ?? config.learnDictionaryValidation.baseUrl,
    dictionaryValidationTimeoutMs: row?.dictionaryValidationTimeoutMs ?? config.learnDictionaryValidation.timeoutMs,
    dictionaryValidationCacheTtlMs: row?.dictionaryValidationCacheTtlMs ?? config.learnDictionaryValidation.cacheTtlMs,
    dictionaryValidationMaxCacheEntries: row?.dictionaryValidationMaxCacheEntries ?? config.learnDictionaryValidation.maxCacheEntries,
    reviewInitialIntervalDays: row?.reviewInitialIntervalDays ?? config.learnReview.initialIntervalDays,
    reviewMaxIntervalDays: row?.reviewMaxIntervalDays ?? config.learnReview.maxIntervalDays,
    reviewMinimumEase: row?.reviewMinimumEase ?? config.learnReview.minimumEase,
    reviewMaximumEase: row?.reviewMaximumEase ?? config.learnReview.maximumEase,
    reviewCorrectEaseStep: row?.reviewCorrectEaseStep ?? config.learnReview.correctEaseStep,
    reviewIncorrectEasePenalty: row?.reviewIncorrectEasePenalty ?? config.learnReview.incorrectEasePenalty,
    reviewWrongDelayMinutes: row?.reviewWrongDelayMinutes ?? config.learnReview.wrongDelayMinutes,
    analyticsRetentionDays: row?.analyticsRetentionDays ?? config.learnReview.analyticsRetentionDays,
    importMaxCourses: row?.importMaxCourses ?? config.learnImport.maxCourses,
    importMaxSectionsPerCourse: row?.importMaxSectionsPerCourse ?? config.learnImport.maxSectionsPerCourse,
    importMaxVocabularyPerCourse: row?.importMaxVocabularyPerCourse ?? config.learnImport.maxVocabularyPerCourse,
  };
}

// Reads the live Learn config, cached briefly to keep this cheap on hot paths
// (dictionary lookups, quiz/import routes). Invalidated immediately on write.
export async function getLearnConfig(): Promise<LearnConfigValues> {
  if (cached && Date.now() - cachedAt < CACHE_TTL_MS) return cached;
  const row = await prisma.learnConfig.findUnique({ where: { id: SINGLETON_ID } });
  cached = resolve(row);
  cachedAt = Date.now();
  return cached;
}

// Fields an admin may set. `webUntisAuthorizationReference` is accepted here
// (write-only) but never returned by getLearnConfig()'s public API callers —
// the admin route reports only whether one is set, matching
// docs/legal-readiness.md's "without exposing the approval reference" rule.
export type LearnConfigInput = Partial<{
  legalGateEnabled: boolean;
  webUntisAuthorizationReference: string;
  privacyNoticeUrl: string;
  privacyNoticeVersion: string;
  dictionaryEnabled: boolean;
  dictionaryProvider: string;
  dictionaryBaseUrl: string;
  dictionaryContactEmail: string;
  dictionaryAllowedPairs: string;
  dictionaryTimeoutMs: number;
  dictionaryCacheTtlMs: number;
  dictionaryMaxCacheEntries: number;
  dictionaryValidationEnabled: boolean;
  dictionaryValidationProvider: string;
  dictionaryValidationBaseUrl: string;
  dictionaryValidationTimeoutMs: number;
  dictionaryValidationCacheTtlMs: number;
  dictionaryValidationMaxCacheEntries: number;
  reviewInitialIntervalDays: number;
  reviewMaxIntervalDays: number;
  reviewMinimumEase: number;
  reviewMaximumEase: number;
  reviewCorrectEaseStep: number;
  reviewIncorrectEasePenalty: number;
  reviewWrongDelayMinutes: number;
  analyticsRetentionDays: number;
  importMaxCourses: number;
  importMaxSectionsPerCourse: number;
  importMaxVocabularyPerCourse: number;
}>;

export async function updateLearnConfig(partial: LearnConfigInput, updatedBy: string): Promise<void> {
  await prisma.learnConfig.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID, ...partial, updatedBy },
    update: { ...partial, updatedBy },
  });
  cached = null;
}
