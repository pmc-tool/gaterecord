import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPauseAndAuditLog1775730708595 implements MigrationInterface {
  name = 'AddPauseAndAuditLog1775730708595';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "tenants" ADD "is_paused" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE "tenants" ADD "paused_at" TIMESTAMP`);
    await queryRunner.query(`ALTER TABLE "tenants" ADD "pause_resumes_at" TIMESTAMP`);
    await queryRunner.query(`ALTER TABLE "tenants" ADD "pause_reason" character varying`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "tenants" DROP COLUMN "pause_reason"`);
    await queryRunner.query(`ALTER TABLE "tenants" DROP COLUMN "pause_resumes_at"`);
    await queryRunner.query(`ALTER TABLE "tenants" DROP COLUMN "paused_at"`);
    await queryRunner.query(`ALTER TABLE "tenants" DROP COLUMN "is_paused"`);
  }
}
