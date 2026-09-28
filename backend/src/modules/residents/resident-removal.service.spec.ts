import { HttpException } from '@nestjs/common';
import { Membership } from '@database/entities/membership.entity';
import { RfidCard } from '@database/entities/rfid-card.entity';
import { Tenant } from '@database/entities/tenant.entity';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import { Vehicle } from '@database/entities/vehicle.entity';
import { FakePeopleManager, buildLifecycle, peopleFixtures } from '../people/people.spec-harness';
import { ResidentRemovalService } from './resident-removal.service';

jest.mock('bcrypt', () => ({ hash: jest.fn(async () => 'hashed-unguessable') }));

/**
 * ResidentRemovalService over the real MembershipLifecycleService and
 * MembershipsService, on the in-memory manager from the people harness.
 */
describe('ResidentRemovalService', () => {
  const originalFlag = process.env.GATE_MEMBERSHIP_CONTEXT;
  let m: FakePeopleManager;
  let service: ResidentRemovalService;
  let fx: ReturnType<typeof peopleFixtures>;
  let towerA: Tenant;
  let towerB: Tenant;
  let towerC: Tenant;

  const liveMemberships = (userId: string) =>
    m.rows(Membership).filter((row) => row.userId === userId && row.deletedAt == null);

  beforeEach(() => {
    process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
    const harness = buildLifecycle();
    m = harness.m;
    service = new ResidentRemovalService(harness.service);
    fx = peopleFixtures(m);
    const plan = fx.plan();
    towerA = fx.tenant(plan, { name: 'Tower A' });
    towerB = fx.tenant(plan, { name: 'Tower B' });
    towerC = fx.tenant(plan, { name: 'Tower C' });
  });

  afterAll(() => {
    process.env.GATE_MEMBERSHIP_CONTEXT = originalFlag;
  });

  describe('removeFromBuilding', () => {
    it('requires the building: 400 TENANT_REQUIRED and nothing changes', async () => {
      const p = fx.person();
      fx.membership(p, towerB);

      for (const missing of [undefined, null, '']) {
        const error = await service.removeFromBuilding(p.id, missing).catch((e) => e);
        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).getStatus()).toBe(400);
        expect(((error as HttpException).getResponse() as { code: string }).code).toBe(
          'TENANT_REQUIRED',
        );
      }
      expect(liveMemberships(p.id)).toHaveLength(1);
    });

    it('removing P from B leaves A and C untouched', async () => {
      const p = fx.person({ tenantId: towerA.id });
      fx.membership(p, towerA, { role: UserRole.BUILDING_ADMIN });
      fx.membership(p, towerB, { role: UserRole.RESIDENT });
      fx.membership(p, towerC, { role: UserRole.SECURITY });
      const cardA = m.insert(RfidCard, { userId: p.id, tenantId: towerA.id, uid: 'A' });
      const cardB = m.insert(RfidCard, { userId: p.id, tenantId: towerB.id, uid: 'B' });
      const carC = m.insert(Vehicle, { ownerId: p.id, tenantId: towerC.id, licensePlate: 'C-1' });

      const result = await service.removeFromBuilding(p.id, towerB.id, {
        expectedRole: UserRole.RESIDENT,
      });

      expect(result.membership).toMatchObject({ tenantId: towerB.id, role: UserRole.RESIDENT });
      expect(
        liveMemberships(p.id)
          .map((row) => row.tenantId)
          .sort(),
      ).toEqual([towerA.id, towerC.id].sort());
      expect(m.row(RfidCard, cardA.id)).toBeDefined();
      expect(m.row(RfidCard, cardB.id)).toBeUndefined();
      expect(m.row(Vehicle, carC.id)).toBeDefined();
      expect(m.row(User, p.id)).toMatchObject({
        tenantId: towerA.id,
        role: UserRole.BUILDING_ADMIN,
      });
    });

    it('keeps the legacy 409 wording for a person who is not a resident there', async () => {
      const p = fx.person();
      fx.membership(p, towerB, { role: UserRole.SECURITY });

      const error = await service
        .removeFromBuilding(p.id, towerB.id, { expectedRole: UserRole.RESIDENT })
        .catch((e) => e);

      expect((error as HttpException).getStatus()).toBe(409);
      expect((error as HttpException).message).toBe('Not currently a resident of this building.');
      expect(liveMemberships(p.id)).toHaveLength(1);
    });

    it('without expectedRole any role is removed (the Users page)', async () => {
      const p = fx.person();
      fx.membership(p, towerB, { role: UserRole.SECURITY });

      await service.removeFromBuilding(p.id, towerB.id, { reason: 'removed_by_admin' });

      expect(liveMemberships(p.id)).toHaveLength(0);
      // Their last building is gone: the sentinel "new user" values.
      expect(m.row(User, p.id)).toMatchObject({
        tenantId: null,
        role: UserRole.BUILDING_ADMIN,
        status: UserStatus.ACTIVE,
      });
    });
  });

  describe('restoreDeletedUser', () => {
    it('a restored person has zero live memberships and the sentinel values, so a removed guard gets nothing back', async () => {
      const guard = fx.person({
        tenantId: towerC.id,
        role: UserRole.SECURITY,
        deletedAt: new Date(),
      });
      fx.membership(guard, towerC, { role: UserRole.SECURITY });
      const card = m.insert(RfidCard, { userId: guard.id, tenantId: towerC.id, uid: 'GUARD' });

      await service.restoreDeletedUser(guard.id);

      expect(m.row(User, guard.id)).toMatchObject({
        deletedAt: null,
        tenantId: null,
        role: UserRole.BUILDING_ADMIN,
      });
      expect(liveMemberships(guard.id)).toHaveLength(0);
      expect(m.row(RfidCard, card.id)).toBeUndefined();
    });

    it('is a no-op for a person who is not deleted', async () => {
      const p = fx.person({ tenantId: towerA.id });
      fx.membership(p, towerA);

      await service.restoreDeletedUser(p.id);

      expect(liveMemberships(p.id)).toHaveLength(1);
    });
  });
});
