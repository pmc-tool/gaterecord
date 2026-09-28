/**
 * PPL-14: onboarding status from the overlay and memberships, and creating
 * additional buildings as a building_admin membership.
 *
 * The REAL OnboardingService and MembershipsService run over the in-memory
 * RollbackPeopleManager (no database). The two policy facts that are pure SQL
 * (buildings created by the person, admin on a multi_building plan) are
 * answered from the same in-memory rows by a subclass; the rules that use them
 * are unit-tested directly in the building-creation-policy block below.
 */
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EntityManager, Repository } from 'typeorm';
import {
  BuildingJoinRequest,
  JoinRequestStatus,
} from '@database/entities/building-join-request.entity';
import { Membership } from '@database/entities/membership.entity';
import { SubscriptionPlan } from '@database/entities/subscription-plan.entity';
import { Tenant, TenantStatus } from '@database/entities/tenant.entity';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import { ACTING_USER_MARK, ActingUser, ContextKind } from '@common/context/acting-user';
import { membershipErrorCodeOf } from '@common/context/membership-context.errors';
import { peopleFixtures } from '../people/people.spec-harness';
import { MembershipStack, buildMembershipStack } from '../tenants/tenant-lifecycle.spec-harness';
import {
  DEFAULT_MAX_BUILDINGS_CREATED_PER_PERSON,
  decideBuildingCreation,
  parseBuildingCreationPolicy,
  parseMaxBuildingsCreated,
} from './building-creation-policy';
import { CreateBuildingDto } from './dto/create-building.dto';
import { OnboardingService } from './onboarding.service';

/** Answers the two SQL-only policy facts from the fake's rows. */
class TestOnboardingService extends OnboardingService {
  constructor(
    private readonly stack: MembershipStack,
    ...args: ConstructorParameters<typeof OnboardingService>
  ) {
    super(...args);
  }

  protected async countBuildingsCreatedBy(_m: EntityManager, personId: string): Promise<number> {
    return this.stack.m
      .live(Tenant)
      .filter(
        (row) => (row.settings as Record<string, unknown> | null)?.createdByUserId === personId,
      ).length;
  }

  protected async isAdminOnMultiBuildingPlan(
    _m: EntityManager,
    personId: string,
  ): Promise<boolean> {
    return this.stack.m.live(Membership).some((row) => {
      if (row.userId !== personId || row.role !== UserRole.BUILDING_ADMIN) return false;
      if (row.status !== UserStatus.ACTIVE) return false;
      const tenant = this.stack.m.row(Tenant, row.tenantId as string);
      const plan =
        tenant && this.stack.m.row(SubscriptionPlan, tenant.subscriptionPlanId as string);
      return (plan?.features as { multi_building?: boolean } | undefined)?.multi_building === true;
    });
  }
}

/** A membership-count query builder over the fake rows (live membership, live building). */
function membershipRepositoryOver(stack: MembershipStack) {
  const calls: string[] = [];
  const repository = {
    createQueryBuilder: jest.fn(() => {
      const params: Record<string, unknown> = {};
      const qb: Record<string, jest.Mock> = {};
      qb.innerJoin = jest.fn((relation: string) => {
        calls.push(`innerJoin ${relation}`);
        return qb;
      });
      qb.where = jest.fn((_sql: string, p: Record<string, unknown>) => {
        Object.assign(params, p);
        return qb;
      });
      qb.getCount = jest.fn(
        async () =>
          stack.m.live(Membership).filter((row) => {
            const tenant = stack.m.row(Tenant, row.tenantId as string);
            return row.userId === params.personId && !!tenant && tenant.deletedAt == null;
          }).length,
      );
      return qb;
    }),
  };
  return { repository: repository as unknown as Repository<Membership>, calls };
}

function repositoryOver<T extends object>(stack: MembershipStack, target: new () => T) {
  return {
    findOne: (options: { where: object }) => stack.m.findOne(target, options),
    find: async () => stack.m.live(target).map((row) => Object.assign(new target(), row)),
    save: async (entity: T) => stack.m.save(entity as T & { id?: string }),
  } as unknown as Repository<T>;
}

/** An overlaid principal as the strategies build it. */
function acting(
  person: Partial<User>,
  overlay: {
    contextKind: ContextKind;
    role?: UserRole | null;
    tenantId?: string | null;
    tenant?: Partial<Tenant> | null;
    isSuperAdmin?: boolean;
  },
): ActingUser {
  return Object.assign(new User(), person, {
    role: overlay.role ?? null,
    tenantId: overlay.tenantId ?? null,
    tenant: overlay.tenant ?? null,
    contextKind: overlay.contextKind,
    contextProblem: null,
    contextProblemReason: null,
    isSuperAdmin: overlay.isSuperAdmin ?? false,
    [ACTING_USER_MARK]: true,
  }) as unknown as ActingUser;
}

const DTO: CreateBuildingDto = {
  buildingName: 'Tower E',
  buildingAddress: '5 East Road',
  planName: 'starter',
};

describe('building-creation-policy (PPL-14)', () => {
  it('parses the policy: unset is open, known values pass, anything else fails closed', () => {
    expect(parseBuildingCreationPolicy(undefined)).toEqual({ policy: 'open', unrecognised: null });
    expect(parseBuildingCreationPolicy('  Plan ')).toEqual({ policy: 'plan', unrecognised: null });
    expect(parseBuildingCreationPolicy('off')).toEqual({ policy: 'off', unrecognised: null });
    expect(parseBuildingCreationPolicy('closed')).toEqual({
      policy: 'off',
      unrecognised: 'closed',
    });
  });

  it('parses the cap: default 5, negative is unlimited, junk is the default', () => {
    expect(parseMaxBuildingsCreated(undefined)).toBe(DEFAULT_MAX_BUILDINGS_CREATED_PER_PERSON);
    expect(parseMaxBuildingsCreated('3')).toBe(3);
    expect(parseMaxBuildingsCreated('0')).toBe(0);
    expect(parseMaxBuildingsCreated('-1')).toBeNull();
    expect(parseMaxBuildingsCreated('many')).toBe(DEFAULT_MAX_BUILDINGS_CREATED_PER_PERSON);
  });

  const base = {
    policy: 'open' as const,
    maxCreated: 5,
    liveMemberships: 1,
    createdSoFar: 0,
    adminOfMultiBuildingPlan: false,
  };

  it('always allows the first building, whatever the policy (only the cap applies)', () => {
    for (const policy of ['open', 'plan', 'off'] as const) {
      expect(decideBuildingCreation({ ...base, policy, liveMemberships: 0 })).toBeNull();
    }
    expect(decideBuildingCreation({ ...base, liveMemberships: 0, createdSoFar: 5 })).toBe(
      'LIMIT_REACHED',
    );
  });

  it('applies the policy to additional buildings', () => {
    expect(decideBuildingCreation(base)).toBeNull();
    expect(decideBuildingCreation({ ...base, policy: 'off' })).toBe('POLICY_OFF');
    expect(decideBuildingCreation({ ...base, policy: 'plan' })).toBe('PLAN_REQUIRED');
    expect(
      decideBuildingCreation({ ...base, policy: 'plan', adminOfMultiBuildingPlan: true }),
    ).toBeNull();
    expect(decideBuildingCreation({ ...base, createdSoFar: 5 })).toBe('LIMIT_REACHED');
    expect(decideBuildingCreation({ ...base, maxCreated: null, createdSoFar: 99 })).toBeNull();
  });
});

describe('OnboardingService on memberships (PPL-14)', () => {
  const originalFlag = process.env.GATE_MEMBERSHIP_CONTEXT;
  let stack: MembershipStack;
  let fx: ReturnType<typeof peopleFixtures>;
  let settings: Record<string, string | undefined>;
  let membershipCount: ReturnType<typeof membershipRepositoryOver>;
  let service: TestOnboardingService;
  let freePlan: SubscriptionPlan;

  beforeEach(() => {
    process.env.GATE_MEMBERSHIP_CONTEXT = 'off';
    stack = buildMembershipStack();
    fx = peopleFixtures(stack.m);
    freePlan = fx.plan({ name: 'Free', isDefault: true, isActive: true, defaultValidityDays: 60 });
    settings = {};
    membershipCount = membershipRepositoryOver(stack);

    service = new TestOnboardingService(
      stack,
      repositoryOver(stack, Tenant),
      repositoryOver(stack, SubscriptionPlan),
      {
        findOne: async (options: { where: { userId: string } }) =>
          stack.m
            .rows(BuildingJoinRequest)
            .filter((row) => row.userId === options.where.userId)
            .map((row) => Object.assign(new BuildingJoinRequest(), row))
            .pop() ?? null,
      } as unknown as Repository<BuildingJoinRequest>,
      membershipCount.repository,
      stack.dataSource,
      stack.memberships,
      { get: (key: string) => settings[key] } as unknown as ConfigService,
    );
  });

  afterEach(() => {
    process.env.GATE_MEMBERSHIP_CONTEXT = originalFlag;
  });

  describe('getStatus', () => {
    it('a super admin with no membership does not need onboarding', async () => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
      const admin = fx.person({ role: UserRole.SUPER_ADMIN });

      const status = await service.getStatus(
        acting(admin, { contextKind: 'platform', role: UserRole.SUPER_ADMIN, isSuperAdmin: true }),
      );

      expect(status).toMatchObject({
        needsOnboarding: false,
        isSuperAdmin: true,
        tenantId: null,
        role: UserRole.SUPER_ADMIN,
        tenant: null,
      });
    });

    it('a person whose only membership is inactive does not need onboarding (L8)', async () => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
      const tower = fx.tenant(freePlan);
      const person = fx.person({ tenantId: tower.id, role: UserRole.RESIDENT });
      fx.membership(person, tower, { status: UserStatus.INACTIVE });

      const status = await service.getStatus(acting(person, { contextKind: 'none' }));

      expect(status.needsOnboarding).toBe(false);
      expect(status.role).toBeNull();
      expect(membershipCount.calls).toContain('innerJoin membership.tenant');
    });

    it('a person with no membership needs onboarding and sees a pending join request', async () => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
      const tower = fx.tenant(freePlan);
      const person = fx.person();
      stack.m.insert(BuildingJoinRequest, {
        userId: person.id,
        tenantId: tower.id,
        status: JoinRequestStatus.PENDING,
      });

      const status = await service.getStatus(acting(person, { contextKind: 'none' }));

      expect(status).toMatchObject({ needsOnboarding: true, joinRequestStatus: 'pending' });
    });

    it('a membership in a deleted building does not count', async () => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
      const gone = fx.tenant(freePlan);
      stack.m.row(Tenant, gone.id)!.deletedAt = new Date();
      const person = fx.person();
      fx.membership(person, gone);

      const status = await service.getStatus(acting(person, { contextKind: 'none' }));

      expect(status.needsOnboarding).toBe(true);
    });

    it('flag off: an existing single-building user gets the same fields as before', async () => {
      const tower = fx.tenant(freePlan, { name: 'Tower A', slug: 'tower-a' });
      const person = fx.person({ tenantId: tower.id, role: UserRole.BUILDING_ADMIN });
      fx.membership(person, tower, { role: UserRole.BUILDING_ADMIN });
      const overlay = acting(person, {
        contextKind: 'legacy',
        role: UserRole.BUILDING_ADMIN,
        tenantId: tower.id,
        tenant: { id: tower.id, name: 'Tower A', slug: 'tower-a', status: TenantStatus.ACTIVE },
      });

      const status = await service.getStatus(overlay);

      expect(status).toEqual({
        needsOnboarding: false,
        isSuperAdmin: false,
        tenantId: tower.id,
        role: UserRole.BUILDING_ADMIN,
        joinRequestStatus: null,
        tenant: { id: tower.id, name: 'Tower A', slug: 'tower-a', status: TenantStatus.ACTIVE },
        plans: expect.any(Array),
      });
    });

    it('flag off: a legacy row that names a building counts as onboarded even without a membership', async () => {
      const tower = fx.tenant(freePlan);
      const person = fx.person({ tenantId: tower.id, role: UserRole.RESIDENT });

      const status = await service.getStatus(
        acting(person, { contextKind: 'legacy', role: UserRole.RESIDENT, tenantId: tower.id }),
      );

      expect(status.needsOnboarding).toBe(false);
    });
  });

  describe('createBuilding', () => {
    it('multi flag on: a resident of B creates E, gets membershipId, and the person row is not written', async () => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
      const towerB = fx.tenant(freePlan, { name: 'Tower B' });
      const person = fx.person({ tenantId: towerB.id, role: UserRole.RESIDENT, unit: '4B' });
      fx.membership(person, towerB, { role: UserRole.RESIDENT, unit: '4B' });
      const before = { ...stack.m.row(User, person.id) };

      const result = await service.createBuilding(
        acting(person, { contextKind: 'membership', role: UserRole.RESIDENT, tenantId: towerB.id }),
        DTO,
      );

      const towerE = stack.m.live(Tenant).find((row) => row.name === 'Tower E');
      expect(towerE).toBeDefined();
      expect(towerE?.settings).toMatchObject({ createdByUserId: person.id });

      const created = stack.m.live(Membership).find((row) => row.tenantId === towerE?.id);
      expect(created).toMatchObject({ userId: person.id, role: UserRole.BUILDING_ADMIN });
      expect(result.membershipId).toBe(created?.id);
      expect(result.membership).toEqual({
        id: created?.id,
        role: UserRole.BUILDING_ADMIN,
        tenant: expect.objectContaining({ id: towerE?.id, name: 'Tower E' }),
      });
      expect(result.user).toMatchObject({
        id: person.id,
        role: UserRole.BUILDING_ADMIN,
        tenantId: towerE?.id,
      });

      // No update of gate_users at all: B stays the primary membership.
      expect(stack.m.writes.filter((w) => w.kind === 'update' && w.target === User)).toEqual([]);
      expect(stack.m.row(User, person.id)).toEqual(before);
    });

    it('zero memberships: the first building is created and mirrored onto the legacy row', async () => {
      const person = fx.person();

      const result = await service.createBuilding(acting(person, { contextKind: 'legacy' }), DTO);

      expect(result.tenant.name).toBe('Tower E');
      expect(stack.m.row(User, person.id)).toMatchObject({
        tenantId: result.tenant.id,
        role: UserRole.BUILDING_ADMIN,
      });
    });

    it('flag off: someone who already has a building is refused and no building is created', async () => {
      const towerA = fx.tenant(freePlan, { name: 'Tower A' });
      const person = fx.person({ tenantId: towerA.id });
      fx.membership(person, towerA, { role: UserRole.BUILDING_ADMIN });

      const error = await service
        .createBuilding(acting(person, { contextKind: 'legacy', tenantId: towerA.id }), DTO)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect(membershipErrorCodeOf(error)).toBe('MULTI_MEMBERSHIP_DISABLED');
      expect(stack.m.live(Tenant).some((row) => row.name === 'Tower E')).toBe(false);
    });

    it('refuses past MAX_BUILDINGS_CREATED_PER_PERSON with 403 and creates nothing', async () => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
      settings.MAX_BUILDINGS_CREATED_PER_PERSON = '1';
      const person = fx.person();
      await service.createBuilding(acting(person, { contextKind: 'none' }), {
        ...DTO,
        buildingName: 'First',
      });

      const error = await service
        .createBuilding(acting(person, { contextKind: 'none' }), DTO)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toMatchObject({
        code: 'BUILDING_LIMIT_REACHED',
      });
      expect(stack.m.live(Tenant).some((row) => row.name === 'Tower E')).toBe(false);
    });

    it("policy 'plan': only an active admin of a multi_building plan may add a building", async () => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
      settings.ONBOARDING_MULTI_BUILDING_POLICY = 'plan';
      const towerB = fx.tenant(freePlan, { name: 'Tower B' });
      const resident = fx.person();
      fx.membership(resident, towerB, { role: UserRole.RESIDENT });

      const error = await service
        .createBuilding(acting(resident, { contextKind: 'none' }), DTO)
        .catch((e: unknown) => e);
      expect((error as ForbiddenException).getResponse()).toMatchObject({
        code: 'BUILDING_CREATION_NOT_ALLOWED',
      });

      const multiPlan = fx.plan({ name: 'Multi', features: { multi_building: true } });
      const towerM = fx.tenant(multiPlan, { name: 'Tower M' });
      const admin = fx.person();
      fx.membership(admin, towerM, { role: UserRole.BUILDING_ADMIN });

      const result = await service.createBuilding(acting(admin, { contextKind: 'none' }), DTO);
      expect(result.membership.role).toBe(UserRole.BUILDING_ADMIN);
    });

    it("policy 'off' and an unknown value both refuse an additional building", async () => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
      const towerB = fx.tenant(freePlan, { name: 'Tower B' });
      const person = fx.person();
      fx.membership(person, towerB, { role: UserRole.BUILDING_ADMIN });

      for (const value of ['off', 'closed']) {
        settings.ONBOARDING_MULTI_BUILDING_POLICY = value;
        const error = await service
          .createBuilding(acting(person, { contextKind: 'none' }), DTO)
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ForbiddenException);
      }
    });

    it('refuses a taken building name with 409', async () => {
      fx.tenant(freePlan, { name: 'Tower E' });
      const person = fx.person();

      await expect(
        service.createBuilding(acting(person, { contextKind: 'legacy' }), DTO),
      ).rejects.toThrow('Building name already registered');
    });
  });

  describe('updateBuilding', () => {
    it('renames the building the request acts in, as its admin', async () => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
      const towerD = fx.tenant(freePlan, { name: 'Tower D' });
      const person = fx.person();

      const result = await service.updateBuilding(
        acting(person, {
          contextKind: 'membership',
          role: UserRole.BUILDING_ADMIN,
          tenantId: towerD.id,
        }),
        { buildingName: 'Tower D Renamed' },
      );

      expect(result).toMatchObject({ id: towerD.id, name: 'Tower D Renamed' });
    });

    it('403 in a resident context, 409 MEMBERSHIP_REQUIRED without one', async () => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
      const towerB = fx.tenant(freePlan);
      const person = fx.person();

      const asResident = await service
        .updateBuilding(
          acting(person, {
            contextKind: 'membership',
            role: UserRole.RESIDENT,
            tenantId: towerB.id,
          }),
          { buildingName: 'Nope' },
        )
        .catch((e: unknown) => e);
      expect(membershipErrorCodeOf(asResident)).toBe('ROLE_NOT_ALLOWED_IN_BUILDING');

      const noContext = await service
        .updateBuilding(acting(person, { contextKind: 'none' }), { buildingName: 'Nope' })
        .catch((e: unknown) => e);
      expect(membershipErrorCodeOf(noContext)).toBe('MEMBERSHIP_REQUIRED');
    });
  });
});
