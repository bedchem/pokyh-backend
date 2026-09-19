import { ValidationError } from '../utils/errors';
import { getLearnAiConfig } from './learnAiConfig';

export interface ValidatedUpload {
  kind: 'image' | 'text';
  mimeType: string;
  byteSize: number;
  // Base64 for images (fed to Ollama's `images` field as-is); UTF-8 text for
  // the 'text' kind (inlined into the prompt as bounded, delimited context).
  content: string;
}

// The client's claimed MIME type / filename extension is never trusted for
// anything except cosmetic display — the actual kind is decided from the
// file's real bytes, matching this repo's existing rule (see
// learnDictionary.ts's egress guard and CLAUDE.md's upload-validation
// requirement). A file that matches none of these signatures, and isn't
// plausible plain text, is rejected outright rather than guessed at.
const IMAGE_SIGNATURES: Array<{ mime: string; matches: (buf: Buffer) => boolean }> = [
  { mime: 'image/png', matches: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a },
  { mime: 'image/jpeg', matches: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/webp', matches: (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
  { mime: 'image/gif', matches: (b) => b.length > 5 && b.toString('ascii', 0, 3) === 'GIF' && (b.toString('ascii', 3, 6) === '87a' || b.toString('ascii', 3, 6) === '89a') },
];

// Kept small on purpose: this text is inlined directly into the bounded
// chat context (default num_ctx is 4096 tokens total, shared with the
// system prompt, personalized context, and conversation history) — a much
// larger cap would silently crowd out everything else in a small model's
// context window rather than fail loudly.
const MAX_TEXT_CHARS = 4_000;
const MAX_FILENAME_LENGTH = 200;

function sanitizeFilename(raw: string): string {
  // Display-only (never used as a real filesystem path — content lives in
  // MySQL) — still strip control characters and cap length before it's ever
  // persisted or shown back to the user.
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, MAX_FILENAME_LENGTH) || 'file';
}

export async function validateUpload(filename: string, dataBase64: string): Promise<ValidatedUpload> {
  const aiCfg = await getLearnAiConfig();
  if (!aiCfg.uploadsEnabled) {
    throw new ValidationError('File uploads are currently disabled');
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(dataBase64, 'base64');
  } catch {
    throw new ValidationError('Invalid file data');
  }
  if (buffer.length === 0) {
    throw new ValidationError('File is empty');
  }
  // Checked against the real decoded byte length, not whatever size the
  // client's request metadata claims.
  if (buffer.length > aiCfg.uploadMaxBytes) {
    throw new ValidationError(`File exceeds the ${Math.floor(aiCfg.uploadMaxBytes / 1024)}KB limit`);
  }

  const image = IMAGE_SIGNATURES.find((signature) => signature.matches(buffer));
  if (image) {
    return { kind: 'image', mimeType: image.mime, byteSize: buffer.length, content: buffer.toString('base64') };
  }

  // Not a recognized image signature. Accept only content that is plausibly
  // plain text — reject anything with NUL bytes or other control characters
  // in its first slice, which real UTF-8 prose never contains, rather than
  // guessing from the extension. This blocks arbitrary binaries (executables,
  // archives, unsupported document formats) from being silently accepted as
  // "text" and echoed back into a model prompt.
  const text = buffer.toString('utf8');
  const sampleForBinaryCheck = text.slice(0, 4_000);
  // eslint-disable-next-line no-control-regex
  const looksBinary = /[\x00-\x08\x0e-\x1f]/.test(sampleForBinaryCheck);
  if (looksBinary) {
    throw new ValidationError('Unsupported file type — only images and plain text are accepted');
  }
  if (text.length > MAX_TEXT_CHARS) {
    throw new ValidationError(`Text file exceeds ${MAX_TEXT_CHARS} characters`);
  }

  return { kind: 'text', mimeType: 'text/plain', byteSize: buffer.length, content: text };
}

export { sanitizeFilename };
