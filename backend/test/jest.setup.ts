/**
 * Runs before every test file, before any application module is imported.
 *
 * backend/.env points at the SHARED staging database. Whatever loads it later
 * (ConfigModule, dotenv in data-source.ts or the seed) never overrides a
 * variable that is already set, and ConfigService reads process.env first, so
 * pinning the values here wins everywhere:
 *
 *   - DATABASE_URL goes to a closed local port. A spec that boots AppModule (or
 *     any DataSource built from DATABASE_URL) fails with ECONNREFUSED on
 *     127.0.0.1:1 instead of connecting to staging.
 *   - NODE_ENV=production keeps TypeORM synchronize off even if it did connect.
 *   - GATE_MEMBERSHIP_CONTEXT starts 'off' (legacy) so results never depend on
 *     the developer's shell; specs that need it flip it per case.
 *
 * Database suites connect through TEST_DATABASE_URL only; see
 * test/db/test-data-source.ts.
 */
process.env.DATABASE_URL = 'postgres://invalid@127.0.0.1:1/none';
process.env.DATABASE_SSL = 'false';
process.env.NODE_ENV = 'production';
process.env.GATE_MEMBERSHIP_CONTEXT = 'off';
