import { DataSource } from 'typeorm';
import { HttpException } from '@nestjs/common';
import { MembershipsService } from '../../src/modules/memberships/memberships.service';
import { Membership } from '../../src/database/entities/membership.entity';
import { SubscriptionPlan } from '../../src/database/entities/subscription-plan.entity';
import { Tenant } from '../../src/database/entities/tenant.entity';
import { User, UserRole, UserStatus } from '../../src/database/entities/user.entity';
import { createTestDataSource, describeDb, rebuildSchema } from './test-data-source';
import { makeMembership, makePerson, makePlan, makeTenant, reloadPerson } from './fixtures';

function codeOf(result: PromiseSettledResult<unknown>): unknown {
  if (result.status !== 'rejected') return null;
  const error = result.reason;
  return error instanceof HttpException
    ? (error.getResponse() as { code?: unknown }).code
    : String(error);
}

describeDb('MembershipsService (database)', () => {
  const originalFlag = process.env.GATE_MEMBERSHIP_CONTEXT;
  let dataSource: DataSource;
  let service: MembershipsService;
  let plan: SubscriptionPlan;
  let towerA: Tenant;
  let towerB: Tenant;

  beforeAll(async () => {
    dataSource = await createTestDataSource();
    await rebuildSchema(dataSource);
    service = new MembershipsService(dataSource);
    plan = await makePlan(dataSource);
  });

  beforeEach(async () => {
    process.env.GATE_MEMBERSHIP_CONTEXT = 'off';
    towerA = await makeTenant(dataSource, plan);
    towerB = await makeTenant(dataSource, plan);
  });

  afterAll(async () => {
    process.env.GATE_MEMBERSHIP_CONTEXT = originalFlag;
    await dataSource?.destroy();
  });

  const liveCount = (userId: string) =>
    dataSource.getRepository(Membership).count({ where: { userId } });

  it('mirrors 0, 1 and 2 memberships onto the legacy columns', async () => {
    process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
    const person = await makePerson(dataSource);

    const first = await service.add({
      userId: person.id,
      tenantId: towerA.id,
      role: UserRole.RESIDENT,
      unit: '12B',
    });
    expect(await reloadPerson(dataSource, person.id)).toMatchObject({
      tenantId: towerA.id,
      role: UserRole.RESIDENT,
      unit: '12B',
    });

    await service.add({ userId: person.id, tenantId: towerB.id, role: UserRole.SECURITY });
    expect(await reloadPerson(dataSource, person.id)).toMatchObject({ tenantId: towerA.id });

    await service.update(first.id, { status: UserStatus.INACTIVE });
    expect(await reloadPerson(dataSource, person.id)).toMatchObject({
      tenantId: towerB.id,
      role: UserRole.SECURITY,
      status: UserStatus.ACTIVE,
    });

    await service.remove(first.id);
    const [second] = await service.listLiveForUser(person.id);
    await service.remove(second.id);
    expect(await reloadPerson(dataSource, person.id)).toMatchObject({
      tenantId: null,
      role: UserRole.BUILDING_ADMIN,
      unit: null,
    });
  });

  it("never touches a super admin's role; their building follows the memberships", async () => {
    const admin = await makePerson(dataSource, { role: UserRole.SUPER_ADMIN });
    await service.add({ userId: admin.id, tenantId: towerA.id, role: UserRole.RESIDENT });

    expect(await reloadPerson(dataSource, admin.id)).toMatchObject({
      role: UserRole.SUPER_ADMIN,
      tenantId: towerA.id,
    });
  });

  it('turns two concurrent adds into one row and one 409', async () => {
    const person = await makePerson(dataSource);

    const results = await Promise.allSettled([
      service.add({ userId: person.id, tenantId: towerA.id, role: UserRole.RESIDENT }),
      service.add({ userId: person.id, tenantId: towerA.id, role: UserRole.SECURITY }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.map(codeOf).filter(Boolean)).toEqual(['MEMBERSHIP_EXISTS']);
    expect(await liveCount(person.id)).toBe(1);
  });

  it('with the flag off, a second building gives 409 MULTI_MEMBERSHIP_DISABLED, even concurrently', async () => {
    const person = await makePerson(dataSource);

    const results = await Promise.allSettled([
      service.add({ userId: person.id, tenantId: towerA.id, role: UserRole.RESIDENT }),
      service.add({ userId: person.id, tenantId: towerB.id, role: UserRole.RESIDENT }),
    ]);

    expect(results.map(codeOf).filter(Boolean)).toEqual(['MULTI_MEMBERSHIP_DISABLED']);
    expect(await liveCount(person.id)).toBe(1);
  });

  it('with the flag off, a status change also updates gate_users.status', async () => {
    const person = await makePerson(dataSource);
    const membership = await service.add({
      userId: person.id,
      tenantId: towerA.id,
      role: UserRole.RESIDENT,
    });

    await service.update(membership.id, { status: UserStatus.INACTIVE });
    expect((await reloadPerson(dataSource, person.id)).status).toBe(UserStatus.INACTIVE);

    await service.update(membership.id, { status: UserStatus.ACTIVE });
    expect((await reloadPerson(dataSource, person.id)).status).toBe(UserStatus.ACTIVE);
  });

  it('restorePerson leaves zero live memberships and the sentinel', async () => {
    const person = await makePerson(dataSource);
    await service.add({
      userId: person.id,
      tenantId: towerA.id,
      role: UserRole.RESIDENT,
      unit: '1A',
    });
    await dataSource.getRepository(User).softDelete(person.id);
    await dataSource.getRepository(User).restore(person.id);

    await expect(service.restorePerson(person.id)).resolves.toBe(1);

    expect(await liveCount(person.id)).toBe(0);
    expect(await reloadPerson(dataSource, person.id)).toMatchObject({
      tenantId: null,
      role: UserRole.BUILDING_ADMIN,
      unit: null,
    });
  });

  it('removeAllForTenant ends the building with one deleted_at', async () => {
    const first = await makePerson(dataSource);
    const second = await makePerson(dataSource);
    await service.add({ userId: first.id, tenantId: towerA.id, role: UserRole.BUILDING_ADMIN });
    await service.add({ userId: second.id, tenantId: towerA.id, role: UserRole.SECURITY });

    await expect(service.removeAllForTenant(towerA.id)).resolves.toBe(2);

    const ended = await dataSource
      .getRepository(Membership)
      .find({ where: { tenantId: towerA.id }, withDeleted: true });
    expect(new Set(ended.map((row) => row.deletedAt?.getTime())).size).toBe(1);
    expect((await reloadPerson(dataSource, first.id)).tenantId).toBeNull();
  });

  it('saving a User with a partial memberships array writes nothing to gate_memberships', async () => {
    const person = await makePerson(dataSource);
    const kept = await makeMembership(dataSource, person, towerA);
    await makeMembership(dataSource, person, towerB, { role: UserRole.SECURITY });

    const loaded = await dataSource.getRepository(User).findOneOrFail({
      where: { id: person.id },
      relations: ['memberships'],
    });
    loaded.memberships = [Object.assign(kept, { role: UserRole.BUILDING_ADMIN })];
    loaded.phone = '+100';
    await dataSource.getRepository(User).save(loaded);

    const rows = await dataSource.getRepository(Membership).find({ where: { userId: person.id } });
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === kept.id)?.role).toBe(UserRole.RESIDENT);
  });
});
