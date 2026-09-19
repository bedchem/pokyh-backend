import { prisma } from '../db';
import { config } from '../config';

// Admin-editable AI vocabulary trainer configuration, backed by the LearnAiConfig
// singleton row (id 1) with a short in-memory cache. Every field falls back
// to the LEARN_AI_* environment default in src/config.ts when the row — or a
// field on it — is null, so behaviour is unchanged until an admin explicitly
// saves a value. LEARN_AI_ALLOWED_HOSTS is deliberately not part of this: it
// is a security-boundary value and stays environment-only, same rule as
// LEARN_ALLOWED_ORIGINS in learnConfig.ts.
export interface LearnAiConfigValues {
  enabled: boolean;
  modelName: string;
  contextTokens: number;
  numPredictFast: number;
  rateLimitMessagesPerHour: number;
  maxConcurrentTrainingGenerations: number;
  ollamaBaseUrl: string;
  ollamaTimeoutMs: number;
}

const SINGLETON_ID = 1;
const CACHE_TTL_MS = 30_000;

let cached: LearnAiConfigValues | null = null;
let cachedAt = 0;

type LearnAiConfigRow = Awaited<ReturnType<typeof prisma.learnAiConfig.findUnique>>;

function resolve(row: LearnAiConfigRow): LearnAiConfigValues {
  return {
    enabled: row?.enabled ?? config.learnAi.enabled,
    modelName: row?.modelName ?? config.learnAi.modelName,
    contextTokens: row?.contextTokens ?? config.learnAi.contextTokens,
    numPredictFast: row?.numPredictFast ?? config.learnAi.numPredictFast,
    rateLimitMessagesPerHour: row?.rateLimitMessagesPerHour ?? config.learnAi.rateLimitMessagesPerHour,
    maxConcurrentTrainingGenerations: row?.maxConcurrentTrainingGenerations ?? config.learnAi.maxConcurrentTrainingGenerations,
    ollamaBaseUrl: row?.ollamaBaseUrl ?? config.learnAi.ollamaBaseUrl,
    ollamaTimeoutMs: row?.ollamaTimeoutMs ?? config.learnAi.ollamaTimeoutMs,
  };
}

// Reads the live AI config, cached briefly to keep this cheap on hot paths
// (every training request). Invalidated immediately on write.
export async function getLearnAiConfig(): Promise<LearnAiConfigValues> {
  if (cached && Date.now() - cachedAt < CACHE_TTL_MS) return cached;
  const row = await prisma.learnAiConfig.findUnique({ where: { id: SINGLETON_ID } });
  cached = resolve(row);
  cachedAt = Date.now();
  return cached;
}

export type LearnAiConfigInput = Partial<{
  enabled: boolean;
  modelName: string;
  contextTokens: number;
  numPredictFast: number;
  rateLimitMessagesPerHour: number;
  maxConcurrentTrainingGenerations: number;
  ollamaBaseUrl: string;
  ollamaTimeoutMs: number;
}>;

export async function updateLearnAiConfig(partial: LearnAiConfigInput, updatedBy: string): Promise<void> {
  await prisma.learnAiConfig.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID, ...partial, updatedBy },
    update: { ...partial, updatedBy },
  });
  cached = null;
}
