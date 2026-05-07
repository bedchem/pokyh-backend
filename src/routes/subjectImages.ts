import { Router, Request, Response } from 'express';
import { z } from 'zod';
import sharp from 'sharp';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { readLimiter, writeLimiter } from '../middleware/rateLimiter';

const router = Router();

function normalizeKey(s: string): string {
  return s.toLowerCase().trim().slice(0, 200);
}

// POST /subject-images/report — frontend reports discovered subjects (upsert, no image)
const reportSchema = z.object({
  subjects: z.array(z.object({
    key:       z.string().min(1).max(200),
    longName:  z.string().min(1).max(200),
    shortName: z.string().max(50).default(''),
  })).max(100),
});

router.post('/report', writeLimiter, requireAuth, async (req: Request, res: Response) => {
  const { subjects } = reportSchema.parse(req.body);
  const rows = subjects.map(s => ({
    key:       normalizeKey(s.key),
    longName:  s.longName,
    shortName: s.shortName,
  })).filter(s => s.key.length > 0);

  for (const row of rows) {
    await prisma.knownSubject.upsert({
      where:  { key: row.key },
      create: row,
      update: {},  // don't overwrite existing name
    });
  }
  res.json({ ok: true, count: rows.length });
});

// GET /subject-images — list all subjects that have an image (for frontend cache)
router.get('/', readLimiter, async (_req: Request, res: Response): Promise<void> => {
  const images = await prisma.subjectImage.findMany({ select: { subject: true } });
  res.json(images.map(i => ({ subject: i.subject })));
});

// GET /subject-images/:subject — serve binary image (API key only, for <img src>)
router.get('/:subject', readLimiter, async (req: Request, res: Response): Promise<void> => {
  const subject = normalizeKey(req.params['subject'] as string);
  const row = await prisma.subjectImage.findUnique({ where: { subject } });

  if (!row) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  const etag = `"${row.updatedAt.getTime()}"`;
  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return;
  }

  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=86400');
  res.setHeader('Last-Modified', row.updatedAt.toUTCString());
  res.setHeader('Content-Type', row.mimeType);
  res.setHeader('Content-Length', row.data.length);
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.end(row.data);
});

export { router as subjectImagesRouter };
