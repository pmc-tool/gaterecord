import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRefundEnumTypes1775731214576 implements MigrationInterface {
  name = 'AddRefundEnumTypes1775731214576';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."subscription_audit_logs_event_type_enum" RENAME TO "subscription_audit_logs_event_type_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."subscription_audit_logs_event_type_enum" AS ENUM('subscription_created', 'subscription_activated', 'subscription_updated', 'subscription_canceled', 'subscription_expired', 'subscription_resumed', 'payment_succeeded', 'payment_failed', 'payment_refunded', 'payment_partial_refund', 'credit_issued', 'credit_applied', 'plan_upgraded', 'plan_downgraded', 'billing_cycle_changed', 'trial_started', 'trial_ending_soon', 'trial_ended', 'trial_converted', 'dunning_email_sent', 'account_suspended', 'account_reactivated', 'stripe_sync_completed', 'stripe_sync_failed')`,
    );
    await queryRunner.query(
      `ALTER TABLE "subscription_audit_logs" ALTER COLUMN "event_type" TYPE "public"."subscription_audit_logs_event_type_enum" USING "event_type"::"text"::"public"."subscription_audit_logs_event_type_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."subscription_audit_logs_event_type_enum_old"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."subscription_audit_logs_event_type_enum_old" AS ENUM('subscription_created', 'subscription_activated', 'subscription_updated', 'subscription_canceled', 'subscription_expired', 'subscription_resumed', 'payment_succeeded', 'payment_failed', 'payment_refunded', 'plan_upgraded', 'plan_downgraded', 'billing_cycle_changed', 'trial_started', 'trial_ending_soon', 'trial_ended', 'trial_converted', 'dunning_email_sent', 'account_suspended', 'account_reactivated', 'stripe_sync_completed', 'stripe_sync_failed')`,
    );
    await queryRunner.query(
      `ALTER TABLE "subscription_audit_logs" ALTER COLUMN "event_type" TYPE "public"."subscription_audit_logs_event_type_enum_old" USING "event_type"::"text"::"public"."subscription_audit_logs_event_type_enum_old"`,
    );
    await queryRunner.query(`DROP TYPE "public"."subscription_audit_logs_event_type_enum"`);
    await queryRunner.query(
      `ALTER TYPE "public"."subscription_audit_logs_event_type_enum_old" RENAME TO "subscription_audit_logs_event_type_enum"`,
    );
  }
}
