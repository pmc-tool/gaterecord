import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Adds tenants.has_used_paid_plan — a one-way latch that marks a building as
 * having consumed its one-time free/default plan by ever paying for a real plan.
 * Once true it never resets, so the free tier can be permanently shown as
 * "used" and blocked from re-selection.
 *
 * Backfill marks every tenant that has ALREADY paid, so the rule applies to
 * existing customers too:
 *   (a) currently sits on a non-default plan with a live Stripe subscription, OR
 *   (b) has any succeeded charge in the payments ledger (covers those who paid
 *       then cancelled and are now suspended with no live subscription).
 */
export class AddHasUsedPaidPlan1775737200000 implements MigrationInterface {
  name = 'AddHasUsedPaidPlan1775737200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Column may already exist via `synchronize` in dev — guard the add.
    const table = await queryRunner.getTable('tenants');
    if (!table?.columns.find((c) => c.name === 'has_used_paid_plan')) {
      await queryRunner.addColumn(
        'tenants',
        new TableColumn({
          name: 'has_used_paid_plan',
          type: 'boolean',
          isNullable: false,
          default: false,
        }),
      );
    }

    // (a) Tenants on a paid (non-default) plan with a live Stripe subscription.
    await queryRunner.query(`
      UPDATE "tenants" t
      SET "has_used_paid_plan" = true
      FROM "subscription_plans" sp
      WHERE t."subscription_plan_id" = sp."id"
        AND sp."is_default" = false
        AND t."stripe_subscription_id" IS NOT NULL
    `);

    // (b) Tenants with any succeeded charge — they paid at least once, even if
    // they later cancelled. Guarded by table existence so a fresh DB without a
    // payments table (shouldn't happen in practice) does not fail the migration.
    const hasPayments = await queryRunner.hasTable('payments');
    if (hasPayments) {
      await queryRunner.query(`
        UPDATE "tenants" t
        SET "has_used_paid_plan" = true
        WHERE EXISTS (
          SELECT 1 FROM "payments" p
          WHERE p."tenant_id" = t."id"
            AND p."transaction_type" = 'charge'
            AND p."status" = 'succeeded'
            AND p."amount" > 0
        )
    `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('tenants');
    if (table?.columns.find((c) => c.name === 'has_used_paid_plan')) {
      await queryRunner.dropColumn('tenants', 'has_used_paid_plan');
    }
  }
}
