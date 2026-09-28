/**
 * Postgres for database suites, and only ever a local, disposable one.
 *
 * Database suites read TEST_DATABASE_URL and nothing else (never DATABASE_URL,
 * which jest.setup.ts has already pointed at a dead port). They are skipped when
 * it is unset, so `npm test` passes on a machine with no database. When it IS
 * set it must name a local host (localhost, 127.0.0.1, ::1 or the docker
 * gate_postgres container) and a database whose name contains "test", because
 * the suites drop and rebuild the whole schema. Anything else fails the suite
 * immediately instead of running against it.
 *
 * Example: docker compose up postgres, create a database gate_test, then
 *   TEST_DATABASE_URL=postgres://postgres:password@localhost:5432/gate_test npx jest test/db
 */
import 'reflect-metadata';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { describeDatabaseUrl, isLocalDatabaseUrl } from '../../src/database/database-host';

export const TEST_DATABASE_URL: string | undefined =
  process.env.TEST_DATABASE_URL?.trim() || undefined;

/** Throws unless the URL is a local database named like a test database. */
export function assertDisposableTestDatabase(url: string): void {
  if (!isLocalDatabaseUrl(url)) {
    throw new Error(
      `TEST_DATABASE_URL must point at a local database; ${describeDatabaseUrl(url)} is not local. ` +
        'Database suites drop and rebuild the schema.',
    );
  }

  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!/test/i.test(databaseName)) {
    throw new Error(
      `TEST_DATABASE_URL names database "${databaseName}". Use a database whose name contains ` +
        '"test" (for example gate_test): database suites drop and rebuild the whole schema.',
    );
  }
}

/**
 * describe() for suites that need Postgres: describe.skip without
 * TEST_DATABASE_URL, and a thrown error (the suite fails) for a remote one.
 */
export const describeDb: jest.Describe = (() => {
  if (!TEST_DATABASE_URL) {
    return describe.skip;
  }
  assertDisposableTestDatabase(TEST_DATABASE_URL);
  return describe;
})();

/** A connected DataSource over every entity, with synchronize off. */
export async function createTestDataSource(): Promise<DataSource> {
  if (!TEST_DATABASE_URL) {
    throw new Error('TEST_DATABASE_URL is not set');
  }
  assertDisposableTestDatabase(TEST_DATABASE_URL);

  const dataSource = new DataSource({
    type: 'postgres',
    url: TEST_DATABASE_URL,
    entities: [path.join(__dirname, '../../src/database/entities/*.entity.ts')],
    synchronize: false,
    logging: false,
  });

  return dataSource.initialize();
}

/** Drops every table of the test database and rebuilds the schema from the entities. */
export async function rebuildSchema(dataSource: DataSource): Promise<void> {
  assertDisposableTestDatabase(TEST_DATABASE_URL ?? '');
  await dataSource.dropDatabase();
  await dataSource.synchronize();
}
