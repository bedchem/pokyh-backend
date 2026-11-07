import { PrismaMariaDb } from '@prisma/adapter-mariadb';

// Prisma runs its queries through the MariaDB driver, which owns the
// connection pool. The pool is sized from the URL's Prisma parameters
// (`connection_limit`, `pool_timeout`, `connect_timeout`, see config.ts),
// which the driver itself would ignore.
//
// The database sits on the same private network as the server, as in every
// shipped deployment, and is reached without TLS: MySQL 8's default sign-in
// then needs the server's public key. A database elsewhere asks for TLS with
// `sslaccept=strict` (certificate checked) or `sslaccept=accept_invalid_certs`.
export function mysqlAdapter(databaseUrl: string, connections?: number): PrismaMariaDb {
  const url = new URL(databaseUrl);
  const number = (name: string): number | undefined => {
    const value = Number(url.searchParams.get(name));
    return Number.isFinite(value) && value > 0 ? value : undefined;
  };
  const sslaccept = url.searchParams.get('sslaccept');
  return new PrismaMariaDb({
    host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    connectionLimit: connections ?? number('connection_limit') ?? 10,
    acquireTimeout: (number('pool_timeout') ?? 10) * 1000,
    connectTimeout: (number('connect_timeout') ?? 5) * 1000,
    allowPublicKeyRetrieval: true,
    ...(sslaccept ? { ssl: { rejectUnauthorized: sslaccept !== 'accept_invalid_certs' } } : {}),
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
