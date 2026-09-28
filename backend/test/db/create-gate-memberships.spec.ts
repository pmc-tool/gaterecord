import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { CreateGateMemberships1775740000000 } from '../../src/database/migrations/1775740000000-CreateGateMemberships';
import { Tenant } from '../../src/database/entities/tenant.entity';
import { User, UserRole, UserStatus } from '../../src/database/entities/user.entity';
import { createTestDataSource, describeDb, rebuildSchema } from './test-data-source';
import { makeMembership, makePerson, makePlan, makeTenant } from './fixtures';

interface MembershipRow {
  user_id: string;
  tenant_id: string;
  role: string;
  status: string;
  unit: string | null;
  deleted_at: Date | null;
}

describeDb('migration 1775740000000-CreateGateMemberships', () => {
  let dataSource: DataSource;
  const migration = new CreateGateMemberships1775740000000();

  beforeAll(async () => {
    dataSource = await createTestDataSource();
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  /** Runs up() or down() in one transaction, as migration:run does. */
  async function run(direction: 'up' | 'down'): Promise<void> {
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      await migration[direction](queryRunner);
      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /** Today's schema: everything synchronize builds, minus gate_memberships. */
  async function preMigrationSchema(): Promise<void> {
    await rebuildSchema(dataSource);
    await dataSource.query(`DROP TABLE "gate_memberships"`);
    await dataSource.query(`DROP TYPE "public"."gate_memberships_role_enum"`);
    await dataSource.query(`DROP TYPE "public"."gate_memberships_status_enum"`);
  }

  async function memberships(): Promise<MembershipRow[]> {
    return dataSource.query(
      `SELECT "user_id", "tenant_id", "role"::text AS "role", "status"::text AS "status", ` +
        `"unit", "deleted_at" FROM "gate_memberships" ORDER BY "user_id", "tenant_id"`,
    );
  }

  async function schemaNames() {
    const constraints = await dataSource.query(
      `SELECT "conname" FROM "pg_constraint" ` +
        `WHERE "conrelid" = to_regclass('public.gate_memberships') ORDER BY 1`,
    );
    // Scoped to the current schema, so another schema in the same test database
    // (with its own gate_memberships) is not counted.
    const indexes = await dataSource.query(
      `SELECT "indexname", "indexdef" FROM "pg_indexes" ` +
        `WHERE "tablename" = 'gate_memberships' AND "schemaname" = current_schema() ORDER BY 1`,
    );
    const enums = await dataSource.query(
      `SELECT "typname" FROM "pg_type" WHERE "typname" LIKE 'gate_memberships_%' ` +
        `AND "typnamespace" = to_regnamespace(current_schema()) ORDER BY 1`,
    );
    return { constraints, indexes, enums };
  }

  /** One legacy row per backfill case. */
  async function legacyRows() {
    const plan = await makePlan(dataSource);
    const tower = await makeTenant(dataSource, plan);
    const gone = await makeTenant(dataSource, plan);

    const rows = {
      admin: await makePerson(dataSource, { tenantId: tower.id, role: UserRole.BUILDING_ADMIN }),
      resident: await makePerson(dataSource, {
        tenantId: tower.id,
        role: UserRole.RESIDENT,
        unit: '12B',
      }),
      security: await makePerson(dataSource, { tenantId: tower.id, role: UserRole.SECURITY }),
      staff: await makePerson(dataSource, { tenantId: tower.id, role: UserRole.STAFF }),
      pending: await makePerson(dataSource, {
        tenantId: tower.id,
        role: UserRole.RESIDENT,
        status: UserStatus.PENDING,
      }),
      inactive: await makePerson(dataSource, {
        tenantId: tower.id,
        role: UserRole.RESIDENT,
        status: UserStatus.INACTIVE,
      }),
      superAdmin: await makePerson(dataSource, {
        tenantId: tower.id,
        role: UserRole.SUPER_ADMIN,
      }),
      tenantless: await makePerson(dataSource, { tenantId: null }),
      deletedPerson: await makePerson(dataSource, { tenantId: tower.id, role: UserRole.RESIDENT }),
      inDeletedTower: await makePerson(dataSource, { tenantId: gone.id, role: UserRole.RESIDENT }),
      dangling: await makePerson(dataSource, { tenantId: null, role: UserRole.RESIDENT }),
    };

    await dataSource.getRepository(User).softDelete(rows.deletedPerson.id);
    await dataSource.getRepository(Tenant).softDelete(gone.id);

    // A tenant id with no tenants row: only possible without the FK, which old
    // data predates.
    const [fk] = await dataSource.query(
      `SELECT tc.constraint_name AS "name" FROM information_schema.table_constraints tc ` +
        `JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name ` +
        `AND kcu.table_schema = tc.table_schema ` +
        `WHERE tc.table_name = 'gate_users' AND tc.constraint_type = 'FOREIGN KEY' ` +
        `AND tc.table_schema = current_schema() AND kcu.column_name = 'tenant_id'`,
    );
    if (fk) {
      await dataSource.query(`ALTER TABLE "gate_users" DROP CONSTRAINT "${fk.name}"`);
    }
    await dataSource.query(`UPDATE "gate_users" SET "tenant_id" = $1 WHERE "id" = $2`, [
      randomUUID(),
      rows.dangling.id,
    ]);

    return { tower, gone, rows };
  }

  it('backfills one membership per eligible row and nothing else', async () => {
    await preMigrationSchema();
    const { tower, gone, rows } = await legacyRows();

    await run('up');

    const byUser = new Map((await memberships()).map((row) => [row.user_id, row]));
    expect(byUser.get(rows.admin.id)).toMatchObject({
      tenant_id: tower.id,
      role: 'building_admin',
      status: 'active',
      deleted_at: null,
    });
    expect(byUser.get(rows.resident.id)).toMatchObject({ role: 'resident', unit: '12B' });
    expect(byUser.get(rows.security.id)).toMatchObject({ role: 'security' });
    expect(byUser.get(rows.staff.id)).toMatchObject({ role: 'staff' });
    expect(byUser.get(rows.pending.id)).toMatchObject({ status: 'pending' });
    expect(byUser.get(rows.inactive.id)).toMatchObject({ status: 'inactive' });

    const [goneTower] = await dataSource.query(
      `SELECT "deleted_at" FROM "tenants" WHERE "id" = $1`,
      [gone.id],
    );
    expect(byUser.get(rows.inDeletedTower.id)?.deleted_at).toEqual(goneTower.deleted_at);

    for (const excluded of [rows.superAdmin, rows.tenantless, rows.deletedPerson, rows.dangling]) {
      expect(byUser.has(excluded.id)).toBe(false);
    }
    expect(byUser.size).toBe(7);
  });

  it('inserts nothing on a second run', async () => {
    const before = await memberships();
    await run('up');
    expect(await memberships()).toEqual(before);
  });

  it('round-trips down() then up()', async () => {
    const before = await memberships();
    await run('down');
    expect(await dataSource.query(`SELECT to_regclass('public.gate_memberships') AS "t"`)).toEqual([
      { t: null },
    ]);
    await run('up');
    expect(await memberships()).toEqual(before);
  });

  it('aborts when an eligible row is left without a live membership', async () => {
    const [someone] = await dataSource.query(
      `SELECT "m"."user_id" FROM "gate_memberships" "m" ` +
        `JOIN "tenants" "t" ON "t"."id" = "m"."tenant_id" ` +
        `WHERE "m"."deleted_at" IS NULL AND "t"."deleted_at" IS NULL LIMIT 1`,
    );
    await dataSource.query(
      `UPDATE "gate_memberships" SET "deleted_at" = now() WHERE "user_id" = $1`,
      [someone.user_id],
    );

    await expect(run('up')).rejects.toThrow('have no live membership');

    await dataSource.query(
      `UPDATE "gate_memberships" SET "deleted_at" = NULL WHERE "user_id" = $1`,
      [someone.user_id],
    );
  });

  it('refuses down() while a person has two live memberships', async () => {
    const plan = await makePlan(dataSource);
    const first = await makeTenant(dataSource, plan);
    const second = await makeTenant(dataSource, plan);
    const person = await makePerson(dataSource, { tenantId: first.id, role: UserRole.RESIDENT });
    await makeMembership(dataSource, person, first);
    await makeMembership(dataSource, person, second);

    await expect(run('down')).rejects.toThrow('more than one building');
  });

  it('builds the same PK, FK, index and enum names as synchronize', async () => {
    await rebuildSchema(dataSource);
    const synchronized = await schemaNames();

    await preMigrationSchema();
    await run('up');
    const migrated = await schemaNames();

    expect(migrated).toEqual(synchronized);
    expect(migrated.constraints.map((row: { conname: string }) => row.conname)).toEqual([
      'FK_gate_memberships_tenant',
      'FK_gate_memberships_user',
      'PK_gate_memberships_id',
    ]);
  });
});
