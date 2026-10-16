import { createHmac } from 'crypto';
import type { Request } from 'express';
import { prisma } from '../db';
import { config } from '../config';
import { tokenAccount } from '../middleware/auth';
import { clientIp } from '../middleware/requestLogger';
import { visitorKeyFor } from './visitorKey';
import { schoolOfUser } from './schools';
import { classifyUserAgent, localDayAndHour, type UsageDevice } from './usageAnalytics';
import { countryFromHeader, placeFromHeader, sendsGpc, visitPage, visitorIp, visitorSource } from './webVisitMeta';

// Visitors of the website and the apps, signed in or not, behind "Besucher"
// and the visitor map on the admin Analytics page; described in the privacy
// notice under "Website- und App-Besucher".
//
// - Website: one row per page view (the page_view event of POST /activity-log).
// - Apps: one row per opening of the iOS or Android app, taken from its usage
//   heartbeat (POST /usage/ping): once per visit, address and day — so again
//   when the phone moves to another network or a visit runs past midnight.
//   The apps send nothing extra for this; the address is the heartbeat's own.
// - Kept: the address, the country (and, where the edge sends them, region
//   and city) it comes from, the device family, whether someone was signed
//   in, the page or the app version, the local day and hour.
// - The address and the place are removed after REQUEST_LOG_RETENTION_DAYS
//   (index.ts); the row then stays as an anonymous count.
// - The account only with its consent to the usage statistics (`namedUid`),
//   like the usage visits; it goes with the address, or on withdrawal.
//   Otherwise a row only says whether someone was signed in. A day-scoped
//   visitor key (the same salted hash as the usage visits) counts different
//   visitors per day: a signed-in visitor by account — the same key on the
//   website and in the apps, so someone using both is one visitor — and a
//   guest by device (see visitorSource).
// - Every signed-in visit also carries a keyed hash of its account (no name),
//   so the page can say how many different accounts share an address — a
//   school network puts many behind one. It goes with the address.
// - A browser sending Global Privacy Control is counted without its address
//   or account.
// - Bots and scripts are not visitors.

// A visitor whose access token ran out meanwhile still counts as their
// account: the website sends its first page view with the old token before it
// refreshes it, and counting that view as a guest made every returning
// visitor two on that day. As long as the website keeps a session (its
// refresh cookie lasts 30 days); access is never decided by this.
const EXPIRED_TOKEN_GRACE_SECONDS = 30 * 24 * 60 * 60;

// A pseudonym that is the same for one account everywhere but cannot be
// turned back into it without the server secret; never shown, only counted.
export function accountKeyOf(stableUid: string): string {
  return createHmac('sha256', config.jwtSecret).update(`pokyh:web-visit-account:v1:${stableUid}`).digest('hex').slice(0, 16);
}

// What every visit keeps about who came from where, website or app.
async function visitorFields(req: Request, userAgent: string, namedUid: string | null, now: Date) {
  const { dayKey, hour } = localDayAndHour(now, config.usageAnalytics.timezone);
  const ip = visitorIp(clientIp(req), req.headers['cf-connecting-ip']);
  const account = req.user?.stableUid ?? tokenAccount(req, EXPIRED_TOKEN_GRACE_SECONDS);
  const accountKey = account ? accountKeyOf(account) : null;
  const visitorKey = await visitorKeyFor(visitorSource(accountKey, ip, userAgent), dayKey);
  const anonymous = sendsGpc(req.headers['sec-gpc']);
  return {
    ip: anonymous ? null : ip,
    country: countryFromHeader(req.headers['cf-ipcountry']),
    region: anonymous ? null : placeFromHeader(req.headers['cf-region']),
    city: anonymous ? null : placeFromHeader(req.headers['cf-ipcity']),
    visitorKey,
    signedIn: Boolean(account),
    stableUid: anonymous ? null : namedUid,
    accountKey: anonymous ? null : accountKey,
    // A signed-in visit's school, as on the usage visits.
    schoolId: account ? await schoolOfUser(account) : null,
    dayKey,
    hour,
    createdAt: now,
  };
}

export async function recordWebVisit(req: Request, page: string | undefined, namedUid: string | null): Promise<void> {
  const userAgent = req.headers['user-agent'] ?? '';
  const kind = classifyUserAgent(userAgent);
  if (!kind || kind.client !== 'web') return;

  const fields = await visitorFields(req, userAgent, namedUid, new Date());
  await prisma.webVisit.create({
    data: { ...fields, client: 'web', device: kind.device, page: visitPage(page) },
  });
}

// Visits, addresses and days already stored by this node, so the heartbeat
// (every 30 seconds per open app) rarely needs the database to know.
const storedAppVisits = new Set<string>();

export async function recordAppVisit(
  req: Request,
  visit: { sessionId: string; device: UsageDevice; appVersion: string },
  namedUid: string | null,
): Promise<void> {
  const userAgent = req.headers['user-agent'] ?? '';
  if (userAgent && !classifyUserAgent(userAgent)) return;

  const fields = await visitorFields(req, userAgent, namedUid, new Date());
  const seen = `${visit.sessionId}|${fields.ip ?? ''}|${fields.dayKey}`;
  if (storedAppVisits.has(seen)) return;
  // Another node, or this one before a restart, may have stored it already.
  const existing = await prisma.webVisit.findFirst({
    where: { sessionId: visit.sessionId, ip: fields.ip, dayKey: fields.dayKey },
    select: { id: true },
  });
  if (!existing) {
    await prisma.webVisit.create({
      data: {
        ...fields,
        client: 'app',
        sessionId: visit.sessionId,
        appVersion: visit.appVersion.slice(0, 32),
        device: visit.device,
        page: '',
      },
    });
  }
  if (storedAppVisits.size > 20_000) storedAppVisits.clear();
  storedAppVisits.add(seen);
}
