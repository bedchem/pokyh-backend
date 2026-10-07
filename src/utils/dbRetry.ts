import { Prisma } from '@prisma/client';

// MySQL resolves a lock cycle between two transactions by rolling one of them
// back. That is not a fault of either transaction: the one that was rolled
// back simply has to run again. Prisma reports it as P2034 (or, for a raw
// statement, as MySQL error 1213; 1205 is a lock wait that timed out).
function isWriteConflict(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (err.code === 'P2034') return true;
  const code = String((err.meta as { code?: unknown } | undefined)?.code ?? '');
  return err.code === 'P2010' && (code === '1213' || code === '1205');
}

// Runs `work` and repeats it when the database rolled it back because of a
// lock conflict. `work` must be safe to run more than once — a transaction
// that was rolled back left nothing behind, so a whole transaction qualifies.
export async function retryOnWriteConflict<T>(work: () => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (err) {
      if (attempt >= attempts || !isWriteConflict(err)) throw err;
      // A short, slightly random pause lets the other transaction finish
      // instead of colliding with it again straight away.
      await new Promise((resolve) => setTimeout(resolve, 15 * attempt + Math.floor(Math.random() * 25)));
    }
  }
}
