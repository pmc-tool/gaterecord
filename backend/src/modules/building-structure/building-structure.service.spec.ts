/**
 * PPL-21: building structure acts in the active building, and occupancy is
 * counted from RESIDENT memberships' own unit.
 *
 * Unit test with in-memory repository doubles (no database). The occupancy
 * double evaluates the same filters the service binds (membership tenant and
 * role, grouped by membership.unit) over a small membership table, so a
 * person who is a resident in two buildings shows the unit they hold in each.
 */
import { randomUUID } from 'crypto';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { BuildingFlat } from '@database/entities/building-flat.entity';
import { BuildingFloor } from '@database/entities/building-floor.entity';
import { Membership } from '@database/entities/membership.entity';
import { Tenant } from '@database/entities/tenant.entity';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import { ACTING_USER_MARK, ContextKind } from '@common/context/acting-user';
import { membershipErrorCodeOf } from '@common/context/membership-context.errors';
import { BuildingStructureService } from './building-structure.service';

const B = '0b0b0b0b-0000-4000-8000-00000000000b';
const D = '0d0d0d0d-0000-4000-8000-00000000000d';
const P = '0f0f0f0f-0000-4000-8000-00000000000f';

type MembershipRow = Pick<Membership, 'userId' | 'tenantId' | 'role' | 'status' | 'unit'>;

function acting(overlay: {
  contextKind: ContextKind;
  role: UserRole | null;
  tenantId: string | null;
}): User {
  return Object.assign(new User(), {
    id: P,
    email: 'p@example.test',
    role: overlay.role,
    tenantId: overlay.tenantId,
    contextKind: overlay.contextKind,
    contextProblem: null,
    contextProblemReason: overlay.contextKind === 'none' ? 'AMBIGUOUS' : null,
    isSuperAdmin: overlay.role === UserRole.SUPER_ADMIN,
    [ACTING_USER_MARK]: true,
  });
}

describe('BuildingStructureService in the active building (PPL-21)', () => {
  const originalFlag = process.env.GATE_MEMBERSHIP_CONTEXT;
  let floors: BuildingFloor[];
  let flats: BuildingFlat[];
  let memberships: MembershipRow[];
  let tenants: string[];
  let occupancyParams: Record<string, unknown>[];
  let service: BuildingStructureService;

  const matches = (row: object, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => (row as Record<string, unknown>)[key] === value);

  beforeEach(() => {
    process.env.GATE_MEMBERSHIP_CONTEXT = 'off';
    floors = [];
    flats = [];
    tenants = [B, D];
    occupancyParams = [];
    memberships = [
      // P is a resident of B (flat 4B) and of D (flat 7A).
      { userId: P, tenantId: B, role: UserRole.RESIDENT, status: UserStatus.ACTIVE, unit: '4b' },
      { userId: P, tenantId: D, role: UserRole.RESIDENT, status: UserStatus.ACTIVE, unit: '7A' },
      // Another resident of B, inactive, in 4B too: still occupies it.
      {
        userId: randomUUID(),
        tenantId: B,
        role: UserRole.RESIDENT,
        status: UserStatus.INACTIVE,
        unit: '4B',
      },
      // B's security, with a unit that is not a flat: not a resident, not counted.
      {
        userId: randomUUID(),
        tenantId: B,
        role: UserRole.SECURITY,
        status: UserStatus.ACTIVE,
        unit: '7A',
      },
    ];

    const floorRepository = {
      find: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        floors.filter((f) => matches(f, where)),
      ),
      findOne: jest.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          floors.find((f) => matches(f, where)) ?? null,
      ),
      create: jest.fn((values: Partial<BuildingFloor>) =>
        Object.assign(new BuildingFloor(), values),
      ),
      save: jest.fn(async (floor: BuildingFloor) => {
        floor.id = floor.id ?? randomUUID();
        floors.push(floor);
        return floor;
      }),
    };
    const flatRepository = {
      find: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        flats.filter((f) => matches(f, where)),
      ),
    };
    const membershipRepository = {
      findOne: jest.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          memberships.find((m) => matches(m, where)) ?? null,
      ),
      createQueryBuilder: jest.fn(() => {
        const params: Record<string, unknown> = {};
        const joins: string[] = [];
        const qb: Record<string, jest.Mock> = {};
        qb.innerJoin = jest.fn((relation: string) => (joins.push(relation), qb));
        qb.select = jest.fn(() => qb);
        qb.addSelect = jest.fn(() => qb);
        qb.where = jest.fn(
          (_sql: string, p: Record<string, unknown>) => (Object.assign(params, p), qb),
        );
        qb.andWhere = jest.fn(
          (_sql: string, p: Record<string, unknown>) => (Object.assign(params, p), qb),
        );
        qb.groupBy = jest.fn(() => qb);
        qb.getRawMany = jest.fn(async () => {
          occupancyParams.push({ ...params, joins });
          const counts = new Map<string | null, number>();
          for (const m of memberships) {
            if (m.tenantId !== params.tenantId || m.role !== params.role) continue;
            counts.set(m.unit, (counts.get(m.unit) ?? 0) + 1);
          }
          return [...counts].map(([unit, count]) => ({ unit, count: String(count) }));
        });
        return qb;
      }),
    };
    const tenantRepository = {
      findOne: jest.fn(async ({ where }: { where: { id: string } }) =>
        tenants.includes(where.id) ? Object.assign(new Tenant(), { id: where.id }) : null,
      ),
    };

    service = new BuildingStructureService(
      floorRepository as unknown as Repository<BuildingFloor>,
      flatRepository as unknown as Repository<BuildingFlat>,
      membershipRepository as unknown as Repository<Membership>,
      tenantRepository as unknown as Repository<Tenant>,
      {} as DataSource,
    );
  });

  afterEach(() => {
    process.env.GATE_MEMBERSHIP_CONTEXT = originalFlag;
  });

  function addFlat(tenantId: string, flatNumber: string) {
    const floor = Object.assign(new BuildingFloor(), {
      id: randomUUID(),
      tenantId,
      floorNumber: 4,
      name: null,
    });
    floors.push(floor);
    flats.push(
      Object.assign(new BuildingFlat(), {
        id: randomUUID(),
        tenantId,
        floorId: floor.id,
        flatNumber,
        flatKey: flatNumber.toUpperCase(),
      }),
    );
  }

  it('creates floors in the building the admin acts in', async () => {
    const floor = await service.createFloor(
      acting({ contextKind: 'membership', role: UserRole.BUILDING_ADMIN, tenantId: D }),
      { floorNumber: 3 },
    );

    expect(floor.floorNumber).toBe(3);
    expect(floors).toEqual([expect.objectContaining({ tenantId: D, floorNumber: 3 })]);
  });

  it('a resident context gets 403 and writes nothing', async () => {
    const error = await service
      .createFloor(acting({ contextKind: 'membership', role: UserRole.RESIDENT, tenantId: B }), {
        floorNumber: 3,
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(membershipErrorCodeOf(error)).toBe('ROLE_NOT_ALLOWED_IN_BUILDING');
    expect(floors).toEqual([]);
  });

  it('no chosen building is 409 MEMBERSHIP_REQUIRED', async () => {
    const error = await service
      .getStructure(acting({ contextKind: 'none', role: null, tenantId: null }))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect(membershipErrorCodeOf(error)).toBe('MEMBERSHIP_REQUIRED');
  });

  it("occupancy counts P's unit in B only from P's B membership", async () => {
    addFlat(B, '4B');
    addFlat(B, '7A');

    const structure = await service.getStructure(
      acting({ contextKind: 'membership', role: UserRole.BUILDING_ADMIN, tenantId: B }),
    );

    const flatViews = structure.floors.flatMap((f) => f.flats);
    expect(flatViews.find((f) => f.flatNumber === '4B')?.residentCount).toBe(2);
    // P lives in 7A of D, not of B; B's security guard is not a resident.
    expect(flatViews.find((f) => f.flatNumber === '7A')?.residentCount).toBe(0);
    expect(structure.summary).toMatchObject({ residentCount: 2, occupiedFlatCount: 1 });
    expect(occupancyParams).toEqual([
      expect.objectContaining({ tenantId: B, role: UserRole.RESIDENT, joins: ['membership.user'] }),
    ]);
  });

  it('a platform super admin reads any building with ?tenantId, never writes without a building', async () => {
    const admin = acting({ contextKind: 'platform', role: UserRole.SUPER_ADMIN, tenantId: null });

    await service.getStructure(admin, D);
    expect(occupancyParams[0]).toMatchObject({ tenantId: D });

    await expect(service.createFloor(admin, { floorNumber: 1 })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('?tenantId is ignored for a building admin (they read the building they act in)', async () => {
    await service.getStructure(
      acting({ contextKind: 'membership', role: UserRole.BUILDING_ADMIN, tenantId: B }),
      D,
    );

    expect(occupancyParams[0]).toMatchObject({ tenantId: B });
  });

  describe('join floor plan', () => {
    it('flag off: someone who already has a building is refused as before', async () => {
      const legacy = Object.assign(new User(), { id: P, tenantId: B, role: UserRole.RESIDENT });

      await expect(service.getJoinFloorPlan(legacy, D)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('flag on: an admin of A may browse B, but not a building they already hold a role in', async () => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
      const other = '0a0a0a0a-0000-4000-8000-00000000000a';
      tenants.push(other);
      addFlat(other, '1A');
      const user = acting({
        contextKind: 'membership',
        role: UserRole.BUILDING_ADMIN,
        tenantId: D,
      });

      const plan = await service.getJoinFloorPlan(user, other);
      expect(plan.floors[0].flats).toEqual([expect.objectContaining({ flatNumber: '1A' })]);

      const error = await service.getJoinFloorPlan(user, B).catch((e: unknown) => e);
      expect(membershipErrorCodeOf(error)).toBe('MEMBERSHIP_EXISTS');
    });

    it('404 for a building that does not exist', async () => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
      await expect(
        service.getJoinFloorPlan(
          acting({ contextKind: 'none', role: null, tenantId: null }),
          randomUUID(),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
