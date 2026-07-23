import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Makes rfid_cards polymorphic: a card belongs to EITHER a user OR a vehicle.
 * Purely additive and backward-compatible —
 *   - user_id becomes nullable (existing human cards keep their value);
 *   - vehicle_id is added (nullable FK to vehicles, ON DELETE CASCADE);
 *   - a CHECK enforces exactly one of user_id / vehicle_id.
 *
 * The intrinsic vehicles.rfid_uid column is NOT touched — vehicle cards recorded
 * here are ADDITIONAL scannable credentials, not a replacement for the primary tag.
 */
export class RfidCardsPolymorphic1775737300000 implements MigrationInterface {
  name = 'RfidCardsPolymorphic1775737300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Relax user_id to nullable (idempotent: dropping NOT NULL twice is a no-op).
    await queryRunner.query(
      `ALTER TABLE "rfid_cards" ALTER COLUMN "user_id" DROP NOT NULL`,
    );

    // 2. Add vehicle_id (guarded — dev `synchronize` may have added it already).
    const table = await queryRunner.getTable('rfid_cards');
    if (!table?.columns.find((c) => c.name === 'vehicle_id')) {
      await queryRunner.addColumn(
        'rfid_cards',
        new TableColumn({ name: 'vehicle_id', type: 'uuid', isNullable: true }),
      );
    }

    // 3. FK vehicle_id -> vehicles(id); deleting a vehicle removes its cards.
    const fk = await queryRunner.query(
      `SELECT 1 FROM information_schema.table_constraints
       WHERE constraint_name = 'FK_rfid_cards_vehicle' AND table_name = 'rfid_cards'`,
    );
    if (!fk.length) {
      await queryRunner.query(
        `ALTER TABLE "rfid_cards"
         ADD CONSTRAINT "FK_rfid_cards_vehicle"
         FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE CASCADE`,
      );
    }

    // 4. Exactly one holder. Existing rows (user_id set, vehicle_id null) pass.
    const chk = await queryRunner.query(
      `SELECT 1 FROM information_schema.table_constraints
       WHERE constraint_name = 'CHK_rfid_cards_one_holder' AND table_name = 'rfid_cards'`,
    );
    if (!chk.length) {
      await queryRunner.query(
        `ALTER TABLE "rfid_cards"
         ADD CONSTRAINT "CHK_rfid_cards_one_holder"
         CHECK ((("user_id" IS NOT NULL)::int + ("vehicle_id" IS NOT NULL)::int) = 1)`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "rfid_cards" DROP CONSTRAINT IF EXISTS "CHK_rfid_cards_one_holder"`,
    );
    await queryRunner.query(
      `ALTER TABLE "rfid_cards" DROP CONSTRAINT IF EXISTS "FK_rfid_cards_vehicle"`,
    );
    const table = await queryRunner.getTable('rfid_cards');
    if (table?.columns.find((c) => c.name === 'vehicle_id')) {
      await queryRunner.dropColumn('rfid_cards', 'vehicle_id');
    }
    // user_id is intentionally left nullable — re-adding NOT NULL would fail if
    // any vehicle-held cards exist.
  }
}
