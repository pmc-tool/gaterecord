/**
 * Drift check between gate_memberships and the legacy gate_users columns.
 *
 * MembershipsService keeps gate_users.tenant_id / role / unit equal to each
 * person's primary membership. Anything that writes those columns directly
 * (another developer's older backend on the shared staging database, a manual
 * fix, a code rollback) makes the two disagree. Run this after every deploy to a
 * shared database and before any flag flip.
 *
 *   npx ts-node -r tsconfig-paths/register scripts/reconcile-memberships.ts --check
 *
 * READ-ONLY: every query runs in a READ ONLY transaction that is rolled back.
 * It prints the database it is about to read FIRST, and refuses a non-local
 * database unless --remote is given, which you add only once the database owner
 * has approved the run. Only --check exists in this release; the repair mode
 * (--apply-legacy-to-memberships) is a follow-up.
 *
 * Some checks depend on GATE_MEMBERSHIP_CONTEXT as this shell reads it: states
 * that are normal while the flag is on (several buildings, a person inactive in
 * every building they hold) are drift while it is off, because the legacy
 * readers then see only gate_users. Run it with the value the backend has, and
 * with GATE_MEMBERSHIP_CONTEXT=off before and after a rollback to off (runbook
 * M4).
 *
 * Exit code: 0 clean, 1 drift found, 2 usage or connection error.
 */
import { DataSource, QueryRunner } from 'typeorm';
import { config } from 'dotenv';
import { describeDatabaseUrl, isLocalDatabaseUrl } from '../src/database/database-host';
import { isMembershipContextEnabled } from '../src/common/context/membership-flags';

const SAMPLE_SIZE = 20;
const KNOWN_FLAGS = new Set(['--check', '--remote']);

export interface Check {
  key: string;
  title: string;
  /** true: a finding is drift (exit 1). false: shown for review only. */
  drift: boolean;
  /** A SELECT listing the findings, runnable on its own (the database suites do). */
  sql: string;
}

/**
 * Rows whose role the mirror writes. A super admin keeps the platform role; only
 * their tenant_id and unit follow memberships (K2b checks those).
 */
const NOT_SUPER_ADMIN = `"u"."role"::text <> 'super_admin'`;

const LIVE_COUNT = `(SELECT COUNT(*) FROM "gate_memberships" "lm" WHERE "lm"."user_id" = "u"."id" AND "lm"."deleted_at" IS NULL)`;

/** The checks for a flag value (default: GATE_MEMBERSHIP_CONTEXT as this process reads it). */
export function buildChecks(membershipContextOn = isMembershipContextEnabled()): Check[] {
  const flagOff = !membershipContextOn;
  return [
    {
      key: 'K1',
      title: 'single-membership people whose legacy columns disagree with that membership',
      drift: true,
      sql:
        `SELECT "u"."id" AS "person_id", ` +
        `"u"."tenant_id" AS "legacy_tenant_id", "u"."role"::text AS "legacy_role", "u"."unit" AS "legacy_unit", ` +
        `"m"."tenant_id", "m"."role"::text AS "role", "m"."unit" ` +
        `FROM "gate_users" "u" ` +
        `JOIN "gate_memberships" "m" ON "m"."user_id" = "u"."id" AND "m"."deleted_at" IS NULL ` +
        `WHERE "u"."deleted_at" IS NULL AND ${NOT_SUPER_ADMIN} AND ${LIVE_COUNT} = 1 ` +
        `AND ("u"."tenant_id" IS DISTINCT FROM "m"."tenant_id" ` +
        `OR "u"."role"::text IS DISTINCT FROM "m"."role"::text ` +
        `OR "u"."unit" IS DISTINCT FROM "m"."unit")`,
    },
    {
      key: 'K2',
      title: 'legacy building (live) with no live membership there',
      drift: true,
      sql:
        `SELECT "u"."id" AS "person_id", "u"."tenant_id", "u"."role"::text AS "role" ` +
        `FROM "gate_users" "u" JOIN "tenants" "t" ON "t"."id" = "u"."tenant_id" AND "t"."deleted_at" IS NULL ` +
        `WHERE "u"."deleted_at" IS NULL AND ${NOT_SUPER_ADMIN} ` +
        `AND NOT EXISTS (SELECT 1 FROM "gate_memberships" "m" WHERE "m"."user_id" = "u"."id" ` +
        `AND "m"."tenant_id" = "u"."tenant_id" AND "m"."deleted_at" IS NULL)`,
    },
    {
      key: 'K2b',
      title:
        'super admins whose legacy building (live) has no live membership there (the legacy gate check still lets them in)',
      drift: true,
      sql:
        `SELECT "u"."id" AS "person_id", "u"."tenant_id", "u"."unit" ` +
        `FROM "gate_users" "u" JOIN "tenants" "t" ON "t"."id" = "u"."tenant_id" AND "t"."deleted_at" IS NULL ` +
        `WHERE "u"."deleted_at" IS NULL AND "u"."role"::text = 'super_admin' ` +
        `AND NOT EXISTS (SELECT 1 FROM "gate_memberships" "m" WHERE "m"."user_id" = "u"."id" ` +
        `AND "m"."tenant_id" = "u"."tenant_id" AND "m"."deleted_at" IS NULL)`,
    },
    {
      key: 'K3',
      title: 'live memberships of soft-deleted people',
      drift: true,
      sql:
        `SELECT "m"."id" AS "membership_id", "m"."user_id" AS "person_id", "m"."tenant_id" ` +
        `FROM "gate_memberships" "m" JOIN "gate_users" "u" ON "u"."id" = "m"."user_id" ` +
        `WHERE "m"."deleted_at" IS NULL AND "u"."deleted_at" IS NOT NULL`,
    },
    {
      key: 'K4',
      title: 'live memberships in soft-deleted buildings',
      drift: true,
      sql:
        `SELECT "m"."id" AS "membership_id", "m"."user_id" AS "person_id", "m"."tenant_id" ` +
        `FROM "gate_memberships" "m" JOIN "tenants" "t" ON "t"."id" = "m"."tenant_id" ` +
        `WHERE "m"."deleted_at" IS NULL AND "t"."deleted_at" IS NOT NULL`,
    },
    {
      key: 'K5',
      title:
        'people with no membership whose legacy columns are not the sentinel (building_admin, no building, no unit)',
      drift: true,
      sql:
        `SELECT "u"."id" AS "person_id", "u"."tenant_id", "u"."role"::text AS "role", "u"."unit" ` +
        `FROM "gate_users" "u" ` +
        `WHERE "u"."deleted_at" IS NULL AND ${NOT_SUPER_ADMIN} AND ${LIVE_COUNT} = 0 ` +
        `AND "u"."tenant_id" IS NULL ` +
        `AND ("u"."role"::text <> 'building_admin' OR "u"."unit" IS NOT NULL)`,
    },
    {
      key: 'K6',
      title: 'people holding roles in more than one building',
      // Drift only while the flag is off: nobody may have a second building then.
      drift: flagOff,
      sql:
        `SELECT "u"."id" AS "person_id", ${LIVE_COUNT} AS "live_memberships" ` +
        `FROM "gate_users" "u" WHERE "u"."deleted_at" IS NULL AND ${LIVE_COUNT} > 1`,
    },
    {
      key: 'K7',
      title:
        'people active on gate_users whose membership in their legacy building is not active (legacy readers would let them in)',
      // Normal while the flag is on (someone inactive in every building they
      // hold); drift while it is off, because the legacy readers see gate_users.
      drift: flagOff,
      sql:
        `SELECT "u"."id" AS "person_id", "u"."tenant_id", "u"."role"::text AS "role", ` +
        `"m"."id" AS "membership_id", "m"."status"::text AS "membership_status", ` +
        `${LIVE_COUNT} AS "live_memberships" ` +
        `FROM "gate_users" "u" ` +
        `JOIN "gate_memberships" "m" ON "m"."user_id" = "u"."id" AND "m"."tenant_id" = "u"."tenant_id" ` +
        `AND "m"."deleted_at" IS NULL ` +
        `WHERE "u"."deleted_at" IS NULL AND ${NOT_SUPER_ADMIN} ` +
        `AND "u"."status"::text = 'active' AND "m"."status"::text <> 'active'`,
    },
    {
      key: 'R1',
      title:
        'single-membership people whose gate_users.status differs from the membership status (a platform ban, or a missed dual-write)',
      // Drift while the flag is off, when the legacy readers use gate_users.status:
      // a row where gate_users is the stricter one is a platform ban to confirm;
      // the other way round (also listed by K7) would let someone in.
      drift: flagOff,
      sql:
        `SELECT "u"."id" AS "person_id", "u"."status"::text AS "person_status", "m"."status"::text AS "membership_status" ` +
        `FROM "gate_users" "u" ` +
        `JOIN "gate_memberships" "m" ON "m"."user_id" = "u"."id" AND "m"."deleted_at" IS NULL ` +
        `WHERE "u"."deleted_at" IS NULL AND ${NOT_SUPER_ADMIN} AND ${LIVE_COUNT} = 1 ` +
        `AND "u"."status"::text <> "m"."status"::text`,
    },
    {
      key: 'R2',
      title:
        'review: legacy building soft-deleted or missing, with no live membership (expected after the backfill)',
      drift: false,
      sql:
        `SELECT "u"."id" AS "person_id", "u"."tenant_id", ("t"."id" IS NULL) AS "dangling" ` +
        `FROM "gate_users" "u" LEFT JOIN "tenants" "t" ON "t"."id" = "u"."tenant_id" ` +
        `WHERE "u"."deleted_at" IS NULL AND ${NOT_SUPER_ADMIN} AND "u"."tenant_id" IS NOT NULL ` +
        `AND ("t"."id" IS NULL OR "t"."deleted_at" IS NOT NULL) ` +
        `AND NOT EXISTS (SELECT 1 FROM "gate_memberships" "m" WHERE "m"."user_id" = "u"."id" ` +
        `AND "m"."tenant_id" = "u"."tenant_id" AND "m"."deleted_at" IS NULL)`,
    },
  ];
}

function usage(message?: string): never {
  if (message) {
    console.error(message);
  }
  console.error(
    'Usage: npx ts-node -r tsconfig-paths/register scripts/reconcile-memberships.ts --check [--remote]',
  );
  process.exit(2);
}

async function runCheck(queryRunner: QueryRunner, check: Check) {
  const [{ total }] = await queryRunner.query(
    `SELECT COUNT(*)::int AS "total" FROM (${check.sql}) AS "findings"`,
  );
  const sample = total > 0 ? await queryRunner.query(`${check.sql} LIMIT ${SAMPLE_SIZE}`) : [];
  return { total: Number(total), sample };
}

async function main(): Promise<number> {
  const url = process.env.DATABASE_URL;
  const args = process.argv.slice(2);

  // First line of output, before anything else happens.
  console.log(`Database: ${describeDatabaseUrl(url)}`);

  const unknown = args.filter((arg) => !KNOWN_FLAGS.has(arg));
  if (unknown.length > 0) {
    usage(`Unknown option(s): ${unknown.join(', ')}. Only --check is available in this release.`);
  }
  if (!args.includes('--check')) {
    usage('Nothing to do: pass --check.');
  }
  if (!isLocalDatabaseUrl(url) && !args.includes('--remote')) {
    usage(
      'This is not a local database. Reading a shared database needs approval from its ' +
        'owner; once approved, re-run with --remote.',
    );
  }

  console.log(
    `GATE_MEMBERSHIP_CONTEXT: ${isMembershipContextEnabled() ? 'on' : 'off'} (as read by this shell)`,
  );

  const dataSource = new DataSource({
    type: 'postgres',
    url,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
    synchronize: false,
    logging: false,
  });
  await dataSource.initialize();
  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();

  let driftFound = false;
  try {
    await queryRunner.query('BEGIN TRANSACTION READ ONLY');

    const [{ table }] = await queryRunner.query(
      `SELECT to_regclass('public.gate_memberships')::text AS "table"`,
    );
    if (!table) {
      console.log('gate_memberships does not exist: migration 1775740000000 has not run here.');
      return 1;
    }

    for (const check of buildChecks()) {
      const { total, sample } = await runCheck(queryRunner, check);
      const marker = total === 0 ? 'ok   ' : check.drift ? 'DRIFT' : 'note ';
      console.log(`\n[${marker}] ${check.key} ${check.title}: ${total}`);
      if (total > 0) {
        console.table(sample);
        if (total > sample.length) {
          console.log(`  ... and ${total - sample.length} more`);
        }
      }
      driftFound = driftFound || (check.drift && total > 0);
    }
  } finally {
    await queryRunner.query('ROLLBACK').catch(() => undefined);
    await queryRunner.release();
    await dataSource.destroy();
  }

  console.log(driftFound ? '\nDrift found.' : '\nNo drift.');
  return driftFound ? 1 : 0;
}

// Runs only as a script: the database suites import buildChecks() without
// loading backend/.env or opening a connection.
if (require.main === module) {
  config();
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(
        'reconcile-memberships failed:',
        error instanceof Error ? error.message : error,
      );
      process.exit(2);
    });
}
