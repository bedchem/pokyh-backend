import { readFile, rename, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { prisma } from '../db';
import { config } from '../config';
import { logger } from '../utils/logger';
import { listBackups, restoreBackupAtBoot } from './dbBackup';
import { downloadNewestOffsiteBackup, offsiteConfigured } from './offsite';

// ─── Rebuilding a lost database by itself ──────────────────────────────────────
//
// A database volume can be lost (a broken disk, a removed volume, a failed
// MySQL upgrade that left an empty data directory). The server notices it at
// start: the database has no tables at all, although this node knew data
// before — its backups volume has backups, or the state file the server
// writes there whenever the database has data. It then restores the newest
// backup that reads back completely, before anything else touches the
// database, and continues as usual. In a cluster the other nodes then bring
// the rows that changed since that backup (the regular self-check repairs
// every difference).
//
// The empty-database signal is deliberately strict: a database with its
// tables but few rows (a school year that just rolled over, say) is never
// "lost". DB_AUTO_RESTORE=off switches the behaviour off, for example to
// start over with an empty database on purpose.

const STATE_FILE = 'database-state.json';

interface DataState {
  database: string;
  tables: number;
  users: number;
  at: string;
}

const databaseName = () => {
  try {
    return new URL(config.databaseUrl).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
};

async function readState(): Promise<DataState | null> {
  try {
    const state = JSON.parse(await readFile(path.join(config.backupDir, STATE_FILE), 'utf8')) as DataState;
    return state.database === databaseName() ? state : null;
  } catch {
    return null;
  }
}

/** Notes on the backups volume that this database holds data (counts only, no content). */
export async function rememberDataPresent(): Promise<void> {
  try {
    const [tables, users] = await Promise.all([countTables(), prisma.user.count()]);
    if (!tables) return;
    await mkdir(config.backupDir, { recursive: true });
    const file = path.join(config.backupDir, STATE_FILE);
    const state: DataState = { database: databaseName(), tables, users, at: new Date().toISOString() };
    await writeFile(`${file}.tmp`, JSON.stringify(state));
    await rename(`${file}.tmp`, file);
  } catch {
    // Only a hint for the next start; never worth failing over.
  }
}

async function countTables(): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint | number }>>(
    'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()',
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Before the schema is applied: true when the database is missing or has no
 * tables, false when it has tables, null when that cannot be told (the
 * database server is not reachable yet).
 */
export async function databaseIsEmpty(): Promise<boolean | null> {
  try {
    return (await countTables()) === 0;
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    // Prisma P1003 / MySQL 1049: the database itself does not exist.
    if (/P1003|does not exist|Unknown database|1049/i.test(text)) return true;
    return null;
  }
}

/**
 * After the schema was applied to a database that was empty before: restores
 * the newest usable backup when this node held data before. True when it did.
 */
export async function healLostDatabase(): Promise<boolean> {
  const mode = config.dbAutoRestore;
  if (mode === 'off') return false;

  const state = await readState();
  const local = await listBackups().catch(() => []);
  const hadData = (state?.users ?? 0) > 0 || (state?.tables ?? 0) > 0 || local.length > 0;
  if (!hadData && mode !== 'offsite') return false;

  logger.error('The database is empty although this node had data: restoring the newest backup', {
    action: 'db_heal_started',
    knownAt: state?.at ?? null,
    localBackups: local.length,
  });

  // Newest first; a backup that does not read back completely is skipped.
  for (const backup of local) {
    try {
      await restoreBackupAtBoot(backup.filename);
      logger.warn('Database rebuilt from the newest local backup', { action: 'db_heal_restored', filename: backup.filename, source: 'local' });
      return true;
    } catch (err) {
      logger.error('Backup could not be restored; trying an older one', {
        action: 'db_heal_backup_failed', filename: backup.filename, message: err instanceof Error ? err.message.split('\n')[0] : String(err),
      });
    }
  }

  if (offsiteConfigured()) {
    try {
      const filename = await downloadNewestOffsiteBackup();
      if (filename) {
        await restoreBackupAtBoot(filename);
        logger.warn('Database rebuilt from the newest off-site backup', { action: 'db_heal_restored', filename, source: 'offsite' });
        return true;
      }
    } catch (err) {
      logger.error('Off-site backup could not be restored', { action: 'db_heal_offsite_failed', message: err instanceof Error ? err.message.split('\n')[0] : String(err) });
    }
  }

  if (hadData) {
    logger.error('The database is empty and no backup could be restored. Restore one by hand (admin panel → Backups) before using the server.', { action: 'db_heal_impossible' });
  }
  return false;
}
