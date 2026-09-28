import { databaseHostOf } from '../src/database/database-host';
import { TEST_DATABASE_URL, assertDisposableTestDatabase } from './db/test-data-source';

/**
 * The harness itself: nothing a spec imports can reach the database named in
 * backend/.env (the shared staging database).
 */
describe('jest harness', () => {
  it('points DATABASE_URL at a closed local port and keeps synchronize off', () => {
    expect(process.env.DATABASE_URL).toBe('postgres://invalid@127.0.0.1:1/none');
    expect(databaseHostOf(process.env.DATABASE_URL)).toBe('127.0.0.1');
    expect(process.env.NODE_ENV).toBe('production');
    expect(process.env.GATE_MEMBERSHIP_CONTEXT).toBe('off');
  });

  it('still wins after dotenv loads backend/.env', async () => {
    const dotenv = await import('dotenv');
    dotenv.config();
    expect(process.env.DATABASE_URL).toBe('postgres://invalid@127.0.0.1:1/none');
  });

  it('only accepts a local database named like a test database for DB suites', () => {
    expect(() =>
      assertDisposableTestDatabase('postgres://u:p@192.168.200.103:5432/gate_test'),
    ).toThrow('not local');
    expect(() =>
      assertDisposableTestDatabase('postgres://u:p@localhost:5432/gate_management'),
    ).toThrow('contains "test"');
    expect(() =>
      assertDisposableTestDatabase('postgres://u:p@localhost:5432/gate_test'),
    ).not.toThrow();
  });

  it('never takes the database suites URL from DATABASE_URL', () => {
    expect(TEST_DATABASE_URL).not.toBe(process.env.DATABASE_URL);
  });
});
