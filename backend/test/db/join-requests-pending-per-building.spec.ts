import { DataSource } from 'typeorm';
import { JoinRequestsPendingPerBuilding1775740100000 } from '../../src/database/migrations/1775740100000-JoinRequestsPendingPerBuilding';
import { isUniqueViolation } from '../../src/database/pg-errors';
import { createTestDataSource, describeDb, rebuildSchema } from './test-data-source';
import { makeJoinRequest, makePerson, makePlan, makeTenant } from './fixtures';

describeDb('migration 1775740100000-JoinRequestsPendingPerBuilding', () => {
  let dataSource: DataSource;
  const migration = new JoinRequestsPendingPerBuilding1775740100000();

  beforeAll(async () => {
    dataSource = await createTestDataSource();
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  async function run(direction: 'up' | 'down'): Promise<void> {
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    try {
      await migration[direction](queryRunner);
    } finally {
      await queryRunner.release();
    }
  }

  async function indexNames(): Promise<string[]> {
    const rows: Array<{ indexname: string }> = await dataSource.query(
      `SELECT "indexname" FROM "pg_indexes" WHERE "tablename" = 'building_join_requests' ` +
        `AND "schemaname" = current_schema() ` +
        `AND "indexname" LIKE 'UQ_building_join_requests_one_pending%' ORDER BY 1`,
    );
    return rows.map((row) => row.indexname);
  }

  it('swaps the per-person index for the per-building one, idempotently', async () => {
    // Today's schema: the old per-person index, not the new one.
    await rebuildSchema(dataSource);
    await dataSource.query(
      `DROP INDEX IF EXISTS "public"."UQ_building_join_requests_one_pending_per_user_tenant"`,
    );
    await dataSource.query(
      `CREATE UNIQUE INDEX "UQ_building_join_requests_one_pending_per_user" ` +
        `ON "building_join_requests" ("user_id") WHERE "status" = 'pending' AND "deleted_at" IS NULL`,
    );

    await run('up');
    await run('up');

    expect(await indexNames()).toEqual(['UQ_building_join_requests_one_pending_per_user_tenant']);
  });

  it('allows pending requests to two buildings, not two to the same one', async () => {
    const plan = await makePlan(dataSource);
    const towerA = await makeTenant(dataSource, plan);
    const towerB = await makeTenant(dataSource, plan);
    const person = await makePerson(dataSource);

    await makeJoinRequest(dataSource, person, towerA);
    await makeJoinRequest(dataSource, person, towerB);

    const duplicate = await makeJoinRequest(dataSource, person, towerA).catch((error) => error);
    expect(
      isUniqueViolation(duplicate, 'UQ_building_join_requests_one_pending_per_user_tenant'),
    ).toBe(true);
  });

  it('refuses down() while someone has pending requests to two buildings', async () => {
    await expect(run('down')).rejects.toThrow('more than one building');
    expect(await indexNames()).toEqual(['UQ_building_join_requests_one_pending_per_user_tenant']);
  });
});
