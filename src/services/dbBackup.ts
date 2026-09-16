import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { mkdir, readdir, rename, stat, unlink } from 'fs/promises';
import path from 'path';
import { createGunzip, createGzip } from 'zlib';
import { prisma } from '../db';
import { config } from '../config';
import { logger } from '../utils/logger';

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

// ─── Configuration (DB-backed, env-default fallback — same pattern as
// src/services/learnConfig.ts) ────────────────────────────────────────────────

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
      const dump = spawn('mysqldump', [
        '--single-transaction',
        '--routines',
        '--triggers',
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

      const gzip = createGzip();
      const out = createWriteStream(partPath);
      dump.stdout.pipe(gzip).pipe(out);

      const fail = (message: string) => reject(new Error(message));
      dump.on('error', (err) => fail(`mysqldump could not start: ${err.message}`));
      out.on('error', (err) => fail(`backup write failed: ${err.message}`));
      out.on('finish', () => {
        if (dump.exitCode === 0 || dump.exitCode === null) resolve();
      });
      dump.on('close', (code) => {
        if (code !== 0) fail(`mysqldump exited with code ${code}: ${stderr.slice(0, 500)}`);
      });
    });

    await rename(partPath, finalPath);
    const stats = await stat(finalPath);
    logger.info('Database backup completed', { action: 'db_backup_completed', trigger, filename, sizeBytes: stats.size });
    await recordRunResult('ok');
    await pruneOldBackups();
    return { filename, sizeBytes: stats.size };
  } catch (err) {
    await unlink(partPath).catch(() => {});
    logger.error('Database backup failed', { action: 'db_backup_failed', trigger, message: err instanceof Error ? err.message : String(err) });
    await recordRunResult('error');
    throw err;
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
    pruned++;
  }
  if (pruned > 0) {
    logger.info('Database backup retention pruning', { action: 'db_backup_pruned', pruned, retentionDays });
  }
  return pruned;
}

// ─── Restoring a backup (manual, admin-triggered only) ─────────────────────────
// Deliberately not wired to any scheduled path — restoring overwrites the live
// database and must always be a deliberate, single admin action.

export async function restoreBackup(filename: string): Promise<void> {
  const filePath = resolveBackupPath(filename);
  if (!filePath) throw new Error('Invalid backup filename');
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

    const source = createReadStream(filePath);
    source.pipe(createGunzip()).pipe(restore.stdin);

    restore.on('error', (err) => reject(new Error(`mysql could not start: ${err.message}`)));
    restore.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`mysql restore exited with code ${code}: ${stderr.slice(0, 500)}`));
    });
  });

  logger.info('Database backup restored', { action: 'db_backup_restored', filename });
}

// ─── Scheduling ────────────────────────────────────────────────────────────────
// Checked hourly (config.backupCheckIntervalMs); runs once per UTC calendar
// day at/after the configured hour, tracked via lastRunAt on the singleton row
// so a restart never causes a duplicate same-day run.

async function checkAndRunScheduled(): Promise<void> {
  const cfg = await getBackupConfig();
  if (!cfg.enabled) return;

  const now = new Date();
  if (now.getUTCHours() < cfg.scheduleHour) return;

  const alreadyRanToday = cfg.lastRunAt
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
  if (!config.backupEnabled) {
    logger.info('Scheduled database backups disabled (BACKUP_ENABLED=false)');
    return;
  }
  setTimeout(() => void checkAndRunScheduled().catch(() => {}), 30_000);
  setInterval(() => void checkAndRunScheduled().catch(() => {}), config.backupCheckIntervalMs);
}
