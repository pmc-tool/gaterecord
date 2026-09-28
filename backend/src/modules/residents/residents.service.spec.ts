import { HttpException } from '@nestjs/common';
import { Membership } from '@database/entities/membership.entity';
import { RfidCard } from '@database/entities/rfid-card.entity';
import { SubscriptionPlan } from '@database/entities/subscription-plan.entity';
import { Tenant } from '@database/entities/tenant.entity';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import { Vehicle } from '@database/entities/vehicle.entity';
import { membershipErrorCodeOf } from '@common/context/membership-context.errors';
import { floorLookupKey } from '../building-structure/building-structure.service';
import {
  FakePeopleManager,
  LifecycleHarness,
  buildLifecycle,
  peopleFixtures,
} from '../people/people.spec-harness';
import {
  acceptTargetedSave,
  actingIn,
  actingLegacy,
  actingOnPlatform,
  dataSourceOver,
  membershipQueryRepository,
  repositoryOver,
  stubMembershipReads,
} from '../users/people-api.spec-harness';
import { ResidentRemovalService } from './resident-removal.service';
import { ResidentsService } from './residents.service';

/**
 * PPL-10 / PPL-11: residents are RESIDENT memberships. The real
 * MembershipsService and MembershipLifecycleService run underneath over the
 * in-memory manager.
 */

// bcrypt at cost 10 is slow and irrelevant here.
jest.mock('bcrypt', () => ({ hash: jest.fn(async () => 'hashed-unguessable') }));

async function failure(promise: Promise<unknown>): Promise<HttpException> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    return error as HttpException;
  }
  throw new Error('expected the call to fail');
}

describe('ResidentsService (memberships)', () => {
  const originalFlag = process.env.GATE_MEMBERSHIP_CONTEXT;
  let h: LifecycleHarness;
  let m: FakePeopleManager;
  let fx: ReturnType<typeof peopleFixtures>;
  let service: ResidentsService;
  let findFloorsForUnits: jest.Mock;
  let plan: SubscriptionPlan;
  let towerA: Tenant;
  let towerB: Tenant;

  const liveMemberships = (userId: string) =>
    m.rows(Membership).filter((row) => row.deletedAt == null && row.userId === userId);

  beforeEach(() => {
    process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
    h = buildLifecycle();
    m = acceptTargetedSave(h.m);
    fx = peopleFixtures(m);
    stubMembershipReads(h.memberships, m);
    findFloorsForUnits = jest.fn(async () => new Map());

    service = new ResidentsService(
      membershipQueryRepository(m) as never,
      repositoryOver(m, Vehicle) as never,
      repositoryOver(m, RfidCard) as never,
      dataSourceOver(m),
      h.memberships,
      h.service,
      new ResidentRemovalService(h.service),
      { findFloorsForUnits } as never,
    );

    plan = fx.plan({ maxUsers: 10 });
    towerA = fx.tenant(plan, { name: 'Tower A' });
    towerB = fx.tenant(plan, { name: 'Tower B' });
  });

  afterAll(() => {
    process.env.GATE_MEMBERSHIP_CONTEXT = originalFlag;
  });

  /** P: admin of A and resident of B (unit 12B). Admins of A and B act. */
  function scenario() {
    const p = fx.person({ email: 'p@example.test', tenantId: towerA.id });
    const pa = fx.membership(p, towerA, { role: UserRole.BUILDING_ADMIN });
    const pb = fx.membership(p, towerB, { role: UserRole.RESIDENT, unit: '12B' });
    const adminA = fx.person({ email: 'a@example.test' });
    const aa = fx.membership(adminA, towerA, { role: UserRole.BUILDING_ADMIN });
    const adminB = fx.person({ email: 'b@example.test' });
    const bb = fx.membership(adminB, towerB, { role: UserRole.BUILDING_ADMIN });
    return { p, pa, pb, adminA, aa, adminB, bb };
  }

  describe('reads (PPL-10)', () => {
    it("P appears only in B's resident list, with B's unit and only B's assets", async () => {
      const { p, pb, aa, bb } = scenario();
      m.insert(Vehicle, { ownerId: p.id, tenantId: towerA.id, licensePlate: 'A-1' });
      const carB = m.insert(Vehicle, { ownerId: p.id, tenantId: towerB.id, licensePlate: 'B-1' });
      m.insert(RfidCard, { userId: p.id, tenantId: towerA.id, uid: 'CARD-A' });
      const cardB = m.insert(RfidCard, { userId: p.id, tenantId: towerB.id, uid: 'CARD-B' });

      const inA = await service.findAll(actingIn(m, aa));
      expect(inA.data).toHaveLength(0);
      expect(inA.total).toBe(0);

      const inB = await service.findAll(actingIn(m, bb));
      expect(inB.total).toBe(1);
      const [row] = inB.data;
      expect(row).toMatchObject({
        id: p.id,
        membershipId: pb.id,
        role: UserRole.RESIDENT,
        unit: '12B',
        tenantId: towerB.id,
      });
      expect(row.vehicles.map((vehicle) => vehicle.id)).toEqual([carB.id]);
      expect(row.rfidCards.map((card) => card.id)).toEqual([cardB.id]);
      expect(row).not.toHaveProperty('passwordHash');
      expect(row).not.toHaveProperty('qrCode');
    });

    it('floors come from (membership tenant, membership unit)', async () => {
      const { bb } = scenario();
      const floor = { id: 'floor-12', floorNumber: 12, label: 'Floor 12' };
      findFloorsForUnits.mockResolvedValue(new Map([[floorLookupKey(towerB.id, '12B'), floor]]));

      const { data } = await service.findAll(actingIn(m, bb));

      expect(findFloorsForUnits).toHaveBeenCalledWith([{ tenantId: towerB.id, unit: '12B' }]);
      expect(data[0].floor).toEqual(floor);
    });

    it('security may list; a resident context may not', async () => {
      const { pb } = scenario();
      const guard = fx.person({ email: 'g@example.test', role: UserRole.SECURITY });
      const gb = fx.membership(guard, towerB, { role: UserRole.SECURITY });

      await expect(service.findAll(actingIn(m, gb))).resolves.toMatchObject({ total: 1 });

      const error = await failure(service.findAll(actingIn(m, pb)));
      expect(membershipErrorCodeOf(error)).toBe('ROLE_NOT_ALLOWED_IN_BUILDING');
    });

    it('findOne uses the membership: 404 outside the building, TENANT_REQUIRED for an ambiguous platform read', async () => {
      const { p, aa, bb } = scenario();
      const root = fx.person({ email: 'root@example.test', role: UserRole.SUPER_ADMIN });

      const notHere = await failure(service.findOne(p.id, actingIn(m, aa)));
      expect(notHere.getStatus()).toBe(404);

      await expect(service.findOne(p.id, actingIn(m, bb))).resolves.toMatchObject({
        tenantId: towerB.id,
      });

      // One resident membership: the platform admin needs no tenantId.
      await expect(service.findOne(p.id, actingOnPlatform(m, root.id))).resolves.toMatchObject({
        tenantId: towerB.id,
      });

      fx.membership(p, fx.tenant(plan, { name: 'Tower C' }), { role: UserRole.RESIDENT });
      const ambiguous = await failure(service.findOne(p.id, actingOnPlatform(m, root.id)));
      expect(ambiguous.getStatus()).toBe(400);
      expect(membershipErrorCodeOf(ambiguous)).toBe('TENANT_REQUIRED');
    });

    it('an unknown status filter matches nobody instead of reaching Postgres', async () => {
      const { bb } = scenario();
      await expect(service.findAll(actingIn(m, bb), { status: 'nonsense' })).resolves.toMatchObject(
        { data: [], total: 0 },
      );
    });
  });

  describe('writes (PPL-11)', () => {
    it('adding the admin of A as a resident of B returns existingAccount and keeps A', async () => {
      const admin = fx.person({ email: 'p@example.test', tenantId: towerA.id });
      const pa = fx.membership(admin, towerA, { role: UserRole.BUILDING_ADMIN });
      const adminB = fx.person({ email: 'b@example.test' });
      const bb = fx.membership(adminB, towerB, { role: UserRole.BUILDING_ADMIN });

      const created = await service.create(
        {
          email: 'P@example.test',
          firstName: 'P',
          lastName: 'Person',
          unit: '3C',
          // A building admin's body tenantId is ignored, as it always was.
          tenantId: towerA.id,
        },
        actingIn(m, bb),
      );

      expect(created).toMatchObject({
        id: admin.id,
        existingAccount: true,
        tenantId: towerB.id,
        role: UserRole.RESIDENT,
        unit: '3C',
      });
      expect(liveMemberships(admin.id)).toHaveLength(2);
      expect(m.row(Membership, pa.id)).toMatchObject({ role: UserRole.BUILDING_ADMIN });
    });

    it('a new resident gets a person with a QR code and an inactive membership when asked', async () => {
      const adminB = fx.person({ email: 'b@example.test' });
      const bb = fx.membership(adminB, towerB, { role: UserRole.BUILDING_ADMIN });

      const created = await service.create(
        {
          email: 'new@example.test',
          firstName: 'N',
          lastName: 'R',
          unit: '1A',
          isActive: false,
        },
        actingIn(m, bb),
      );

      expect(created).toMatchObject({ existingAccount: false, status: UserStatus.INACTIVE });
      expect(m.row(User, created.id)?.qrCode).toMatch(/^GR-/);
    });

    it('a platform admin must name the building', async () => {
      const root = fx.person({ email: 'root@example.test', role: UserRole.SUPER_ADMIN });
      const error = await failure(
        service.create(
          { email: 'x@example.test', firstName: 'X', lastName: 'Y', unit: '1' },
          actingOnPlatform(m, root.id),
        ),
      );
      expect(membershipErrorCodeOf(error)).toBe('TENANT_REQUIRED');
    });

    it('isActive=false changes only B, and unit goes to the membership', async () => {
      const { p, pa, pb, bb } = scenario();

      const row = await service.update(p.id, { isActive: false, unit: '14A' }, actingIn(m, bb));

      expect(row).toMatchObject({ status: UserStatus.INACTIVE, unit: '14A' });
      expect(m.row(Membership, pb.id)).toMatchObject({ status: UserStatus.INACTIVE, unit: '14A' });
      expect(m.row(Membership, pa.id)?.status).toBe(UserStatus.ACTIVE);
      expect(m.row(User, p.id)?.status).toBe(UserStatus.ACTIVE);
    });

    it('name fields are read-only for a building admin, and a platform admin may change them', async () => {
      const { p, bb } = scenario();
      const root = fx.person({ email: 'root@example.test', role: UserRole.SUPER_ADMIN });

      const error = await failure(service.update(p.id, { lastName: 'Changed' }, actingIn(m, bb)));
      expect(membershipErrorCodeOf(error)).toBe('PERSON_FIELDS_READ_ONLY');

      await service.update(p.id, { lastName: 'Changed' }, actingOnPlatform(m, root.id));
      expect(m.row(User, p.id)?.lastName).toBe('Changed');
    });

    it('residents are not moved between buildings', async () => {
      const { p, bb } = scenario();
      const error = await failure(service.update(p.id, { tenantId: towerA.id }, actingIn(m, bb)));
      expect(error.getStatus()).toBe(403);
    });

    it('DELETE removes only B', async () => {
      const { p, pa, pb, bb } = scenario();

      await service.remove(p.id, actingIn(m, bb));

      expect(m.row(Membership, pb.id)?.deletedAt).not.toBeNull();
      expect(m.row(Membership, pa.id)?.deletedAt).toBeNull();
      expect(m.row(User, p.id)?.deletedAt).toBeNull();
    });

    it('flag off: a single-building resident keeps working as before', async () => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'off';
      const admin = fx.person({ email: 'b@example.test', tenantId: towerB.id });
      fx.membership(admin, towerB, { role: UserRole.BUILDING_ADMIN });

      const created = await service.create(
        { email: 'r@example.test', firstName: 'R', lastName: 'S', unit: '2B' },
        actingLegacy(m, admin.id),
      );
      expect(m.row(User, created.id)).toMatchObject({
        tenantId: towerB.id,
        role: UserRole.RESIDENT,
        unit: '2B',
      });

      await service.update(created.id, { isActive: false }, actingLegacy(m, admin.id));
      expect(m.row(User, created.id)?.status).toBe(UserStatus.INACTIVE);

      await service.remove(created.id, actingLegacy(m, admin.id));
      expect(m.row(User, created.id)).toMatchObject({
        tenantId: null,
        status: UserStatus.ACTIVE,
        deletedAt: null,
      });
    });
  });
});
