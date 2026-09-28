import { DataSource } from 'typeorm';
import { MembershipsService } from '../../src/modules/memberships/memberships.service';
import { MembershipContextService } from '../../src/modules/memberships/membership-context.service';
import { Membership } from '../../src/database/entities/membership.entity';
import { SubscriptionPlan } from '../../src/database/entities/subscription-plan.entity';
import { Tenant, TenantStatus } from '../../src/database/entities/tenant.entity';
import { User, UserRole, UserStatus } from '../../src/database/entities/user.entity';
import { JoinRequestStatus } from '../../src/database/entities/building-join-request.entity';
import { createTestDataSource, describeDb, rebuildSchema } from './test-data-source';
import { makeJoinRequest, makeMembership, makePerson, makePlan, makeTenant } from './fixtures';

/**
 * AUTH-5 / AUTH-9 against Postgres: the membership reads, GET /memberships/me
 * and the context resolver. What the unit specs stub is checked here: the
 * INNER JOIN drops soft-deleted buildings, soft-deleted memberships are never
 * returned, and the filters are the SQL ones.
 */
describeDb('Membership reads and context (database)', () => {
  const originalFlag = process.env.GATE_MEMBERSHIP_CONTEXT;
  let dataSource: DataSource;
  let service: MembershipsService;
  let context: MembershipContextService;
  let plan: SubscriptionPlan;

  beforeAll(async () => {
    dataSource = await createTestDataSource();
    await rebuildSchema(dataSource);
    service = new MembershipsService(dataSource);
    context = new MembershipContextService(service, dataSource.getRepository(Tenant));
    plan = await makePlan(dataSource);
  });

  beforeEach(() => {
    process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
  });

  afterAll(async () => {
    process.env.GATE_MEMBERSHIP_CONTEXT = originalFlag;
    await dataSource?.destroy();
  });

  /** The D1 person: admin of A, resident of B, security of C (suspended), plus history. */
  async function d1() {
    const person = await makePerson(dataSource);
    const a = await makeTenant(dataSource, plan, { name: `A Tower ${person.id.slice(0, 6)}` });
    const b = await makeTenant(dataSource, plan, { name: `B Tower ${person.id.slice(0, 6)}` });
    const c = await makeTenant(dataSource, plan, {
      name: `C Tower ${person.id.slice(0, 6)}`,
      status: TenantStatus.SUSPENDED,
    });
    const deletedBuilding = await makeTenant(dataSource, plan, {
      name: `D Tower ${person.id.slice(0, 6)}`,
    });
    const inactiveBuilding = await makeTenant(dataSource, plan, {
      name: `E Tower ${person.id.slice(0, 6)}`,
    });
    const endedBuilding = await makeTenant(dataSource, plan, {
      name: `F Tower ${person.id.slice(0, 6)}`,
    });

    const adminA = await makeMembership(dataSource, person, a, { role: UserRole.BUILDING_ADMIN });
    const residentB = await makeMembership(dataSource, person, b, {
      role: UserRole.RESIDENT,
      unit: '4C',
    });
    const securityC = await makeMembership(dataSource, person, c, { role: UserRole.SECURITY });
    const inDeleted = await makeMembership(dataSource, person, deletedBuilding, {
      role: UserRole.RESIDENT,
    });
    await dataSource.getRepository(Tenant).softDelete(deletedBuilding.id);
    const inactive = await makeMembership(dataSource, person, inactiveBuilding, {
      role: UserRole.RESIDENT,
      status: UserStatus.INACTIVE,
    });
    const ended = await makeMembership(dataSource, person, endedBuilding, {
      role: UserRole.SECURITY,
    });
    await dataSource.getRepository(Membership).softDelete(ended.id);

    return { person, a, b, c, adminA, residentB, securityC, inDeleted, inactive, ended };
  }

  describe('findOwnedWithTenant', () => {
    it('finds the own membership with its building, any status', async () => {
      const x = await d1();
      const found = await service.findOwnedWithTenant(x.securityC.id, x.person.id);
      expect(found).toMatchObject({ id: x.securityC.id, tenantId: x.c.id });
      expect(found?.tenant).toMatchObject({ id: x.c.id, status: TenantStatus.SUSPENDED });
      expect((await service.findOwnedWithTenant(x.inactive.id, x.person.id))?.status).toBe(
        UserStatus.INACTIVE,
      );
    });

    it("finds nothing for someone else's, an ended or a deleted-building membership", async () => {
      const x = await d1();
      const stranger = await makePerson(dataSource);
      expect(await service.findOwnedWithTenant(x.adminA.id, stranger.id)).toBeNull();
      expect(await service.findOwnedWithTenant(x.ended.id, x.person.id)).toBeNull();
      expect(await service.findOwnedWithTenant(x.inDeleted.id, x.person.id)).toBeNull();
      expect(await service.findOwnedWithTenant('not-a-uuid', x.person.id)).toBeNull();
    });
  });

  it('listActiveForPerson: active, selectable, live building (suspended included)', async () => {
    const x = await d1();
    const active = await service.listActiveForPerson(x.person.id);
    expect(active.map((m) => m.id).sort()).toEqual(
      [x.adminA.id, x.residentB.id, x.securityC.id].sort(),
    );
    expect(active.every((m) => m.tenant)).toBe(true);
  });

  it('listForPerson: every live membership in a live building, sorted by building name', async () => {
    const x = await d1();
    const all = await service.listForPerson(x.person.id);
    expect(all.map((m) => m.id)).toEqual([
      x.adminA.id,
      x.residentB.id,
      x.securityC.id,
      x.inactive.id,
    ]);
  });

  it('listPendingJoinRequests: pending only, live buildings only', async () => {
    const person = await makePerson(dataSource);
    const open = await makeTenant(dataSource, plan);
    const rejectedIn = await makeTenant(dataSource, plan);
    const gone = await makeTenant(dataSource, plan);
    const pending = await makeJoinRequest(dataSource, person, open);
    await makeJoinRequest(dataSource, person, rejectedIn, { status: JoinRequestStatus.REJECTED });
    await makeJoinRequest(dataSource, person, gone);
    await dataSource.getRepository(Tenant).softDelete(gone.id);

    const requests = await service.listPendingJoinRequests(person.id);
    expect(requests.map((r) => r.id)).toEqual([pending.id]);
    expect(requests[0].tenant.id).toBe(open.id);
  });

  it('findAdminMembership filters by person, building, status and building status', async () => {
    const person = await makePerson(dataSource);
    const pendingTower = await makeTenant(dataSource, plan, {
      status: TenantStatus.PENDING_PAYMENT,
    });
    const activeTower = await makeTenant(dataSource, plan);
    const admin = await makeMembership(dataSource, person, pendingTower, {
      role: UserRole.BUILDING_ADMIN,
    });
    await makeMembership(dataSource, person, activeTower, { role: UserRole.RESIDENT });

    const found = await service.findAdminMembership({
      personId: person.id,
      status: UserStatus.ACTIVE,
      tenantStatus: TenantStatus.PENDING_PAYMENT,
    });
    expect(found?.id).toBe(admin.id);
    expect(found?.user.id).toBe(person.id);
    expect(await service.findAdminMembership({ tenantId: activeTower.id })).toBeNull();
    expect(
      await service.findAdminMembership({ personId: person.id, status: UserStatus.INACTIVE }),
    ).toBeNull();
    await expect(service.findAdminMembership({})).rejects.toThrow('tenantId or a personId');
  });

  it('getMine builds the C4 body from the database', async () => {
    const x = await d1();
    const acting = await context.resolve(x.person, x.residentB.id);
    const body = await service.getMine(acting);

    expect(body.activeMembershipId).toBe(x.residentB.id);
    expect(body.memberships.map((m) => m.id)).toEqual([
      x.adminA.id,
      x.residentB.id,
      x.securityC.id,
      x.inactive.id,
    ]);
    expect(body.memberships[3].status).toBe(UserStatus.INACTIVE);
    expect(Object.keys(body.memberships[0].tenant).sort()).toEqual(
      ['address', 'id', 'isPaused', 'name', 'status'].sort(),
    );
  });

  describe('MembershipContextService.resolve', () => {
    it('acts as a chosen membership, including in a suspended building', async () => {
      const x = await d1();
      const acting = await context.resolve(x.person, x.securityC.id);
      expect(acting).toMatchObject({
        contextKind: 'membership',
        role: UserRole.SECURITY,
        tenantId: x.c.id,
      });
    });

    it('refuses an inactive, ended, deleted-building or foreign membership', async () => {
      const x = await d1();
      const stranger = await makePerson(dataSource);
      for (const [who, id] of [
        [x.person, x.inactive.id],
        [x.person, x.ended.id],
        [x.person, x.inDeleted.id],
        [stranger, x.adminA.id],
      ] as Array<[User, string]>) {
        const acting = await context.resolve(who, id);
        expect(acting.contextProblem).toBe('MEMBERSHIP_INVALID');
      }
    });

    it('auto-selects a single membership and reports AMBIGUOUS for several', async () => {
      const single = await makePerson(dataSource);
      const tower = await makeTenant(dataSource, plan);
      await makeMembership(dataSource, single, tower, { role: UserRole.RESIDENT });
      expect((await context.resolve(single)).tenantId).toBe(tower.id);

      const x = await d1();
      expect(await context.resolve(x.person)).toMatchObject({
        contextKind: 'none',
        contextProblemReason: 'AMBIGUOUS',
      });
    });

    it('legacy mode reads the gate_users row and its tenant only', async () => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'off';
      const tower = await makeTenant(dataSource, plan);
      const person = await makePerson(dataSource, { tenantId: tower.id, role: UserRole.RESIDENT });
      const acting = await context.resolve(person, 'garbage');
      expect(acting).toMatchObject({
        contextKind: 'legacy',
        role: UserRole.RESIDENT,
        tenantId: tower.id,
      });
      expect(acting.tenant?.id).toBe(tower.id);
    });
  });
});
