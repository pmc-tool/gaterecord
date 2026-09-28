import { DataSource } from 'typeorm';
import { MembershipAccessService } from '../../src/modules/memberships/membership-access.service';
import {
  CARD_ISSUE_ROLES,
  PERSONAL_QR_ROLES,
  VEHICLE_OWNER_ROLES,
} from '../../src/modules/memberships/membership-access.constants';
import { Membership } from '../../src/database/entities/membership.entity';
import { Tenant } from '../../src/database/entities/tenant.entity';
import { User, UserRole, UserStatus } from '../../src/database/entities/user.entity';
import { createTestDataSource, describeDb, rebuildSchema } from './test-data-source';
import { makeMembership, makePerson, makePlan, makeTenant } from './fixtures';

describeDb('MembershipAccessService (database)', () => {
  const originalFlag = process.env.GATE_MEMBERSHIP_CONTEXT;
  let dataSource: DataSource;
  let service: MembershipAccessService;
  let towers: Record<'A' | 'B' | 'C' | 'D', Tenant>;
  let p: User;
  let inB: Membership;

  beforeAll(async () => {
    dataSource = await createTestDataSource();
    await rebuildSchema(dataSource);
    service = new MembershipAccessService(dataSource);

    const plan = await makePlan(dataSource);
    towers = {
      A: await makeTenant(dataSource, plan),
      B: await makeTenant(dataSource, plan),
      C: await makeTenant(dataSource, plan),
      D: await makeTenant(dataSource, plan),
    };

    // P: admin of A (the legacy row points there), resident of B, security of C.
    p = await makePerson(dataSource, { tenantId: towers.A.id, role: UserRole.BUILDING_ADMIN });
    await makeMembership(dataSource, p, towers.A, { role: UserRole.BUILDING_ADMIN });
    inB = await makeMembership(dataSource, p, towers.B, { role: UserRole.RESIDENT, unit: '12B' });
    await makeMembership(dataSource, p, towers.C, { role: UserRole.SECURITY });
  });

  afterAll(async () => {
    process.env.GATE_MEMBERSHIP_CONTEXT = originalFlag;
    await dataSource?.destroy();
  });

  const reasonAt = async (tower: Tenant) =>
    (await service.checkHolder(p.id, tower.id, { roles: PERSONAL_QR_ROLES })).reason;

  it('allows A, B and C and says NO_MEMBERSHIP for D', async () => {
    process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
    expect(await reasonAt(towers.A)).toBeNull();
    expect(await reasonAt(towers.B)).toBeNull();
    expect(await reasonAt(towers.C)).toBeNull();
    expect(await reasonAt(towers.D)).toBe('NO_MEMBERSHIP');

    const atB = await service.checkHolder(p.id, towers.B.id, { roles: VEHICLE_OWNER_ROLES });
    expect(atB).toMatchObject({ allowed: true, unit: '12B', role: UserRole.RESIDENT });
    expect(await service.hasActiveMembership(p.id, towers.A.id, CARD_ISSUE_ROLES)).toBe(false);
  });

  it('denies only B while B is inactive', async () => {
    process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
    await dataSource.getRepository(Membership).update(inB.id, { status: UserStatus.INACTIVE });

    expect(await reasonAt(towers.B)).toBe('MEMBERSHIP_INACTIVE');
    expect(await reasonAt(towers.A)).toBeNull();
    expect(await reasonAt(towers.C)).toBeNull();

    await dataSource.getRepository(Membership).update(inB.id, { status: UserStatus.ACTIVE });
  });

  it('denies everywhere while the person is banned', async () => {
    process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
    await dataSource.getRepository(User).update(p.id, { status: UserStatus.INACTIVE });

    for (const tower of Object.values(towers)) {
      expect(await reasonAt(tower)).toBe('ACCOUNT_BANNED');
    }

    await dataSource.getRepository(User).update(p.id, { status: UserStatus.ACTIVE });
  });

  it('ignores memberships in a deleted building', async () => {
    process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
    await dataSource.getRepository(Tenant).softDelete(towers.C.id);
    expect(await reasonAt(towers.C)).toBe('NO_MEMBERSHIP');
    await dataSource.getRepository(Tenant).restore(towers.C.id);
  });

  it('with the flag off, matches the legacy gate_users row', async () => {
    process.env.GATE_MEMBERSHIP_CONTEXT = 'off';
    expect(await reasonAt(towers.A)).toBeNull();
    expect(await reasonAt(towers.B)).toBe('NO_MEMBERSHIP');
  });

  it('returns each recipient once and admin emails per building', async () => {
    const other = await makePerson(dataSource);
    await makeMembership(dataSource, other, towers.A, { role: UserRole.SECURITY });

    expect(
      await service.findActivePersonIds(towers.A.id, [UserRole.BUILDING_ADMIN, UserRole.SECURITY]),
    ).toEqual([p.id, other.id].sort());

    const emails = await service.findTenantAdminEmails([towers.A.id, towers.D.id]);
    expect(emails.get(towers.A.id)).toEqual([p.email]);
    expect(emails.get(towers.D.id)).toEqual([]);

    const members = await service.findTenantMembers(towers.A.id);
    expect(members.map((membership) => membership.user.id).sort()).toEqual([p.id, other.id].sort());
  });
});
