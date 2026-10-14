import { brotliCompress, brotliDecompress, constants } from 'zlib';
import { promisify } from 'util';

// How a call's content is laid out before it is sealed: compressed when that
// pays off, and padded to a fixed set of sizes. No dependency on the network
// or the database, so it is tested on its own (tests/clusterFraming).
//
//   [codec: 1 byte][length: 4 bytes][content][zero padding]
//
// Compression makes a package of hundreds of changes small, so a batch costs
// one short request instead of many. Because compressed size depends on the
// content, it could hint at what a package contains even though it is
// encrypted; rounding every package up to the next size step leaves an
// observer little more than "small, medium or large".

const CODEC_RAW = 0;
const CODEC_BROTLI = 1;
const HEADER_BYTES = 5;
// Below this, compressing costs more than it saves.
const COMPRESS_FROM_BYTES = 1024;
const MIN_PADDED_BYTES = 1024;
const LARGE_STEP_BYTES = 64 * 1024;

const compress = promisify(brotliCompress);
const decompress = promisify(brotliDecompress);

// Powers of two up to 64 KiB, then whole multiples of 64 KiB.
export function paddedSize(bytes: number): number {
  if (bytes <= MIN_PADDED_BYTES) return MIN_PADDED_BYTES;
  if (bytes <= LARGE_STEP_BYTES) return 2 ** Math.ceil(Math.log2(bytes));
  return Math.ceil(bytes / LARGE_STEP_BYTES) * LARGE_STEP_BYTES;
}

export async function packPayload(plaintext: Buffer): Promise<Buffer> {
  let codec = CODEC_RAW;
  let body = plaintext;
  if (plaintext.length >= COMPRESS_FROM_BYTES) {
    const compressed = await compress(plaintext, {
      params: {
        // A middle quality: most of the gain at a fraction of the CPU time.
        [constants.BROTLI_PARAM_QUALITY]: 5,
        [constants.BROTLI_PARAM_SIZE_HINT]: plaintext.length,
      },
    });
    if (compressed.length < plaintext.length) {
      codec = CODEC_BROTLI;
      body = compressed;
    }
  }
  const out = Buffer.alloc(paddedSize(HEADER_BYTES + body.length));
  out.writeUInt8(codec, 0);
  out.writeUInt32BE(body.length, 1);
  body.copy(out, HEADER_BYTES);
  return out;
}

// `maxBytes` bounds the unpacked size, so a hostile package cannot expand into
// gigabytes (a decompression bomb) — it is refused instead.
export async function unpackPayload(packed: Buffer, maxBytes: number): Promise<Buffer> {
  if (packed.length < HEADER_BYTES) throw new Error('package is too short');
  const codec = packed.readUInt8(0);
  const length = packed.readUInt32BE(1);
  if (length > packed.length - HEADER_BYTES) throw new Error('package length is inconsistent');
  const body = packed.subarray(HEADER_BYTES, HEADER_BYTES + length);
  if (codec === CODEC_RAW) {
    if (body.length > maxBytes) throw new Error('package exceeds the size limit');
    return body;
  }
  if (codec === CODEC_BROTLI) {
    return decompress(body, { maxOutputLength: maxBytes });
  }
  throw new Error('package uses an unknown encoding');
}
