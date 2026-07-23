import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the global `users` mirror table (one row per human platform-wide),
 * synced from the upstream account service.
 *
 * Runs AFTER the migration that renames the gate-management `users` table to
 * `gate_users`, so the `users` name is free by the time this executes.
 */
export class CreateGlobalUsersTable1775736200000 implements MigrationInterface {
  name = 'CreateGlobalUsersTable1775736200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Guard: the table may already exist via synchronize in non-production envs.
    const hasTable = await queryRunner.hasTable('users');
    if (hasTable) {
      return;
    }

    await queryRunner.query(
      `CREATE TABLE "users" ("id" uuid NOT NULL, "email" character varying NOT NULL, "user_meta" jsonb, "is_active" boolean NOT NULL DEFAULT true, "synced_at" TIMESTAMP, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_users_id" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_users_email" ON "users" ("email") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const hasTable = await queryRunner.hasTable('users');
    if (!hasTable) {
      return;
    }

    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_users_email"`);
    await queryRunner.query(`DROP TABLE "users"`);
  }
}
