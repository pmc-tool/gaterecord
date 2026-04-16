import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

export class AddResidentIdToAccessEvents1775735000000 implements MigrationInterface {
  name = 'AddResidentIdToAccessEvents1775735000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Check if column already exists (may have been added via synchronize)
    const table = await queryRunner.getTable('access_events');
    const hasColumn = table?.columns.find((col) => col.name === 'resident_id');

    if (!hasColumn) {
      // Add resident_id column
      await queryRunner.addColumn(
        'access_events',
        new TableColumn({
          name: 'resident_id',
          type: 'uuid',
          isNullable: true,
        }),
      );
    }

    // Check if FK constraint exists
    const hasFk = table?.foreignKeys.find((fk) => fk.name === 'FK_access_events_resident_id');
    if (!hasFk) {
      // Add foreign key constraint
      await queryRunner.query(`
        ALTER TABLE "access_events" 
        ADD CONSTRAINT "FK_access_events_resident_id" 
        FOREIGN KEY ("resident_id") REFERENCES "users"("id") 
        ON DELETE SET NULL
      `);
    }

    // Check if index exists
    const hasIndex = table?.indices.find((idx) => idx.name === 'IDX_access_events_resident_timestamp');
    if (!hasIndex) {
      // Add index for fast RBAC filtering
      await queryRunner.createIndex(
        'access_events',
        new TableIndex({
          name: 'IDX_access_events_resident_timestamp',
          columnNames: ['resident_id', 'timestamp'],
        }),
      );
    }

    // Add composite index for subject lookup optimization
    const hasSubjectIndex = table?.indices.find((idx) => idx.name === 'IDX_access_events_subject_type_id');
    if (!hasSubjectIndex) {
      await queryRunner.createIndex(
        'access_events',
        new TableIndex({
          name: 'IDX_access_events_subject_type_id',
          columnNames: ['subject_type', 'subject_id'],
        }),
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Remove indexes
    await queryRunner.dropIndex('access_events', 'IDX_access_events_subject_type_id');
    await queryRunner.dropIndex('access_events', 'IDX_access_events_resident_timestamp');

    // Remove foreign key
    await queryRunner.query(`
      ALTER TABLE "access_events" 
      DROP CONSTRAINT "FK_access_events_resident_id"
    `);

    // Remove column
    await queryRunner.dropColumn('access_events', 'resident_id');
  }
}
