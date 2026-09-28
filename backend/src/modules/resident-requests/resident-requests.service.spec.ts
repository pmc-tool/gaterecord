import { HttpException } from '@nestjs/common';
import { FindOperator, QueryFailedError } from 'typeorm';
import {
  BuildingJoinRequest,
  JoinRequestStatus,
} from '@database/entities/building-join-request.entity';
import { Membership } from '@database/entities/membership.entity';
import { SubscriptionPlan } from '@database/entities/subscription-plan.entity';
import { Tenant } from '@database/entities/tenant.entity';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import { membershipErrorCodeOf } from '@common/context/membership-context.errors';
import { ResidentRemovalService } from '../residents/resident-removal.service';
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
  personOf,
  repositoryOver,
} from '../users/people-api.spec-harness';
import {
  JOIN_REQUEST_PENDING_INDEX,
  MAX_PENDING_JOIN_REQUESTS,
  ResidentRequestsService,
} from './resident-requests.service';

/**
 * PPL-12 / PPL-13: joining a building as a resident when the requester may
 * already hold roles elsewhere, and approval as a RESIDENT membership. The real
 * MembershipsService and lifecycle run underneath over the in-memory manager.
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

describe('ResidentRequestsService (memberships)', () => {
  const originalFlag = process.env.GATE_MEMBERSHIP_CONTEXT;
  let h: LifecycleHarness;
  let m: FakePeopleManager;
  let fx: ReturnType<typeof peopleFixtures>;
  let service: ResidentRequestsService;
  let requests: ReturnType<typeof repositoryOver<BuildingJoinRequest>>;
  let tenants: ReturnType<typeof repositoryOver<Tenant>>;
  let notifications: { createForTenantRoles: jest.Mock; create: jest.Mock };
  let plan: SubscriptionPlan;
  let towerA: Tenant;
  let towerB: Tenant;
  let towerD: Tenant;

  const liveMemberships = (userId: string) =>
    m.rows(Membership).filter((row) => row.deletedAt == null && row.userId === userId);

  beforeEach(() => {
    process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
    h = buildLifecycle();
    m = acceptTargetedSave(h.m);
    fx = peopleFixtures(m);
    requests = repositoryOver(m, BuildingJoinRequest);
    tenants = repositoryOver(m, Tenant);
    notifications = {
      createForTenantRoles: jest.fn(async () => []),
      create: jest.fn(async () => null),
    };

    service = new ResidentRequestsService(
      requests as never,
      repositoryOver(m, User) as never,
      tenants as never,
      notifications as never,
      dataSourceOver(m),
      h.memberships,
      new ResidentRemovalService(h.service),
    );

    plan = fx.plan({ maxUsers: 10 });
    towerA = fx.tenant(plan, { name: 'Tower A' });
    towerB = fx.tenant(plan, { name: 'Tower B' });
    towerD = fx.tenant(plan, { name: 'Tower D' });
  });

  afterAll(() => {
    process.env.GATE_MEMBERSHIP_CONTEXT = originalFlag;
  });

  /** P is the admin of A. */
  function adminOfA() {
    const p = fx.person({ email: 'p@example.test', tenantId: towerA.id });
    const pa = fx.membership(p, towerA, { role: UserRole.BUILDING_ADMIN });
    return { p, pa };
  }

  function pendingRequest(
    userId: string,
    tenant: Tenant,
    values: Partial<BuildingJoinRequest> = {},
  ) {
    return m.insert(BuildingJoinRequest, {
      userId,
      tenantId: tenant.id,
      status: JoinRequestStatus.PENDING,
      unit: '5E',
      phone: '+8801',
      note: null,
      ...values,
    });
  }

  // ------------------------------------------------------------------ PPL-12

  describe('requester side (PPL-12)', () => {
    it('search: the admin of A may search and is not offered A', async () => {
      const { pa } = adminOfA();
      tenants.find.mockResolvedValue([]);

      await service.searchBuildings(actingIn(m, pa), { q: 'tower' });
      const [{ where }] = tenants.find.mock.calls[0] as unknown as [
        { where: Record<string, unknown>[] },
      ];
      expect(where).toHaveLength(2);
      for (const clause of where) {
        const id = clause.id as FindOperator<unknown>;
        expect(id.type).toBe('not');
        // Not(In([...])).value reads through to the inner list.
        expect(id.value).toEqual([towerA.id]);
      }

      await service.searchBuildings(actingIn(m, pa), {});
      const [{ where: blank }] = tenants.find.mock.calls[1] as unknown as [
        { where: Record<string, unknown> },
      ];
      expect((blank.id as FindOperator<unknown>).type).toBe('not');
    });

    it('search: flag off, a person with a building gets 403 as before', async () => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'off';
      const { p } = adminOfA();
      const error = await failure(service.searchBuildings(actingLegacy(m, p.id), {}));
      expect(error.getStatus()).toBe(403);
    });

    it('the admin of A can request B and D; both wait together', async () => {
      const { p } = adminOfA();

      const toB = await service.createRequest(p.id, { tenantId: towerB.id, unit: '4B' });
      const toD = await service.createRequest(p.id, { tenantId: towerD.id, unit: '9D' });

      expect(toB).toMatchObject({ status: JoinRequestStatus.PENDING, building: { id: towerB.id } });
      expect(toD).toMatchObject({ status: JoinRequestStatus.PENDING, building: { id: towerD.id } });
      expect(notifications.createForTenantRoles).toHaveBeenCalledWith(
        towerB.id,
        [UserRole.BUILDING_ADMIN],
        expect.objectContaining({ title: 'New resident request' }),
      );
      // A request is never a membership.
      expect(liveMemberships(p.id)).toHaveLength(1);

      const mine = await service.listMyRequests(actingIn(m, liveMembershipOf(p.id, towerA)));
      expect(mine.map((request) => request.building.id).sort()).toEqual(
        [towerB.id, towerD.id].sort(),
      );
    });

    it('refusals: JOIN_REQUEST_PENDING, MEMBERSHIP_EXISTS, ACCOUNT_SUSPENDED, unknown building', async () => {
      const { p } = adminOfA();
      await service.createRequest(p.id, { tenantId: towerB.id });

      const again = await failure(service.createRequest(p.id, { tenantId: towerB.id }));
      expect(again.getStatus()).toBe(409);
      expect(membershipErrorCodeOf(again)).toBe('JOIN_REQUEST_PENDING');

      const own = await failure(service.createRequest(p.id, { tenantId: towerA.id }));
      expect(own.getStatus()).toBe(409);
      expect(membershipErrorCodeOf(own)).toBe('MEMBERSHIP_EXISTS');

      const missing = await failure(
        service.createRequest(p.id, { tenantId: '00000000-0000-4000-8000-000000000000' }),
      );
      expect(missing.getStatus()).toBe(404);

      const banned = fx.person({ email: 'x@example.test', status: UserStatus.INACTIVE });
      const suspended = await failure(service.createRequest(banned.id, { tenantId: towerB.id }));
      expect(suspended.getStatus()).toBe(403);
      expect(membershipErrorCodeOf(suspended)).toBe('ACCOUNT_SUSPENDED');
    });

    it(`at most ${MAX_PENDING_JOIN_REQUESTS} requests wait at once`, async () => {
      const person = fx.person({ email: 'n@example.test' });
      for (let i = 0; i < MAX_PENDING_JOIN_REQUESTS; i++) {
        pendingRequest(person.id, fx.tenant(plan));
      }

      const error = await failure(service.createRequest(person.id, { tenantId: towerB.id }));
      expect(error.getStatus()).toBe(409);
    });

    it('a racing duplicate caught by the unique index becomes 409 JOIN_REQUEST_PENDING', async () => {
      const person = fx.person({ email: 'n@example.test' });
      const driverError = Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint: JOIN_REQUEST_PENDING_INDEX,
      });
      requests.save.mockRejectedValueOnce(new QueryFailedError('INSERT', [], driverError));

      const error = await failure(service.createRequest(person.id, { tenantId: towerB.id }));
      expect(membershipErrorCodeOf(error)).toBe('JOIN_REQUEST_PENDING');
    });

    it('flag off: a person who belongs to a building gets 409 MULTI_MEMBERSHIP_DISABLED up front', async () => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'off';
      const { p } = adminOfA();

      const error = await failure(service.createRequest(p.id, { tenantId: towerB.id }));
      expect(error.getStatus()).toBe(409);
      expect(membershipErrorCodeOf(error)).toBe('MULTI_MEMBERSHIP_DISABLED');

      // A person with no building keeps the one-request-at-a-time rule.
      const newcomer = fx.person({ email: 'n@example.test' });
      await service.createRequest(newcomer.id, { tenantId: towerB.id });
      const second = await failure(service.createRequest(newcomer.id, { tenantId: towerD.id }));
      expect(second.getStatus()).toBe(409);
    });

    it('an approved request is visible only while the resident membership exists', async () => {
      const person = fx.person({ email: 'n@example.test' });
      pendingRequest(person.id, towerB, { status: JoinRequestStatus.APPROVED });

      expect(await service.getMyRequest(personOf(m, person.id))).toBeNull();

      fx.membership(person, towerB, { role: UserRole.RESIDENT });
      await expect(service.getMyRequest(personOf(m, person.id))).resolves.toMatchObject({
        status: JoinRequestStatus.APPROVED,
      });
    });

    it('cancel: by id, or the only pending one; several without an id is 400', async () => {
      const person = fx.person({ email: 'n@example.test' });
      const toB = pendingRequest(person.id, towerB);
      const toD = pendingRequest(person.id, towerD);

      const ambiguous = await failure(service.cancelMyRequest(person.id));
      expect(ambiguous.getStatus()).toBe(400);

      await expect(service.cancelMyRequest(person.id, toD.id)).resolves.toMatchObject({
        status: JoinRequestStatus.CANCELLED,
      });
      await expect(service.cancelMyRequest(person.id)).resolves.toMatchObject({ id: toB.id });

      const none = await failure(service.cancelMyRequest(person.id));
      expect(none.getStatus()).toBe(404);

      // Someone else's request is never theirs to cancel.
      const other = fx.person({ email: 'o@example.test' });
      const theirs = pendingRequest(other.id, towerB);
      const foreign = await failure(service.cancelMyRequest(person.id, theirs.id));
      expect(foreign.getStatus()).toBe(404);
    });

    it('leave in the B-resident context removes only B', async () => {
      const { p, pa } = adminOfA();
      const pb = fx.membership(p, towerB, { role: UserRole.RESIDENT, unit: '4B' });

      await service.leaveBuilding(actingIn(m, pb), { tenantId: towerA.id });

      expect(m.row(Membership, pb.id)?.deletedAt).not.toBeNull();
      expect(m.row(Membership, pa.id)?.deletedAt).toBeNull();
    });

    it('leave in the admin-of-A context is 400', async () => {
      const { pa } = adminOfA();
      const error = await failure(service.leaveBuilding(actingIn(m, pa)));
      expect(error.getStatus()).toBe(400);
      expect(m.row(Membership, pa.id)?.deletedAt).toBeNull();
    });

    it('legacy leave: the row building (or the body tenantId); none at all is 409', async () => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'off';
      const resident = fx.person({
        email: 'r@example.test',
        role: UserRole.RESIDENT,
        tenantId: towerB.id,
      });
      const rb = fx.membership(resident, towerB, { role: UserRole.RESIDENT });

      await service.leaveBuilding(actingLegacy(m, resident.id));
      expect(m.row(Membership, rb.id)?.deletedAt).not.toBeNull();

      const nobody = fx.person({ email: 'n@example.test' });
      const error = await failure(service.leaveBuilding(actingLegacy(m, nobody.id)));
      expect(error.getStatus()).toBe(409);
    });
  });

  // ------------------------------------------------------------------ PPL-13

  describe('reviewer side (PPL-13)', () => {
    function adminOf(tenant: Tenant) {
      const admin = fx.person({ email: `admin-${tenant.name}@example.test` });
      return fx.membership(admin, tenant, { role: UserRole.BUILDING_ADMIN });
    }

    it('approval adds (P, B, resident, unit) without saving the person, and fills an empty phone', async () => {
      const { p, pa } = adminOfA();
      const request = pendingRequest(p.id, towerB, { unit: ' 4B ', phone: '+8801' });
      const saveSpy = jest.spyOn(m as unknown as { save: jest.Mock }, 'save');

      const view = await service.approve(actingIn(m, adminOf(towerB)), request.id, {});

      expect(view.status).toBe(JoinRequestStatus.APPROVED);
      const live = liveMemberships(p.id);
      expect(live).toHaveLength(2);
      expect(live.find((row) => row.tenantId === towerB.id)).toMatchObject({
        role: UserRole.RESIDENT,
        unit: '4B',
        status: UserStatus.ACTIVE,
      });
      expect(m.row(Membership, pa.id)).toMatchObject({ role: UserRole.BUILDING_ADMIN });
      expect(m.row(User, p.id)).toMatchObject({ phone: '+8801', role: UserRole.BUILDING_ADMIN });
      for (const [first, second] of saveSpy.mock.calls) {
        expect(second ?? first).not.toBeInstanceOf(User);
      }
      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: p.id, tenantId: towerB.id }),
      );
    });

    it("an admin acting in A gets 404 for B's request, and sees only A's queue", async () => {
      const person = fx.person({ email: 'n@example.test' });
      const toB = pendingRequest(person.id, towerB);
      const toA = pendingRequest(person.id, towerA);
      const aa = adminOf(towerA);

      const approve = await failure(service.approve(actingIn(m, aa), toB.id, {}));
      expect(approve.getStatus()).toBe(404);
      const reject = await failure(service.reject(actingIn(m, aa), toB.id, {}));
      expect(reject.getStatus()).toBe(404);

      const queue = await service.listForReviewer(actingIn(m, aa));
      expect(queue.map((request) => request.id)).toEqual([toA.id]);

      const root = fx.person({ email: 'root@example.test', role: UserRole.SUPER_ADMIN });
      const everything = await service.listForReviewer(actingOnPlatform(m, root.id));
      expect(everything.map((request) => request.id).sort()).toEqual([toA.id, toB.id].sort());
    });

    it('approve and reject cannot both commit', async () => {
      const person = fx.person({ email: 'n@example.test' });
      const request = pendingRequest(person.id, towerB);
      const bb = adminOf(towerB);

      await service.reject(actingIn(m, bb), request.id, { decisionNote: 'Not a tenant' });
      const late = await failure(service.approve(actingIn(m, bb), request.id, {}));
      expect(late.getStatus()).toBe(400);
      expect(liveMemberships(person.id)).toHaveLength(0);
    });

    it('refuses a banned requester (403) and one who already has a role there (409)', async () => {
      const bb = adminOf(towerB);

      const banned = fx.person({ email: 'x@example.test', status: UserStatus.INACTIVE });
      const bannedRequest = pendingRequest(banned.id, towerB);
      const suspended = await failure(service.approve(actingIn(m, bb), bannedRequest.id, {}));
      expect(membershipErrorCodeOf(suspended)).toBe('ACCOUNT_SUSPENDED');

      const guard = fx.person({ email: 'g@example.test' });
      fx.membership(guard, towerB, { role: UserRole.SECURITY });
      const guardRequest = pendingRequest(guard.id, towerB);
      const exists = await failure(service.approve(actingIn(m, bb), guardRequest.id, {}));
      expect(exists.getStatus()).toBe(409);
      expect(membershipErrorCodeOf(exists)).toBe('MEMBERSHIP_EXISTS');
      expect(m.row(BuildingJoinRequest, guardRequest.id)?.status).toBe(JoinRequestStatus.PENDING);
    });

    it('the seat rule applies and requires a plan', async () => {
      const noPlan = fx.tenant(null, { name: 'Tower N' });
      const admin = adminOf(noPlan);
      const person = fx.person({ email: 'n@example.test' });
      const request = pendingRequest(person.id, noPlan);

      const error = await failure(service.approve(actingIn(m, admin), request.id, {}));
      expect(error.getStatus()).toBe(403);
      expect(liveMemberships(person.id)).toHaveLength(0);
    });

    it('flag off: a requester who belongs to another building is refused (409 MULTI_MEMBERSHIP_DISABLED)', async () => {
      const { p } = adminOfA();
      const request = pendingRequest(p.id, towerB);
      const bb = adminOf(towerB);
      process.env.GATE_MEMBERSHIP_CONTEXT = 'off';

      const error = await failure(service.approve(actingIn(m, bb), request.id, {}));
      expect(membershipErrorCodeOf(error)).toBe('MULTI_MEMBERSHIP_DISABLED');
    });
  });

  function liveMembershipOf(personId: string, tenant: Tenant): Membership {
    const row = liveMemberships(personId).find((candidate) => candidate.tenantId === tenant.id);
    if (!row) throw new Error('no membership');
    return Object.assign(new Membership(), row);
  }
});
