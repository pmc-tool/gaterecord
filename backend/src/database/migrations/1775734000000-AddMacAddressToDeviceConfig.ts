import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMacAddressToDeviceConfig1775734000000 implements MigrationInterface {
  name = 'AddMacAddressToDeviceConfig1775734000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "device_configs" 
      ADD COLUMN IF NOT EXISTS "mac_address" VARCHAR(17) NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "device_configs" 
      DROP COLUMN IF EXISTS "mac_address"
    `);
  }
}
