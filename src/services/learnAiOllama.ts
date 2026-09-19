import { AppError } from '../utils/errors';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getLearnAiConfig } from './learnAiConfig';

// Pulling a multi-GB model needs far longer than any single training request is
// ever allowed to take — this is deliberately its own constant, not derived
// from LEARN_AI_OLLAMA_TIMEOUT_MS.
const MODEL_PULL_TIMEOUT_MS = 60 * 60 * 1000;

export type ModelRole = 'system' | 'user' | 'assistant';

export interface ModelMessageInput {
  role: ModelRole;
  content: string;
}

export interface ModelResult {
  content: string;
  modelName: string;
  promptTokens: number | null;
  completionTokens: number | null;
}

let modelReady = false;
let pullInFlight: Promise<void> | null = null;

// Ollama is reachable only on the internal Docker network. This guard keeps
// that true even if an admin were to edit LearnAiConfig.ollamaBaseUrl —
// the allowed-hosts list itself stays environment-only (src/config.ts),
// mirroring learnDictionary.ts's safeProviderUrl().
function safeOllamaUrl(baseUrl: string, path: string): URL {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new AppError('Assistant is not configured correctly', 503);
  }
  const hostname = base.hostname.toLocaleLowerCase('en-US');
  if (
    (base.protocol !== 'http:' && base.protocol !== 'https:')
    || !config.learnAiAllowedHosts.includes(hostname)
    || base.username
    || base.password
  ) {
    throw new AppError('Assistant is not configured correctly', 503);
  }
  return new URL(path, base);
}

export function isModelReady(): boolean {
  return modelReady;
}

async function fetchLocalModelNames(baseUrl: string, timeoutMs: number): Promise<Set<string>> {
  const url = safeOllamaUrl(baseUrl, '/api/tags');
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) }).catch(() => null);
  if (!res || !res.ok) throw new AppError('Assistant provider could not be reached', 503);
  const data = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
  const names = new Set<string>();
  for (const model of data.models ?? []) {
    if (model.name) names.add(model.name);
    if (model.model) names.add(model.model);
  }
  return names;
}

async function pullModel(baseUrl: string, modelName: string): Promise<void> {
  const url = safeOllamaUrl(baseUrl, '/api/pull');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelName, stream: true }),
    signal: AbortSignal.timeout(MODEL_PULL_TIMEOUT_MS),
  }).catch(() => null);
  if (!res || !res.ok || !res.body) throw new AppError('Assistant provider could not be reached', 503);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lastLoggedAt = 0;
  let success = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf('\n');
      if (!line) continue;
      let progress: { status?: string; completed?: number; total?: number } | null = null;
      try {
        progress = JSON.parse(line);
      } catch {
        continue;
      }
      if (progress?.status === 'success') success = true;
      const now = Date.now();
      if (now - lastLoggedAt > 5_000) {
        lastLoggedAt = now;
        logger.info('learn_ai_model_pull_progress', {
          model: modelName,
          status: progress?.status ?? 'unknown',
          completed: progress?.completed ?? null,
          total: progress?.total ?? null,
        });
      }
    }
  }

  if (!success) throw new AppError('Assistant model download did not complete', 503);
}

// Checks whether the configured model is already present locally and pulls
// it if not, then marks the vocabulary trainer ready. Safe to call repeatedly —
// concurrent callers share one in-flight check/pull. Deliberately never
// awaited by the HTTP server's own startup sequence (src/index.ts): a
// multi-GB first-boot pull must never block the rest of Pokyh/Learn from
// serving requests. Training requests check isModelReady() first instead.
export async function ensureModelReady(): Promise<void> {
  if (pullInFlight) return pullInFlight;
  pullInFlight = (async () => {
    try {
      const aiCfg = await getLearnAiConfig();
      if (!aiCfg.enabled) {
        modelReady = false;
        return;
      }
      const present = await fetchLocalModelNames(aiCfg.ollamaBaseUrl, aiCfg.ollamaTimeoutMs);
      if (!present.has(aiCfg.modelName)) {
        logger.info('learn_ai_model_pull_start', { model: aiCfg.modelName });
        await pullModel(aiCfg.ollamaBaseUrl, aiCfg.modelName);
        logger.info('learn_ai_model_pull_complete', { model: aiCfg.modelName });
      }
      modelReady = true;
    } catch (err) {
      modelReady = false;
      logger.error('learn_ai_model_pull_failed', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      pullInFlight = null;
    }
  })();
  return pullInFlight;
}

/**
 * Produces a compact, structured response for the vocabulary trainer.
 *
 * The `think: false` request prevents models that support Ollama's thinking
 * mode from emitting reasoning. `format: 'json'` keeps the model response
 * machine-readable; the caller still validates every field before storing it.
 */
export async function generateStructuredResponse(messages: ModelMessageInput[]): Promise<ModelResult> {
  const aiCfg = await getLearnAiConfig();
  if (!aiCfg.enabled) throw new AppError('The vocabulary trainer is currently disabled', 503);
  if (!modelReady) throw new AppError('The vocabulary trainer is still starting up — try again shortly', 503);

  const url = safeOllamaUrl(aiCfg.ollamaBaseUrl, '/api/chat');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: aiCfg.modelName,
      messages,
      stream: false,
      format: 'json',
      think: false,
      options: {
        num_ctx: aiCfg.contextTokens,
        // A single sentence and translation do not need a long completion.
        num_predict: Math.min(aiCfg.numPredictFast, 256),
      },
    }),
    signal: AbortSignal.timeout(aiCfg.ollamaTimeoutMs),
  }).catch(() => null);

  if (!res || !res.ok) throw new AppError('The vocabulary trainer could not be reached', 503);

  const data = (await res.json()) as {
    message?: { content?: string };
    model?: string;
    prompt_eval_count?: number;
    eval_count?: number;
  };
  const content = data.message?.content?.trim();
  if (!content) throw new AppError('The vocabulary trainer returned an empty response', 503);

  return {
    content,
    modelName: data.model ?? aiCfg.modelName,
    promptTokens: typeof data.prompt_eval_count === 'number' ? data.prompt_eval_count : null,
    completionTokens: typeof data.eval_count === 'number' ? data.eval_count : null,
  };
}
