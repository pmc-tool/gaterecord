/**
 * The one seat rule for a building's subscription plan (maxUsers).
 *
 * Before memberships there were six counters and they disagreed: POST /users
 * counted every gate_users row pointing at the building, POST /residents and
 * join approval counted only role=resident rows, plan usage and the billing
 * downgrade check counted rows again, and a person was only ever counted in the
 * building their single row pointed at. With one person able to hold a role in
 * several buildings, a seat is now one live membership: one row per
 * (person, building), whatever its status, counted in EVERY building the person
 * belongs to.
 *
 * Which roles use a seat is one line, SEAT_COUNTED_ROLES. It is every membership
 * role today (admins and security use the product too); narrowing it to
 * residents only is the flip point if the owner decides so.
 *
 * Programming errors (a missing or malformed building id) throw a plain Error
 * rather than an HTTP exception: a null tenant must never reach the WHERE
 * clause, where TypeORM would drop the condition and count every building.
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { MEMBERSHIP_ROLES, Membership, MembershipRole } from '@database/entities/membership.entity';
import { SubscriptionPlan } from '@database/entities/subscription-plan.entity';
import { Tenant } from '@database/entities/tenant.entity';
import { isUuid } from '@common/context/acting-user';

/** The membership roles that take a seat. The flip point for "who counts". */
export const SEAT_COUNTED_ROLES: readonly MembershipRole[] = MEMBERSHIP_ROLES;

/** Legacy wording, kept word for word: the web shows these messages as they are. */
export const NO_PLAN_MESSAGE = 'No subscription plan found. Please subscribe to a plan first.';

export function seatLimitMessage(maxUsers: number): string {
  return `User limit reached. Your plan allows ${maxUsers} users. Please upgrade your plan to add more users.`;
}

export interface SeatCheckOptions {
  /**
   * Refuse with 403 NO_PLAN_MESSAGE when the building has no subscription plan.
   * The residents and join-approval paths always did; POST /users treated a
   * missing plan as "no limit". Default false.
   */
  requirePlan?: boolean;
  /**
   * Take FOR UPDATE on the tenant row (default true), so two concurrent adds
   * cannot both take the last seat. Requires an active transaction. Pass false
   * only for a pre-check outside a transaction, and repeat the check under the
   * lock before writing.
   */
  lock?: boolean;
}

export interface SeatCheck {
  /** The building, loaded (and locked unless lock:false). */
  tenant: Tenant;
  /** Seats in use before the add. */
  used: number;
  /** The plan's limit, or null when nothing limits it (no plan, negative maxUsers). */
  limit: number | null;
}

/**
 * The plan's seat limit, or null for "no limit". A negative maxUsers is the
 * "unlimited" convention the web already labels as such (-1). Zero means no
 * seats at all.
 */
export function seatLimitOf(
  plan: Pick<SubscriptionPlan, 'maxUsers'> | null | undefined,
): number | null {
  const max = plan?.maxUsers;
  if (typeof max !== 'number' || !Number.isFinite(max) || max < 0) {
    return null;
  }
  return max;
}

function assertBuildingId(tenantId: unknown, caller: string): asserts tenantId is string {
  if (!tenantId) {
    throw new Error(`${caller} needs a tenantId`);
  }
  if (!isUuid(tenantId)) {
    throw new Error(`${caller}: '${String(tenantId)}' is not a building id`);
  }
}

/**
 * Seats in use in one building: live memberships with a seat-counted role, of
 * people who are not soft-deleted. The partial unique index allows one live
 * membership per (person, building), so this is also the number of people.
 * Any status counts, as every legacy counter did: an inactive person still
 * holds their place in the building.
 *
 * Throws when tenantId is missing or not a uuid.
 */
export async function countSeats(
  manager: EntityManager,
  tenantId: string | null | undefined,
): Promise<number> {
  assertBuildingId(tenantId, 'countSeats');

  // Soft-deleted memberships drop out as the main alias, and TypeORM adds
  // "person.deleted_at IS NULL" to the join, so a removed person never counts.
  return manager
    .createQueryBuilder(Membership, 'membership')
    .innerJoin('membership.user', 'person')
    .where('membership.tenantId = :tenantId', { tenantId })
    .andWhere('membership.role IN (:...roles)', { roles: [...SEAT_COUNTED_ROLES] })
    .getCount();
}

/**
 * countSeats for many buildings in ONE query (dashboards, cron batches). Every
 * valid requested id is a key of the result, 0 when nobody is there; ids that
 * are not uuids are ignored instead of reaching Postgres.
 */
export async function countSeatsByTenant(
  manager: EntityManager,
  tenantIds: readonly (string | null | undefined)[],
): Promise<Map<string, number>> {
  const ids = [...new Set(tenantIds.filter(isUuid).map((id) => id.toLowerCase()))];
  const seats = new Map<string, number>(ids.map((id) => [id, 0]));
  if (ids.length === 0) {
    return seats;
  }

  const rows = await manager
    .createQueryBuilder(Membership, 'membership')
    .innerJoin('membership.user', 'person')
    .select('membership.tenantId', 'tenantId')
    .addSelect('COUNT(DISTINCT membership.userId)', 'seats')
    .where('membership.tenantId IN (:...tenantIds)', { tenantIds: ids })
    .andWhere('membership.role IN (:...roles)', { roles: [...SEAT_COUNTED_ROLES] })
    .groupBy('membership.tenantId')
    .getRawMany<{ tenantId: string; seats: string | number }>();

  for (const row of rows) {
    seats.set(String(row.tenantId).toLowerCase(), Number(row.seats));
  }
  return seats;
}

/**
 * Refuses (403, legacy wording) when the building has no free seat, and
 * otherwise returns what it found. Locks the tenant row first unless told not
 * to, which is the same lock MembershipsService.add() takes next, so the check
 * and the insert are serialised against every other add in that building.
 *
 * 404 'Tenant not found' for a missing or soft-deleted building.
 */
export async function assertSeatAvailable(
  manager: EntityManager,
  tenantId: string | null | undefined,
  options: SeatCheckOptions = {},
): Promise<SeatCheck> {
  assertBuildingId(tenantId, 'assertSeatAvailable');
  const { requirePlan = false, lock = true } = options;

  // The tenant alone: Postgres refuses FOR UPDATE on the nullable side of the
  // outer join a subscriptionPlan relation would add, so the plan is read next.
  const tenant = await manager.findOne(Tenant, {
    where: { id: tenantId },
    ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
  });
  if (!tenant) {
    throw new NotFoundException('Tenant not found');
  }

  const plan = tenant.subscriptionPlanId
    ? await manager.findOne(SubscriptionPlan, { where: { id: tenant.subscriptionPlanId } })
    : null;
  if (!plan) {
    if (requirePlan) {
      throw new ForbiddenException(NO_PLAN_MESSAGE);
    }
    return { tenant, used: await countSeats(manager, tenant.id), limit: null };
  }

  const limit = seatLimitOf(plan);
  const used = await countSeats(manager, tenant.id);
  if (limit !== null && used >= limit) {
    throw new ForbiddenException(seatLimitMessage(plan.maxUsers));
  }

  return { tenant, used, limit };
}
