import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { MEMBERSHIP_ROLES, Membership } from '@database/entities/membership.entity';
import { SubscriptionPlan } from '@database/entities/subscription-plan.entity';
import { Tenant } from '@database/entities/tenant.entity';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import {
  NO_PLAN_MESSAGE,
  SEAT_COUNTED_ROLES,
  assertSeatAvailable,
  countSeats,
  countSeatsByTenant,
  seatLimitMessage,
  seatLimitOf,
} from './seat-limit';
import { toMembershipRow, toPersonView, toPlatformPersonRow } from './people.views';

const TOWER_A = '11111111-1111-4111-8111-111111111111';
const TOWER_B = '22222222-2222-4222-8222-222222222222';
const PLAN_ID = '33333333-3333-4333-8333-333333333333';

/** A chainable query-builder double that records every call. */
function recordingQueryBuilder(result: { count?: number; raw?: unknown[] }) {
  const calls: Array<[string, unknown[]]> = [];
  const qb: Record<string, jest.Mock> = {};
  for (const method of ['innerJoin', 'where', 'andWhere', 'select', 'addSelect', 'groupBy']) {
    qb[method] = jest.fn((...args: unknown[]) => {
      calls.push([method, args]);
      return qb;
    });
  }
  qb.getCount = jest.fn(async () => result.count ?? 0);
  qb.getRawMany = jest.fn(async () => result.raw ?? []);
  return { qb, calls };
}

function managerWith(options: {
  count?: number;
  raw?: unknown[];
  tenant?: Partial<Tenant> | null;
  plan?: Partial<SubscriptionPlan> | null;
}) {
  const { qb, calls } = recordingQueryBuilder(options);
  const findOne = jest.fn(async (target: unknown) => {
    if (target === Tenant) return options.tenant ?? null;
    if (target === SubscriptionPlan) return options.plan ?? null;
    return null;
  });
  const createQueryBuilder = jest.fn(() => qb);
  const manager = { createQueryBuilder, findOne } as unknown as EntityManager;
  return { manager, qb, calls, findOne, createQueryBuilder };
}

describe('seat-limit', () => {
  it('counts every membership role (the seat question flip point)', () => {
    expect([...SEAT_COUNTED_ROLES].sort()).toEqual([...MEMBERSHIP_ROLES].sort());
  });

  describe('countSeats', () => {
    it.each([null, undefined, '', 'not-a-uuid'])(
      'throws for tenantId %p and never queries',
      async (id) => {
        const { manager, createQueryBuilder } = managerWith({});
        await expect(countSeats(manager, id as string)).rejects.toThrow(/countSeats/);
        expect(createQueryBuilder).not.toHaveBeenCalled();
      },
    );

    it('counts live memberships of live people in that building, seat roles only', async () => {
      const { manager, calls, createQueryBuilder } = managerWith({ count: 4 });

      await expect(countSeats(manager, TOWER_A)).resolves.toBe(4);

      expect(createQueryBuilder).toHaveBeenCalledWith(Membership, 'membership');
      // The inner join on the person is what drops soft-deleted people.
      expect(calls).toContainEqual(['innerJoin', ['membership.user', 'person']]);
      expect(calls).toContainEqual([
        'where',
        ['membership.tenantId = :tenantId', { tenantId: TOWER_A }],
      ]);
      expect(calls).toContainEqual([
        'andWhere',
        ['membership.role IN (:...roles)', { roles: [...SEAT_COUNTED_ROLES] }],
      ]);
    });
  });

  describe('countSeatsByTenant', () => {
    it('answers every valid id in one query, 0 for empty buildings, ignoring junk ids', async () => {
      const { manager, createQueryBuilder } = managerWith({
        raw: [{ tenantId: TOWER_A, seats: '3' }],
      });

      const seats = await countSeatsByTenant(manager, [TOWER_A, TOWER_B, null, 'junk', TOWER_A]);

      expect(createQueryBuilder).toHaveBeenCalledTimes(1);
      expect([...seats.entries()]).toEqual([
        [TOWER_A, 3],
        [TOWER_B, 0],
      ]);
    });

    it('does not query at all when no id is valid', async () => {
      const { manager, createQueryBuilder } = managerWith({});
      await expect(countSeatsByTenant(manager, [null, undefined, 'x'])).resolves.toEqual(new Map());
      expect(createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('seatLimitOf', () => {
    it('treats a missing plan and a negative limit as unlimited, 0 as no seats', () => {
      expect(seatLimitOf(null)).toBeNull();
      expect(seatLimitOf({ maxUsers: -1 })).toBeNull();
      expect(seatLimitOf({ maxUsers: 0 })).toBe(0);
      expect(seatLimitOf({ maxUsers: 25 })).toBe(25);
    });
  });

  describe('assertSeatAvailable', () => {
    const tenant = { id: TOWER_A, subscriptionPlanId: PLAN_ID, name: 'Tower A' };

    it('locks the tenant row, then refuses at the limit with the legacy message', async () => {
      const { manager, findOne } = managerWith({ count: 3, tenant, plan: { maxUsers: 3 } });

      const error = await assertSeatAvailable(manager, TOWER_A).catch((e) => e);

      expect(error).toBeInstanceOf(ForbiddenException);
      expect(error.message).toBe(seatLimitMessage(3));
      expect(seatLimitMessage(3)).toBe(
        'User limit reached. Your plan allows 3 users. Please upgrade your plan to add more users.',
      );
      expect(findOne).toHaveBeenCalledWith(Tenant, {
        where: { id: TOWER_A },
        lock: { mode: 'pessimistic_write' },
      });
    });

    it('passes below the limit and reports what it found', async () => {
      const { manager } = managerWith({ count: 2, tenant, plan: { maxUsers: 3 } });
      await expect(assertSeatAvailable(manager, TOWER_A)).resolves.toMatchObject({
        tenant: { id: TOWER_A },
        used: 2,
        limit: 3,
      });
    });

    it('takes no lock for a pre-check (lock:false)', async () => {
      const { manager, findOne } = managerWith({ count: 0, tenant, plan: { maxUsers: 3 } });
      await assertSeatAvailable(manager, TOWER_A, { lock: false });
      expect(findOne).toHaveBeenCalledWith(Tenant, { where: { id: TOWER_A } });
    });

    it('404 for a missing building, and throws before any query for a null tenant', async () => {
      const missing = managerWith({ tenant: null });
      await expect(assertSeatAvailable(missing.manager, TOWER_A)).rejects.toBeInstanceOf(
        NotFoundException,
      );

      const nothing = managerWith({});
      await expect(assertSeatAvailable(nothing.manager, null)).rejects.toThrow(/tenantId/);
      expect(nothing.findOne).not.toHaveBeenCalled();
    });

    it('a building without a plan: unlimited by default, 403 with requirePlan', async () => {
      const planless = { id: TOWER_A, subscriptionPlanId: null };
      const open = managerWith({ count: 50, tenant: planless as never });
      await expect(assertSeatAvailable(open.manager, TOWER_A)).resolves.toMatchObject({
        limit: null,
      });

      const strict = managerWith({ count: 0, tenant: planless as never });
      const error = await assertSeatAvailable(strict.manager, TOWER_A, { requirePlan: true }).catch(
        (e) => e,
      );
      expect(error).toBeInstanceOf(ForbiddenException);
      expect(error.message).toBe(NO_PLAN_MESSAGE);
    });

    it('a negative maxUsers never refuses', async () => {
      const { manager } = managerWith({ count: 10_000, tenant, plan: { maxUsers: -1 } });
      await expect(assertSeatAvailable(manager, TOWER_A)).resolves.toMatchObject({ limit: null });
    });
  });
});

describe('people.views', () => {
  const FORBIDDEN_KEYS = ['passwordHash', 'userId', 'notificationSettings', 'qrCode'];

  function fullPerson(): User {
    return Object.assign(new User(), {
      id: '44444444-4444-4444-8444-444444444444',
      email: 'p@example.test',
      firstName: 'Pat',
      lastName: 'Person',
      phone: '+100',
      passwordHash: '$2b$10$secret',
      userId: '55555555-5555-4555-8555-555555555555',
      notificationSettings: { emailNotifications: true, inAppNotifications: true },
      qrCode: 'GR-token',
      role: UserRole.BUILDING_ADMIN,
      status: UserStatus.ACTIVE,
      tenantId: TOWER_A,
      unit: 'legacy-unit',
      profileImageUrl: 'https://img',
      mustChangePassword: false,
      lastLoginAt: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-02-01T00:00:00Z'),
    });
  }

  function membershipIn(person: User | undefined): Membership {
    return Object.assign(new Membership(), {
      id: '66666666-6666-4666-8666-666666666666',
      userId: person?.id,
      tenantId: TOWER_B,
      role: UserRole.RESIDENT,
      status: UserStatus.INACTIVE,
      unit: '9C',
      user: person,
      tenant: Object.assign(new Tenant(), { id: TOWER_B, name: 'Tower B', slug: 'tower-b' }),
    });
  }

  it('toMembershipRow: the person id plus the membership values, nothing private', () => {
    const person = fullPerson();
    const row = toMembershipRow(membershipIn(person));

    expect(row).toEqual({
      id: person.id,
      membershipId: '66666666-6666-4666-8666-666666666666',
      email: 'p@example.test',
      firstName: 'Pat',
      lastName: 'Person',
      phone: '+100',
      role: UserRole.RESIDENT,
      status: UserStatus.INACTIVE,
      tenantId: TOWER_B,
      tenant: { id: TOWER_B, name: 'Tower B', slug: 'tower-b' },
      unit: '9C',
      profileImageUrl: 'https://img',
      createdAt: person.createdAt,
      updatedAt: person.updatedAt,
    });
    for (const key of FORBIDDEN_KEYS) {
      expect(row).not.toHaveProperty(key);
    }
    expect(JSON.stringify(row)).not.toContain('secret');
  });

  it('toMembershipRow takes the person as an argument and needs one', () => {
    const person = fullPerson();
    const withoutRelation = membershipIn(undefined);
    expect(toMembershipRow(withoutRelation, person).id).toBe(person.id);
    expect(() => toMembershipRow(withoutRelation)).toThrow(/no person loaded/);
  });

  it('toPersonView and toPlatformPersonRow carry no private field', () => {
    const person = fullPerson();

    const view = toPersonView(person);
    expect(view).toMatchObject({ id: person.id, email: person.email, mustChangePassword: false });
    for (const key of FORBIDDEN_KEYS) {
      expect(view).not.toHaveProperty(key);
    }

    const platformRow = toPlatformPersonRow(Object.assign(person, { role: UserRole.SUPER_ADMIN }));
    expect(platformRow).toMatchObject({
      membershipId: null,
      role: UserRole.SUPER_ADMIN,
      tenantId: null,
      tenant: null,
      unit: null,
    });
    for (const key of FORBIDDEN_KEYS) {
      expect(platformRow).not.toHaveProperty(key);
    }
  });
});
