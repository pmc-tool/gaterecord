import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Building structure — floors and the flats on them, edited by a building admin
 * from Building Settings.
 *
 * Purely additive: two new tables, nothing existing is altered. Residents keep
 * their free-text `gate_users.unit`, so down() is a clean drop.
 *
 * Every step is independently idempotent, because outside production
 * `synchronize` may already have built either table. The unique indexes use the
 * same names as the entities' @Index declarations so the two paths converge on
 * one index rather than two. Foreign keys are probed by COLUMN rather than by
 * name: synchronize names its FKs with a hash, and probing by our name would add
 * a duplicate FK beside it.
 */
export class CreateBuildingFloorsAndFlats1775739000000 implements MigrationInterface {
  name = 'CreateBuildingFloorsAndFlats1775739000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "building_floors" (` +
        `"id" uuid NOT NULL DEFAULT uuid_generate_v4(), ` +
        `"created_at" TIMESTAMP NOT NULL DEFAULT now(), ` +
        `"updated_at" TIMESTAMP NOT NULL DEFAULT now(), ` +
        `"deleted_at" TIMESTAMP, ` +
        `"tenant_id" uuid NOT NULL, ` +
        `"floor_number" integer NOT NULL, ` +
        `"name" character varying(60), ` +
        `CONSTRAINT "PK_building_floors_id" PRIMARY KEY ("id")` +
        `)`,
    );

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "building_flats" (` +
        `"id" uuid NOT NULL DEFAULT uuid_generate_v4(), ` +
        `"created_at" TIMESTAMP NOT NULL DEFAULT now(), ` +
        `"updated_at" TIMESTAMP NOT NULL DEFAULT now(), ` +
        `"deleted_at" TIMESTAMP, ` +
        `"tenant_id" uuid NOT NULL, ` +
        `"floor_id" uuid NOT NULL, ` +
        `"flat_number" character varying(20) NOT NULL, ` +
        `"flat_key" character varying(20) NOT NULL, ` +
        `CONSTRAINT "PK_building_flats_id" PRIMARY KEY ("id")` +
        `)`,
    );

    // ON DELETE CASCADE mirrors the entities. Tenants are soft-deleted in normal
    // operation, so the tenant FKs only fire on a genuine hard delete; the floor
    // FK fires whenever an admin removes a floor, taking its flats with it.
    await this.addForeignKeyIfMissing(
      queryRunner,
      'building_floors',
      'tenant_id',
      `ALTER TABLE "building_floors" ADD CONSTRAINT "FK_building_floors_tenant" ` +
        `FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await this.addForeignKeyIfMissing(
      queryRunner,
      'building_flats',
      'tenant_id',
      `ALTER TABLE "building_flats" ADD CONSTRAINT "FK_building_flats_tenant" ` +
        `FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await this.addForeignKeyIfMissing(
      queryRunner,
      'building_flats',
      'floor_id',
      `ALTER TABLE "building_flats" ADD CONSTRAINT "FK_building_flats_floor" ` +
        `FOREIGN KEY ("floor_id") REFERENCES "building_floors"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // One "Floor 3" per building; one "4B" per building (case/space-insensitive
    // via flat_key). The service checks both first for a friendly message; these
    // are the guard against two concurrent saves.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_building_floors_tenant_floor_number" ` +
        `ON "building_floors" ("tenant_id", "floor_number")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_building_flats_tenant_flat_key" ` +
        `ON "building_flats" ("tenant_id", "flat_key")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_building_flats_floor" ON "building_flats" ("floor_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Flats reference floors, so they go first.
    await queryRunner.query(`DROP TABLE IF EXISTS "building_flats"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "building_floors"`);
  }

  private async addForeignKeyIfMissing(
    queryRunner: QueryRunner,
    table: string,
    column: string,
    ddl: string,
  ): Promise<void> {
    const existing = await queryRunner.query(
      `SELECT 1 FROM information_schema.table_constraints tc ` +
        `JOIN information_schema.key_column_usage kcu ` +
        `ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema ` +
        `WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = $1 AND kcu.column_name = $2`,
      [table, column],
    );

    if (!existing || existing.length === 0) {
      await queryRunner.query(ddl);
    }
  }
}
