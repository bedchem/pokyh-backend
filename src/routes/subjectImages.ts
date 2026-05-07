import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { readLimiter, writeLimiter } from '../middleware/rateLimiter';

const router = Router();

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_BYTES = 3 * 1024 * 1024; // 3 MB decoded

function normalizeSubject(s: string): string {
  return s.toLowerCase().trim().slice(0, 200);
}

// GET /subject-images — list subjects that have an image (no binary)
router.get('/', readLimiter, requireAuth, async (_req: Request, res: Response) => {
  const rows = await prisma.subjectImage.findMany({
    select: { subject: true, mimeType: true, updatedAt: true },
    orderBy: { subject: 'asc' },
  });
  res.json(rows);
});

// GET /subject-images/:subject — serve binary image (API key only, for <img src>)
router.get('/:subject', readLimiter, async (req: Request, res: Response): Promise<void> => {
  const subject = normalizeSubject(req.params['subject'] as string);
  const row = await prisma.subjectImage.findUnique({ where: { subject } });

  if (!row) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  const etag = `"${row.updatedAt.getTime()}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=86400');
  res.setHeader('Last-Modified', row.updatedAt.toUTCString());

  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return;
  }

  res.setHeader('Content-Type', row.mimeType);
  res.setHeader('Content-Length', row.data.length);
  res.end(row.data);
});

// PUT /subject-images/:subject — upload or replace image
const uploadSchema = z.object({
  data: z.string().min(1),
  mimeType: z.string(),
});

router.put('/:subject', writeLimiter, requireAuth, async (req: Request, res: Response): Promise<void> => {
  const subject = normalizeSubject(req.params['subject'] as string);
  if (!subject) {
    res.status(400).json({ error: 'Invalid subject' });
    return;
  }

  const body = uploadSchema.parse(req.body);

  if (!ALLOWED_MIME.has(body.mimeType)) {
    res.status(422).json({ error: 'Unsupported image type' });
    return;
  }

  const buf = Buffer.from(body.data, 'base64');
  if (buf.length > MAX_BYTES) {
    res.status(413).json({ error: 'Image too large (max 3 MB)' });
    return;
  }

  await prisma.subjectImage.upsert({
    where: { subject },
    create: { subject, data: buf, mimeType: body.mimeType },
    update: { data: buf, mimeType: body.mimeType },
  });

  res.json({ ok: true, subject });
});

// DELETE /subject-images/:subject
router.delete('/:subject', writeLimiter, requireAuth, async (req: Request, res: Response): Promise<void> => {
  const subject = normalizeSubject(req.params['subject'] as string);
  try {
    await prisma.subjectImage.delete({ where: { subject } });
  } catch {
    // Not found is fine for delete
  }
  res.status(204).end();
});

export { router as subjectImagesRouter };
