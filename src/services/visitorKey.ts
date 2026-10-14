import { createHash, randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../db';

// Counting how many different people used Pokyh on a day without knowing who.
//
// Every day gets a random salt; a visit stores sha256(salt + account) cut to
// 16 hex characters. Within the day the same account gives the same key, so
// "active today" can be counted; the next day it gets another key, so days
// cannot be linked. The salt of a past day is deleted (index.ts), after which
// no key can be traced back to an account by anyone, the operator included.
//
// The salt lives in the database so every cluster node hands out the same key.

const salts = new Map<string, string>();

async function saltFor(dayKey: string): Promise<string> {
  const cached = salts.get(dayKey);
  if (cached) return cached;
  // Keeps whichever salt was stored first if two requests race.
  const row = await prisma.usageDaySalt.upsert({
    where: { dayKey },
    create: { dayKey, salt: randomBytes(32).toString('hex') },
    update: {},
    select: { salt: true },
  });
  if (salts.size > 4) salts.clear();
  salts.set(dayKey, row.salt);
  return row.salt;
}

export async function visitorKeyFor(stableUid: string, dayKey: string): Promise<string> {
  const salt = await saltFor(dayKey);
  return createHash('sha256').update(`${salt}:${stableUid}`).digest('hex').slice(0, 16);
}

// Visits from before visitor keys existed (or restored from a backup) get one
// before they lose their account, so the day's count of different people
// survives. The salt exists only for this one statement: the same account on
// the same day gets the same key, and nothing leads back to it afterwards.
export async function keyUnkeyedVisits(stableUid?: string): Promise<number> {
  const salt = randomBytes(32).toString('hex');
  const key = Prisma.sql`LEFT(SHA2(CONCAT(${salt}, ':', day_key, ':', stable_uid), 256), 16)`;
  return stableUid
    ? prisma.$executeRaw`UPDATE usage_sessions SET visitor_key = ${key} WHERE visitor_key IS NULL AND stable_uid = ${stableUid}`
    : prisma.$executeRaw`UPDATE usage_sessions SET visitor_key = ${key} WHERE visitor_key IS NULL AND stable_uid IS NOT NULL`;
}
