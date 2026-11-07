import { readFileSync } from 'fs';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';

// Prisma runs its queries through the MariaDB driver, which owns the
// connection pool. The pool is sized from the URL's Prisma parameters
// (`connection_limit`, `pool_timeout`, `connect_timeout`, see config.ts),
// which the driver itself would ignore.
//
// TLS to the database is on, as it was with Prisma's own engine: MySQL 8
// offers it out of the box (with a certificate of its own making, so the
// certificate is checked only with `sslaccept=strict`, against the CA file in
// `sslcert` when one is named). A database without TLS needs `ssl=false`; MySQL's
// default sign-in then fetches the server's key over the open link, which
// only a private network between the two makes acceptable.
export function mysqlAdapter(databaseUrl: string, connections?: number): PrismaMariaDb {
  const url = new URL(databaseUrl);
  const number = (name: string): number | undefined => {
    const value = Number(url.searchParams.get(name));
    return Number.isFinite(value) && value > 0 ? value : undefined;
  };
  const tlsOff = /^(false|0|off|disabled?)$/i.test(url.searchParams.get('ssl') ?? '');
  const sslcert = url.searchParams.get('sslcert');
  const tls = tlsOff
    ? { allowPublicKeyRetrieval: true }
    : {
      ssl: {
        rejectUnauthorized: url.searchParams.get('sslaccept') === 'strict',
        ...(sslcert ? { ca: readFileSync(sslcert, 'utf8') } : {}),
      },
    };
  return new PrismaMariaDb({
    host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    connectionLimit: connections ?? number('connection_limit') ?? 10,
    acquireTimeout: (number('pool_timeout') ?? 10) * 1000,
    connectTimeout: (number('connect_timeout') ?? 5) * 1000,
    ...tls,
  });
}

/**
 * The MySQL error number behind a failed query (1062, 1213, …), or null.
 * Prisma 7 hands it on in the driver adapter's error; a raw query's failure
 * is P2010 with it there, a model query's a Prisma code with it there too.
 */
export function mysqlErrorNumber(err: unknown): number | null {
  const meta = (err as { meta?: unknown } | null)?.meta as
    | { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown; code?: unknown } } }
    | undefined;
  if (!meta || typeof meta !== 'object') return null;
  const cause = meta.driverAdapterError?.cause;
  for (const candidate of [cause?.originalCode, cause?.code, meta.code]) {
    const code = Number(candidate);
    if (candidate !== undefined && candidate !== null && Number.isInteger(code) && code > 0) return code;
  }
  return null;
}
