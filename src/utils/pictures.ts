import sharp, { type Metadata } from 'sharp';

// Every picture the server keeps (dishes, subjects, popups) goes through here:
// read for what the bytes are, not for what anyone says they are, then drawn
// anew as WebP. What is kept is only pixels: no SVG, no script, no EXIF with a
// phone's location, no file that is two formats at once. Stored in the
// database, so it is part of every backup and of the cluster's copy.

/** The formats a picture may come in. */
export const PICTURE_FORMATS: ReadonlySet<string> = new Set(['jpeg', 'png', 'webp', 'gif']);
/** The types an upload may declare. */
export const PICTURE_MIME_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
/** What an upload may weigh. */
export const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;
/** What a picture fetched from a link may weigh. */
export const MAX_FETCHED_BYTES = 10 * 1024 * 1024;
// A small file can unpack to an enormous picture: more than any phone takes is
// refused before it is decoded into memory (all frames of an animation together).
export const MAX_PICTURE_PIXELS = 50_000_000;
// The frames an animation may have.
const MAX_FRAMES = 300;
/** The side a stored picture has at most: phones send far more than any screen shows. */
export const MAX_PICTURE_SIDE = 1600;

/** Why a picture is not taken; `status`: 413 for too many bytes, 422 for anything else. */
export class PictureError extends Error {
  constructor(message: string, readonly status: 413 | 422 = 422) {
    super(message);
  }
}

export interface Crop {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Picture {
  data: Buffer<ArrayBuffer>;
  mimeType: 'image/webp';
  width: number;
  height: number;
}

export interface PictureOptions {
  /** A part of the picture to keep, in its pixels (after turning it upright). */
  crop?: Crop;
  maxSide?: number;
  /** Keep an animation moving (popups); otherwise its first frame. */
  animated?: boolean;
}

/** The picture `input` is, as WebP; a PictureError when it is none the server takes. */
export async function toWebp(input: Buffer, { crop, maxSide = MAX_PICTURE_SIDE, animated = false }: PictureOptions = {}): Promise<Picture> {
  if (input.length === 0) throw new PictureError('Das ist kein gültiges Bild');
  let meta: Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: false }).metadata();
  } catch {
    throw new PictureError('Das ist kein gültiges Bild');
  }
  if (!meta.format || !PICTURE_FORMATS.has(meta.format)) throw new PictureError('Das ist kein gültiges Bild');
  const frames = animated ? Math.max(1, meta.pages ?? 1) : 1;
  const frameHeight = meta.pageHeight ?? meta.height ?? 0;
  const width = meta.width ?? 0;
  if (width === 0 || frameHeight === 0) throw new PictureError('Das ist kein gültiges Bild');
  if (width * frameHeight * frames > MAX_PICTURE_PIXELS || frames > MAX_FRAMES) throw new PictureError('Das Bild ist zu groß (zu viele Pixel)');

  // A crop is of one picture: an animation that is cropped keeps its first frame.
  const many = animated && frames > 1 && !crop;
  try {
    // rotate(): phones store a picture sideways with a note; the note goes.
    let picture = sharp(input, { limitInputPixels: MAX_PICTURE_PIXELS, animated: many }).rotate();
    if (crop) {
      // Upright first, so the crop is in the pixels the administrator saw.
      const upright = await picture.toBuffer({ resolveWithObject: true });
      const { width: w, height: h } = upright.info;
      const fits = [crop.left, crop.top, crop.width, crop.height].every((n) => Number.isInteger(n) && n >= 0)
        && crop.width > 0 && crop.height > 0 && crop.left + crop.width <= w && crop.top + crop.height <= h;
      if (!fits) throw new PictureError('Der Ausschnitt liegt nicht im Bild');
      picture = sharp(upright.data, { limitInputPixels: MAX_PICTURE_PIXELS, animated: many }).extract(crop);
    }
    const { data, info } = await picture
      .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 85, ...(many ? { loop: meta.loop ?? 0 } : {}) })
      .toBuffer({ resolveWithObject: true });
    return { data: Buffer.from(data), mimeType: 'image/webp', width: info.width, height: many ? (info.pageHeight ?? info.height) : info.height };
  } catch (err) {
    if (err instanceof PictureError) throw err;
    throw new PictureError('Das Bild konnte nicht gelesen werden');
  }
}

/**
 * Headers for a picture served from the database: only a picture type is ever
 * named (whatever a row says, e.g. one brought in by the JSON import), and the
 * answer may not run anything, even when opened on its own.
 */
export function pictureHeaders(mimeType: string): Record<string, string> {
  return {
    'Content-Type': PICTURE_MIME_TYPES.has(mimeType) ? mimeType : 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  };
}

/** The bytes of an upload (base64, without "data:…"), refused when too large. */
export function uploadBytes(base64: string, mimeType: string): Buffer {
  if (!PICTURE_MIME_TYPES.has(mimeType)) throw new PictureError('Dieses Bildformat wird nicht unterstützt');
  // base64 is 4 characters for 3 bytes: refused before it is decoded.
  if (base64.length > Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 4) throw new PictureError('Das Bild ist zu groß (höchstens 3 MB)', 413);
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > MAX_UPLOAD_BYTES) throw new PictureError('Das Bild ist zu groß (höchstens 3 MB)', 413);
  return bytes;
}
