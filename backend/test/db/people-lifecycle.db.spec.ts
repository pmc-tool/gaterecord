import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { HttpException } from '@nestjs/common';
import { MembershipsService } from '../../src/modules/memberships/memberships.service';
import { MembershipLifecycleService } from '../../src/modules/people/membership-lifecycle.service';
import {
  assertSeatAvailable,
  countSeats,
  countSeatsByTenant,
} from '../../src/modules/people/seat-limit';
import { AccountIdentityClient } from '../../src/modules/account-identity/account-identity.client';
import { EmailService } from '../../src/modules/notification/email.service';
import { Membership } from '../../src/database/entities/membership.entity';
import { RfidCard } from '../../src/database/entities/rfid-card.entity';
import { SubscriptionPlan } from '../../src/database/entities/subscription-plan.entity';
import { Tenant } from '../../src/database/entities/tenant.entity';
import { User, UserRole, UserStatus } from '../../src/database/entities/user.entity';
import { createTestDataSource, describeDb, rebuildSchema } from './test-data-source';
import { makeMembership, makePerson, makePlan, makeTenant, reloadPerson } from './fixtures';

/**
 * The people core against real Postgres: the SQL the unit specs cannot see
 * (seat counts through the person join, the case-insensitive email lookup over
 * soft-deleted rows, FOR UPDATE inside a transaction, tenant-scoped deletes).
 * Skipped without TEST_DATABASE_URL.
 */
describeDb('people core (database)', () => {
  const originalFlag = process.env.GATE_MEMBERSHIP_CONTEXT;
  let dataSource: DataSource;
  let lifecycle: MembershipLifecycleService;
  let provisionUser: jest.Mock;
  let plan: SubscriptionPlan;
  let towerA: Tenant;
  let towerB: Tenant;
  let towerC: Tenant;

  beforeAll(async () => {
    dataSource = await createTestDataSource();
    await rebuildSchema(dataSource);
    plan = await makePlan(dataSource, { maxUsers: 3 });
  });

  beforeEach(async () => {
    process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
    towerA = await makeTenant(dataSource, plan);
    towerB = await makeTenant(dataSource, plan);
    towerC = await makeTenant(dataSource, plan);

    provisionUser = jest.fn(async (input: { email: string }) => ({
      id: randomUUID(),
      email: input.email,
      created: true,
      emailSent: false,
      password: 'Temp#Pass-1234',
    }));
    lifecycle = new MembershipLifecycleService(
      dataSource,
      new MembershipsService(dataSource),
      { provisionUser } as unknown as AccountIdentityClient,
      {
        sendNewUserCredentialsEmail: jest.fn(async () => true),
        sendAddedToBuildingEmail: jest.fn(async () => true),
      } as unknown as EmailService,
      { get: (_key: string, fallback?: unknown) => fallback } as unknown as ConfigService,
    );
  });

  afterAll(async () => {
    process.env.GATE_MEMBERSHIP_CONTEXT = originalFlag;
    await dataSource?.destroy();
  });

  const card = (person: User, tenant: Tenant) =>
    dataSource.getRepository(RfidCard).save({
      userId: person.id,
      tenantId: tenant.id,
      uid: `UID-${randomUUID().slice(0, 8)}`,
    });

  const liveMemberships = (userId: string) =>
    dataSource.getRepository(Membership).find({ where: { userId } });

  it('countSeats: one per live membership of a live person, per building', async () => {
    const admin = await makePerson(dataSource);
    const resident = await makePerson(dataSource);
    const removed = await makePerson(dataSource);
    const deletedPerson = await makePerson(dataSource);
    await makeMembership(dataSource, admin, towerA, { role: UserRole.BUILDING_ADMIN });
    await makeMembership(dataSource, resident, towerA, { status: UserStatus.INACTIVE });
    await makeMembership(dataSource, resident, towerB);
    const ended = await makeMembership(dataSource, removed, towerA);
    await dataSource.getRepository(Membership).softDelete(ended.id);
    await makeMembership(dataSource, deletedPerson, towerA);
    await dataSource.getRepository(User).softDelete(deletedPerson.id);

    await expect(countSeats(dataSource.manager, towerA.id)).resolves.toBe(2);
    await expect(countSeats(dataSource.manager, null)).rejects.toThrow();

    const byTenant = await countSeatsByTenant(dataSource.manager, [
      towerA.id,
      towerB.id,
      towerC.id,
    ]);
    expect(byTenant.get(towerA.id)).toBe(2);
    expect(byTenant.get(towerB.id)).toBe(1);
    expect(byTenant.get(towerC.id)).toBe(0);
  });

  it('assertSeatAvailable locks the tenant inside a transaction and refuses at the limit', async () => {
    for (let i = 0; i < 3; i += 1) {
      await makeMembership(dataSource, await makePerson(dataSource), towerC);
    }

    const refused = await dataSource
      .transaction((m) => assertSeatAvailable(m, towerC.id))
      .catch((error) => error);
    expect(refused).toBeInstanceOf(HttpException);
    expect((refused as HttpException).getStatus()).toBe(403);

    await expect(
      dataSource.transaction((m) => assertSeatAvailable(m, towerB.id)),
    ).resolves.toMatchObject({ used: 0, limit: 3 });
  });

  it('adds an existing mixed-case email without provisioning, and restores a deleted one', async () => {
    const existing = await makePerson(dataSource, { email: 'Mixed.Case@Example.test' });
    const added = await lifecycle.addPersonToTenant({
      email: 'mixed.case@example.test',
      firstName: 'M',
      lastName: 'C',
      tenantId: towerA.id,
      role: UserRole.SECURITY,
    });
    expect(added.person.id).toBe(existing.id);
    expect(added.existingAccount).toBe(true);
    expect(provisionUser).not.toHaveBeenCalled();

    const deleted = await makePerson(dataSource, { tenantId: towerB.id, role: UserRole.SECURITY });
    const oldCard = await card(deleted, towerB);
    await dataSource.getRepository(User).softDelete(deleted.id);

    const restored = await lifecycle.addPersonToTenant({
      email: deleted.email.toUpperCase(),
      firstName: 'R',
      lastName: 'D',
      tenantId: towerC.id,
      role: UserRole.RESIDENT,
    });
    expect(restored.person.id).toBe(deleted.id);
    expect((await reloadPerson(dataSource, deleted.id)).deletedAt).toBeNull();
    expect(
      await dataSource.getRepository(RfidCard).findOne({ where: { id: oldCard.id } }),
    ).toBeNull();
    expect((await liveMemberships(deleted.id)).map((m) => m.tenantId)).toEqual([towerC.id]);
  });

  it("removeMembership from B keeps A's and C's cards and memberships", async () => {
    const p = await makePerson(dataSource);
    await makeMembership(dataSource, p, towerA, { role: UserRole.BUILDING_ADMIN });
    await makeMembership(dataSource, p, towerB);
    await makeMembership(dataSource, p, towerC, { role: UserRole.SECURITY });
    const [cardA, cardB, cardC] = [
      await card(p, towerA),
      await card(p, towerB),
      await card(p, towerC),
    ];

    await lifecycle.removeMembership({
      userId: p.id,
      tenantId: towerB.id,
      reason: 'removed_by_admin',
    });

    const cards = dataSource.getRepository(RfidCard);
    expect(await cards.findOne({ where: { id: cardA.id } })).not.toBeNull();
    expect(await cards.findOne({ where: { id: cardB.id } })).toBeNull();
    expect(await cards.findOne({ where: { id: cardC.id } })).not.toBeNull();
    expect((await liveMemberships(p.id)).map((m) => m.tenantId).sort()).toEqual(
      [towerA.id, towerC.id].sort(),
    );
  });

  it('platform removal leaves zero memberships and a soft-deleted person; restore gives nothing back', async () => {
    const p = await makePerson(dataSource);
    await makeMembership(dataSource, p, towerA);
    await makeMembership(dataSource, p, towerB, { role: UserRole.SECURITY });
    const superAdmin = await makePerson(dataSource, { role: UserRole.SUPER_ADMIN });

    await lifecycle.removePersonFromPlatform(p.id, { actor: superAdmin, scope: 'platform' });

    expect(await liveMemberships(p.id)).toHaveLength(0);
    expect((await reloadPerson(dataSource, p.id)).deletedAt).toBeInstanceOf(Date);

    await expect(lifecycle.restoreDeletedPerson(p.id)).resolves.toBe(true);
    const back = await reloadPerson(dataSource, p.id);
    expect(back).toMatchObject({ deletedAt: null, tenantId: null, role: UserRole.BUILDING_ADMIN });
    expect(await liveMemberships(p.id)).toHaveLength(0);
  });
});
