import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'fs/promises';
import path from 'path';
import { pipeline, Writable } from 'stream';
import { createGunzip, createGzip } from 'zlib';
import { prisma } from '../db';
import { config } from '../config';
import { logger } from '../utils/logger';
import { runDatabaseRestore } from '../cluster/hooks';
import { buildInfo } from '../cluster/version';
import { invalidateAllCaches } from './cache';
import { rememberDataPresent } from './dbHeal';
import { syncOffsite } from './offsite';
import { applyAdditiveSchema } from './schemaSync';

// Alpine's mariadb-client (the mysqldump/mysql binaries available in this
// image) doesn't ship the caching_sha2_password plugin that MySQL 8 uses by
// default — connecting with it fails with "Plugin caching_sha2_password
// could not be loaded" (verified locally against mysql:8.0.40). Rather than
// weaken the server's default auth plugin (which the main app connection also
// relies on) or hand mysqldump the root credentials, ensure a dedicated,
// scoped-to-this-database backup/restore account exists, explicitly using the
// universally-supported mysql_native_password plugin. Its password is derived
// deterministically from JWT_SECRET (already a real secret, never itself
// exposed) so nothing new needs to be generated, stored, or copied anywhere;
// re-running this is idempotent and self-corrects if JWT_SECRET ever rotates.
const BACKUP_DB_USER = 'pokyh_backup';

function backupUserPassword(): string {
  return createHash('sha256').update(`${config.jwtSecret}:pokyh-backup-user`).digest('hex');
}

// ensureBackupUser is DDL (CREATE/ALTER USER + GRANT + FLUSH PRIVILEGES) run
// against a shared account name. Two overlapping invocations (e.g. the
// scheduler's check firing at the same time as a manual "run now" click)
// interleave their ALTER USER / FLUSH PRIVILEGES statements across two
// separate connections, which can leave the account's auth state briefly
// inconsistent — reproduced locally as "Access denied" on the very next
// mysqldump despite the password being byte-identical every time. Since the
// password is deterministic (derived from JWT_SECRET) and never changes
// without a restart, there is no need to repeat this DDL at all: run it once
// per process lifetime, and serialize concurrent first-callers on the same
// in-flight promise so they can never race each other.
let ensureBackupUserOnce: Promise<void> | null = null;

async function ensureBackupUser(database: string): Promise<void> {
  if (!ensureBackupUserOnce) {
    ensureBackupUserOnce = (async () => {
      const password = backupUserPassword();
      const escapedPassword = password.replace(/'/g, "''");
      const statements = [
        `CREATE USER IF NOT EXISTS '${BACKUP_DB_USER}'@'%' IDENTIFIED WITH mysql_native_password BY '${escapedPassword}'`,
        `ALTER USER '${BACKUP_DB_USER}'@'%' IDENTIFIED WITH mysql_native_password BY '${escapedPassword}'`,
        // Scoped to this one database only — never global/SUPER privileges.
        // Full DML/DDL is required so a restore (DROP/CREATE/INSERT from the
        // dump file) works, not just SELECT.
        `GRANT ALL PRIVILEGES ON \`${database}\`.* TO '${BACKUP_DB_USER}'@'%'`,
        'FLUSH PRIVILEGES',
      ];
      for (const statement of statements) {
        await prisma.$executeRawUnsafe(statement);
      }
    })().catch((err) => {
      // Let a failed attempt be retried by a later call instead of
      // permanently wedging every future backup.
      ensureBackupUserOnce = null;
      throw err;
    });
  }
  await ensureBackupUserOnce;
}

// ─── Configuration (DB-backed, env-default fallback) ─────────────────────────

export interface BackupConfigValues {
  enabled: boolean;
  scheduleHour: number;
  retentionDays: number;
  lastRunAt: Date | null;
  lastRunStatus: string | null;
}

const SINGLETON_ID = 1;

export async function getBackupConfig(): Promise<BackupConfigValues> {
  const row = await prisma.backupConfig.findUnique({ where: { id: SINGLETON_ID } });
  return {
    enabled: row?.enabled ?? config.backupEnabled,
    scheduleHour: row?.scheduleHour ?? config.backupScheduleHour,
    retentionDays: row?.retentionDays ?? config.backupRetentionDays,
    lastRunAt: row?.lastRunAt ?? null,
    lastRunStatus: row?.lastRunStatus ?? null,
  };
}

export async function updateBackupConfig(
  partial: Partial<Pick<BackupConfigValues, 'enabled' | 'scheduleHour' | 'retentionDays'>>,
  updatedBy: string,
): Promise<void> {
  await prisma.backupConfig.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID, ...partial, updatedBy },
    update: { ...partial, updatedBy },
  });
}

async function recordRunResult(status: 'ok' | 'error'): Promise<void> {
  await prisma.backupConfig.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID, lastRunAt: new Date(), lastRunStatus: status },
    update: { lastRunAt: new Date(), lastRunStatus: status },
  }).catch(() => { /* non-fatal — the backup file itself is what matters */ });
}

// ─── Filesystem-based backup listing ──────────────────────────────────────────
// Backups are not tracked in a DB table (that would need to survive the very
// database it describes); the timestamp-stamped filename is the record.

const FILENAME_PATTERN = /^pokyh-backup-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)\.sql\.gz$/;

export interface BackupFile {
  filename: string;
  createdAt: string;
  sizeBytes: number;
}

export async function listBackups(): Promise<BackupFile[]> {
  await mkdir(config.backupDir, { recursive: true });
  const entries = await readdir(config.backupDir).catch(() => [] as string[]);
  const files = await Promise.all(
    entries
      .filter((name) => FILENAME_PATTERN.test(name))
      .map(async (filename) => {
        const stats = await stat(path.join(config.backupDir, filename)).catch(() => null);
        const match = FILENAME_PATTERN.exec(filename)!;
        return {
          filename,
          createdAt: match[1]!.replace(/T(\d{2})-(\d{2})-(\d{2})Z$/, 'T$1:$2:$3Z'),
          sizeBytes: stats?.size ?? 0,
        };
      }),
  );
  return files.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// Resolves a backup filename to an absolute path, rejecting anything that
// isn't an exact match for our own generated pattern — this is the only guard
// between a client-supplied filename and the filesystem (download/delete).
export function resolveBackupPath(filename: string): string | null {
  if (!FILENAME_PATTERN.test(filename)) return null;
  return path.join(config.backupDir, filename);
}

// ─── Running a backup ──────────────────────────────────────────────────────────

function dbConnectionFromUrl(databaseUrl: string) {
  const parsed = new URL(databaseUrl);
  return {
    host: parsed.hostname,
    port: parsed.port || '3306',
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ''),
  };
}

// Ensures the dedicated backup/restore account exists, then returns
// connection details for it (same host/port/database as the app's own
// connection, different, mysql_native_password-authenticated credentials).
async function backupConnection() {
  const primary = dbConnectionFromUrl(config.databaseUrl);
  await ensureBackupUser(primary.database);
  return { ...primary, user: BACKUP_DB_USER, password: backupUserPassword() };
}

function timestampForFilename(date: Date): string {
  return date.toISOString().replace(/:/g, '-').replace(/\.\d{3}Z$/, 'Z');
}

// Serializes all backup runs. Two mysqldumps racing each other (a scheduled
// run overlapping a manual "run now" click, or a double click) would collide
// on the same second-resolution filename and clobber each other's `.part`
// file — and running two full dumps against the same database at once is
// pointless anyway. A later caller simply waits for and receives the result
// of the run already in flight rather than starting a redundant second one.
let runBackupQueue: Promise<{ filename: string; sizeBytes: number }> = Promise.resolve({ filename: '', sizeBytes: 0 });

export function runBackup(trigger: 'scheduled' | 'manual'): Promise<{ filename: string; sizeBytes: number }> {
  const next = runBackupQueue.catch(() => undefined).then(() => runBackupInternal(trigger));
  runBackupQueue = next;
  return next;
}

// Runs `mysqldump | gzip` and writes to a `.part` file first, renaming to the
// final name only on success — a reader (listBackups, download, restore) can
// never observe a truncated/in-progress backup.
async function runBackupInternal(trigger: 'scheduled' | 'manual'): Promise<{ filename: string; sizeBytes: number }> {
  await mkdir(config.backupDir, { recursive: true });
  const conn = await backupConnection();
  const filename = `pokyh-backup-${timestampForFilename(new Date())}.sql.gz`;
  const finalPath = path.join(config.backupDir, filename);
  const partPath = `${finalPath}.part`;

  logger.info('Database backup started', { action: 'db_backup_started', trigger });

  try {
    await new Promise<void>((resolve, reject) => {
      // No table list is passed after `conn.database`, so mysqldump dumps
      // every table in the database — the full data set, not a curated
      // subset. This deliberately includes ArchivedUser/ArchivedClass/
      // ArchivedTodo/ArchivedReminder (the school-year rollover archive
      // tables) and every other table: there is no separate archive
      // database and nothing here filters tables out. Keep it that way —
      // a future change that adds a table-name argument would silently
      // turn this into a partial backup.
      //
      // Triggers are deliberately left out. The only triggers this database
      // can contain are the cluster change-capture triggers, which the
      // application regenerates itself; dumping them would make a restore
      // fail on their DEFINER, because the scoped backup account may not
      // create objects on behalf of another account.
      const dump = spawn('mysqldump', [
        '--single-transaction',
        '--routines',
        '--skip-triggers',
        '--events',
        '--host', conn.host,
        '--port', conn.port,
        '--user', conn.user,
        conn.database,
      ], {
        // MYSQL_PWD (not a -p CLI argument) keeps the password out of `ps`
        // output and any process-argument logging.
        env: { ...process.env, MYSQL_PWD: conn.password },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';
      dump.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      // The backup is complete only when BOTH hold: mysqldump exited with
      // code 0, and every byte it produced has been flushed to disk. Either
      // event can arrive first, so neither may declare success on its own —
      // otherwise a dump that dies part-way could be kept as a good backup.
      let exitCode: number | null | undefined;
      let written = false;
      let settled = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (err) reject(err); else resolve();
      };
      const settleWhenComplete = () => {
        if (exitCode === 0 && written) settle();
      };

      dump.on('error', (err) => settle(new Error(`mysqldump could not start: ${err.message}`)));
      dump.on('close', (code) => {
        exitCode = code;
        if (code !== 0) {
          settle(new Error(`mysqldump exited with code ${code}: ${stderr.slice(0, 500)}`));
          return;
        }
        settleWhenComplete();
      });
      pipeline(dump.stdout, createGzip(), createWriteStream(partPath), (err) => {
        if (err) {
          settle(new Error(`backup write failed: ${err.message}`));
          return;
        }
        written = true;
        settleWhenComplete();
      });
    });

    await rename(partPath, finalPath);
    const stats = await stat(finalPath);
    await writeManifest(finalPath, filename, trigger, stats.size);
    logger.info('Database backup completed', { action: 'db_backup_completed', trigger, filename, sizeBytes: stats.size });
    await recordRunResult('ok');
    await pruneOldBackups();
    await rememberDataPresent();
    void syncOffsite();
    return { filename, sizeBytes: stats.size };
  } catch (err) {
    await unlink(partPath).catch(() => {});
    logger.error('Database backup failed', { action: 'db_backup_failed', trigger, message: err instanceof Error ? err.message : String(err) });
    await recordRunResult('error');
    throw err;
  }
}

// Every dump gets a manifest next to it (<file>.json): its SHA-256, size, the
// build and when it was made. A restore checks the file against it first, so
// a damaged or swapped file is never loaded. Dumps from before manifests
// existed are checked by reading them back only.
interface BackupManifest {
  filename: string;
  sha256: string;
  sizeBytes: number;
  createdAt: string;
  trigger: string;
  commit: string;
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

async function writeManifest(filePath: string, filename: string, trigger: string, sizeBytes: number): Promise<void> {
  try {
    const manifest: BackupManifest = {
      filename,
      sha256: await sha256File(filePath),
      sizeBytes,
      createdAt: new Date().toISOString(),
      trigger,
      commit: buildInfo().commit,
    };
    await writeFile(`${filePath}.json`, JSON.stringify(manifest, null, 2));
  } catch (err) {
    logger.warn('Backup manifest could not be written', { action: 'db_backup_manifest_failed', filename, message: err instanceof Error ? err.message : String(err) });
  }
}

async function verifyManifest(filePath: string): Promise<void> {
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(await readFile(`${filePath}.json`, 'utf8')) as BackupManifest;
  } catch {
    return;
  }
  if (manifest.sha256 && (await sha256File(filePath)) !== manifest.sha256) {
    throw new Error('backup file does not match its manifest (damaged or replaced)');
  }
}

export async function pruneOldBackups(): Promise<number> {
  const { retentionDays } = await getBackupConfig();
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const backups = await listBackups();
  let pruned = 0;
  for (const backup of backups) {
    if (new Date(backup.createdAt).getTime() >= cutoff) continue;
    const filePath = resolveBackupPath(backup.filename);
    if (!filePath) continue;
    await unlink(filePath).catch(() => {});
    await unlink(`${filePath}.json`).catch(() => {});
    pruned++;
  }
  // Manifests whose dump is gone (deleted in the panel) go as well.
  const names = await readdir(config.backupDir).catch(() => [] as string[]);
  const dumps = new Set(names.filter((name) => FILENAME_PATTERN.test(name)));
  for (const name of names) {
    if (name.endsWith('.sql.gz.json') && !dumps.has(name.slice(0, -'.json'.length))) await unlink(path.join(config.backupDir, name)).catch(() => {});
  }
  if (pruned > 0) {
    logger.info('Database backup retention pruning', { action: 'db_backup_pruned', pruned, retentionDays });
  }
  return pruned;
}

// ─── Restoring a backup (manual, admin-triggered only) ─────────────────────────
// Deliberately not wired to any scheduled path — restoring overwrites the live
// database and must always be a deliberate, single admin action.

// Reads a backup file to its end through gunzip without using the output.
// A truncated or corrupt archive fails here, before a single statement has
// been sent to the database.
function verifyBackupArchive(filePath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const discard = new Writable({ write(_chunk, _encoding, done) { done(); } });
    pipeline(createReadStream(filePath), createGunzip(), discard, (err) => {
      if (err) reject(new Error(`backup file is unreadable or corrupt: ${err.message}`));
      else resolve();
    });
  });
}

async function restoreBackupInternal(filename: string, filePath: string): Promise<void> {
  const conn = await backupConnection();

  await new Promise<void>((resolve, reject) => {
    const restore = spawn('mysql', [
      '--host', conn.host,
      '--port', conn.port,
      '--user', conn.user,
      conn.database,
    ], {
      env: { ...process.env, MYSQL_PWD: conn.password },
      stdio: ['pipe', 'ignore', 'pipe'],
    });

    let stderr = '';
    restore.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    let settled = false;
    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve();
    };
    let inputError: Error | null = null;

    restore.on('error', (err) => settle(new Error(`mysql could not start: ${err.message}`)));
    restore.on('close', (code) => {
      if (code === 0 && !inputError) {
        settle();
        return;
      }
      settle(new Error(
        code === 0 && inputError
          ? `backup file could not be read completely: ${inputError.message}`
          : `mysql restore exited with code ${code}: ${stderr.slice(0, 500)}`,
      ));
    });

    // Every stream in the chain gets an error handler through pipeline(): a
    // read error, a gunzip error, or mysql closing its input early (EPIPE)
    // must surface as a failed restore, never as an uncaught exception.
    pipeline(createReadStream(filePath), createGunzip(), restore.stdin, (err) => {
      if (!err) return;
      inputError = err;
      restore.stdin.destroy();
    });
  });

  logger.info('Database backup restored', { action: 'db_backup_restored', filename });
}

// After a restore the tables are as old as the dump: columns added since are
// put back (additively, nothing is dropped) and every cached answer goes.
async function afterRestore(): Promise<void> {
  await invalidateAllCaches();
  try {
    await applyAdditiveSchema();
  } catch (err) {
    logger.warn('Schema sync after the restore failed; it runs again at the next start', { action: 'db_restore_schema_sync_failed', message: err instanceof Error ? err.message.split('\n')[0] : String(err) });
  }
  await invalidateAllCaches();
}

export async function restoreBackup(filename: string): Promise<void> {
  const filePath = resolveBackupPath(filename);
  if (!filePath) throw new Error('Invalid backup filename');
  await verifyManifest(filePath);
  await verifyBackupArchive(filePath);
  await runDatabaseRestore(() => restoreBackupInternal(filename, filePath));
  await afterRestore();
}

/**
 * The start-up rebuild of a lost database (services/dbHeal.ts): the same
 * checks and restore, before the cluster layer runs. The schema is applied
 * by the start-up sequence right after.
 */
export async function restoreBackupAtBoot(filename: string): Promise<void> {
  const filePath = resolveBackupPath(filename);
  if (!filePath) throw new Error('Invalid backup filename');
  await verifyManifest(filePath);
  await verifyBackupArchive(filePath);
  await restoreBackupInternal(filename, filePath);
  await invalidateAllCaches();
}

// ─── Scheduling ────────────────────────────────────────────────────────────────
// Checked hourly (config.backupCheckIntervalMs); runs once per UTC calendar
// day at/after the configured hour, tracked via lastRunAt on the singleton row
// so a restart never causes a duplicate same-day run. Only a successful run
// counts as "done for today": a failed one is retried on the next check.

async function checkAndRunScheduled(): Promise<void> {
  const cfg = await getBackupConfig();
  if (!cfg.enabled) return;

  const now = new Date();
  // More than one backup a day: due once the last good one is that old.
  if (config.backupIntervalHours < 24) {
    const due = cfg.lastRunStatus !== 'ok' || !cfg.lastRunAt
      || now.getTime() - cfg.lastRunAt.getTime() >= config.backupIntervalHours * 60 * 60 * 1000 - 60_000;
    if (!due) return;
    try { await runBackup('scheduled'); } catch { /* logged inside; retried at the next check */ }
    return;
  }
  if (now.getUTCHours() < cfg.scheduleHour) return;

  const alreadyRanToday = cfg.lastRunStatus === 'ok'
    && cfg.lastRunAt
    && cfg.lastRunAt.getUTCFullYear() === now.getUTCFullYear()
    && cfg.lastRunAt.getUTCMonth() === now.getUTCMonth()
    && cfg.lastRunAt.getUTCDate() === now.getUTCDate();
  if (alreadyRanToday) return;

  try {
    await runBackup('scheduled');
  } catch {
    // Already logged inside runBackup; the next hourly check will retry.
  }
}

export function startBackupScheduler(): void {
  // The check always runs: whether backups are enabled is decided per check
  // from the admin-editable BackupConfig row (falling back to BACKUP_ENABLED),
  // so enabling them in the admin panel takes effect without a restart.
  if (!config.backupEnabled) {
    logger.info('Scheduled database backups are off by default (BACKUP_ENABLED=false) until enabled in the admin panel');
  }
  setTimeout(() => void checkAndRunScheduled().catch(() => {}), 30_000);
  setInterval(() => void checkAndRunScheduled().catch(() => {}), config.backupCheckIntervalMs);
}
