import { randomUUID } from 'node:crypto';
import { config } from '../config';
import { ownsClusterWork } from '../cluster/hooks';
import { prisma } from '../db';
import { logger } from '../utils/logger';
import { toWebp, uploadBytes } from '../utils/pictures';
import { popupImageIds } from './popupRender';

// Pictures uploaded for popups. Kept in the database (popup_images), so every
// backup has them; served at /popup-images/<id> (routes/popupImages.ts) and
// named in a popup's content by that path: ![](/popup-images/<id>). The id is
// random, never guessable, and a picture's bytes never change, so it can be
// kept by browsers for good. Clients get the path with PUBLIC_BASE_URL in
// front (withPictureBase); one no popup names any more goes a day after it
// was uploaded, time enough to write the popup it was uploaded for.

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const isPopupImageId = (id: string) => ID.test(id);
export const popupImagePath = (id: string) => `/popup-images/${id}`;

export interface StoredPopupImage {
  id: string;
  /** Where it is served, by path: what goes into the popup's content. */
  url: string;
  width: number;
  height: number;
}

/** An upload (base64) checked, drawn anew as WebP (animations keep moving) and kept. */
export async function storePopupImage(base64: string, mimeType: string, createdBy: string): Promise<StoredPopupImage> {
  const picture = await toWebp(uploadBytes(base64, mimeType), { animated: true });
  const id = randomUUID();
  await prisma.popupImage.create({
    data: { id, data: picture.data, mimeType: picture.mimeType, width: picture.width, height: picture.height, createdBy: createdBy.slice(0, 191) },
  });
  return { id, url: popupImagePath(id), width: picture.width, height: picture.height };
}

/**
 * A popup's HTML as clients get it: its pictures' paths with PUBLIC_BASE_URL
 * in front, so an app that is not on the API's host finds them. Without that
 * address the paths stay (the website puts the API's in front itself).
 */
export function withPictureBase(html: string): string {
  if (!config.publicBaseUrl) return html;
  return html.replace(/(<img\b[^>]*\bsrc=")(\/popup-images\/)/g, `$1${config.publicBaseUrl}$2`);
}

/** The popup pictures some popup still names. */
async function namedImages(): Promise<Set<string>> {
  const popups = await prisma.popup.findMany({ select: { content: true, contentHtml: true } });
  return popupImageIds(...popups.flatMap((p) => [p.content, p.contentHtml]));
}

const KEEP_UNNAMED_MS = 24 * 60 * 60 * 1000;

/** Removes the pictures no popup names that were uploaded more than a day ago. Returns how many. */
export async function cleanupPopupImages(now = new Date()): Promise<number> {
  const old = await prisma.popupImage.findMany({ where: { createdAt: { lt: new Date(now.getTime() - KEEP_UNNAMED_MS) } }, select: { id: true } });
  if (old.length === 0) return 0;
  const named = await namedImages();
  const gone = old.map((r) => r.id).filter((id) => !named.has(id));
  if (gone.length === 0) return 0;
  const { count } = await prisma.popupImage.deleteMany({ where: { id: { in: gone } } });
  logger.info('popup pictures no popup names removed', { count });
  return count;
}

const CLEANUP_EVERY_MS = 6 * 60 * 60 * 1000;

export function startPopupImageCleanup(): void {
  const run = () => {
    if (!ownsClusterWork('job:popup-images')) return;
    cleanupPopupImages().catch((err) => logger.warn('popup picture cleanup failed', { error: err instanceof Error ? err.message : String(err) }));
  };
  setTimeout(run, 5 * 60 * 1000).unref?.();
  setInterval(run, CLEANUP_EVERY_MS).unref?.();
}
