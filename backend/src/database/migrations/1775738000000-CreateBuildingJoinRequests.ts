import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Resident self-signup — the request side.
 *
 * Creates `building_join_requests`, the queue a building admin reviews when a
 * signed-in user asks to join their building as a resident. Nothing existing is
 * altered: no column is added to `gate_users` and no enum is extended, so this
 * migration is additive and its down() is a clean drop.
 *
 * Every step is independently idempotent rather than sitting behind one
 * `hasTable` early return. Outside production `synchronize` is on and may have
 * built the table already — but it will NOT build the partial unique index,
 * because a filtered index cannot be expressed on the entity. Returning early
 * on "table exists" would therefore leave the only database-level guard against
 * duplicate pending requests permanently missing.
 */
export class CreateBuildingJoinRequests1775738000000 implements MigrationInterface {
  name = 'CreateBuildingJoinRequests1775738000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // `synchronize` may have produced the type already, with or without the table.
    await queryRunner.query(
      `DO $$ BEGIN ` +
        `CREATE TYPE "public"."building_join_requests_status_enum" AS ENUM('pending', 'approved', 'rejected', 'cancelled'); ` +
        `EXCEPTION WHEN duplicate_object THEN null; ` +
        `END $$;`,
    );

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "building_join_requests" (` +
        `"id" uuid NOT NULL DEFAULT uuid_generate_v4(), ` +
        `"created_at" TIMESTAMP NOT NULL DEFAULT now(), ` +
        `"updated_at" TIMESTAMP NOT NULL DEFAULT now(), ` +
        `"deleted_at" TIMESTAMP, ` +
        `"user_id" uuid NOT NULL, ` +
        `"tenant_id" uuid NOT NULL, ` +
        `"status" "public"."building_join_requests_status_enum" NOT NULL DEFAULT 'pending', ` +
        `"unit" character varying, ` +
        `"phone" character varying, ` +
        `"note" text, ` +
        `"reviewed_by" uuid, ` +
        `"reviewed_at" TIMESTAMP, ` +
        `"decision_note" text, ` +
        `CONSTRAINT "PK_building_join_requests_id" PRIMARY KEY ("id")` +
        `)`,
    );

    // ADD CONSTRAINT has no IF NOT EXISTS, so each FK is probed first.
    // ON DELETE CASCADE mirrors the entity's @ManyToOne({ onDelete: 'CASCADE' });
    // both parents are soft-deleted in normal operation, so this only fires on a
    // genuine hard delete.
    await this.addForeignKeyIfMissing(
      queryRunner,
      'FK_building_join_requests_user',
      `ALTER TABLE "building_join_requests" ADD CONSTRAINT "FK_building_join_requests_user" ` +
        `FOREIGN KEY ("user_id") REFERENCES "gate_users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await this.addForeignKeyIfMissing(
      queryRunner,
      'FK_building_join_requests_tenant',
      `ALTER TABLE "building_join_requests" ADD CONSTRAINT "FK_building_join_requests_tenant" ` +
        `FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // The admin queue reads by (tenant, status); the requester's own lookup and
    // the duplicate-request check read by (user, status).
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_building_join_requests_tenant_status" ` +
        `ON "building_join_requests" ("tenant_id", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_building_join_requests_user_status" ` +
        `ON "building_join_requests" ("user_id", "status")`,
    );

    // A user may have at most one request in flight. Enforced in the database as
    // well as the service, because two concurrent submits would otherwise both
    // pass the service's existence check. Partial so that resolved requests stay
    // as history and a rejected user can apply again.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_building_join_requests_one_pending_per_user" ` +
        `ON "building_join_requests" ("user_id") WHERE "status" = 'pending' AND "deleted_at" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const hasTable = await queryRunner.hasTable('building_join_requests');
    if (!hasTable) {
      return;
    }

    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."UQ_building_join_requests_one_pending_per_user"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_building_join_requests_user_status"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_building_join_requests_tenant_status"`,
    );
    // The table owns the enum column, so it has to go before the type.
    await queryRunner.query(`DROP TABLE "building_join_requests"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."building_join_requests_status_enum"`);
  }

  private async addForeignKeyIfMissing(
    queryRunner: QueryRunner,
    constraintName: string,
    ddl: string,
  ): Promise<void> {
    const existing = await queryRunner.query(
      `SELECT 1 FROM information_schema.table_constraints ` +
        `WHERE constraint_name = $1 AND table_name = 'building_join_requests'`,
      [constraintName],
    );

    if (!existing || existing.length === 0) {
      await queryRunner.query(ddl);
    }
  }
}
