import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { writeLimiter } from '../middleware/rateLimiter';
import { logger } from '../utils/logger';
import { forgetUsageData, rememberUsageConsent } from '../services/privacyConsent';

// ─── /privacy ────────────────────────────────────────────────────────────────
// The privacy notice an account acknowledged at sign-in and its choice on the
// usage statistics. The acknowledgement only records that the notice was
// shown and read — it is not consent and not the legal basis of anything. The
// usage statistics are a separate, optional consent (GDPR Art. 6(1)(a), Art. 7;
// Italian Garante 2021 guidelines on tracking tools), so they are asked as
// their own choice, never preset, and can be withdrawn here at any time.
//
// The notice's version is set by the website, which holds its text; the
// server stores which version was acknowledged, when, and the consent with its
// time as proof (Art. 7(1)). The row is deleted with the account.

const router = Router();

// A date, optionally followed by a short revision tag: "2026-10-14", "2026-10-14b".
const version = z.string().regex(/^\d{4}-\d{2}-\d{2}[0-9a-z.-]{0,8}$/);

router.get('/status', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const row = await prisma.privacyConsent.findUnique({ where: { stableUid: req.user!.stableUid } });
  res.json({
    acknowledgedVersion: row?.noticeVersion || null,
    acknowledgedAt: row?.noticeVersion ? row.acknowledgedAt.toISOString() : null,
    usageStats: row?.usageStats ?? false,
    usageStatsAt: row?.usageStatsAt?.toISOString() ?? null,
  });
});

const acknowledgeSchema = z.object({ version, usageStats: z.boolean() });

// POST /privacy/acknowledge — the notice was read (required to use the site)
// together with the usage-statistics choice made on the same screen.
router.post('/acknowledge', requireAuth, writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const parsed = acknowledgeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid payload' });
    return;
  }
  const { stableUid } = req.user!;
  const now = new Date();
  const before = await prisma.privacyConsent.findUnique({ where: { stableUid }, select: { usageStats: true } });
  const changed = before?.usageStats !== parsed.data.usageStats;
  await prisma.privacyConsent.upsert({
    where: { stableUid },
    create: {
      stableUid,
      noticeVersion: parsed.data.version,
      acknowledgedAt: now,
      usageStats: parsed.data.usageStats,
      usageStatsAt: now,
    },
    update: {
      noticeVersion: parsed.data.version,
      acknowledgedAt: now,
      usageStats: parsed.data.usageStats,
      ...(changed ? { usageStatsAt: now } : {}),
    },
  });
  rememberUsageConsent(stableUid, parsed.data.usageStats);
  if (!parsed.data.usageStats) await forgetUsageData(stableUid);
  logger.info('Privacy notice acknowledged', {
    action: 'privacy_acknowledged',
    stableUid,
    version: parsed.data.version,
    usageStats: parsed.data.usageStats,
  });
  res.status(204).send();
});

const usageSchema = z.object({ enabled: z.boolean() });

// PUT /privacy/usage-stats — give or withdraw the consent later (profile).
// Withdrawing deletes what was measured so far.
router.put('/usage-stats', requireAuth, writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const parsed = usageSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid payload' });
    return;
  }
  const { stableUid } = req.user!;
  const now = new Date();
  await prisma.privacyConsent.upsert({
    where: { stableUid },
    // Without an acknowledged notice yet: the consent is recorded on its own
    // and the notice is still asked for at the next sign-in.
    create: { stableUid, noticeVersion: '', acknowledgedAt: now, usageStats: parsed.data.enabled, usageStatsAt: now },
    update: { usageStats: parsed.data.enabled, usageStatsAt: now },
  });
  rememberUsageConsent(stableUid, parsed.data.enabled);
  if (!parsed.data.enabled) await forgetUsageData(stableUid);
  logger.info('Usage statistics consent changed', { action: 'usage_consent_changed', stableUid, enabled: parsed.data.enabled });
  res.status(204).send();
});

export { router as privacyRouter };
