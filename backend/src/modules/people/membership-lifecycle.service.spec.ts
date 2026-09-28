import { HttpException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import {
  BuildingJoinRequest,
  JoinRequestStatus,
} from '@database/entities/building-join-request.entity';
import { Membership } from '@database/entities/membership.entity';
import { Notification } from '@database/entities/notification.entity';
import { RfidCard } from '@database/entities/rfid-card.entity';
import { SubscriptionPlan } from '@database/entities/subscription-plan.entity';
import { Tenant } from '@database/entities/tenant.entity';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import { Vehicle } from '@database/entities/vehicle.entity';
import {
  RegistrationType,
  VisitorPass,
  VisitorPassStatus,
} from '@database/entities/visitor-pass.entity';
import { ACTING_USER_MARK } from '@common/context/acting-user';
import { MembershipLifecycleService, PlatformActor } from './membership-lifecycle.service';
import {
  FakePeopleManager,
  LifecycleHarness,
  buildLifecycle,
  peopleFixtures,
} from './people.spec-harness';
import { NO_PLAN_MESSAGE, seatLimitMessage } from './seat-limit';

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

function bodyOf(error: HttpException): Record<string, unknown> {
  const response = error.getResponse();
  return typeof response === 'object'
    ? (response as Record<string, unknown>)
    : { message: response };
}

describe('MembershipLifecycleService', () => {
  const originalFlag = process.env.GATE_MEMBERSHIP_CONTEXT;
  let h: LifecycleHarness;
  let m: FakePeopleManager;
  let service: MembershipLifecycleService;
  let fx: ReturnType<typeof peopleFixtures>;
  let plan: SubscriptionPlan;
  let towerA: Tenant;
  let towerB: Tenant;
  let towerC: Tenant;
  const admin = { firstName: 'Ada', lastName: 'Admin' };

  const live = (target: new () => object) => m.rows(target).filter((row) => row.deletedAt == null);
  const liveMemberships = (userId: string) =>
    live(Membership).filter((row) => row.userId === userId);

  beforeEach(() => {
    process.env.GATE_MEMBERSHIP_CONTEXT = 'off';
    h = buildLifecycle();
    m = h.m;
    service = h.service;
    fx = peopleFixtures(m);
    plan = fx.plan({ maxUsers: 5 });
    towerA = fx.tenant(plan, { name: 'Tower A' });
    towerB = fx.tenant(plan, { name: 'Tower B' });
    towerC = fx.tenant(plan, { name: 'Tower C' });
  });

  afterAll(() => {
    process.env.GATE_MEMBERSHIP_CONTEXT = originalFlag;
  });

  // ============ addPersonToTenant ============

  describe('addPersonToTenant', () => {
    const base = () => ({
      email: 'New.Person@Example.test',
      firstName: 'New',
      lastName: 'Person',
      tenantId: towerA.id,
      role: UserRole.RESIDENT,
      unit: '4B',
      actor: admin,
    });

    it('new email: provisions once, creates the person with a QR code and sends credentials', async () => {
      const result = await service.addPersonToTenant(base());

      expect(h.provisionUser).toHaveBeenCalledTimes(1);
      expect(h.provisionUser).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'new.person@example.test', sendEmail: false }),
      );

      const stored = m.row(User, result.person.id) as Record<string, unknown>;
      expect(stored.email).toBe('new.person@example.test');
      expect(stored.qrCode).toMatch(/^GR-[0-9a-f-]{36}$/);
      expect(stored.status).toBe(UserStatus.ACTIVE);
      expect(stored.userId).toBe((await h.provisionUser.mock.results[0].value).id);
      // The mirror copied the only membership onto the legacy columns.
      expect(stored).toMatchObject({ tenantId: towerA.id, role: UserRole.RESIDENT, unit: '4B' });

      expect(result.existingAccount).toBe(false);
      expect(result.membership).toMatchObject({
        userId: result.person.id,
        tenantId: towerA.id,
        role: UserRole.RESIDENT,
        status: UserStatus.ACTIVE,
        unit: '4B',
      });
      expect(result.membership.tenant.id).toBe(towerA.id);
      expect(result.membership.user.id).toBe(result.person.id);
      expect(result.person).not.toHaveProperty('passwordHash');

      expect(h.sendNewUserCredentialsEmail).toHaveBeenCalledWith(
        'new.person@example.test',
        'New Person',
        UserRole.RESIDENT,
        'Temp#Pass-1234',
        'Tower A',
        'Ada Admin',
        expect.any(String),
      );
      expect(h.sendAddedToBuildingEmail).not.toHaveBeenCalled();
    });

    it('new gate person whose platform identity already existed: no credentials, the added email', async () => {
      h.provisionUser.mockResolvedValueOnce({
        id: '5b0e4b9e-3f55-4c43-9d7a-0d8f3c1c2b11',
        email: 'new.person@example.test',
        created: false,
        emailSent: false,
      } as never);

      const result = await service.addPersonToTenant(base());

      expect(result.existingAccount).toBe(true);
      expect(h.sendNewUserCredentialsEmail).not.toHaveBeenCalled();
      expect(h.sendAddedToBuildingEmail).toHaveBeenCalledWith(
        'new.person@example.test',
        'New Person',
        UserRole.RESIDENT,
        'Tower A',
        'Ada Admin',
        expect.any(String),
      );
    });

    it('existing email: no provisioning, the added email, existingAccount=true, no new row', async () => {
      const person = fx.person({
        email: 'new.person@example.test',
        firstName: 'Old',
        lastName: 'Timer',
      });
      const rowsBefore = m.rows(User).length;

      const result = await service.addPersonToTenant(base());

      expect(h.provisionUser).not.toHaveBeenCalled();
      expect(m.rows(User)).toHaveLength(rowsBefore);
      expect(result.person.id).toBe(person.id);
      expect(result.existingAccount).toBe(true);
      expect(h.sendAddedToBuildingEmail).toHaveBeenCalledWith(
        'new.person@example.test',
        'Old Timer',
        UserRole.RESIDENT,
        'Tower A',
        'Ada Admin',
        expect.any(String),
      );
      expect(h.sendNewUserCredentialsEmail).not.toHaveBeenCalled();
    });

    it('duplicate: 409 MEMBERSHIP_EXISTS with the role held, nothing provisioned or sent', async () => {
      const person = fx.person({ email: 'new.person@example.test' });
      fx.membership(person, towerA, { role: UserRole.SECURITY });

      const error = await failure(service.addPersonToTenant(base()));

      expect(error.getStatus()).toBe(409);
      expect(bodyOf(error)).toMatchObject({ code: 'MEMBERSHIP_EXISTS', role: UserRole.SECURITY });
      expect(h.provisionUser).not.toHaveBeenCalled();
      expect(h.sendAddedToBuildingEmail).not.toHaveBeenCalled();
    });

    it('banned person: 403 ACCOUNT_SUSPENDED and no membership', async () => {
      const person = fx.person({ email: 'new.person@example.test', status: UserStatus.INACTIVE });

      const error = await failure(service.addPersonToTenant(base()));

      expect(error.getStatus()).toBe(403);
      expect(bodyOf(error).code).toBe('ACCOUNT_SUSPENDED');
      expect(liveMemberships(person.id)).toHaveLength(0);
    });

    it('seat full: 403 with the legacy message BEFORE any identity is provisioned', async () => {
      const small = fx.plan({ maxUsers: 1 });
      const full = fx.tenant(small, { name: 'Full Tower' });
      fx.membership(fx.person(), full, { role: UserRole.BUILDING_ADMIN });

      const error = await failure(service.addPersonToTenant({ ...base(), tenantId: full.id }));

      expect(error.getStatus()).toBe(403);
      expect(bodyOf(error).message).toBe(seatLimitMessage(1));
      expect(h.provisionUser).not.toHaveBeenCalled();
      expect(m.rows(User)).toHaveLength(1);
    });

    it('requirePlan: a building without a plan is refused with the legacy message', async () => {
      const planless = fx.tenant(null, { name: 'No Plan Tower' });

      const refused = await failure(
        service.addPersonToTenant({ ...base(), tenantId: planless.id, requirePlan: true }),
      );
      expect(bodyOf(refused).message).toBe(NO_PLAN_MESSAGE);
      expect(h.provisionUser).not.toHaveBeenCalled();

      // Without requirePlan a missing plan means no limit, as POST /users did.
      await expect(
        service.addPersonToTenant({ ...base(), tenantId: planless.id }),
      ).resolves.toMatchObject({ existingAccount: false });
    });

    it('flag off: a second building is 409 MULTI_MEMBERSHIP_DISABLED; flag on it is added', async () => {
      const person = fx.person({ email: 'new.person@example.test' });
      fx.membership(person, towerB, { role: UserRole.BUILDING_ADMIN });

      const refused = await failure(service.addPersonToTenant(base()));
      expect(refused.getStatus()).toBe(409);
      expect(bodyOf(refused).code).toBe('MULTI_MEMBERSHIP_DISABLED');
      expect(liveMemberships(person.id)).toHaveLength(1);

      process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
      const added = await service.addPersonToTenant(base());
      expect(added.existingAccount).toBe(true);
      expect(
        liveMemberships(person.id)
          .map((row) => row.tenantId)
          .sort(),
      ).toEqual([towerA.id, towerB.id].sort());
      // Tower B's admin role is untouched.
      expect(liveMemberships(person.id).find((row) => row.tenantId === towerB.id)?.role).toBe(
        UserRole.BUILDING_ADMIN,
      );
    });

    it('a soft-deleted person is restored with nothing of their old access, then added', async () => {
      const person = fx.person({
        email: 'new.person@example.test',
        tenantId: towerB.id,
        role: UserRole.SECURITY,
        deletedAt: new Date(),
      });
      m.insert(RfidCard, { userId: person.id, tenantId: towerB.id, uid: 'OLD-CARD' });

      const result = await service.addPersonToTenant(base());

      expect(result.person.id).toBe(person.id);
      expect(m.row(User, person.id)?.deletedAt).toBeNull();
      expect(m.rows(RfidCard)).toHaveLength(0);
      expect(liveMemberships(person.id)).toHaveLength(1);
      expect(m.row(User, person.id)).toMatchObject({
        tenantId: towerA.id,
        role: UserRole.RESIDENT,
      });
      expect(h.provisionUser).not.toHaveBeenCalled();
    });

    it('a person created concurrently (23505 on gate_users) is retried once as the existing person', async () => {
      const originalSave = m.save.bind(m);
      let concurrent: User | null = null;
      jest.spyOn(m, 'save').mockImplementationOnce(async () => {
        concurrent = fx.person({ email: 'new.person@example.test' });
        throw new QueryFailedError('INSERT INTO gate_users', [], {
          code: '23505',
          table: 'gate_users',
        } as unknown as Error);
      });
      jest.spyOn(m, 'save').mockImplementation(originalSave);

      const result = await service.addPersonToTenant(base());

      expect(concurrent).not.toBeNull();
      expect(result.person.id).toBe((concurrent as unknown as User).id);
      expect(h.provisionUser).toHaveBeenCalledTimes(1);
      expect(m.rows(User)).toHaveLength(1);
      expect(liveMemberships(result.person.id)).toHaveLength(1);
      // This request holds the only copy of the new password, so it still delivers it.
      expect(h.sendNewUserCredentialsEmail).toHaveBeenCalledTimes(1);
    });

    it('validates the building and the role before doing anything', async () => {
      const noTenant = await failure(service.addPersonToTenant({ ...base(), tenantId: null }));
      expect(noTenant.getStatus()).toBe(400);
      expect(bodyOf(noTenant).code).toBe('TENANT_REQUIRED');

      const superAdmin = await failure(
        service.addPersonToTenant({ ...base(), role: UserRole.SUPER_ADMIN }),
      );
      expect(superAdmin.getStatus()).toBe(400);

      const unknown = await failure(
        service.addPersonToTenant({ ...base(), tenantId: '0b6c7d1e-5f2a-4c3b-8d9e-1f2a3b4c5d6e' }),
      );
      expect(unknown.getStatus()).toBe(404);
      expect(h.provisionUser).not.toHaveBeenCalled();
    });

    it('an inactive membership is dual-written to gate_users.status for a single-building person', async () => {
      const result = await service.addPersonToTenant({ ...base(), status: UserStatus.INACTIVE });

      expect(result.membership.status).toBe(UserStatus.INACTIVE);
      expect(m.row(User, result.person.id)?.status).toBe(UserStatus.INACTIVE);
    });
  });

  // ============ removeMembership ============

  describe('removeMembership', () => {
    /** Gives the person a full set of assets in one building. */
    function equip(person: User, tenant: Tenant) {
      const tag = tenant.name;
      const personalCard = m.insert(RfidCard, {
        userId: person.id,
        tenantId: tenant.id,
        uid: `${tag}-P`,
      });
      const vehicle = m.insert(Vehicle, {
        ownerId: person.id,
        tenantId: tenant.id,
        licensePlate: `${tag}-PLATE`,
        rfidUid: `${tag}-TAG`,
      });
      const vehicleCard = m.insert(RfidCard, {
        vehicleId: vehicle.id,
        tenantId: tenant.id,
        uid: `${tag}-V`,
      });
      const ownPass = m.insert(VisitorPass, {
        createdById: person.id,
        tenantId: tenant.id,
        registrationType: RegistrationType.SELF_SERVICE,
        status: VisitorPassStatus.ACTIVE,
      });
      const hostedPass = m.insert(VisitorPass, {
        residentId: person.id,
        createdById: 'someone-else',
        tenantId: tenant.id,
        registrationType: RegistrationType.ON_PREMISE,
        status: VisitorPassStatus.PENDING,
      });
      const registeredPass = m.insert(VisitorPass, {
        createdById: person.id,
        residentId: 'a-host',
        tenantId: tenant.id,
        registrationType: RegistrationType.ON_PREMISE,
        status: VisitorPassStatus.ACTIVE,
      });
      const notification = m.insert(Notification, { userId: person.id, tenantId: tenant.id });
      return {
        personalCard,
        vehicle,
        vehicleCard,
        ownPass,
        hostedPass,
        registeredPass,
        notification,
      };
    }

    it("removing P from B releases only B's assets; A and C survive", async () => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
      const p = fx.person({ tenantId: towerA.id });
      fx.membership(p, towerA, { role: UserRole.BUILDING_ADMIN });
      fx.membership(p, towerB, { role: UserRole.RESIDENT, unit: '9C' });
      fx.membership(p, towerC, { role: UserRole.SECURITY });
      const inA = equip(p, towerA);
      const inB = equip(p, towerB);
      const inC = equip(p, towerC);
      const personal = m.insert(Notification, { userId: p.id, tenantId: null });

      const result = await service.removeMembership({
        userId: p.id,
        tenantId: towerB.id,
        reason: 'removed_by_admin',
      });

      expect(result.released).toEqual({
        personalCards: 1,
        vehicles: 1,
        vehicleCards: 1,
        passesCancelled: 2,
        notifications: 1,
      });
      expect(result.membership.deletedAt).toBeInstanceOf(Date);

      // B: gone or cancelled, except the on-premise pass P registered for a host.
      expect(m.row(RfidCard, inB.personalCard.id)).toBeUndefined();
      expect(m.row(RfidCard, inB.vehicleCard.id)).toBeUndefined();
      expect(m.row(Vehicle, inB.vehicle.id)).toBeUndefined();
      expect(m.row(VisitorPass, inB.ownPass.id)?.status).toBe(VisitorPassStatus.CANCELLED);
      expect(m.row(VisitorPass, inB.hostedPass.id)?.status).toBe(VisitorPassStatus.CANCELLED);
      expect(m.row(VisitorPass, inB.registeredPass.id)?.status).toBe(VisitorPassStatus.ACTIVE);
      expect(m.row(Notification, inB.notification.id)).toBeUndefined();

      // A and C: everything intact.
      for (const kept of [inA, inC]) {
        expect(m.row(RfidCard, kept.personalCard.id)).toBeDefined();
        expect(m.row(RfidCard, kept.vehicleCard.id)).toBeDefined();
        expect(m.row(Vehicle, kept.vehicle.id)).toBeDefined();
        expect(m.row(VisitorPass, kept.ownPass.id)?.status).toBe(VisitorPassStatus.ACTIVE);
        expect(m.row(VisitorPass, kept.hostedPass.id)?.status).toBe(VisitorPassStatus.PENDING);
        expect(m.row(Notification, kept.notification.id)).toBeDefined();
      }
      expect(m.row(Notification, personal.id)).toBeDefined();

      expect(
        liveMemberships(p.id)
          .map((row) => row.tenantId)
          .sort(),
      ).toEqual([towerA.id, towerC.id].sort());
      // The person row keeps the primary (A, the oldest active) on the mirror.
      expect(m.row(User, p.id)).toMatchObject({
        tenantId: towerA.id,
        role: UserRole.BUILDING_ADMIN,
      });
    });

    it('every asset delete and update is scoped by the building', async () => {
      const p = fx.person();
      fx.membership(p, towerB);
      equip(p, towerB);

      await service.removeMembership({
        userId: p.id,
        tenantId: towerB.id,
        reason: 'left_building',
      });

      const assetWrites = m.writes.filter((write) =>
        [RfidCard, Vehicle, VisitorPass, Notification].includes(write.target as never),
      );
      expect(assetWrites.length).toBeGreaterThanOrEqual(6);
      for (const write of assetWrites) {
        expect(write.criteria.tenantId).toBe(towerB.id);
      }
      // gate_users is only written by the mirror (MembershipsService), never directly.
      expect(m.row(User, p.id)).toMatchObject({ tenantId: null, role: UserRole.BUILDING_ADMIN });
    });

    it('expectedRole mismatch or no membership: 409 and nothing changes', async () => {
      const p = fx.person();
      fx.membership(p, towerB, { role: UserRole.SECURITY });
      const card = m.insert(RfidCard, { userId: p.id, tenantId: towerB.id, uid: 'X' });

      const wrongRole = await failure(
        service.removeMembership({
          userId: p.id,
          tenantId: towerB.id,
          expectedRole: UserRole.RESIDENT,
          reason: 'removed_by_admin',
        }),
      );
      expect(wrongRole.getStatus()).toBe(409);
      expect(bodyOf(wrongRole).message).toBe('Not currently a resident of this building.');

      const elsewhere = await failure(
        service.removeMembership({ userId: p.id, tenantId: towerA.id, reason: 'removed_by_admin' }),
      );
      expect(elsewhere.getStatus()).toBe(409);

      expect(m.row(RfidCard, card.id)).toBeDefined();
      expect(liveMemberships(p.id)).toHaveLength(1);
    });

    it('requires the building (400 TENANT_REQUIRED) and a known person (404)', async () => {
      const p = fx.person();
      const noTenant = await failure(
        service.removeMembership({ userId: p.id, tenantId: undefined, reason: 'removed_by_admin' }),
      );
      expect(bodyOf(noTenant).code).toBe('TENANT_REQUIRED');

      const nobody = await failure(
        service.removeMembership({
          userId: 'e7d4a1f0-3c2b-4a59-8e6d-9f0a1b2c3d4e',
          tenantId: towerA.id,
          reason: 'removed_by_admin',
        }),
      );
      expect(nobody.getStatus()).toBe(404);
    });

    it('protectLastAdmin refuses the last active admin, and allows one of two', async () => {
      const first = fx.person();
      fx.membership(first, towerA, { role: UserRole.BUILDING_ADMIN });

      const refused = await failure(
        service.removeMembership({
          userId: first.id,
          tenantId: towerA.id,
          reason: 'removed_by_admin',
          protectLastAdmin: true,
        }),
      );
      expect(refused.getStatus()).toBe(409);
      expect(bodyOf(refused).code).toBe('LAST_BUILDING_ADMIN');

      const second = fx.person();
      fx.membership(second, towerA, { role: UserRole.BUILDING_ADMIN });
      await expect(
        service.removeMembership({
          userId: first.id,
          tenantId: towerA.id,
          reason: 'removed_by_admin',
          protectLastAdmin: true,
        }),
      ).resolves.toBeDefined();
    });

    it('ending the last membership lifts the status the dual-write had copied', async () => {
      const p = fx.person({ status: UserStatus.INACTIVE });
      fx.membership(p, towerB, { status: UserStatus.INACTIVE });

      await service.removeMembership({
        userId: p.id,
        tenantId: towerB.id,
        reason: 'removed_by_admin',
      });

      expect(m.row(User, p.id)?.status).toBe(UserStatus.ACTIVE);
    });
  });

  // ============ removePersonFromPlatform ============

  describe('removePersonFromPlatform', () => {
    const platformAdmin = (): PlatformActor =>
      ({
        id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
        role: UserRole.SUPER_ADMIN,
        tenantId: null,
        contextKind: 'platform',
        [ACTING_USER_MARK]: true,
      }) as PlatformActor;

    it('ends every membership, cancels pending requests and soft-deletes the person', async () => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
      const p = fx.person({ tenantId: towerA.id });
      fx.membership(p, towerA);
      fx.membership(p, towerB, { role: UserRole.SECURITY });
      m.insert(RfidCard, { userId: p.id, tenantId: towerA.id, uid: 'A1' });
      m.insert(RfidCard, { userId: p.id, tenantId: towerB.id, uid: 'B1' });
      const request = m.insert(BuildingJoinRequest, {
        userId: p.id,
        tenantId: towerC.id,
        status: JoinRequestStatus.PENDING,
      });

      const result = await service.removePersonFromPlatform(p.id, {
        actor: platformAdmin(),
        scope: 'platform',
      });

      expect(result).toMatchObject({ membershipsEnded: 2, joinRequestsCancelled: 1 });
      expect(result.released.personalCards).toBe(2);
      expect(liveMemberships(p.id)).toHaveLength(0);
      expect(m.row(User, p.id)?.deletedAt).toBeInstanceOf(Date);
      expect(m.row(User, p.id)).toMatchObject({ tenantId: null, role: UserRole.BUILDING_ADMIN });
      expect(m.row(BuildingJoinRequest, request.id)?.status).toBe(JoinRequestStatus.CANCELLED);
    });

    it('locks the pending join requests before the person (request -> tenant -> person)', async () => {
      const p = fx.person({ tenantId: towerA.id });
      fx.membership(p, towerA);
      m.insert(BuildingJoinRequest, {
        userId: p.id,
        tenantId: towerC.id,
        status: JoinRequestStatus.PENDING,
      });

      // Every row lock or write the removal takes, in order.
      const steps: string[] = [];
      const findOne = m.findOne.bind(m);
      jest
        .spyOn(m, 'findOne')
        .mockImplementation(async (target, options: { where: object; lock?: object }) => {
          if (options.lock) steps.push(`lock ${target.name}`);
          return findOne(target, options);
        });
      const update = m.update.bind(m);
      jest.spyOn(m, 'update').mockImplementation(async (target, criteria, values) => {
        steps.push(`update ${target.name}`);
        return update(target, criteria, values);
      });

      await service.removePersonFromPlatform(p.id, { actor: platformAdmin(), scope: 'platform' });

      // Approving a request locks it, then the tenant, then the person: a
      // removal that locked the person first and the request last deadlocked
      // with it (DATA-3).
      expect(steps[0]).toBe('update BuildingJoinRequest');
      expect(steps.indexOf('update BuildingJoinRequest')).toBeLessThan(steps.indexOf('lock User'));
      expect(steps.filter((step) => step === 'update BuildingJoinRequest')).toHaveLength(1);
    });

    it('an unknown person is 404 and cancels nothing', async () => {
      const ghost = '0f0e0d0c-0b0a-4908-8706-050403020100';
      const request = m.insert(BuildingJoinRequest, {
        userId: fx.person().id,
        tenantId: towerC.id,
        status: JoinRequestStatus.PENDING,
      });

      const error = await failure(
        service.removePersonFromPlatform(ghost, { actor: platformAdmin(), scope: 'platform' }),
      );

      expect(error.getStatus()).toBe(404);
      expect(m.row(BuildingJoinRequest, request.id)?.status).toBe(JoinRequestStatus.PENDING);
    });

    it('needs scope=platform, a platform super admin, and never removes the caller', async () => {
      const p = fx.person();
      fx.membership(p, towerA);

      const noScope = await failure(
        service.removePersonFromPlatform(p.id, { actor: platformAdmin(), scope: undefined }),
      );
      expect(noScope.getStatus()).toBe(400);

      const buildingAdmin = {
        id: 'f0e1d2c3-b4a5-4968-8776-655443322110',
        role: UserRole.BUILDING_ADMIN,
        tenantId: towerA.id,
        contextKind: 'membership',
      } as PlatformActor;
      const notPlatform = await failure(
        service.removePersonFromPlatform(p.id, { actor: buildingAdmin, scope: 'platform' }),
      );
      expect(notPlatform.getStatus()).toBe(403);

      // A super admin acting inside one of their buildings is not the Platform context.
      const superInBuilding = {
        ...platformAdmin(),
        role: UserRole.BUILDING_ADMIN,
        contextKind: 'membership',
      };
      const inBuilding = await failure(
        service.removePersonFromPlatform(p.id, {
          actor: superInBuilding as PlatformActor,
          scope: 'platform',
        }),
      );
      expect(inBuilding.getStatus()).toBe(403);

      const self = platformAdmin();
      const selfRemoval = await failure(
        service.removePersonFromPlatform(self.id, { actor: self, scope: 'platform' }),
      );
      expect(selfRemoval.getStatus()).toBe(403);

      expect(liveMemberships(p.id)).toHaveLength(1);
      expect(m.row(User, p.id)?.deletedAt).toBeNull();
    });
  });

  // ============ restoreDeletedPerson ============

  describe('restoreDeletedPerson', () => {
    it('restores an old-style soft-deleted guard with no access and releases their legacy building', async () => {
      // Deleted from the Users page before memberships: the row still names B.
      const guard = fx.person({
        tenantId: towerB.id,
        role: UserRole.SECURITY,
        deletedAt: new Date(),
      });
      m.insert(RfidCard, { userId: guard.id, tenantId: towerB.id, uid: 'GUARD' });

      await expect(service.restoreDeletedPerson(guard.id)).resolves.toBe(true);

      expect(m.row(User, guard.id)).toMatchObject({
        deletedAt: null,
        tenantId: null,
        role: UserRole.BUILDING_ADMIN,
        status: UserStatus.ACTIVE,
      });
      expect(liveMemberships(guard.id)).toHaveLength(0);
      expect(m.rows(RfidCard)).toHaveLength(0);
    });

    it('ends memberships still live, releases those buildings too, and keeps the status', async () => {
      const p = fx.person({
        tenantId: towerA.id,
        status: UserStatus.INACTIVE,
        deletedAt: new Date(),
      });
      fx.membership(p, towerA);
      m.insert(RfidCard, { userId: p.id, tenantId: towerA.id, uid: 'A' });
      const elsewhere = m.insert(RfidCard, {
        userId: 'another-person',
        tenantId: towerA.id,
        uid: 'Z',
      });

      await service.restoreDeletedPerson(p.id);

      expect(liveMemberships(p.id)).toHaveLength(0);
      expect(m.rows(RfidCard).map((row) => row.id)).toEqual([elsewhere.id]);
      expect(m.row(User, p.id)?.status).toBe(UserStatus.INACTIVE);
    });

    it('a restored super admin comes back without platform access', async () => {
      const former = fx.person({ role: UserRole.SUPER_ADMIN, deletedAt: new Date() });

      await service.restoreDeletedPerson(former.id);

      expect(m.row(User, former.id)).toMatchObject({
        deletedAt: null,
        role: UserRole.BUILDING_ADMIN,
      });
    });

    it('is a no-op for a live person (a concurrent sign-in already restored it)', async () => {
      const p = fx.person({ tenantId: towerA.id });
      fx.membership(p, towerA);

      await expect(service.restoreDeletedPerson(p.id)).resolves.toBe(false);
      expect(liveMemberships(p.id)).toHaveLength(1);
    });
  });
});
