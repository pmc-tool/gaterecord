/**
 * Which database a connection string points at, and whether that database is a
 * disposable local one.
 *
 * The committed backend/.env of most developers points at the SHARED staging
 * database. Anything that rewrites a schema (TypeORM `synchronize`, the seed) or
 * that tests may touch has to refuse a remote host by default, because
 * `synchronize` diffs the entities against whatever it finds: pointed at staging
 * it would create tables without their migration backfill and drop indexes that
 * only migrations declare. Local means the loopback addresses and the
 * docker-compose Postgres container; every other host, and a missing or
 * unreadable URL, counts as remote (fail closed).
 */
export const LOCAL_DATABASE_HOSTS: readonly string[] = [
  'localhost',
  '127.0.0.1',
  '::1',
  'gate_postgres',
];

/** Lower-cased host of a postgres:// URL, without IPv6 brackets; null when unreadable. */
export function databaseHostOf(url: string | null | undefined): string | null {
  if (!url) {
    return null;
  }

  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.replace(/^\[(.*)\]$/, '$1') || null;
  } catch {
    return null;
  }
}

export function isLocalDatabaseUrl(url: string | null | undefined): boolean {
  const host = databaseHostOf(url);
  return host !== null && LOCAL_DATABASE_HOSTS.includes(host);
}

/**
 * host:port/database with the credentials left out, for logs and for the
 * "which database am I about to touch" line scripts print first.
 */
export function describeDatabaseUrl(url: string | null | undefined): string {
  if (!url) {
    return '(DATABASE_URL is not set)';
  }

  try {
    const parsed = new URL(url);
    const port = parsed.port ? `:${parsed.port}` : '';
    return `${parsed.hostname}${port}${parsed.pathname}`;
  } catch {
    return '(unreadable DATABASE_URL)';
  }
}

export interface SynchronizeDecision {
  synchronize: boolean;
  /** Set when synchronize was wanted but refused, for a startup warning. */
  refusedReason: string | null;
}

/**
 * The app's `synchronize` setting. Wanted outside production as before, but
 * only honoured against a local database unless ALLOW_REMOTE_SYNC=1 says the
 * operator really means it.
 */
export function resolveSynchronize(options: {
  wanted: boolean;
  url: string | null | undefined;
  allowRemoteSync: boolean;
}): SynchronizeDecision {
  if (!options.wanted) {
    return { synchronize: false, refusedReason: null };
  }

  if (isLocalDatabaseUrl(options.url) || options.allowRemoteSync) {
    return { synchronize: true, refusedReason: null };
  }

  return {
    synchronize: false,
    refusedReason:
      `TypeORM synchronize is OFF: ${describeDatabaseUrl(options.url)} is not a local database. ` +
      'Schema changes on shared databases go through migrations. ' +
      'Set ALLOW_REMOTE_SYNC=1 only if you are sure.',
  };
}
