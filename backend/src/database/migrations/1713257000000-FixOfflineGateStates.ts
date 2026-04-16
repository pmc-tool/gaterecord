import { MigrationInterface, QueryRunner } from 'typeorm';

export class FixOfflineGateStates1713257000000 implements MigrationInterface {
  name = 'FixOfflineGateStates1713257000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Fix all offline gates that have stale state (anything other than CLOSED)
    // When a gate is offline, we don't know its actual state, so reset to CLOSED (secure default)
    const result = await queryRunner.query(`
      UPDATE gates 
      SET state = 'CLOSED' 
      WHERE is_online = false AND state != 'CLOSED'
      RETURNING id, name, state
    `);
    
    console.log('Fixed offline gates with stale state:', result);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Cannot revert - we don't know what the previous states were
    console.log('Cannot revert gate states - no action taken');
  }
}
