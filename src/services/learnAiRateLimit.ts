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
    throw new AppError('You have reached the vocabulary trainer request limit for this hour', 429);
  }
}

// Reserve a quota slot inside the same transaction that writes a durable
// queued request. This prevents a user from bypassing the product limit by
// closing/reopening a tab before an expensive CPU generation has completed.
// A failed generation refunds the reservation below; a successful one records
// its token count without incrementing the message count a second time.
export async function reserveAiUsage(
  tx: Prisma.TransactionClient,
  stableUid: string,
  rateLimitMessagesPerHour: number,
): Promise<void> {
  const windowStart = currentWindowStart();
  const counter = await tx.learnAiUsageCounter.findUnique({
    where: { stableUid_windowStart: { stableUid, windowStart } },
    select: { messageCount: true },
  });
  if ((counter?.messageCount ?? 0) >= rateLimitMessagesPerHour) {
    throw new AppError('You have reached the vocabulary trainer request limit for this hour', 429);
  }
  await recordAiUsage(tx, stableUid, 0);
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

export function recordAiUsageTokens(tx: Prisma.TransactionClient, stableUid: string, tokenCount: number) {
  const windowStart = currentWindowStart();
  // Use upsert rather than update: a failed/retried worker can race the
  // reservation refund at the hour boundary, but token accounting must never
  // make an otherwise completed durable reply fail to persist.
  return tx.learnAiUsageCounter.upsert({
    where: { stableUid_windowStart: { stableUid, windowStart } },
    create: { stableUid, windowStart, messageCount: 0, tokenCount: Math.max(0, tokenCount) },
    update: { tokenCount: { increment: Math.max(0, tokenCount) } },
  });
}

export async function refundReservedAiUsage(stableUid: string): Promise<void> {
  const windowStart = currentWindowStart();
  await prisma.learnAiUsageCounter.updateMany({
    where: { stableUid, windowStart, messageCount: { gt: 0 } },
    data: { messageCount: { decrement: 1 } },
  });
}
