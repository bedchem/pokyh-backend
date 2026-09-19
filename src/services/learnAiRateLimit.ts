import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { AppError } from '../utils/errors';
import { getLearnAiConfig } from './learnAiConfig';

// Hour-floored window, UTC — matches LearnAiUsageCounter.windowStart.
function currentWindowStart(): Date {
  const now = new Date();
  now.setUTCMinutes(0, 0, 0);
  return now;
}

// MySQL is the authoritative quota ledger: this holds correctly even without
// Redis. A Redis-backed fast-rejection path could be layered on top later
// purely as a latency optimization for the common "well under quota" case —
// it would never replace this check as the actual enforcement point.
export async function assertWithinAiQuota(stableUid: string): Promise<void> {
  const aiCfg = await getLearnAiConfig();
  const windowStart = currentWindowStart();
  const counter = await prisma.learnAiUsageCounter.findUnique({
    where: { stableUid_windowStart: { stableUid, windowStart } },
    select: { messageCount: true },
  });
  if ((counter?.messageCount ?? 0) >= aiCfg.rateLimitMessagesPerHour) {
    throw new AppError('You have reached the assistant message limit for this hour', 429);
  }
}

// Must be called inside the same transaction that persists the message pair
// so the increment can never drift from the write it is accounting for.
export function recordAiUsage(tx: Prisma.TransactionClient, stableUid: string, tokenCount: number) {
  const windowStart = currentWindowStart();
  return tx.learnAiUsageCounter.upsert({
    where: { stableUid_windowStart: { stableUid, windowStart } },
    create: { stableUid, windowStart, messageCount: 1, tokenCount: Math.max(0, tokenCount) },
    update: { messageCount: { increment: 1 }, tokenCount: { increment: Math.max(0, tokenCount) } },
  });
}
