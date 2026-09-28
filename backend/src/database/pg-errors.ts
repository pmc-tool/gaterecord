import { QueryFailedError } from 'typeorm';

/** SQLSTATE for unique_violation. */
export const PG_UNIQUE_VIOLATION = '23505';

type PgDriverError = { code?: string; constraint?: string };

/**
 * Postgres unique_violation: two concurrent writes slipped past a service's
 * pre-check and the database index caught the second one.
 *
 * @param constraint when given, only a violation of that index or constraint
 *   name counts, so a caller translating one specific index into a friendly 409
 *   does not also swallow an unrelated duplicate.
 *
 * Note that the error has already aborted the surrounding transaction: callers
 * translate it into an HTTP error and let the transaction roll back, they do not
 * keep using the same EntityManager afterwards.
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (!(error instanceof QueryFailedError)) {
    return false;
  }

  const driverError = (error as QueryFailedError & { driverError?: PgDriverError }).driverError;
  if (driverError?.code !== PG_UNIQUE_VIOLATION) {
    return false;
  }

  return constraint === undefined || driverError.constraint === constraint;
}
