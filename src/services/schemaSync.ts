import { spawn } from 'child_process';
import { prisma } from '../db';
import { config } from '../config';
import { logger } from '../utils/logger';

// ─── Additive schema reconciliation ────────────────────────────────────────────
//
// `prisma db push` (without --accept-data-loss) is all-or-nothing: if the diff
// between the live database and the schema contains ANY destructive step, Prisma
// refuses the WHOLE push — so purely-additive new tables/columns never get
// created either. On an existing production DB that surfaces as e.g.
// "The table `archived_classes` does not exist in the current database".
//
// This routine asks Prisma to compute the diff (so nothing is hardcoded — the
// DDL is generated from the current schema by the migration engine) and applies
// ONLY the additive statements (CREATE TABLE / CREATE INDEX / ALTER … ADD …).
// Destructive statements (DROP …, MODIFY/CHANGE/RENAME) are never executed, so
// no data can be lost. It is the safe fallback used when `db push` is blocked.

// Run `prisma migrate diff` and return the generated SQL (live DB → schema).
function generateDiffSql(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'npx',
      [
        'prisma', 'migrate', 'diff',
        '--from-url', config.databaseUrl,
        '--to-schema-datamodel', 'prisma/schema.prisma',
        '--script',
      ],
      { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (b: Buffer) => { out += b.toString(); });
    child.stderr.on('data', (b: Buffer) => { err += b.toString(); });
    const timer = setTimeout(() => child.kill('SIGKILL'), config.dbPushTimeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`migrate diff exited ${code}: ${err.trim() || out.trim()}`));
    });
  });
}

// Split a SQL script into individual statements, dropping `-- comments` and
// blank lines. Statements are terminated by a semicolon at end of line, which
// matches the format Prisma's `migrate diff --script` emits.
function splitStatements(sql: string): string[] {
  const noComments = sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
  return noComments
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// A statement is additive (safe) when it only creates objects or adds columns/
// constraints — never drops, modifies or renames existing ones.
function isAdditive(stmt: string): boolean {
  const s = stmt.toUpperCase();
  if (/\b(DROP|MODIFY|CHANGE|RENAME|TRUNCATE)\b/.test(s)) return false;
  if (s.startsWith('CREATE TABLE'))  return true;
  if (s.startsWith('CREATE INDEX'))  return true;
  if (s.startsWith('CREATE UNIQUE')) return true;
  // ALTER TABLE is only allowed when every clause is an ADD (guarded by the
  // destructive check above, so no DROP/MODIFY/CHANGE can slip through here).
  if (s.startsWith('ALTER TABLE') && /\bADD\b/.test(s)) return true;
  return false;
}

// Prisma may combine a safe ADD with destructive clauses in one ALTER TABLE
// statement. The all-or-nothing `isAdditive` check must reject that complete
// statement, but doing so would also strand a newly required nullable column.
// Split only top-level, comma-separated ADD clauses into their own ALTERs;
// every emitted fragment is rechecked by isAdditive before execution. Prisma's
// generated MySQL DDL puts each ALTER clause on its own line, which keeps this
// deliberately narrow parser out of user-provided SQL entirely.
function additiveFragments(stmt: string): string[] {
  if (isAdditive(stmt)) return [stmt];
  const match = stmt.match(/^(ALTER\s+TABLE\s+`[^`]+`)\s+([\s\S]+)$/i);
  if (!match) return [];
  const [, table, clauses] = match;
  return clauses
    .split(/,\s*(?=(?:ADD|DROP|MODIFY|CHANGE|RENAME)\b)/i)
    .filter((clause) => /^ADD\s+/i.test(clause.trim()))
    .map((clause) => `${table} ${clause.trim()}`)
    .filter(isAdditive);
}

// MySQL 8.0.13+ accepts defaults on TEXT/BLOB/JSON columns only in expression
// form — `DEFAULT ('[]')`, not `DEFAULT '[]'`. Prisma's migration engine emits
// the expression form when it pushes, but `migrate diff --script` prints the
// bare literal, which MySQL rejects. Normalise it for the affected types.
function fixTextDefaults(stmt: string): string {
  return stmt.replace(
    /\b(TEXT|TINYTEXT|MEDIUMTEXT|LONGTEXT|JSON|BLOB|TINYBLOB|MEDIUMBLOB|LONGBLOB)([^,\n]*?)\bDEFAULT\s+('(?:[^'\\]|\\.)*')/gi,
    (_m, type, between, literal) => `${type}${between}DEFAULT (${literal})`,
  );
}

// The general Learn AI chat was intentionally retired in favour of the
// vocabulary-only trainer. These are exact, former chat-only tables/columns
// from that feature; they hold no vocabulary, course, enrollment, grant, or
// review state. This one-purpose cleanup is deliberately kept separate from
// the additive reconciler above, which otherwise never executes destructive
// DDL. It is safe to repeat: we inspect the current schema first and issue
// fixed statements only for objects that still exist.
const RETIRED_AI_CHAT_TABLES = [
  'learn_ai_attachments',
  'learn_ai_messages',
  'learn_ai_conversations',
] as const;
const RETIRED_AI_CHAT_CONFIG_COLUMNS = [
  'personalized_context_enabled',
  'upload_max_bytes',
  'uploads_enabled',
] as const;

async function removeRetiredAiChatSchema(): Promise<void> {
  const tables = await prisma.$queryRawUnsafe<Array<{ TABLE_NAME: string }>>(
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('learn_ai_attachments', 'learn_ai_messages', 'learn_ai_conversations')",
  );
  const existingTables = new Set(tables.map((row) => row.TABLE_NAME));
  let removedTables = 0;
  for (const table of RETIRED_AI_CHAT_TABLES) {
    if (!existingTables.has(table)) continue;
    await prisma.$executeRawUnsafe(`DROP TABLE \`${table}\``);
    removedTables++;
  }

  const columns = await prisma.$queryRawUnsafe<Array<{ COLUMN_NAME: string }>>(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'learn_ai_config' AND COLUMN_NAME IN ('personalized_context_enabled', 'upload_max_bytes', 'uploads_enabled')",
  );
  const existingColumns = new Set(columns.map((row) => row.COLUMN_NAME));
  let removedColumns = 0;
  for (const column of RETIRED_AI_CHAT_CONFIG_COLUMNS) {
    if (!existingColumns.has(column)) continue;
    await prisma.$executeRawUnsafe(`ALTER TABLE \`learn_ai_config\` DROP COLUMN \`${column}\``);
    removedColumns++;
  }
  if (removedTables || removedColumns) {
    logger.info('Retired general AI chat data removed', { removedTables, removedColumns });
  }
}

// Apply the additive portion of the schema diff. Returns the number of
// statements executed. Throws only if generating the diff fails — individual
// statement errors are logged and skipped so one stale object can't block the
// rest.
export async function applyAdditiveSchema(): Promise<number> {
  const sql = await generateDiffSql();
  const statements = splitStatements(sql);
  const additive  = statements.flatMap(additiveFragments);
  const skipped   = statements.length - additive.length;

  if (additive.length === 0) {
    await removeRetiredAiChatSchema();
    if (skipped > 0) {
      logger.warn(`Schema diff has ${skipped} change(s), but all are destructive — skipped to protect data. Run a migration manually if intended.`);
    }
    return 0;
  }

  let applied = 0;
  for (const stmt of additive) {
    try {
      // Reviewed: `stmt` originates only from `prisma migrate diff --script`
      // output (schema DDL), never from a request — this path runs at
      // startup only and never handles user/request-derived input.
      await prisma.$executeRawUnsafe(fixTextDefaults(stmt));
      applied++;
    } catch (err) {
      const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
      logger.warn(`Additive schema statement failed (continuing): ${msg}`);
    }
  }
  await removeRetiredAiChatSchema();
  logger.info(`Additive schema sync applied ${applied}/${additive.length} statement(s)${skipped ? `, skipped ${skipped} destructive` : ''}`);
  return applied;
}
