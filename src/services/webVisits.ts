import { createHmac } from 'crypto';
import type { Request } from 'express';
import { prisma } from '../db';
import { config } from '../config';
import { clientIp } from '../middleware/requestLogger';
import { visitorKeyFor } from './visitorKey';
import { classifyUserAgent, localDayAndHour } from './usageAnalytics';
import { countryFromHeader, placeFromHeader, sendsGpc, visitPage, visitorIp, visitorSource } from './webVisitMeta';

// Website visitors, signed in or not: one row per page view of the website
// (the page_view event of POST /activity-log). Behind "Website-Besucher" and
// the visitor map on the admin Analytics page; described in the privacy
// notice under "Website-Besucher".
//
// - Kept: the address, the country (and, where the edge sends them, region
//   and city) it comes from, the device family, whether someone was signed
//   in, the page, the local day and hour.
// - The address and the place are removed after REQUEST_LOG_RETENTION_DAYS
//   (index.ts); the row then stays as an anonymous count.
// - The account only with its consent to the usage statistics (`namedUid`),
//   like the usage visits; it goes with the address, or on withdrawal.
//   Otherwise a row only says whether someone was signed in. A day-scoped
//   visitor key (the same salted hash as the usage visits) counts different
//   visitors per day: a signed-in visitor by account, a guest by device
//   (see visitorSource).
// - Every signed-in view also carries a keyed hash of its account (no name),
//   so the page can say how many different accounts share an address — a
//   school network puts many behind one. It goes with the address.
// - A browser sending Global Privacy Control is counted without its address
//   or account.
// - Bots, scripts and the native apps are not website visitors.

// A pseudonym that is the same for one account everywhere but cannot be
// turned back into it without the server secret; never shown, only counted.
function accountKeyOf(stableUid: string): string {
  return createHmac('sha256', config.jwtSecret).update(`pokyh:web-visit-account:v1:${stableUid}`).digest('hex').slice(0, 16);
}

export async function recordWebVisit(req: Request, page: string | undefined, namedUid: string | null): Promise<void> {
  const userAgent = req.headers['user-agent'] ?? '';
  const kind = classifyUserAgent(userAgent);
  if (!kind || kind.client !== 'web') return;

  const now = new Date();
  const { dayKey, hour } = localDayAndHour(now, config.usageAnalytics.timezone);
  const ip = visitorIp(clientIp(req), req.headers['cf-connecting-ip']);
  const accountKey = req.user ? accountKeyOf(req.user.stableUid) : null;
  const visitorKey = await visitorKeyFor(visitorSource(accountKey, ip, userAgent), dayKey);
  const anonymous = sendsGpc(req.headers['sec-gpc']);

  await prisma.webVisit.create({
    data: {
      ip: anonymous ? null : ip,
      country: countryFromHeader(req.headers['cf-ipcountry']),
      region: anonymous ? null : placeFromHeader(req.headers['cf-region']),
      city: anonymous ? null : placeFromHeader(req.headers['cf-ipcity']),
      visitorKey,
      device: kind.device,
      signedIn: Boolean(req.user),
      stableUid: anonymous ? null : namedUid,
      accountKey: anonymous ? null : accountKey,
      page: visitPage(page),
      dayKey,
      hour,
      createdAt: now,
    },
  });
}
