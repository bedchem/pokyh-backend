import { Router, Request, Response } from 'express';
import { prisma } from '../db';
import { readLimiter } from '../middleware/rateLimiter';
import { isPopupImageId } from '../services/popupImages';
import { pictureHeaders } from '../utils/pictures';

// GET /popup-images/:id — a picture uploaded for popups (services/popupImages.ts).
// Public like the popups' pictures always were; its id is random and its bytes
// never change, so browsers keep it for good.
const router = Router();

router.get('/:id', readLimiter, async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params['id']).toLowerCase();
  if (!isPopupImageId(id)) { res.status(404).end(); return; }
  const etag = `"${id}"`;
  // Shown by the website and the apps from another origin (helmet says same-origin).
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  if (req.headers['if-none-match'] === etag) {
    res.setHeader('ETag', etag);
    res.status(304).end();
    return;
  }
  const row = await prisma.popupImage.findUnique({ where: { id }, select: { data: true, mimeType: true } });
  if (!row) { res.status(404).end(); return; }
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  for (const [name, value] of Object.entries(pictureHeaders(row.mimeType))) res.setHeader(name, value);
  res.setHeader('Content-Length', row.data.length);
  res.end(row.data);
});

export { router as popupImagesRouter };
