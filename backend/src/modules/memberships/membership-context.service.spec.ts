import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import { Tenant, TenantStatus } from '@database/entities/tenant.entity';
import { Membership, MembershipRole } from '@database/entities/membership.entity';
import { ACTING_USER_MARK, ActingUser, isActingUser } from '@common/context/acting-user';
import { MembershipContextService, buildActingUser } from './membership-context.service';
import { recordMembershipTablePresence } from './membership-table';

/**
 * AUTH-5: every header x membership x flag branch of the resolver, against
 * mocked reads (the SQL of the reads is covered by
 * test/db/membership-reads.db.spec.ts).
 */
const PERSON_ID = '0b6f6a3c-8a53-4d8e-9d1f-2c5a7b1e0a01';
const OTHER_PERSON_ID = '0b6f6a3c-8a53-4d8e-9d1f-2c5a7b1e0a02';
const TOWER_A = '1a1a1a1a-1111-4111-8111-111111111111';
const TOWER_B = '2b2b2b2b-2222-4222-8222-222222222222';
const MEMBERSHIP_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const MEMBERSHIP_B = 'bbbbbbbb-0000-4000-8000-00000000000b';

function tenant(id: string, overrides: Partial<Tenant> = {}): Tenant {
  return Object.assign(new Tenant(), {
    id,
    name: `Tower ${id.slice(0, 1)}`,
    slug: `tower-${id.slice(0, 4)}`,
    status: TenantStatus.ACTIVE,
    isPaused: false,
    ...overrides,
  });
}

function person(overrides: Partial<User> = {}): User {
  return Object.assign(new User(), {
    id: PERSON_ID,
    email: 'x@example.test',
    firstName: 'X',
    lastName: 'Person',
    role: UserRole.BUILDING_ADMIN,
    status: UserStatus.ACTIVE,
    tenantId: TOWER_A,
    unit: null,
    passwordHash: '$2b$10$should-never-reach-req-user',
    ...overrides,
  });
}

function membership(
  id: string,
  tenantRow: Tenant,
  role: MembershipRole = UserRole.RESIDENT,
  overrides: Partial<Membership> = {},
): Membership {
  return Object.assign(new Membership(), {
    id,
    userId: PERSON_ID,
    tenantId: tenantRow.id,
    tenant: tenantRow,
    role,
    status: UserStatus.ACTIVE,
    unit: role === UserRole.RESIDENT ? '12B' : null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    deletedAt: null,
    ...overrides,
  });
}

describe('MembershipContextService (AUTH-5)', () => {
  const originalFlag = process.env.GATE_MEMBERSHIP_CONTEXT;
  let membershipsService: {
    findOwnedWithTenant: jest.Mock;
    listActiveForPerson: jest.Mock;
    findLive: jest.Mock;
  };
  let tenantRepository: { findOne: jest.Mock };
  let service: MembershipContextService;

  beforeEach(() => {
    membershipsService = {
      findOwnedWithTenant: jest.fn().mockResolvedValue(null),
      listActiveForPerson: jest.fn().mockResolvedValue([]),
      findLive: jest.fn().mockResolvedValue(null),
    };
    tenantRepository = { findOne: jest.fn().mockResolvedValue(tenant(TOWER_A)) };
    service = new MembershipContextService(membershipsService as never, tenantRepository as never);
  });

  afterEach(() => {
    process.env.GATE_MEMBERSHIP_CONTEXT = originalFlag;
    recordMembershipTablePresence(false);
  });

  const enable = () => (process.env.GATE_MEMBERSHIP_CONTEXT = 'on');
  const disable = () => (process.env.GATE_MEMBERSHIP_CONTEXT = 'off');

  describe('flag off (legacy overlay)', () => {
    beforeEach(disable);

    it("gives today's req.user values: role, tenantId, unit and tenant from the row", async () => {
      const row = person({ role: UserRole.RESIDENT, unit: '4C' });
      const acting = await service.resolve(row, MEMBERSHIP_B);

      expect(acting).toMatchObject({
        id: PERSON_ID,
        role: UserRole.RESIDENT,
        tenantId: TOWER_A,
        unit: '4C',
        contextKind: 'legacy',
        contextProblem: null,
        contextProblemReason: null,
        isSuperAdmin: false,
      });
      expect(acting.tenant).toEqual(tenant(TOWER_A));
      expect(acting.activeMembership).toBeNull();
      expect(tenantRepository.findOne).toHaveBeenCalledWith({ where: { id: TOWER_A } });
    });

    it('never reads gate_memberships, whatever the header', async () => {
      for (const header of [undefined, 'platform', 'garbage', [MEMBERSHIP_A], MEMBERSHIP_A]) {
        const acting = await service.resolve(person(), header);
        expect(acting.contextKind).toBe('legacy');
      }
      expect(membershipsService.findOwnedWithTenant).not.toHaveBeenCalled();
      expect(membershipsService.listActiveForPerson).not.toHaveBeenCalled();
    });

    it('gives a null tenant for a tenantless row without a query', async () => {
      const acting = await service.resolve(person({ tenantId: null }));
      expect(acting).toMatchObject({ tenantId: null, tenant: null, contextKind: 'legacy' });
      expect(tenantRepository.findOne).not.toHaveBeenCalled();
    });

    it('gives a null tenant when the building was soft-deleted', async () => {
      tenantRepository.findOne.mockResolvedValue(null);
      const acting = await service.resolve(person());
      expect(acting.tenantId).toBe(TOWER_A);
      expect(acting.tenant).toBeNull();
    });

    it('keeps a super admin row as it is', async () => {
      const acting = await service.resolve(person({ role: UserRole.SUPER_ADMIN, tenantId: null }));
      expect(acting).toMatchObject({
        role: UserRole.SUPER_ADMIN,
        tenantId: null,
        isSuperAdmin: true,
        contextKind: 'legacy',
      });
    });

    describe('rollback safety net (membership in the legacy building not active)', () => {
      beforeEach(() => recordMembershipTablePresence(true));

      it.each([UserStatus.INACTIVE, UserStatus.PENDING])(
        'a %s membership there grants no building: role, tenant and unit null',
        async (status) => {
          membershipsService.findLive.mockResolvedValue(
            membership(MEMBERSHIP_A, tenant(TOWER_A), UserRole.RESIDENT, { status }),
          );

          const acting = await service.resolve(person({ role: UserRole.RESIDENT, unit: '12B' }));

          expect(acting).toMatchObject({
            id: PERSON_ID,
            contextKind: 'legacy',
            role: null,
            tenantId: null,
            tenant: null,
            unit: null,
            contextProblem: null,
            isSuperAdmin: false,
          });
          expect(membershipsService.findLive).toHaveBeenCalledWith(PERSON_ID, TOWER_A);
          expect(tenantRepository.findOne).not.toHaveBeenCalled();
        },
      );

      it('an active membership there, or none, keeps the row values', async () => {
        for (const found of [membership(MEMBERSHIP_A, tenant(TOWER_A)), null]) {
          membershipsService.findLive.mockResolvedValue(found);
          const acting = await service.resolve(person());
          expect(acting).toMatchObject({
            role: UserRole.BUILDING_ADMIN,
            tenantId: TOWER_A,
            contextKind: 'legacy',
          });
        }
      });

      it('never checks a super admin or a tenantless row', async () => {
        membershipsService.findLive.mockResolvedValue(
          membership(MEMBERSHIP_A, tenant(TOWER_A), UserRole.RESIDENT, {
            status: UserStatus.INACTIVE,
          }),
        );

        const admin = await service.resolve(person({ role: UserRole.SUPER_ADMIN }));
        expect(admin).toMatchObject({ role: UserRole.SUPER_ADMIN, tenantId: TOWER_A });
        await service.resolve(person({ tenantId: null }));

        expect(membershipsService.findLive).not.toHaveBeenCalled();
      });

      it('reads nothing until the boot check has seen gate_memberships', async () => {
        recordMembershipTablePresence(false);
        membershipsService.findLive.mockResolvedValue(
          membership(MEMBERSHIP_A, tenant(TOWER_A), UserRole.RESIDENT, {
            status: UserStatus.INACTIVE,
          }),
        );

        const acting = await service.resolve(person());

        expect(acting.tenantId).toBe(TOWER_A);
        expect(membershipsService.findLive).not.toHaveBeenCalled();
      });
    });
  });

  describe('flag on', () => {
    beforeEach(enable);

    describe('malformed header', () => {
      it.each([
        ['text', 'not-a-uuid'],
        ['array', [MEMBERSHIP_A]],
        ['two ids', `${MEMBERSHIP_A},${MEMBERSHIP_B}`],
        ['number', 42],
      ])('%s is MEMBERSHIP_INVALID and never queried', async (_label, header) => {
        const acting = await service.resolve(person(), header);
        expect(acting).toMatchObject({
          contextKind: 'none',
          contextProblem: 'MEMBERSHIP_INVALID',
          contextProblemReason: null,
          role: null,
          tenantId: null,
          tenant: null,
          unit: null,
        });
        expect(membershipsService.findOwnedWithTenant).not.toHaveBeenCalled();
      });
    });

    describe("'platform'", () => {
      it('is the Platform context for a super admin', async () => {
        const acting = await service.resolve(
          person({ role: UserRole.SUPER_ADMIN, tenantId: null }),
          'platform',
        );
        expect(acting).toMatchObject({
          contextKind: 'platform',
          role: UserRole.SUPER_ADMIN,
          tenantId: null,
          tenant: null,
          unit: null,
          isSuperAdmin: true,
          contextProblem: null,
        });
      });

      it('is MEMBERSHIP_INVALID for anyone else', async () => {
        const acting = await service.resolve(person(), 'platform');
        expect(acting).toMatchObject({ contextKind: 'none', contextProblem: 'MEMBERSHIP_INVALID' });
      });
    });

    describe('a membership id', () => {
      it.each([UserRole.BUILDING_ADMIN, UserRole.RESIDENT, UserRole.SECURITY, UserRole.STAFF])(
        'acts as the own ACTIVE %s membership',
        async (role) => {
          const towerB = tenant(TOWER_B);
          const chosen = membership(MEMBERSHIP_B, towerB, role as MembershipRole);
          membershipsService.findOwnedWithTenant.mockResolvedValue(chosen);

          const acting = await service.resolve(person(), MEMBERSHIP_B.toUpperCase());

          expect(membershipsService.findOwnedWithTenant).toHaveBeenCalledWith(
            MEMBERSHIP_B,
            PERSON_ID,
          );
          expect(acting).toMatchObject({
            contextKind: 'membership',
            role,
            tenantId: TOWER_B,
            unit: chosen.unit,
            contextProblem: null,
          });
          expect(acting.tenant).toBe(towerB);
          expect(acting.activeMembership).toBe(chosen);
        },
      );

      it.each([
        ['suspended', { status: TenantStatus.SUSPENDED }],
        ['pending payment', { status: TenantStatus.PENDING_PAYMENT }],
        ['paused', { isPaused: true }],
      ])('accepts a %s building (D6; SubscriptionGuard gates its writes)', async (_l, t) => {
        membershipsService.findOwnedWithTenant.mockResolvedValue(
          membership(MEMBERSHIP_B, tenant(TOWER_B, t), UserRole.BUILDING_ADMIN),
        );
        const acting = await service.resolve(person(), MEMBERSHIP_B);
        expect(acting.contextKind).toBe('membership');
        expect(acting.tenantId).toBe(TOWER_B);
      });

      it.each([UserStatus.INACTIVE, UserStatus.PENDING])(
        'refuses an own %s membership',
        async (status) => {
          membershipsService.findOwnedWithTenant.mockResolvedValue(
            membership(MEMBERSHIP_B, tenant(TOWER_B), UserRole.RESIDENT, { status }),
          );
          const acting = await service.resolve(person(), MEMBERSHIP_B);
          expect(acting).toMatchObject({
            contextKind: 'none',
            contextProblem: 'MEMBERSHIP_INVALID',
          });
          expect(acting.activeMembership).toBeNull();
        },
      );

      it('refuses a foreign, ended or deleted-building id (the read finds nothing)', async () => {
        membershipsService.findOwnedWithTenant.mockResolvedValue(null);
        const acting = await service.resolve(person(), MEMBERSHIP_A);
        expect(acting).toMatchObject({
          contextKind: 'none',
          contextProblem: 'MEMBERSHIP_INVALID',
          contextProblemReason: null,
        });
      });

      it("refuses someone else's membership even if a read ever returned it", async () => {
        membershipsService.findOwnedWithTenant.mockResolvedValue(
          membership(MEMBERSHIP_B, tenant(TOWER_B), UserRole.RESIDENT, { userId: OTHER_PERSON_ID }),
        );
        const acting = await service.resolve(person(), MEMBERSHIP_B);
        expect(acting.contextProblem).toBe('MEMBERSHIP_INVALID');
      });

      it('refuses a membership whose building did not load', async () => {
        membershipsService.findOwnedWithTenant.mockResolvedValue(
          membership(MEMBERSHIP_B, tenant(TOWER_B), UserRole.RESIDENT, {
            tenant: null as unknown as Tenant,
          }),
        );
        const acting = await service.resolve(person(), MEMBERSHIP_B);
        expect(acting.contextProblem).toBe('MEMBERSHIP_INVALID');
      });

      it('lets a super admin act inside one of their own buildings', async () => {
        membershipsService.findOwnedWithTenant.mockResolvedValue(
          membership(MEMBERSHIP_B, tenant(TOWER_B), UserRole.RESIDENT),
        );
        const acting = await service.resolve(
          person({ role: UserRole.SUPER_ADMIN, tenantId: null }),
          MEMBERSHIP_B,
        );
        expect(acting).toMatchObject({
          contextKind: 'membership',
          role: UserRole.RESIDENT,
          tenantId: TOWER_B,
          isSuperAdmin: true,
        });
      });
    });

    describe('no header', () => {
      it.each([undefined, null, '', '   '])(
        '%p gives a super admin the Platform context',
        async (h) => {
          const acting = await service.resolve(
            person({ role: UserRole.SUPER_ADMIN, tenantId: null }),
            h,
          );
          expect(acting.contextKind).toBe('platform');
          expect(membershipsService.listActiveForPerson).not.toHaveBeenCalled();
        },
      );

      it('auto-selects the only usable membership', async () => {
        const only = membership(MEMBERSHIP_A, tenant(TOWER_A), UserRole.SECURITY);
        membershipsService.listActiveForPerson.mockResolvedValue([only]);

        const acting = await service.resolve(person());

        expect(membershipsService.listActiveForPerson).toHaveBeenCalledWith(PERSON_ID);
        expect(acting).toMatchObject({
          contextKind: 'membership',
          role: UserRole.SECURITY,
          tenantId: TOWER_A,
        });
        expect(acting.activeMembership).toBe(only);
      });

      it('auto-selects a single staff membership (staff is selectable, O4)', async () => {
        membershipsService.listActiveForPerson.mockResolvedValue([
          membership(MEMBERSHIP_A, tenant(TOWER_A), UserRole.STAFF),
        ]);
        const acting = await service.resolve(person());
        expect(acting).toMatchObject({ contextKind: 'membership', role: UserRole.STAFF });
      });

      it('gives MEMBERSHIP_REQUIRED NO_MEMBERSHIPS with none', async () => {
        const acting = await service.resolve(person());
        expect(acting).toMatchObject({
          contextKind: 'none',
          contextProblem: 'MEMBERSHIP_REQUIRED',
          contextProblemReason: 'NO_MEMBERSHIPS',
          role: null,
          tenantId: null,
        });
      });

      it('gives MEMBERSHIP_REQUIRED AMBIGUOUS with several', async () => {
        membershipsService.listActiveForPerson.mockResolvedValue([
          membership(MEMBERSHIP_A, tenant(TOWER_A), UserRole.BUILDING_ADMIN),
          membership(MEMBERSHIP_B, tenant(TOWER_B), UserRole.RESIDENT),
        ]);
        const acting = await service.resolve(person());
        expect(acting).toMatchObject({
          contextKind: 'none',
          contextProblem: 'MEMBERSHIP_REQUIRED',
          contextProblemReason: 'AMBIGUOUS',
        });
      });

      it('ignores rows the read should not have returned (inactive)', async () => {
        membershipsService.listActiveForPerson.mockResolvedValue([
          membership(MEMBERSHIP_A, tenant(TOWER_A), UserRole.BUILDING_ADMIN),
          membership(MEMBERSHIP_B, tenant(TOWER_B), UserRole.RESIDENT, {
            status: UserStatus.INACTIVE,
          }),
        ]);
        const acting = await service.resolve(person());
        expect(acting).toMatchObject({ contextKind: 'membership', tenantId: TOWER_A });
      });
    });
  });

  describe('the principal it builds (C5)', () => {
    beforeEach(enable);

    it('is a marked clone: the person is not mutated, the mark is enumerable', async () => {
      const row = person();
      const snapshot = { ...row };
      membershipsService.findOwnedWithTenant.mockResolvedValue(
        membership(MEMBERSHIP_B, tenant(TOWER_B), UserRole.SECURITY),
      );

      const acting = await service.resolve(row, MEMBERSHIP_B);

      expect(acting).not.toBe(row);
      expect({ ...row }).toEqual(snapshot);
      expect(row.role).toBe(UserRole.BUILDING_ADMIN);
      expect(acting).toBeInstanceOf(User);
      expect(isActingUser(acting)).toBe(true);
      expect(Object.getOwnPropertySymbols(acting)).toContain(ACTING_USER_MARK);
      expect(Object.prototype.propertyIsEnumerable.call(acting, ACTING_USER_MARK)).toBe(true);
      // Spreads keep the mark, so the write-guard subscriber still sees it.
      expect(isActingUser({ ...acting })).toBe(true);
    });

    it('keeps activeMembership non-enumerable and never carries passwordHash', async () => {
      const chosen = membership(MEMBERSHIP_B, tenant(TOWER_B));
      membershipsService.findOwnedWithTenant.mockResolvedValue(chosen);

      const acting = await service.resolve(person(), MEMBERSHIP_B);

      expect(acting.activeMembership).toBe(chosen);
      expect(Object.keys(acting)).not.toContain('activeMembership');
      expect(Object.keys({ ...acting })).not.toContain('activeMembership');
      expect('passwordHash' in acting).toBe(false);
      expect(JSON.parse(JSON.stringify(acting))).not.toHaveProperty('passwordHash');
      expect(JSON.parse(JSON.stringify(acting))).not.toHaveProperty('activeMembership');
    });

    it('activeMembership.userId is the person id (gate_users.id)', async () => {
      membershipsService.listActiveForPerson.mockResolvedValue([
        membership(MEMBERSHIP_A, tenant(TOWER_A)),
      ]);
      const acting: ActingUser = await service.resolve(person());
      expect(acting.activeMembership?.userId).toBe(acting.id);
    });
  });

  describe('buildActingUser', () => {
    it('applies the overlay over the person fields', () => {
      const acting = buildActingUser(person({ phone: '555' }), {
        contextKind: 'platform',
        role: UserRole.SUPER_ADMIN,
        tenantId: null,
        tenant: null,
        unit: null,
        isSuperAdmin: true,
      });
      expect(acting).toMatchObject({
        phone: '555',
        email: 'x@example.test',
        role: UserRole.SUPER_ADMIN,
        tenantId: null,
        contextKind: 'platform',
        contextProblem: null,
        contextProblemReason: null,
      });
      expect(acting.activeMembership).toBeNull();
    });
  });

  describe('isPlatformAdmin (A1 flip point)', () => {
    it('is the gate_users super_admin role', () => {
      expect(service.isPlatformAdmin({ role: UserRole.SUPER_ADMIN })).toBe(true);
      expect(service.isPlatformAdmin({ role: UserRole.BUILDING_ADMIN })).toBe(false);
      expect(service.isPlatformAdmin(null)).toBe(false);
    });
  });
});
