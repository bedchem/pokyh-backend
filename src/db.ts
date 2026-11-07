import { Prisma, PrismaClient } from '@prisma/client';
import { config } from './config';
import { mysqlAdapter } from './dbAdapter';
import { invalidateAllCaches, invalidateForSql, invalidateTables, isCacheTable, modelsTouchedBy, modelsWrittenBy, sqlOfRawArgs } from './services/cache';

// A write inside a transaction becomes visible to other connections only at
// its commit; an answer read in between could be kept under the new version.
// The written tables are invalidated once more after this long, when the
// commit has long happened (transactions here are short). The client does not
// say which writes run inside a transaction, so every write is settled; the
// tables are collected and settled together, once per interval.
const TX_SETTLE_MS = 2_000;

let settling = new Set<string>();
let settleEverything = false;
let settleTimer: NodeJS.Timeout | null = null;

function settleLater(models: string[] | null): void {
  if (models === null) settleEverything = true;
  else for (const model of models) settling.add(model);
  if (settleTimer) return;
  settleTimer = setTimeout(() => {
    const tables = settling;
    const everything = settleEverything;
    settling = new Set();
    settleEverything = false;
    settleTimer = null;
    void (everything ? invalidateAllCaches() : invalidateTables(tables)).catch(() => undefined);
  }, TX_SETTLE_MS);
  settleTimer.unref();
}

// Every write through the client keeps the read cache honest
// (services/cache.ts): the written tables' cached answers are out of date
// before the write returns to its caller. It sees every operation, also those
// of transactions and raw statements.
const readCacheHook = Prisma.defineExtension({
  name: 'pokyh-read-cache',
  query: {
    async $allOperations({ model, operation, args, query }) {
      const result = await query(args);
      try {
        if (model) {
          // Only tables a cached answer is built from: a write to a log or
          // usage table makes nothing stale and skips the round trip to Redis.
          const models = modelsTouchedBy(model, operation, args).filter(isCacheTable);
          if (models.length) {
            await invalidateTables(models);
            settleLater(models);
          }
        } else if (operation.startsWith('$executeRaw')) {
          const sql = sqlOfRawArgs(args);
          if (sql === null) {
            await invalidateAllCaches();
            settleLater(null);
          } else {
            await invalidateForSql(sql);
            const models = modelsWrittenBy(sql);
            if (models === null || models.length) settleLater(models);
          }
        }
      } catch {
        // The cache must never fail a write that already succeeded.
      }
      return result;
    },
  },
});

// The hook adds no methods and changes no result, so the client keeps the
// plain client's type: code passes it where a transaction client is expected
// too (an extended client's type would not fit there).
function createClient(): PrismaClient {
  return new PrismaClient({
    adapter: mysqlAdapter(config.databaseUrl),
    log: config.debug ? ['query', 'info', 'warn', 'error'] : ['error'],
  }).$extends(readCacheHook) as unknown as PrismaClient;
}

// Development reloads reuse the client (and its pool).
const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

export const prisma: PrismaClient = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

// The admin panel's heavy figures (Analytics: dozens of aggregations at once)
// read through a pool of their own, a few connections wide: a cold build waits
// on its own pool instead of taking every connection the apps' requests need.
// Reads only — nothing written here would pass the cache hook above.
let reportingClient: PrismaClient | null = null;
export function reportingDb(): PrismaClient {
  if (!reportingClient) {
    reportingClient = new PrismaClient({ adapter: mysqlAdapter(config.databaseUrl, config.reportingConnections), log: ['error'] });
  }
  return reportingClient;
}

export async function closeReportingDb(): Promise<void> {
  const client = reportingClient;
  reportingClient = null;
  await client?.$disconnect().catch(() => undefined);
}

export default prisma;
