import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, In, IsNull, Not } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import {
  Membership,
  MembershipRole,
  MembershipStatus,
  SELECTABLE_ROLES,
  isMembershipRole,
} from '@database/entities/membership.entity';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import { Tenant, TenantStatus } from '@database/entities/tenant.entity';
import {
  BuildingJoinRequest,
  JoinRequestStatus,
} from '@database/entities/building-join-request.entity';
import { isUniqueViolation } from '@database/pg-errors';
import {
  ActingUser,
  PLATFORM_CONTEXT_ID,
  contextKindOf,
  isActingUser,
  isUuid,
} from '@common/context/acting-user';
import { isMembershipContextEnabled } from '@common/context/membership-flags';
import {
  membershipExists,
  multiMembershipDisabled,
} from '@common/context/membership-context.errors';
import {
  MembershipTenantView,
  MembershipView,
  MembershipsMeResponse,
  PendingJoinRequestView,
} from './dto/memberships-me.response';
import { queueMembershipChange } from './membership-change.events';

/** Name of the partial unique index behind "one live role per building". */
export const MEMBERSHIP_UNIQUE_INDEX = 'UQ_gate_memberships_user_tenant';

export interface AddMembershipInput {
  /** gate_users.id of the person (never the Keycloak sub). */
  userId: string;
  tenantId: string;
  role: MembershipRole;
  /** Defaults to ACTIVE. */
  status?: MembershipStatus;
  unit?: string | null;
}

/** Fields left undefined are not changed; unit may be set to null. */
export interface UpdateMembershipInput {
  role?: MembershipRole;
  status?: MembershipStatus;
  unit?: string | null;
}

/** The legacy gate_users columns the mirror maintains (contract C2). */
export interface LegacyColumns {
  tenantId: string | null;
  role: UserRole;
  unit: string | null;
}

/** What a person with no membership looks like on gate_users: a new, tenantless admin-to-be. */
export const LEGACY_SENTINEL: Readonly<LegacyColumns> = Object.freeze({
  tenantId: null,
  role: UserRole.BUILDING_ADMIN,
  unit: null,
});

/**
 * The membership the legacy columns copy: active ones first, then the oldest,
 * then the lowest id, so the choice is stable across runs and never depends on
 * row order. Pass LIVE memberships only.
 */
export function pickPrimaryMembership<T extends Pick<Membership, 'id' | 'status' | 'createdAt'>>(
  memberships: readonly T[],
): T | null {
  if (memberships.length === 0) {
    return null;
  }

  const rank = (m: T) => (m.status === UserStatus.ACTIVE ? 0 : 1);
  const time = (m: T) => new Date(m.createdAt).getTime();

  return [...memberships].sort(
    (a, b) => rank(a) - rank(b) || time(a) - time(b) || a.id.localeCompare(b.id),
  )[0];
}

export function legacyColumnsFor(
  primary: Pick<Membership, 'tenantId' | 'role' | 'unit'> | null,
): LegacyColumns {
  return primary
    ? { tenantId: primary.tenantId, role: primary.role, unit: primary.unit ?? null }
    : { ...LEGACY_SENTINEL };
}

const USER_STATUSES = Object.values(UserStatus) as string[];

/** Filters for findAdminMembership. At least one of tenantId / personId is required. */
export interface AdminMembershipQuery {
  tenantId?: string;
  /** gate_users.id of the person. */
  personId?: string;
  /** Membership status; any status when omitted. */
  status?: MembershipStatus;
  /** Building status, e.g. PENDING_PAYMENT for a signup waiting on checkout. */
  tenantStatus?: TenantStatus;
}

/** The C4 tenant projection: exactly id, name, address, status and isPaused. */
export function toMembershipTenantView(tenant: Tenant): MembershipTenantView {
  return {
    id: tenant.id,
    name: tenant.name,
    address: tenant.address ?? null,
    status: tenant.status,
    isPaused: tenant.isPaused === true,
  };
}

/** One membership as GET /memberships/me lists it (tenant must be loaded). */
export function toMembershipView(membership: Membership): MembershipView {
  return {
    id: membership.id,
    role: membership.role,
    status: membership.status,
    unit: membership.unit ?? null,
    tenant: toMembershipTenantView(membership.tenant),
  };
}

/**
 * What a principal acts as, as the web names it: the membership id, 'platform'
 * for the Platform context, or null (no context, a stale header, legacy mode).
 */
export function activeMembershipIdOf(user: ActingUser | User | null | undefined): string | null {
  if (!isActingUser(user)) {
    return null;
  }

  switch (contextKindOf(user)) {
    case 'membership':
      return user.activeMembership?.id ?? null;
    case 'platform':
      return PLATFORM_CONTEXT_ID;
    default:
      return null;
  }
}

/**
 * Whether a membership can be acted as: ACTIVE, a role in SELECTABLE_ROLES and
 * a loaded (therefore live) building. The one rule shared by the context
 * resolver, auto-select and the session user.
 */
export function isSelectableMembership(membership: Membership | null | undefined): boolean {
  return (
    !!membership &&
    membership.status === UserStatus.ACTIVE &&
    SELECTABLE_ROLES.includes(membership.role) &&
    !!membership.tenantId &&
    !!membership.tenant
  );
}

/**
 * The ONLY code that writes gate_memberships, and the only writer of the legacy
 * gate_users.tenant_id / role / unit columns (contract C2).
 *
 * Every write method:
 *   - takes an optional EntityManager and joins the caller's transaction when it
 *     has one, otherwise opens its own;
 *   - takes row locks in one global order, join request (the caller's) -> tenant
 *     -> person, so two writers can never wait on each other in a cycle;
 *   - re-syncs the legacy mirror in the same transaction, so a reader of the old
 *     columns (legacy mode, other developers' old backends, the admin app) keeps
 *     seeing the person's primary building;
 *   - queues a 'membership.changed' event on that transaction, published only
 *     once it commits (membership-change.events.ts), so the connected sockets
 *     of the people concerned are re-checked against the committed state.
 *
 * Status dual-write (until the status split, DB-12, which is deferred): when a
 * membership's status changes and the person has exactly ONE live membership,
 * the same value is written to gate_users.status, regardless of
 * GATE_MEMBERSHIP_CONTEXT, so deactivating a single-building person keeps
 * locking them out exactly as it does today. Removals keep that true as well:
 * a person left with exactly one live membership that is not active gets its
 * status (settleStatusAfterRemoval). Super admin statuses are never touched
 * (their status is a platform ban only).
 *
 * Business rules (seats, emails, last-admin protection, account provisioning,
 * bans) belong to the callers; this service only keeps the rows consistent.
 */
@Injectable()
export class MembershipsService {
  constructor(private readonly dataSource: DataSource) {}

  // ============ Writes ============

  /**
   * Gives a person a role in a building.
   *
   * 409 MEMBERSHIP_EXISTS when the person already has a live role there (one
   * role per building). While GATE_MEMBERSHIP_CONTEXT is off, 409
   * MULTI_MEMBERSHIP_DISABLED when the person already has a live membership in
   * ANOTHER building. 404 when the person or the building is gone.
   *
   * A non-active status is copied to gate_users.status when this is the person's
   * only membership (the dual-write). An ACTIVE membership never lifts a
   * non-active gate_users.status: that value may be a platform ban, which the
   * caller must check (and refuse) before adding.
   */
  async add(input: AddMembershipInput, manager?: EntityManager): Promise<Membership> {
    this.assertRole(input.role);
    const status = input.status ?? UserStatus.ACTIVE;
    this.assertStatus(status);

    if (!isUuid(input.tenantId)) {
      throw new NotFoundException('Building not found');
    }
    if (!isUuid(input.userId)) {
      throw new NotFoundException('Person not found');
    }

    return this.inTransaction(manager, async (m) => {
      // Lock order: tenant, then person. The tenant lock also serialises seat
      // checks callers run just before this, and keeps the building from being
      // deleted under us.
      const tenant = await m.findOne(Tenant, {
        where: { id: input.tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!tenant) {
        throw new NotFoundException('Building not found');
      }

      const person = await this.lockPerson(m, input.userId, false);
      if (!person) {
        throw new NotFoundException('Person not found');
      }

      // Read under the person lock: a concurrent add() for the same person has
      // either committed (and is visible here) or is still waiting for the lock.
      const live = await this.listLiveForUser(person.id, m);
      const sameBuilding = live.find((existing) => existing.tenantId === tenant.id);
      if (sameBuilding) {
        throw membershipExists(sameBuilding.role);
      }
      if (live.length > 0 && !isMembershipContextEnabled()) {
        throw multiMembershipDisabled();
      }

      let saved: Membership;
      try {
        saved = await m.save(
          m.create(Membership, {
            userId: person.id,
            tenantId: tenant.id,
            role: input.role,
            status,
            unit: input.unit ?? null,
          }),
        );
      } catch (error) {
        // Only reachable when something inserted without taking the person lock.
        if (isUniqueViolation(error, MEMBERSHIP_UNIQUE_INDEX)) {
          throw membershipExists(null);
        }
        throw error;
      }

      if (live.length === 0 && status !== UserStatus.ACTIVE) {
        await this.mirrorStatus(m, person, status);
      }
      await this.writeLegacyMirror(m, person.id);
      queueMembershipChange(m, { personIds: [person.id] });

      return saved;
    });
  }

  /** Changes the role, status or unit of one live membership. 404 when it is gone. */
  async update(
    membershipId: string,
    changes: UpdateMembershipInput,
    manager?: EntityManager,
  ): Promise<Membership> {
    if (changes.role !== undefined) {
      this.assertRole(changes.role);
    }
    if (changes.status !== undefined) {
      this.assertStatus(changes.status);
    }

    return this.inTransaction(manager, async (m) => {
      const { person, membership } = await this.lockMembership(m, membershipId);

      const statusChanged = changes.status !== undefined && changes.status !== membership.status;
      if (changes.role !== undefined) {
        membership.role = changes.role;
      }
      if (changes.status !== undefined) {
        membership.status = changes.status;
      }
      if (changes.unit !== undefined) {
        membership.unit = changes.unit;
      }

      const saved = await m.save(membership);

      if (statusChanged && person) {
        const liveCount = await m.count(Membership, { where: { userId: person.id } });
        if (liveCount === 1) {
          await this.mirrorStatus(m, person, saved.status);
        }
      }
      await this.writeLegacyMirror(m, membership.userId);
      queueMembershipChange(m, { personIds: [membership.userId] });

      return saved;
    });
  }

  /**
   * Ends one membership (soft delete, so the history stays). 404 when it is
   * already gone.
   *
   * When this was the person's last membership and gate_users.status still holds
   * the non-active status the dual-write copied from it, the person is set back
   * to ACTIVE: leaving a building must not leave them locked out of the whole
   * platform, which is also what removing a resident does today. When exactly
   * one membership is left and it is not active, its status is copied instead
   * (settleStatusAfterRemoval).
   */
  async remove(membershipId: string, manager?: EntityManager): Promise<Membership> {
    return this.inTransaction(manager, async (m) => {
      const { person, membership } = await this.lockMembership(m, membershipId);

      const deletedAt = new Date();
      await m.update(Membership, { id: membership.id, deletedAt: IsNull() }, { deletedAt });
      membership.deletedAt = deletedAt;

      if (person) {
        await this.settleStatusAfterRemoval(m, person, [membership.status]);
      }
      await this.writeLegacyMirror(m, membership.userId);
      queueMembershipChange(m, { personIds: [membership.userId] });

      return membership;
    });
  }

  /**
   * Ends every live membership of a building with ONE shared deleted_at (so the
   * set can be told apart from earlier removals), re-mirrors each person (status
   * included, as remove() does) and returns how many were ended. Works on a building the caller has already
   * soft-deleted in the same transaction.
   */
  async removeAllForTenant(tenantId: string, manager?: EntityManager): Promise<number> {
    if (!isUuid(tenantId)) {
      return 0;
    }

    return this.inTransaction(manager, async (m) => {
      // Lock order: tenant first, which also stops add() from putting anyone new
      // into the building while it is being emptied.
      await m.findOne(Tenant, {
        where: { id: tenantId },
        withDeleted: true,
        lock: { mode: 'pessimistic_write' },
      });

      const before = await m.find(Membership, { where: { tenantId } });
      const personIds = [...new Set(before.map((membership) => membership.userId))].sort();
      const persons = new Map<string, User>();
      for (const personId of personIds) {
        const person = await this.lockPerson(m, personId, true);
        if (person) {
          persons.set(personId, person);
        }
      }

      // Re-read under the person locks: a concurrent remove() may have won.
      const live = await m.find(Membership, { where: { tenantId } });
      if (live.length === 0) {
        return 0;
      }

      const deletedAt = new Date();
      await m.update(
        Membership,
        { id: In(live.map((membership) => membership.id)), deletedAt: IsNull() },
        { deletedAt },
      );

      for (const personId of personIds) {
        const person = persons.get(personId);
        const ended = live.filter((membership) => membership.userId === personId);
        if (person && ended.length > 0) {
          await this.settleStatusAfterRemoval(
            m,
            person,
            ended.map((membership) => membership.status),
          );
        }
        await this.writeLegacyMirror(m, personId);
      }
      queueMembershipChange(m, { personIds, tenantId });

      return live.length;
    });
  }

  /**
   * For a soft-deleted person being brought back (identity provisioning signs
   * them in again): ends any membership still live, so restoring can never hand
   * back their old access, and writes the sentinel. Their status is kept, so an
   * account that was also deactivated stays blocked. Returns how many ended.
   */
  async restorePerson(personId: string, manager?: EntityManager): Promise<number> {
    if (!isUuid(personId)) {
      return 0;
    }

    return this.inTransaction(manager, async (m) => {
      const person = await this.lockPerson(m, personId, true);
      if (!person) {
        return 0;
      }

      const live = await m.find(Membership, { where: { userId: personId } });
      if (live.length > 0) {
        await m.update(
          Membership,
          { id: In(live.map((membership) => membership.id)), deletedAt: IsNull() },
          { deletedAt: new Date() },
        );
        queueMembershipChange(m, { personIds: [personId] });
      }
      await this.writeLegacyMirror(m, personId);

      return live.length;
    });
  }

  // ============ Reads ============

  /**
   * The person's live (not soft-deleted) membership in a building, any status,
   * or null. Ids that are not uuids return null instead of reaching Postgres, and
   * a missing id can never turn into an unscoped query.
   */
  async findLive(
    userId: string,
    tenantId: string,
    manager?: EntityManager,
  ): Promise<Membership | null> {
    if (!isUuid(userId) || !isUuid(tenantId)) {
      return null;
    }

    return this.em(manager).findOne(Membership, { where: { userId, tenantId } });
  }

  /** All live memberships of a person, any status, oldest first. */
  async listLiveForUser(userId: string, manager?: EntityManager): Promise<Membership[]> {
    if (!isUuid(userId)) {
      return [];
    }

    return this.em(manager).find(Membership, {
      where: { userId },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
  }

  // ---- Reads with the building loaded (AUTH-5) ----
  //
  // Each of these INNER JOINs the full Tenant. TypeORM adds "deleted_at IS NULL"
  // to that join, so a membership whose building was soft-deleted drops out:
  // nobody can act in, auto-select or list a deleted building. Soft-deleted
  // memberships are excluded as the main alias. Non-uuid ids return null / []
  // without reaching Postgres.

  /**
   * The person's own live membership `membershipId`, with its live building,
   * whatever its status, or null (someone else's id, ended, deleted building).
   * The caller decides whether it can be acted as (isSelectableMembership).
   */
  async findOwnedWithTenant(
    membershipId: string,
    personId: string,
    manager?: EntityManager,
  ): Promise<Membership | null> {
    if (!isUuid(membershipId) || !isUuid(personId)) {
      return null;
    }

    return this.withTenant(manager)
      .where('membership.id = :membershipId', { membershipId })
      .andWhere('membership.userId = :personId', { personId })
      .getOne();
  }

  /**
   * The memberships a person can act as: ACTIVE, role in SELECTABLE_ROLES, live
   * building (suspended, pending-payment and paused buildings included, D6).
   * Oldest first. Exactly one of these is what auto-select picks.
   */
  async listActiveForPerson(personId: string, manager?: EntityManager): Promise<Membership[]> {
    if (!isUuid(personId)) {
      return [];
    }

    return this.withTenant(manager)
      .where('membership.userId = :personId', { personId })
      .andWhere('membership.status = :status', { status: UserStatus.ACTIVE })
      .andWhere('membership.role IN (:...roles)', { roles: [...SELECTABLE_ROLES] })
      .orderBy('membership.createdAt', 'ASC')
      .addOrderBy('membership.id', 'ASC')
      .getMany();
  }

  /**
   * Every live membership of a person in a live building, ANY status and any
   * role (inactive, pending and staff rows are listed so the picker can show
   * them disabled), sorted by building name, then role.
   */
  async listForPerson(personId: string, manager?: EntityManager): Promise<Membership[]> {
    if (!isUuid(personId)) {
      return [];
    }

    return this.withTenant(manager)
      .where('membership.userId = :personId', { personId })
      .orderBy('tenant.name', 'ASC')
      .addOrderBy('membership.role', 'ASC')
      .addOrderBy('membership.id', 'ASC')
      .getMany();
  }

  /**
   * The person's PENDING resident join requests to live buildings, oldest first,
   * with the building loaded. The canonical source of C4 pendingJoinRequests (a
   * request is never a membership).
   */
  async listPendingJoinRequests(
    personId: string,
    manager?: EntityManager,
  ): Promise<BuildingJoinRequest[]> {
    if (!isUuid(personId)) {
      return [];
    }

    return this.em(manager)
      .createQueryBuilder(BuildingJoinRequest, 'request')
      .innerJoinAndSelect('request.tenant', 'tenant')
      .where('request.userId = :personId', { personId })
      .andWhere('request.status = :status', { status: JoinRequestStatus.PENDING })
      .orderBy('request.createdAt', 'ASC')
      .addOrderBy('request.id', 'ASC')
      .getMany();
  }

  /**
   * The oldest live BUILDING_ADMIN membership matching the filters, with its live
   * building and its live person loaded, or null. One signature for every
   * "who administers this building" / "which building does this person
   * administer" question (signup resume, paid-signup login, billing).
   *
   * At least one of tenantId / personId is required: a query with neither would
   * match any admin of any building, so it is refused as a programming error
   * rather than run.
   */
  async findAdminMembership(
    query: AdminMembershipQuery,
    manager?: EntityManager,
  ): Promise<Membership | null> {
    const { tenantId, personId, status, tenantStatus } = query;
    if (tenantId === undefined && personId === undefined) {
      throw new Error('findAdminMembership needs a tenantId or a personId');
    }
    if (
      (tenantId !== undefined && !isUuid(tenantId)) ||
      (personId !== undefined && !isUuid(personId))
    ) {
      return null;
    }

    const qb = this.withTenant(manager)
      .innerJoinAndSelect('membership.user', 'user')
      .where('membership.role = :role', { role: UserRole.BUILDING_ADMIN });
    if (tenantId !== undefined) {
      qb.andWhere('membership.tenantId = :tenantId', { tenantId });
    }
    if (personId !== undefined) {
      qb.andWhere('membership.userId = :personId', { personId });
    }
    if (status !== undefined) {
      qb.andWhere('membership.status = :status', { status });
    }
    if (tenantStatus !== undefined) {
      qb.andWhere('tenant.status = :tenantStatus', { tenantStatus });
    }

    return qb.orderBy('membership.createdAt', 'ASC').addOrderBy('membership.id', 'ASC').getOne();
  }

  // ---- GET /memberships/me (AUTH-9) ----

  /**
   * The C4 body for the caller. Built from the acting principal, so
   * activeMembershipId is what THIS request resolved to: a stale or foreign
   * header resolves to no context, so it gives null here instead of an error.
   */
  async getMine(user: ActingUser | User): Promise<MembershipsMeResponse> {
    const [memberships, requests] = await Promise.all([
      this.listForPerson(user.id),
      this.listPendingJoinRequests(user.id),
    ]);

    return {
      isSuperAdmin: isActingUser(user) ? user.isSuperAdmin : user.role === UserRole.SUPER_ADMIN,
      activeMembershipId: activeMembershipIdOf(user),
      multiMembershipEnabled: isMembershipContextEnabled(),
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
      },
      memberships: memberships.map(toMembershipView),
      pendingJoinRequests: requests.map(
        (request): PendingJoinRequestView => ({
          id: request.id,
          status: JoinRequestStatus.PENDING,
          tenant: { id: request.tenant.id, name: request.tenant.name },
        }),
      ),
    };
  }

  // ============ Legacy mirror ============

  /**
   * Re-derives gate_users.tenant_id / role / unit from the person's live
   * memberships: the primary membership (pickPrimaryMembership) or the sentinel
   * (building_admin, no tenant, no unit) when there is none. On a super admin
   * row only tenant_id and unit follow (its role is never touched), and it never
   * writes status. Idempotent: no write when the columns already agree.
   *
   * Every write method above already calls this inside its own transaction; call
   * it directly only to repair a person (seed, fixtures). Without a manager it
   * opens a transaction and locks the person row first.
   */
  async syncLegacyColumns(personId: string, manager?: EntityManager): Promise<void> {
    if (!isUuid(personId)) {
      return;
    }

    await this.inTransaction(manager, async (m) => {
      await this.lockPerson(m, personId, true);
      await this.writeLegacyMirror(m, personId);
    });
  }

  // ============ Internals ============

  private em(manager?: EntityManager): EntityManager {
    return manager ?? this.dataSource.manager;
  }

  /** Live memberships (alias `membership`) inner-joined to their live building (alias `tenant`). */
  private withTenant(manager?: EntityManager) {
    return this.em(manager)
      .createQueryBuilder(Membership, 'membership')
      .innerJoinAndSelect('membership.tenant', 'tenant');
  }

  /** Joins the caller's transaction when it has one; otherwise opens one. */
  private async inTransaction<T>(
    manager: EntityManager | undefined,
    work: (m: EntityManager) => Promise<T>,
  ): Promise<T> {
    if (manager?.queryRunner?.isTransactionActive) {
      return work(manager);
    }

    return this.em(manager).transaction(work);
  }

  /**
   * FOR UPDATE on the person row. Loaded without relations on purpose: Postgres
   * rejects FOR UPDATE on the nullable side of an outer join.
   */
  private lockPerson(m: EntityManager, personId: string, withDeleted: boolean) {
    return m.findOne(User, {
      where: { id: personId },
      withDeleted,
      lock: { mode: 'pessimistic_write' },
    });
  }

  /**
   * Finds a live membership, locks its person and reads the membership again
   * under that lock, so a concurrent removal is seen instead of overwritten.
   */
  private async lockMembership(
    m: EntityManager,
    membershipId: string,
  ): Promise<{ person: User | null; membership: Membership }> {
    const current = isUuid(membershipId)
      ? await m.findOne(Membership, { where: { id: membershipId } })
      : null;
    if (!current) {
      throw new NotFoundException('Membership not found');
    }

    const person = await this.lockPerson(m, current.userId, true);
    const membership = await m.findOne(Membership, { where: { id: membershipId } });
    if (!membership) {
      throw new NotFoundException('Membership not found');
    }

    return { person, membership };
  }

  private async writeLegacyMirror(m: EntityManager, personId: string): Promise<void> {
    const person = await m.findOne(User, { where: { id: personId }, withDeleted: true });
    if (!person) {
      return;
    }

    const live = await this.listLiveForUser(personId, m);
    const target = legacyColumnsFor(pickPrimaryMembership(live));

    if (person.role === UserRole.SUPER_ADMIN) {
      await this.writeSuperAdminMirror(m, person, target);
      return;
    }

    if (
      person.tenantId === target.tenantId &&
      person.role === target.role &&
      (person.unit ?? null) === target.unit
    ) {
      return;
    }

    // The role condition keeps a super_admin grant that raced in untouched.
    await m.update(User, { id: personId, role: Not(UserRole.SUPER_ADMIN) }, {
      tenantId: target.tenantId,
      role: target.role,
      unit: target.unit,
    } as QueryDeepPartialEntity<User>);
  }

  /**
   * A super admin keeps the platform role, but tenant_id and unit follow the
   * memberships as everyone else's do (the primary membership's; NULL with
   * none). Left stale, a super admin removed from a building kept passing the
   * legacy gate check there (it lets a super_admin row through the
   * role-agnostic credential sets in the building its tenant_id names); granting
   * super_admin to someone who already holds a building leaves exactly such a
   * value behind. The role condition keeps a revoke that raced in untouched.
   */
  private async writeSuperAdminMirror(
    m: EntityManager,
    person: User,
    target: LegacyColumns,
  ): Promise<void> {
    if (person.tenantId === target.tenantId && (person.unit ?? null) === target.unit) {
      return;
    }

    await m.update(User, { id: person.id, role: UserRole.SUPER_ADMIN }, {
      tenantId: target.tenantId,
      unit: target.unit,
    } as QueryDeepPartialEntity<User>);
  }

  /** The dual-write: copy a membership status onto gate_users.status. */
  private async mirrorStatus(m: EntityManager, person: User, status: UserStatus): Promise<void> {
    if (person.role === UserRole.SUPER_ADMIN || person.status === status) {
      return;
    }

    await m.update(User, { id: person.id }, { status });
    person.status = status;
  }

  /**
   * Keeps the status dual-write true after memberships END (remove,
   * removeAllForTenant), by what is left:
   *
   *   none           gate_users.status goes back to ACTIVE if it still holds a
   *                  status one of the ended memberships had (the undo of the
   *                  dual-write: a removal never locks a person out of the
   *                  whole platform);
   *   exactly one,   its status is copied onto an ACTIVE gate_users.status, so
   *   not active     the person looks exactly like someone who only ever held
   *                  that building. Without this, a person deactivated in B
   *                  while also holding A kept gate_users.status 'active' once A
   *                  ended, and after a flag-off rollback (whose readers see
   *                  only gate_users) passed B's gate again;
   *   otherwise      nothing.
   *
   * It never LIFTS a non-active gate_users.status while a membership is left:
   * then that status is a platform ban (the add paths refuse a banned person,
   * and update() copies a status only while exactly one membership is live),
   * and gate_users.status is the only record of it. For the same reason one
   * non-active status is never swapped for another. Super admins are never
   * touched.
   */
  private async settleStatusAfterRemoval(
    m: EntityManager,
    person: User,
    endedStatuses: readonly UserStatus[],
  ): Promise<void> {
    if (person.role === UserRole.SUPER_ADMIN) {
      return;
    }

    const remaining = await m.find(Membership, { where: { userId: person.id } });

    if (remaining.length === 0) {
      if (person.status !== UserStatus.ACTIVE && endedStatuses.includes(person.status)) {
        await m.update(User, { id: person.id }, { status: UserStatus.ACTIVE });
        person.status = UserStatus.ACTIVE;
      }
      return;
    }

    if (
      remaining.length === 1 &&
      remaining[0].status !== UserStatus.ACTIVE &&
      person.status === UserStatus.ACTIVE
    ) {
      await this.mirrorStatus(m, person, remaining[0].status);
    }
  }

  private assertRole(role: unknown): asserts role is MembershipRole {
    if (!isMembershipRole(role)) {
      throw new BadRequestException(
        `'${String(role)}' is not a role a person can hold in a building.`,
      );
    }
  }

  private assertStatus(status: unknown): asserts status is MembershipStatus {
    if (!USER_STATUSES.includes(status as string)) {
      throw new BadRequestException(`'${String(status)}' is not a membership status.`);
    }
  }
}
