/**
 * PPL-20: plan usage follows the building the request acts in and the shared
 * seat rule; a null tenant never reaches a count.
 *
 * Unit test with repository doubles (no database). The seat count is the real
 * people/seat-limit countSeats, run against a query-builder double that
 * records the building it was bound to.
 */
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Gate } from '@database/entities/gate.entity';
import { Tenant } from '@database/entities/tenant.entity';
import { User, UserRole } from '@database/entities/user.entity';
import { Vehicle } from '@database/entities/vehicle.entity';
import { VisitorPass } from '@database/entities/visitor-pass.entity';
import { ACTING_USER_MARK, ContextKind } from '@common/context/acting-user';
import { membershipErrorCodeOf } from '@common/context/membership-context.errors';
import { PlanUsageService } from './plan-usage.service';

const A = '0a0a0a0a-0000-4000-8000-00000000000a';
const D = '0d0d0d0d-0000-4000-8000-00000000000d';

function acting(overlay: {
  contextKind: ContextKind;
  role: UserRole | null;
  tenantId: string | null;
}): User {
  return Object.assign(new User(), {
    id: '11111111-1111-4111-8111-111111111111',
    role: overlay.role,
    tenantId: overlay.tenantId,
    contextKind: overlay.contextKind,
    contextProblem: null,
    contextProblemReason: overlay.contextKind === 'none' ? 'NO_MEMBERSHIPS' : null,
    isSuperAdmin: overlay.role === UserRole.SUPER_ADMIN,
    [ACTING_USER_MARK]: true,
  });
}

describe('PlanUsageService in the active building (PPL-20)', () => {
  const seatsByTenant: Record<string, number> = { [A]: 3, [D]: 8 };
  let seatQueries: string[];
  let tenants: { findOne: jest.Mock; manager: { createQueryBuilder: jest.Mock } };
  let counts: { gate: jest.Mock; vehicle: jest.Mock; pass: jest.Mock };
  let service: PlanUsageService;

  beforeEach(() => {
    seatQueries = [];
    tenants = {
      findOne: jest.fn(async ({ where }: { where: { id: string } }) =>
        Object.assign(new Tenant(), {
          id: where.id,
          subscriptionPlan: {
            name: where.id === D ? 'Pro' : 'Free',
            isDefault: where.id !== D,
            maxUsers: 20,
            maxGates: 5,
            maxVehicles: 50,
            maxVisitorPassesPerMonth: 100,
          },
        }),
      ),
      manager: {
        createQueryBuilder: jest.fn(() => {
          let tenantId = '';
          const qb: Record<string, jest.Mock> = {};
          qb.innerJoin = jest.fn(() => qb);
          qb.where = jest.fn(
            (_sql: string, p: { tenantId: string }) => ((tenantId = p.tenantId), qb),
          );
          qb.andWhere = jest.fn(() => qb);
          qb.getCount = jest.fn(async () => {
            seatQueries.push(tenantId);
            return seatsByTenant[tenantId] ?? 0;
          });
          return qb;
        }),
      },
    };
    counts = {
      gate: jest.fn(async ({ where }: { where: { tenantId: string } }) =>
        where.tenantId === D ? 2 : 1,
      ),
      vehicle: jest.fn(async () => 4),
      pass: jest.fn(async () => 6),
    };

    service = new PlanUsageService(
      tenants as unknown as Repository<Tenant>,
      { count: counts.gate } as unknown as Repository<Gate>,
      { count: counts.vehicle } as unknown as Repository<Vehicle>,
      { count: counts.pass } as unknown as Repository<VisitorPass>,
    );
  });

  it("the admin of A and D acting in D gets D's counts", async () => {
    const usage = await service.getUsage(
      acting({ contextKind: 'membership', role: UserRole.BUILDING_ADMIN, tenantId: D }),
    );

    expect(tenants.findOne).toHaveBeenCalledWith(expect.objectContaining({ where: { id: D } }));
    expect(seatQueries).toEqual([D]);
    expect(usage).toEqual({
      plan: { name: 'Pro', isDefault: false },
      users: { used: 8, limit: 20 },
      gates: { used: 2, limit: 5 },
      vehicles: { used: 4, limit: 50 },
      passesThisMonth: { used: 6, limit: 100 },
    });
  });

  it('a platform super admin gets zeros and no query runs', async () => {
    const usage = await service.getUsage(
      acting({ contextKind: 'platform', role: UserRole.SUPER_ADMIN, tenantId: null }),
    );

    expect(usage.plan).toBeNull();
    expect(usage.users).toEqual({ used: 0, limit: 0 });
    expect(tenants.findOne).not.toHaveBeenCalled();
    expect(seatQueries).toEqual([]);
  });

  it('no building chosen: 409, and a null tenant never reaches a count', async () => {
    const error = await service
      .getUsage(acting({ contextKind: 'none', role: null, tenantId: null }))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect(membershipErrorCodeOf(error)).toBe('MEMBERSHIP_REQUIRED');
    expect(tenants.findOne).not.toHaveBeenCalled();
    expect(counts.gate).not.toHaveBeenCalled();
    expect(seatQueries).toEqual([]);
  });

  it('a security context in the building is 403', async () => {
    const error = await service
      .getUsage(acting({ contextKind: 'membership', role: UserRole.SECURITY, tenantId: A }))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(counts.gate).not.toHaveBeenCalled();
  });

  it('flag off: the legacy single-building admin row keeps its usage', async () => {
    const legacy = Object.assign(new User(), { role: UserRole.BUILDING_ADMIN, tenantId: A });

    const usage = await service.getUsage(legacy);

    expect(usage.users.used).toBe(3);
  });
});
