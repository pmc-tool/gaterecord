import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPaymentsTable1775731607422 implements MigrationInterface {
  name = 'AddPaymentsTable1775731607422';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."payments_transaction_type_enum" AS ENUM('charge', 'refund', 'credit', 'chargeback', 'adjustment')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."payments_payment_type_enum" AS ENUM('subscription', 'one_time', 'setup_fee', 'upgrade', 'downgrade_credit')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."payments_status_enum" AS ENUM('succeeded', 'pending', 'failed', 'refunded', 'partially_refunded', 'canceled', 'disputed')`,
    );
    await queryRunner.query(
      `CREATE TABLE "payments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenant_id" uuid NOT NULL, "subscription_plan_id" uuid, "stripe_payment_intent_id" character varying, "stripe_charge_id" character varying, "stripe_invoice_id" character varying, "stripe_refund_id" character varying, "stripe_subscription_id" character varying, "transaction_type" "public"."payments_transaction_type_enum" NOT NULL, "payment_type" "public"."payments_payment_type_enum" NOT NULL, "status" "public"."payments_status_enum" NOT NULL DEFAULT 'pending', "amount" numeric(10,2) NOT NULL, "net_amount" numeric(10,2), "fee_amount" numeric(10,2), "tax_amount" numeric(10,2), "refunded_amount" numeric(10,2) NOT NULL DEFAULT '0', "currency" character varying(3) NOT NULL DEFAULT 'usd', "billing_period_start" TIMESTAMP, "billing_period_end" TIMESTAMP, "billing_cycle" character varying, "payment_method_type" character varying, "payment_method_last4" character varying, "payment_method_brand" character varying, "description" character varying, "failure_reason" character varying, "refund_reason" character varying, "metadata" jsonb, "customer_email" character varying, "customer_name" character varying, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "paid_at" TIMESTAMP, "refunded_at" TIMESTAMP, CONSTRAINT "PK_197ab7af18c93fbb0c9b28b4a59" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_32b41cdb985a296213e9a928b5" ON "payments" ("status") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_1237daf748b7653a6ebb9492fe" ON "payments" ("created_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_5c872c09b4966e5a3d9d777486" ON "payments" ("stripe_charge_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_f286ef7a954505c6013990086b" ON "payments" ("stripe_payment_intent_id") WHERE "stripe_payment_intent_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_6c039ced2230e9c06f2a872000" ON "payments" ("tenant_id", "created_at") `,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ADD CONSTRAINT "FK_9109b53fca5cef7720aca72974d" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ADD CONSTRAINT "FK_0c024bdfc636885d3ce044cd290" FOREIGN KEY ("subscription_plan_id") REFERENCES "subscription_plans"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "payments" DROP CONSTRAINT "FK_0c024bdfc636885d3ce044cd290"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" DROP CONSTRAINT "FK_9109b53fca5cef7720aca72974d"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_6c039ced2230e9c06f2a872000"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_f286ef7a954505c6013990086b"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_5c872c09b4966e5a3d9d777486"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_1237daf748b7653a6ebb9492fe"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_32b41cdb985a296213e9a928b5"`);
    await queryRunner.query(`DROP TABLE "payments"`);
    await queryRunner.query(`DROP TYPE "public"."payments_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."payments_payment_type_enum"`);
    await queryRunner.query(`DROP TYPE "public"."payments_transaction_type_enum"`);
  }
}
