import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 6 — Webhook idempotency.
 *
 * Creates `processed_stripe_events`, a ledger of Stripe webhook event ids we
 * have already handled. The webhook entry point consults it before dispatching
 * and records the id after a handler succeeds, so Stripe's automatic retries /
 * duplicate deliveries are acknowledged without re-processing.
 */
export class AddProcessedStripeEvents1775737100000 implements MigrationInterface {
  name = 'AddProcessedStripeEvents1775737100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Guard: in non-production envs `synchronize` may already have created it.
    const hasTable = await queryRunner.hasTable('processed_stripe_events');
    if (hasTable) {
      return;
    }

    await queryRunner.query(
      `CREATE TABLE "processed_stripe_events" (` +
        `"id" uuid NOT NULL DEFAULT uuid_generate_v4(), ` +
        `"event_id" character varying NOT NULL, ` +
        `"type" character varying, ` +
        `"processed_at" TIMESTAMP NOT NULL DEFAULT now(), ` +
        `CONSTRAINT "PK_processed_stripe_events_id" PRIMARY KEY ("id"), ` +
        `CONSTRAINT "UQ_processed_stripe_events_event_id" UNIQUE ("event_id")` +
        `)`,
    );

    // Explicit unique index backs the fast idempotency lookup by event id.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_processed_stripe_events_event_id" ON "processed_stripe_events" ("event_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const hasTable = await queryRunner.hasTable('processed_stripe_events');
    if (!hasTable) {
      return;
    }

    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_processed_stripe_events_event_id"`);
    await queryRunner.query(`DROP TABLE "processed_stripe_events"`);
  }
}
