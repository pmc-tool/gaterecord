import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Join requests: one pending request per person PER BUILDING, instead of one per
 * person overall.
 *
 * A person can now hold roles in several buildings, so they may also ask to join
 * several at once; what stays forbidden is two pending requests to the same
 * building. Replaces UQ_building_join_requests_one_pending_per_user (user_id)
 * with UQ_building_join_requests_one_pending_per_user_tenant (user_id,
 * tenant_id), both partial on status = 'pending' AND deleted_at IS NULL.
 *
 * The new index is created BEFORE the old one is dropped, so there is no moment
 * without a database-level guard. Existing data always satisfies the new index,
 * because the old one was stricter. The service still refuses a second pending
 * request per person until the join flow itself is changed, so this can ship
 * early. Both steps are idempotent (IF [NOT] EXISTS).
 */
export class JoinRequestsPendingPerBuilding1775740100000 implements MigrationInterface {
  name = 'JoinRequestsPendingPerBuilding1775740100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const hasTable = await queryRunner.hasTable('building_join_requests');
    if (!hasTable) {
      return;
    }

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_building_join_requests_one_pending_per_user_tenant" ` +
        `ON "building_join_requests" ("user_id", "tenant_id") ` +
        `WHERE "status" = 'pending' AND "deleted_at" IS NULL`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."UQ_building_join_requests_one_pending_per_user"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const hasTable = await queryRunner.hasTable('building_join_requests');
    if (!hasTable) {
      return;
    }

    // The old index allows one pending request per person in total. Refuse
    // rather than fail halfway or pick which of someone's requests to cancel.
    const duplicates: Array<{ user_id: string }> = await queryRunner.query(
      `SELECT "user_id" FROM "building_join_requests" ` +
        `WHERE "status" = 'pending' AND "deleted_at" IS NULL ` +
        `GROUP BY "user_id" HAVING COUNT(*) > 1 LIMIT 5`,
    );
    if (duplicates.length > 0) {
      throw new Error(
        'Cannot revert JoinRequestsPendingPerBuilding: some people have pending requests to ' +
          `more than one building (for example gate_users.id ${duplicates
            .map((row) => row.user_id)
            .join(', ')}). Resolve or cancel the extra requests first.`,
      );
    }

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_building_join_requests_one_pending_per_user" ` +
        `ON "building_join_requests" ("user_id") WHERE "status" = 'pending' AND "deleted_at" IS NULL`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."UQ_building_join_requests_one_pending_per_user_tenant"`,
    );
  }
}
