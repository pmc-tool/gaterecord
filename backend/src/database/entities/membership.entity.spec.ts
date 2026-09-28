import * as path from 'path';
import { DataSource } from 'typeorm';
import { UserRole, UserStatus } from './user.entity';
import { MEMBERSHIP_ROLES, Membership, SELECTABLE_ROLES } from './membership.entity';

/**
 * Builds TypeORM metadata for every entity WITHOUT connecting, and checks that
 * gate_memberships as `synchronize` would build it carries exactly the names
 * migration 1775740000000-CreateGateMemberships creates, so the two paths
 * converge on one set of objects.
 */
describe('Membership entity metadata', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      url: process.env.DATABASE_URL,
      entities: [path.join(__dirname, '*.entity.ts')],
    });
    // Metadata only; initialize() would connect.
    await (dataSource as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
  });

  const membership = () => dataSource.getMetadata(Membership);

  it('pins the table, primary key and enum names', () => {
    const metadata = membership();
    expect(metadata.tableName).toBe('gate_memberships');
    expect(metadata.primaryColumns.map((column) => column.primaryKeyConstraintName)).toEqual([
      'PK_gate_memberships_id',
    ]);
    expect(metadata.findColumnWithPropertyName('role')?.enumName).toBe(
      'gate_memberships_role_enum',
    );
    expect(metadata.findColumnWithPropertyName('status')?.enumName).toBe(
      'gate_memberships_status_enum',
    );
    expect(metadata.findColumnWithPropertyName('status')?.default).toBe(UserStatus.ACTIVE);
  });

  it('pins the foreign key names and cascades', () => {
    const foreignKeys = membership()
      .foreignKeys.map((fk) => ({ name: fk.name, columns: fk.columnNames, onDelete: fk.onDelete }))
      .sort((a, b) => a.name.localeCompare(b.name));
    expect(foreignKeys).toEqual([
      { name: 'FK_gate_memberships_tenant', columns: ['tenant_id'], onDelete: 'CASCADE' },
      { name: 'FK_gate_memberships_user', columns: ['user_id'], onDelete: 'CASCADE' },
    ]);
  });

  it('pins the index names, the partial unique index and the column order', () => {
    const indices = membership()
      .indices.map((index) => ({
        name: index.name,
        columns: index.columns.map((column) => column.databaseName),
        unique: index.isUnique,
        where: index.where ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    expect(indices).toEqual([
      {
        name: 'IDX_gate_memberships_tenant_role_status',
        columns: ['tenant_id', 'role', 'status'],
        unique: false,
        where: null,
      },
      { name: 'IDX_gate_memberships_user', columns: ['user_id'], unique: false, where: null },
      {
        name: 'UQ_gate_memberships_user_tenant',
        columns: ['user_id', 'tenant_id'],
        unique: true,
        where: '"deleted_at" IS NULL',
      },
    ]);
  });

  it('never persists memberships through User or Tenant', () => {
    for (const [entity, property] of [
      ['User', 'memberships'],
      ['Tenant', 'memberships'],
    ]) {
      const relation = dataSource.getMetadata(entity).findRelationWithPropertyPath(property);
      expect(relation?.inverseEntityMetadata.target).toBe(Membership);
      expect(relation?.persistenceEnabled).toBe(false);
    }
    for (const property of ['user', 'tenant']) {
      expect(membership().findRelationWithPropertyPath(property)?.orphanedRowAction).toBe(
        'disable',
      );
    }
  });

  it('declares the per-building pending join request index', () => {
    const index = dataSource
      .getMetadata('BuildingJoinRequest')
      .indices.find(
        (candidate) => candidate.name === 'UQ_building_join_requests_one_pending_per_user_tenant',
      );
    expect(index?.isUnique).toBe(true);
    expect(index?.columns.map((column) => column.databaseName)).toEqual(['user_id', 'tenant_id']);
    expect(index?.where).toBe(`"status" = 'pending' AND "deleted_at" IS NULL`);
  });

  it('uses the same string values as UserRole, without super_admin', () => {
    expect(MEMBERSHIP_ROLES).toEqual(['building_admin', 'resident', 'security', 'staff']);
    expect(MEMBERSHIP_ROLES).not.toContain(UserRole.SUPER_ADMIN);
    expect(SELECTABLE_ROLES).toEqual(MEMBERSHIP_ROLES);
  });
});
