import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddDefaultPlanFields1775737000000 implements MigrationInterface {
  name = 'AddDefaultPlanFields1775737000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Columns may already exist via `synchronize` in non-production envs; guard each add.
    const table = await queryRunner.getTable('subscription_plans');

    if (!table?.columns.find((c) => c.name === 'is_default')) {
      await queryRunner.addColumn(
        'subscription_plans',
        new TableColumn({
          name: 'is_default',
          type: 'boolean',
          isNullable: false,
          default: false,
        }),
      );
    }

    if (!table?.columns.find((c) => c.name === 'is_system')) {
      await queryRunner.addColumn(
        'subscription_plans',
        new TableColumn({
          name: 'is_system',
          type: 'boolean',
          isNullable: false,
          default: false,
        }),
      );
    }

    if (!table?.columns.find((c) => c.name === 'default_validity_days')) {
      await queryRunner.addColumn(
        'subscription_plans',
        new TableColumn({
          name: 'default_validity_days',
          type: 'int',
          isNullable: true,
        }),
      );
    }

    // Partial unique index: at most ONE plan may have is_default = true.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "one_default_plan" ON "subscription_plans" ("is_default") WHERE "is_default" = true`,
    );

    // Idempotent seed of the system Default (Free) plan.
    // Insert only when no default plan exists yet; ignore a pre-existing name collision.
    // Limits/validity live in this row so super admin can retune without a deploy.
    await queryRunner.query(`
      INSERT INTO "subscription_plans"
        ("name", "description", "monthly_price", "yearly_price", "trial_days",
         "max_gates", "max_users", "max_vehicles", "max_visitor_passes_per_month",
         "log_retention_days", "display_order", "is_active", "is_public", "is_featured",
         "is_default", "is_system", "default_validity_days", "features")
      SELECT
        'Free', 'Default free plan auto-assigned to new buildings', 0, 0, 0,
        1, 3, 10, 20,
        7, 0, true, true, false,
        true, true, 60, '{}'::jsonb
      WHERE NOT EXISTS (SELECT 1 FROM "subscription_plans" WHERE "is_default" = true)
      ON CONFLICT ("name") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "one_default_plan"`);

    const table = await queryRunner.getTable('subscription_plans');

    if (table?.columns.find((c) => c.name === 'default_validity_days')) {
      await queryRunner.dropColumn('subscription_plans', 'default_validity_days');
    }
    if (table?.columns.find((c) => c.name === 'is_system')) {
      await queryRunner.dropColumn('subscription_plans', 'is_system');
    }
    if (table?.columns.find((c) => c.name === 'is_default')) {
      await queryRunner.dropColumn('subscription_plans', 'is_default');
    }
  }
}
