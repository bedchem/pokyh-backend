import { PrismaClient } from '@prisma/client';
import { config } from './config';
import { invalidateAllCaches, invalidateForSql, invalidateTables, modelsTouchedBy, sqlOfRawArgs } from './services/cache';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: config.debug ? ['query', 'info', 'warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

// A write inside a transaction becomes visible to other connections only at
// its commit; an answer read in between could be kept under the new version.
// The tables are invalidated once more after this long, when the commit has
// long happened (transactions here are short).
const TX_SETTLE_MS = 2_000;

// Every write through this client keeps the read cache honest
// (services/cache.ts): the written tables' cached answers are out of date
// before the write returns to its caller. Registered once per client, also
// when development reuses the client across reloads.
const hooked = prisma as unknown as { pokyhCacheHook?: boolean };
if (!hooked.pokyhCacheHook) {
  hooked.pokyhCacheHook = true;
  prisma.$use(async (params, next) => {
    const result = await next(params);
    try {
      if (params.model) {
        const models = modelsTouchedBy(params.model, params.action, params.args);
        if (models.length) {
          await invalidateTables(models);
          if (params.runInTransaction) setTimeout(() => void invalidateTables(models), TX_SETTLE_MS);
        }
      } else if ((params.action as string).startsWith('executeRaw')) {
        const sql = sqlOfRawArgs(params.args);
        const invalidate = () => (sql === null ? invalidateAllCaches() : invalidateForSql(sql));
        await invalidate();
        if (params.runInTransaction) setTimeout(() => void invalidate(), TX_SETTLE_MS);
      }
    } catch {
      // The cache must never fail a write that already succeeded.
    }
    return result;
  });
}

export default prisma;
