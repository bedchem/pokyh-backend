import { prisma } from '../db';
import { keyUnkeyedVisits } from './visitorKey';

// Whether an account has opted in to the usage statistics (time in Pokyh,
// device kind, page views with its name). Asked at sign-in next to the privacy
// notice, never preset, revocable in the profile; see routes/privacy.ts.
//
// The usage heartbeat asks this once a minute per open app, so answers are
// held briefly. A change made on this node takes effect at once; one made on
// another cluster node within CACHE_MS, and the daily clean-up removes
// anything stored in between (index.ts).

const CACHE_MS = 60 * 1000;
const cache = new Map<string, { usage: boolean; at: number }>();

export async function hasUsageConsent(stableUid: string): Promise<boolean> {
  const hit = cache.get(stableUid);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.usage;
  const row = await prisma.privacyConsent.findUnique({ where: { stableUid }, select: { usageStats: true } });
  const usage = row?.usageStats ?? false;
  cache.set(stableUid, { usage, at: Date.now() });
  return usage;
}

export function rememberUsageConsent(stableUid: string, usage: boolean): void {
  cache.set(stableUid, { usage, at: Date.now() });
}

// What a withdrawn (or never given) consent means for data already stored:
// the account's visits and page views lose its name and stay only as
// anonymous counts; its website and app visits keep only "signed in".
export async function forgetUsageData(stableUid: string): Promise<void> {
  await keyUnkeyedVisits(stableUid);
  await prisma.usageSession.updateMany({ where: { stableUid }, data: { stableUid: null } });
  await prisma.frontendActivityLog.updateMany({
    where: { stableUid, event: 'page_view' },
    data: { stableUid: null, username: null, ip: null, userAgent: null },
  });
  await prisma.webVisit.updateMany({ where: { stableUid }, data: { stableUid: null } });
}
