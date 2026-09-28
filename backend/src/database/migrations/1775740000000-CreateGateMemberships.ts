import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Roles copied from gate_users into gate_memberships by the backfill.
 *
 * Frozen here on purpose (a migration must not change meaning when application
 * constants move). Staff is included so nobody loses gate access: staff rows
 * become staff memberships, selectable like the other building roles.
 * super_admin is a platform role and never becomes a membership.
 */
const BACKFILL_ROLES = ['building_admin', 'resident', 'security', 'staff'];

/**
 * The rows the backfill turns into memberships: every live person with a
 * building and a building role, whose tenant row exists (live or soft-deleted).
 * Tenantless people go to onboarding, dangling tenant ids are skipped, and
 * soft-deleted people come back later with no membership.
 */
const ELIGIBLE_ROWS =
  `FROM "gate_users" "u" ` +
  `INNER JOIN "tenants" "t" ON "t"."id" = "u"."tenant_id" ` +
  `WHERE "u"."deleted_at" IS NULL ` +
  `AND "u"."tenant_id" IS NOT NULL ` +
  `AND "u"."role"::text = ANY($1::text[])`;

/**
 * Multi-building memberships — the table, and a backfill of today's one role per
 * person.
 *
 * Creates `gate_memberships` (one row per person per building, contract C1) and
 * fills it from the single tenant_id / role / status / unit on each gate_users
 * row. gate_users itself is not altered: those columns stay as a legacy mirror
 * that MembershipsService keeps in step, so old code and a code rollback keep
 * working.
 *
 * Every step is independently idempotent, because outside production
 * `synchronize` may already have built the table from the entity (it builds the
 * same named objects: the entity pins every PK, FK, index and enum name). Foreign
 * keys are probed by COLUMN, as in the other migrations. The backfill is one
 * INSERT ... SELECT guarded twice (NOT EXISTS and ON CONFLICT), so a second run
 * inserts nothing, and the migration ends with a self-check that throws, rolling
 * the whole migration back, if an eligible row is still without its membership.
 *
 * Role and status are copied through ::text, so this does not depend on the name
 * gate_users' enum types happen to have (they were created by synchronize while
 * the table was still called `users`).
 */
export class CreateGateMemberships1775740000000 implements MigrationInterface {
  name = 'CreateGateMemberships1775740000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DO $$ BEGIN ` +
        `CREATE TYPE "public"."gate_memberships_role_enum" AS ENUM('building_admin', 'resident', 'security', 'staff'); ` +
        `EXCEPTION WHEN duplicate_object THEN null; ` +
        `END $$;`,
    );
    await queryRunner.query(
      `DO $$ BEGIN ` +
        `CREATE TYPE "public"."gate_memberships_status_enum" AS ENUM('active', 'inactive', 'pending'); ` +
        `EXCEPTION WHEN duplicate_object THEN null; ` +
        `END $$;`,
    );

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "gate_memberships" (` +
        `"id" uuid NOT NULL DEFAULT uuid_generate_v4(), ` +
        `"created_at" TIMESTAMP NOT NULL DEFAULT now(), ` +
        `"updated_at" TIMESTAMP NOT NULL DEFAULT now(), ` +
        `"deleted_at" TIMESTAMP, ` +
        `"user_id" uuid NOT NULL, ` +
        `"tenant_id" uuid NOT NULL, ` +
        `"role" "public"."gate_memberships_role_enum" NOT NULL, ` +
        `"status" "public"."gate_memberships_status_enum" NOT NULL DEFAULT 'active', ` +
        `"unit" character varying, ` +
        `CONSTRAINT "PK_gate_memberships_id" PRIMARY KEY ("id")` +
        `)`,
    );

    // user_id is the PERSON row (gate_users.id), not the Keycloak sub. Both
    // parents are soft-deleted in normal operation, so the cascades only fire on
    // a genuine hard delete.
    await this.addForeignKeyIfMissing(
      queryRunner,
      'user_id',
      `ALTER TABLE "gate_memberships" ADD CONSTRAINT "FK_gate_memberships_user" ` +
        `FOREIGN KEY ("user_id") REFERENCES "gate_users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await this.addForeignKeyIfMissing(
      queryRunner,
      'tenant_id',
      `ALTER TABLE "gate_memberships" ADD CONSTRAINT "FK_gate_memberships_tenant" ` +
        `FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // Exactly one live role per person per building. Partial, so leaving a
    // building (soft delete) keeps the history and allows a later return.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_gate_memberships_user_tenant" ` +
        `ON "gate_memberships" ("user_id", "tenant_id") WHERE "deleted_at" IS NULL`,
    );
    // "Active residents / admins of building X" (recipients, seats, listings).
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_gate_memberships_tenant_role_status" ` +
        `ON "gate_memberships" ("tenant_id", "role", "status")`,
    );
    // "Everything this person holds" (context resolution, the picker).
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_gate_memberships_user" ON "gate_memberships" ("user_id")`,
    );

    // A row whose building was soft-deleted becomes a membership that ended when
    // the building did. NOT EXISTS looks at ended rows too, so a membership that
    // was removed after an earlier run is never brought back.
    await queryRunner.query(
      `INSERT INTO "gate_memberships" ` +
        `("user_id", "tenant_id", "role", "status", "unit", "created_at", "updated_at", "deleted_at") ` +
        `SELECT "u"."id", "u"."tenant_id", ` +
        `"u"."role"::text::"public"."gate_memberships_role_enum", ` +
        `"u"."status"::text::"public"."gate_memberships_status_enum", ` +
        `"u"."unit", ` +
        `GREATEST("u"."created_at", "t"."created_at"), ` +
        `GREATEST("u"."created_at", "t"."created_at"), ` +
        `"t"."deleted_at" ` +
        ELIGIBLE_ROWS +
        ` AND NOT EXISTS (SELECT 1 FROM "gate_memberships" "m" ` +
        `WHERE "m"."user_id" = "u"."id" AND "m"."tenant_id" = "u"."tenant_id") ` +
        `ON CONFLICT ("user_id", "tenant_id") WHERE "deleted_at" IS NULL DO NOTHING`,
      [BACKFILL_ROLES],
    );

    // Self-check: every eligible row now has its membership, live when the
    // building is live. Throwing here rolls the whole migration back.
    const missing: Array<{ missing: number }> = await queryRunner.query(
      `SELECT COUNT(*)::int AS "missing" ` +
        ELIGIBLE_ROWS +
        ` AND NOT EXISTS (SELECT 1 FROM "gate_memberships" "m" ` +
        `WHERE "m"."user_id" = "u"."id" AND "m"."tenant_id" = "u"."tenant_id" ` +
        `AND ("m"."deleted_at" IS NULL OR "t"."deleted_at" IS NOT NULL))`,
      [BACKFILL_ROLES],
    );
    if (Number(missing[0]?.missing ?? 0) > 0) {
      throw new Error(
        `CreateGateMemberships: ${missing[0].missing} gate_users row(s) with a live building ` +
          'have no live membership after the backfill (probably an ended membership row that ' +
          'the legacy columns still point at). Run scripts/reconcile-memberships.ts --check, ' +
          'resolve the rows, and run the migration again.',
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const hasTable = await queryRunner.hasTable('gate_memberships');
    if (!hasTable) {
      return;
    }

    // gate_users can hold one building per person. Refuse rather than silently
    // dropping every role but one.
    const multi: Array<{ user_id: string }> = await queryRunner.query(
      `SELECT "user_id" FROM "gate_memberships" WHERE "deleted_at" IS NULL ` +
        `GROUP BY "user_id" HAVING COUNT(*) > 1 LIMIT 5`,
    );
    if (multi.length > 0) {
      throw new Error(
        'Cannot revert CreateGateMemberships: some people hold roles in more than one building ' +
          `(for example gate_users.id ${multi.map((row) => row.user_id).join(', ')}), which ` +
          'gate_users cannot represent. Remove the extra memberships first.',
      );
    }

    // Leave the legacy columns exactly as the memberships describe them. The
    // mirror should already agree; this is the safety net. The cast targets are
    // read from the catalog because the enums' names depend on how the table was
    // created.
    //
    // Status too: after the revert gate_users.status is the only status the
    // code reads, so a membership that is not active is copied onto it (a
    // person deactivated in a building while also holding another one could
    // still be 'active' there). An active membership never lifts a non-active
    // gate_users.status, which may be a platform ban.
    const gateUsersRoleType = await this.columnType(queryRunner, 'role');
    const gateUsersStatusType = await this.columnType(queryRunner, 'status');
    if (gateUsersRoleType && gateUsersStatusType) {
      await queryRunner.query(
        `UPDATE "gate_users" "u" SET ` +
          `"tenant_id" = "m"."tenant_id", ` +
          `"role" = "m"."role"::text::${gateUsersRoleType}, ` +
          `"unit" = "m"."unit", ` +
          `"status" = CASE WHEN "m"."status"::text <> 'active' ` +
          `THEN "m"."status"::text::${gateUsersStatusType} ELSE "u"."status" END ` +
          `FROM "gate_memberships" "m" ` +
          `WHERE "m"."user_id" = "u"."id" AND "m"."deleted_at" IS NULL ` +
          `AND "u"."role"::text <> 'super_admin' ` +
          `AND ("u"."tenant_id" IS DISTINCT FROM "m"."tenant_id" ` +
          `OR "u"."role"::text IS DISTINCT FROM "m"."role"::text ` +
          `OR "u"."unit" IS DISTINCT FROM "m"."unit" ` +
          `OR ("m"."status"::text <> 'active' AND "u"."status"::text <> "m"."status"::text))`,
      );
    }

    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_gate_memberships_user"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_gate_memberships_tenant_role_status"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."UQ_gate_memberships_user_tenant"`);
    // The table owns the enum columns, so it has to go before the types.
    await queryRunner.query(`DROP TABLE "gate_memberships"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."gate_memberships_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."gate_memberships_role_enum"`);
  }

  /** The declared type of a gate_users column (its enum name), or null. */
  private async columnType(queryRunner: QueryRunner, column: string): Promise<string | null> {
    const rows: Array<{ type_name: string }> = await queryRunner.query(
      `SELECT format_type("a"."atttypid", "a"."atttypmod") AS "type_name" ` +
        `FROM "pg_attribute" "a" ` +
        `WHERE "a"."attrelid" = to_regclass('public.gate_users') AND "a"."attname" = $1 ` +
        `AND NOT "a"."attisdropped"`,
      [column],
    );
    return rows[0]?.type_name ?? null;
  }

  private async addForeignKeyIfMissing(
    queryRunner: QueryRunner,
    column: string,
    ddl: string,
  ): Promise<void> {
    const existing = await queryRunner.query(
      `SELECT 1 FROM information_schema.table_constraints tc ` +
        `JOIN information_schema.key_column_usage kcu ` +
        `ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema ` +
        `WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = 'gate_memberships' ` +
        // The schema the unqualified ALTER TABLE below targets: a gate_memberships
        // in another schema must not count as this table's foreign key.
        `AND tc.table_schema = current_schema() ` +
        `AND kcu.column_name = $1`,
      [column],
    );

    if (!existing || existing.length === 0) {
      await queryRunner.query(ddl);
    }
  }
}
