import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'fs/promises';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';

// ─── Off-site copies of the backups ────────────────────────────────────────────
//
// The backups volume lives on the same host as the database, so a lost host
// would take both. Every finished backup file (the panel's dumps and the
// point-in-time recovery files of the db-archiver service, BACKUP_DIR/pitr) is
// therefore also kept in an S3-compatible bucket (Backblaze B2, Cloudflare R2,
// Hetzner, Wasabi, MinIO, AWS …), encrypted on this server before it leaves:
// AES-256-GCM under BACKUP_ENCRYPTION_KEY. The storage provider only ever
// holds ciphertext. Without the key nothing can be restored, so it must be
// kept somewhere else too (a password manager).
//
// File format: "PKYB1\n" | 12-byte nonce | ciphertext | 16-byte tag.
// scripts/decrypt-backup.js turns a downloaded file back into the original.
//
// Off unless BACKUP_S3_BUCKET and BACKUP_ENCRYPTION_KEY are set.

const MAGIC = Buffer.from('PKYB1\n');
const INDEX_FILE = '.offsite-uploaded.json';

export function offsiteConfigured(): boolean {
  const o = config.offsite;
  return Boolean(o.endpoint && o.bucket && o.accessKeyId && o.secretAccessKey && o.encryptionKey);
}

// ─── Encryption ────────────────────────────────────────────────────────────────

function encryptionKey(): Buffer {
  return createHash('sha256').update(`${config.offsite.encryptionKey}:pokyh-offsite-backup`).digest();
}

export function encryptBackup(plain: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  return Buffer.concat([MAGIC, iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

export function decryptBackup(sealed: Buffer): Buffer {
  if (sealed.length < MAGIC.length + 12 + 16 || !sealed.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('not an encrypted Pokyh backup');
  }
  const iv = sealed.subarray(MAGIC.length, MAGIC.length + 12);
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([decipher.update(sealed.subarray(MAGIC.length + 12, sealed.length - 16)), decipher.final()]);
}

// ─── S3 (Signature Version 4) ──────────────────────────────────────────────────

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();

// RFC 3986 encoding as S3 expects it in canonical requests.
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

interface S3Request {
  method: 'GET' | 'PUT' | 'DELETE';
  key?: string;
  query?: Record<string, string>;
  body?: Buffer;
}

async function s3(req: S3Request): Promise<globalThis.Response> {
  const o = config.offsite;
  const endpoint = new URL(o.endpoint);
  const objectPath = req.key ? `/${req.key.split('/').map(encode).join('/')}` : '';
  const host = o.forcePathStyle ? endpoint.host : `${o.bucket}.${endpoint.host}`;
  const canonicalUri = o.forcePathStyle ? `/${encode(o.bucket)}${objectPath}` : objectPath || '/';
  const query = Object.entries(req.query ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encode(k)}=${encode(v)}`)
    .join('&');

  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const payloadHash = sha256(req.body ?? '');
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [req.method, canonicalUri, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${day}/${o.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${o.secretAccessKey}`, day), o.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  return fetch(`${endpoint.protocol}//${host}${canonicalUri}${query ? `?${query}` : ''}`, {
    method: req.method,
    headers: {
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      Authorization: `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body: req.body,
    signal: AbortSignal.timeout(10 * 60_000),
  });
}

async function ensureOk(res: globalThis.Response, what: string): Promise<void> {
  if (res.ok) return;
  // The provider's error body names the bucket and the request; only the code is kept.
  const body = await res.text().catch(() => '');
  const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1] ?? '';
  throw new Error(`${what} failed: HTTP ${res.status}${code ? ` ${code}` : ''}`);
}

export interface OffsiteObject {
  key: string;
  size: number;
  lastModified: Date;
}

async function listObjects(prefix: string): Promise<OffsiteObject[]> {
  const out: OffsiteObject[] = [];
  let token: string | undefined;
  do {
    const res = await s3({ method: 'GET', query: { 'list-type': '2', prefix, ...(token ? { 'continuation-token': token } : {}) } });
    await ensureOk(res, 'listing the backup bucket');
    const xml = await res.text();
    for (const block of xml.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? []) {
      const key = /<Key>([\s\S]*?)<\/Key>/.exec(block)?.[1];
      if (!key) continue;
      out.push({
        key: key.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"),
        size: Number(/<Size>(\d+)<\/Size>/.exec(block)?.[1] ?? 0),
        lastModified: new Date(/<LastModified>([^<]+)<\/LastModified>/.exec(block)?.[1] ?? 0),
      });
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] : undefined;
  } while (token);
  return out;
}

// Every node keeps its copies under its own name (CLUSTER_NODE_NAME, or
// "main" for a single server): two nodes never overwrite each other.
function nodePrefix(): string {
  const node = (process.env.CLUSTER_NODE_NAME ?? '').trim().replace(/[^A-Za-z0-9._-]/g, '-') || 'main';
  return `${config.offsite.prefix.replace(/\/+$/, '')}/${node}`;
}

// ─── Upload ────────────────────────────────────────────────────────────────────

type UploadIndex = Record<string, { size: number; mtimeMs: number }>;

async function readIndex(): Promise<UploadIndex> {
  try {
    return JSON.parse(await readFile(path.join(config.backupDir, INDEX_FILE), 'utf8')) as UploadIndex;
  } catch {
    return {};
  }
}

async function writeIndex(index: UploadIndex): Promise<void> {
  const file = path.join(config.backupDir, INDEX_FILE);
  await writeFile(`${file}.tmp`, JSON.stringify(index));
  await rename(`${file}.tmp`, file);
}

// The finished files that belong off-site, relative to BACKUP_DIR: the
// panel's dumps (with their manifests) and the archiver's base dumps and
// closed binary logs. Unfinished files (.part, .tmp) are never taken.
async function localCandidates(): Promise<string[]> {
  const found: string[] = [];
  const take = async (dir: string, pattern: RegExp) => {
    const names = await readdir(path.join(config.backupDir, dir)).catch(() => [] as string[]);
    for (const name of names) if (pattern.test(name)) found.push(dir ? `${dir}/${name}` : name);
  };
  await take('', /^pokyh-backup-[\dT-]+Z\.sql\.gz(\.json)?$/);
  await take('pitr/base', /^base-[\dT-]+Z\.sql\.gz$/);
  await take('pitr/binlog', /^binlog\.\d{6,}$/);
  return found;
}

let syncing: Promise<void> | null = null;

/** Uploads every finished backup file not uploaded yet, then prunes old copies. Never throws. */
export function syncOffsite(): Promise<void> {
  if (!offsiteConfigured()) return Promise.resolve();
  syncing ??= runSync().finally(() => { syncing = null; });
  return syncing;
}

async function runSync(): Promise<void> {
  try {
    const index = await readIndex();
    let uploaded = 0;
    for (const relative of await localCandidates()) {
      const full = path.join(config.backupDir, relative);
      const info = await stat(full).catch(() => null);
      if (!info) continue;
      const known = index[relative];
      if (known && known.size === info.size && known.mtimeMs === info.mtimeMs) continue;
      if (info.size > config.offsite.maxFileBytes) {
        logger.warn('Backup file too large for the off-site copy; skipped', { action: 'offsite_skipped', file: relative, sizeBytes: info.size });
        continue;
      }
      const res = await s3({ method: 'PUT', key: `${nodePrefix()}/${relative}.enc`, body: encryptBackup(await readFile(full)) });
      await ensureOk(res, `uploading ${relative}`);
      index[relative] = { size: info.size, mtimeMs: info.mtimeMs };
      await writeIndex(index);
      uploaded++;
    }
    // Files gone locally (pruned by retention) leave the index too.
    const present = new Set(await localCandidates());
    let changed = false;
    for (const relative of Object.keys(index)) {
      if (!present.has(relative)) { delete index[relative]; changed = true; }
    }
    if (changed) await writeIndex(index);
    const pruned = await pruneOffsite();
    if (uploaded || pruned) logger.info('Off-site backup copies updated', { action: 'offsite_synced', uploaded, pruned });
  } catch (err) {
    logger.error('Off-site backup copy failed', { action: 'offsite_failed', message: err instanceof Error ? err.message : String(err) });
  }
}

// Copies older than BACKUP_OFFSITE_RETENTION_DAYS go; the newest dump always stays.
async function pruneOffsite(): Promise<number> {
  const objects = await listObjects(`${nodePrefix()}/`);
  const cutoff = Date.now() - config.offsite.retentionDays * 24 * 60 * 60 * 1000;
  const dumps = objects.filter((o) => /\/pokyh-backup-[^/]+\.sql\.gz\.enc$/.test(o.key)).sort((a, b) => b.key.localeCompare(a.key));
  const keep = new Set(dumps.slice(0, 1).map((o) => o.key));
  let pruned = 0;
  for (const object of objects) {
    if (keep.has(object.key) || object.lastModified.getTime() >= cutoff) continue;
    const res = await s3({ method: 'DELETE', key: object.key });
    if (res.ok || res.status === 404) pruned++;
  }
  return pruned;
}

// ─── Download ──────────────────────────────────────────────────────────────────

/**
 * Fetches the newest off-site dump of this node into BACKUP_DIR (decrypted,
 * under its original name) and returns that name, or null when there is none.
 */
export async function downloadNewestOffsiteBackup(): Promise<string | null> {
  if (!offsiteConfigured()) return null;
  const dumps = (await listObjects(`${nodePrefix()}/`))
    .filter((o) => /\/pokyh-backup-[\dT-]+Z\.sql\.gz\.enc$/.test(o.key))
    .sort((a, b) => b.key.localeCompare(a.key));
  const newest = dumps[0];
  if (!newest) return null;
  const res = await s3({ method: 'GET', key: newest.key });
  await ensureOk(res, 'downloading the newest backup');
  const plain = decryptBackup(Buffer.from(await res.arrayBuffer()));
  const filename = newest.key.slice(newest.key.lastIndexOf('/') + 1).replace(/\.enc$/, '');
  await mkdir(config.backupDir, { recursive: true });
  const target = path.join(config.backupDir, filename);
  await writeFile(`${target}.part`, plain);
  await rename(`${target}.part`, target);
  logger.warn('Newest off-site backup downloaded', { action: 'offsite_downloaded', filename });
  return filename;
}

export function startOffsiteSync(): void {
  if (!offsiteConfigured()) {
    if (config.offsite.bucket || config.offsite.encryptionKey) {
      logger.warn('Off-site backups are incomplete: BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY and BACKUP_ENCRYPTION_KEY are all needed');
    }
    return;
  }
  setTimeout(() => void syncOffsite(), 60_000);
  setInterval(() => void syncOffsite(), config.offsite.syncIntervalMinutes * 60_000);
}
