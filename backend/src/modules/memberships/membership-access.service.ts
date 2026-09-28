import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, SelectQueryBuilder } from 'typeorm';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import { Tenant } from '@database/entities/tenant.entity';
import { MEMBERSHIP_ROLES, Membership, MembershipRole } from '@database/entities/membership.entity';
import { isUuid } from '@common/context/acting-user';
import { isMembershipContextEnabled } from '@common/context/membership-flags';
import { isMembershipTableKnownPresent } from './membership-table';

/**
 * Where a holder decision was read from:
 *   membership  gate_memberships (GATE_MEMBERSHIP_CONTEXT=on);
 *   legacy      the holder's gate_users row, as the gate checked it before
 *               memberships existed (flag off, and the rollback path), plus the
 *               status of their membership in that same building.
 */
export type HolderCheckSource = 'membership' | 'legacy';

/**
 * Why a credential holder may not pass, in check order:
 *   PERSON_NOT_FOUND     no such person, or soft-deleted;
 *   ACCOUNT_BANNED       gate_users.status is not active (platform-wide);
 *   NO_MEMBERSHIP        no live role in this building (or the building is gone);
 *   MEMBERSHIP_INACTIVE  their role here is deactivated;
 *   MEMBERSHIP_PENDING   their role here is not active yet;
 *   ROLE_NOT_ALLOWED     their role here does not grant this kind of access.
 * The legacy source never reports ACCOUNT_BANNED: before the status split its
 * single gate_users.status is the building status, reported as INACTIVE/PENDING.
 */
export type HolderDenialReason =
  | 'PERSON_NOT_FOUND'
  | 'ACCOUNT_BANNED'
  | 'NO_MEMBERSHIP'
  | 'MEMBERSHIP_INACTIVE'
  | 'MEMBERSHIP_PENDING'
  | 'ROLE_NOT_ALLOWED';

interface HolderDecisionBase {
  source: HolderCheckSource;
  personId: string | null;
  tenantId: string | null;
  /** The membership decided on; null in legacy mode or when there is none. */
  membershipId: string | null;
  /** The role held in this building (legacy: gate_users.role), when known. */
  role: UserRole | null;
  /** The unit held in this building (legacy: gate_users.unit), for greetings. */
  unit: string | null;
}

export type HolderDecision =
  | (HolderDecisionBase & { allowed: true; reason: null })
  | (HolderDecisionBase & { allowed: false; reason: HolderDenialReason });

export interface CheckHolderOptions {
  /** Building roles this kind of access accepts (see membership-access.constants.ts). */
  roles: readonly MembershipRole[];
  manager?: EntityManager;
}

/** The holder's gate_users row, as the legacy gate check reads it. */
export interface LegacyHolderRow {
  personId: string;
  personStatus: UserStatus;
  tenantId: string | null;
  role: UserRole;
  unit: string | null;
  /**
   * Status of the person's live membership in gate_users.tenant_id, when there
   * is one (null / absent otherwise, and before the table is known to exist).
   */
  legacyMembershipStatus?: UserStatus | null;
}

/** The person plus their live membership in the credential's building, if any. */
export interface MembershipHolderRow {
  personId: string;
  personStatus: UserStatus;
  membershipId: string | null;
  membershipRole: MembershipRole | null;
  membershipStatus: UserStatus | null;
  membershipUnit: string | null;
}

function coversAllMembershipRoles(roles: readonly MembershipRole[]): boolean {
  return MEMBERSHIP_ROLES.every((role) => roles.includes(role));
}

function statusReason(status: UserStatus): HolderDenialReason | null {
  if (status === UserStatus.INACTIVE) return 'MEMBERSHIP_INACTIVE';
  if (status === UserStatus.PENDING) return 'MEMBERSHIP_PENDING';
  return null;
}

/**
 * Today's gate rule, read from the holder's gate_users row: same building first
 * ("wrong building"), then status, then role. A super_admin row that carries the
 * building passes the role-agnostic credential sets, because the gate never
 * looked at roles before; it still fails a narrower set such as card issuing.
 *
 * Status is the stricter of gate_users.status and the status of the holder's
 * membership in that same building. The two agree for anyone whose memberships
 * were only ever written with the flag off (the dual-write copies one onto the
 * other), so this changes nothing there. It matters after a flag-off rollback:
 * while the flag was on, a person deactivated in B and holding a second
 * building kept gate_users.status 'active', and without this they passed B's
 * gate again once the flag was off.
 */
export function decideLegacyHolder(
  row: LegacyHolderRow | null,
  tenantId: string | null,
  roles: readonly MembershipRole[],
): HolderDecision {
  const base = {
    source: 'legacy' as const,
    personId: row?.personId ?? null,
    tenantId,
    membershipId: null,
    role: row?.role ?? null,
    unit: row?.unit ?? null,
  };

  if (!row) {
    return { ...base, allowed: false, reason: 'PERSON_NOT_FOUND' };
  }
  if (!tenantId || row.tenantId !== tenantId) {
    return { ...base, allowed: false, reason: 'NO_MEMBERSHIP' };
  }

  const inactive =
    statusReason(row.personStatus) ??
    (row.legacyMembershipStatus ? statusReason(row.legacyMembershipStatus) : null);
  if (inactive) {
    return { ...base, allowed: false, reason: inactive };
  }

  const roleAllowed =
    roles.includes(row.role as MembershipRole) ||
    (row.role === UserRole.SUPER_ADMIN && coversAllMembershipRoles(roles));
  if (!roleAllowed) {
    return { ...base, allowed: false, reason: 'ROLE_NOT_ALLOWED' };
  }

  return { ...base, allowed: true, reason: null };
}

/** The membership rule: person live and not banned, active role here, role allowed. */
export function decideMembershipHolder(
  row: MembershipHolderRow | null,
  tenantId: string | null,
  roles: readonly MembershipRole[],
): HolderDecision {
  const base = {
    source: 'membership' as const,
    personId: row?.personId ?? null,
    tenantId,
    membershipId: row?.membershipId ?? null,
    role: row?.membershipRole ?? null,
    unit: row?.membershipUnit ?? null,
  };

  if (!row) {
    return { ...base, allowed: false, reason: 'PERSON_NOT_FOUND' };
  }
  if (row.personStatus !== UserStatus.ACTIVE) {
    return { ...base, allowed: false, reason: 'ACCOUNT_BANNED' };
  }
  if (!tenantId || !row.membershipId || !row.membershipRole || !row.membershipStatus) {
    return { ...base, allowed: false, reason: 'NO_MEMBERSHIP' };
  }

  const inactive = statusReason(row.membershipStatus);
  if (inactive) {
    return { ...base, allowed: false, reason: inactive };
  }
  if (!roles.includes(row.membershipRole)) {
    return { ...base, allowed: false, reason: 'ROLE_NOT_ALLOWED' };
  }

  return { ...base, allowed: true, reason: null };
}

/**
 * Holder decisions and recipient queries: "is this person allowed in this
 * building" and "who in this building should hear about it".
 *
 * One definition of ACTIVE is shared by every query below: a live (not
 * soft-deleted) membership with status ACTIVE, in a live building, held by a
 * live person whose gate_users.status is ACTIVE (not platform-banned).
 *
 * checkHolder() follows GATE_MEMBERSHIP_CONTEXT: off, it reproduces today's
 * gate_users-row comparison, and additionally denies when the holder's
 * membership in that same building is not active (the rollback safety net,
 * read in the same query once the table is known to exist, membership-table.ts);
 * on, it reads the holder's membership in the credential's building. The recipient queries
 * always read memberships: with the flag off every person has at most one, which
 * mirrors their gate_users row, so they answer the same people as today minus the
 * deactivated and banned ones.
 */
@Injectable()
export class MembershipAccessService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * May `personId` use a personal credential (QR, card, vehicle) in `tenantId`?
   * One indexed query. Ids that are missing or not uuids are denied without a
   * query (PERSON_NOT_FOUND / NO_MEMBERSHIP), never passed to Postgres.
   */
  async checkHolder(
    personId: string | null | undefined,
    tenantId: string | null | undefined,
    options: CheckHolderOptions,
  ): Promise<HolderDecision> {
    const building = isUuid(tenantId) ? tenantId : null;

    if (!isMembershipContextEnabled()) {
      const row = isUuid(personId) ? await this.loadLegacyHolder(personId, options.manager) : null;
      return decideLegacyHolder(row, building, options.roles);
    }

    const row = isUuid(personId)
      ? await this.loadMembershipHolder(personId, building, options.manager)
      : null;
    return decideMembershipHolder(row, building, options.roles);
  }

  /** checkHolder(...).allowed, for registration-time checks. */
  async hasActiveMembership(
    personId: string | null | undefined,
    tenantId: string | null | undefined,
    roles: readonly MembershipRole[],
    manager?: EntityManager,
  ): Promise<boolean> {
    const decision = await this.checkHolder(personId, tenantId, { roles, manager });
    return decision.allowed;
  }

  /**
   * Distinct ids (gate_users.id) of everyone ACTIVE in the building with one of
   * the roles. A person appears once however many rows match.
   */
  async findActivePersonIds(
    tenantId: string,
    roles: readonly MembershipRole[],
    manager?: EntityManager,
  ): Promise<string[]> {
    this.assertTenant(tenantId);
    if (roles.length === 0) {
      return [];
    }

    const query = this.em(manager)
      .createQueryBuilder(Membership, 'm')
      .select('m.userId', 'personId')
      .distinct(true)
      .innerJoin(User, 'p', 'p.id = m.userId')
      .where('m.tenantId = :tenantId', { tenantId })
      .andWhere('m.role IN (:...roles)', { roles: [...roles] });

    const rows = await this.whereActive(query).getRawMany<{ personId: string }>();
    return rows.map((row) => row.personId).sort();
  }

  /**
   * The building's members with their person rows (`membership.user`), ordered
   * by name. Default: every live membership of a live person, any status (for
   * listings). activeOnly narrows to the shared ACTIVE definition.
   */
  async findTenantMembers(
    tenantId: string,
    options: {
      roles?: readonly MembershipRole[];
      activeOnly?: boolean;
      manager?: EntityManager;
    } = {},
  ): Promise<Membership[]> {
    this.assertTenant(tenantId);
    if (options.roles && options.roles.length === 0) {
      return [];
    }

    const query = this.em(options.manager)
      .createQueryBuilder(Membership, 'm')
      .innerJoinAndSelect('m.user', 'p', 'p.deletedAt IS NULL')
      .where('m.tenantId = :tenantId', { tenantId })
      .orderBy('p.lastName', 'ASC')
      .addOrderBy('p.firstName', 'ASC')
      .addOrderBy('m.id', 'ASC');

    if (options.roles) {
      query.andWhere('m.role IN (:...roles)', { roles: [...options.roles] });
    }

    return (options.activeOnly ? this.whereActive(query) : query).getMany();
  }

  /**
   * Email addresses of each building's ACTIVE building admins, keyed by tenant
   * id, oldest membership first and de-duplicated case-insensitively. Every
   * requested (valid) tenant id is a key; an empty list means no admin, and the
   * caller falls back to tenant.contactEmail. Super admins are not included.
   */
  async findTenantAdminEmails(
    tenantIds: readonly string[],
    manager?: EntityManager,
  ): Promise<Map<string, string[]>> {
    const ids = [...new Set(tenantIds.filter((id) => isUuid(id)))];
    const result = new Map<string, string[]>(ids.map((id) => [id, []]));
    if (ids.length === 0) {
      return result;
    }

    const query = this.em(manager)
      .createQueryBuilder(Membership, 'm')
      .select('m.tenantId', 'tenantId')
      .addSelect('p.email', 'email')
      .innerJoin(User, 'p', 'p.id = m.userId')
      .where('m.tenantId IN (:...tenantIds)', { tenantIds: ids })
      .andWhere('m.role = :adminRole', { adminRole: UserRole.BUILDING_ADMIN })
      .orderBy('m.createdAt', 'ASC')
      .addOrderBy('m.id', 'ASC');

    const rows = await this.whereActive(query).getRawMany<{ tenantId: string; email: string }>();

    const seen = new Map<string, Set<string>>();
    for (const row of rows) {
      if (!row.email) continue;
      const key = row.email.trim().toLowerCase();
      const tenantSeen = seen.get(row.tenantId) ?? new Set<string>();
      if (tenantSeen.has(key)) continue;
      tenantSeen.add(key);
      seen.set(row.tenantId, tenantSeen);
      result.get(row.tenantId)?.push(row.email);
    }

    return result;
  }

  // ============ Internals ============

  /**
   * The legacy read: the holder's own row (soft-deleted rows excluded) and, in
   * the same query, the status of their live membership in the building that
   * row names. The membership join is left out until the boot check has seen
   * gate_memberships, so this keeps working before the migration has run.
   */
  protected async loadLegacyHolder(
    personId: string,
    manager?: EntityManager,
  ): Promise<LegacyHolderRow | null> {
    const query = this.em(manager)
      .createQueryBuilder(User, 'p')
      .select('p.id', 'personId')
      .addSelect('p.status', 'personStatus')
      .addSelect('p.tenantId', 'tenantId')
      .addSelect('p.role', 'role')
      .addSelect('p.unit', 'unit')
      .where('p.id = :personId', { personId });

    if (isMembershipTableKnownPresent()) {
      query
        .addSelect('m.status', 'legacyMembershipStatus')
        .leftJoin(
          Membership,
          'm',
          'm.userId = p.id AND m.tenantId = p.tenantId AND m.deletedAt IS NULL',
        );
    }

    const row = await query.getRawOne<LegacyHolderRow>();
    return row ?? null;
  }

  /**
   * The person and, in the same query, their live membership in `tenantId` when
   * that building is live (the unique (user_id, tenant_id) index serves it).
   * A null tenantId still reads the person so a ban can be reported.
   */
  protected async loadMembershipHolder(
    personId: string,
    tenantId: string | null,
    manager?: EntityManager,
  ): Promise<MembershipHolderRow | null> {
    const row = await this.em(manager)
      .createQueryBuilder(User, 'p')
      .select('p.id', 'personId')
      .addSelect('p.status', 'personStatus')
      .addSelect('m.id', 'membershipId')
      .addSelect('m.role', 'membershipRole')
      .addSelect('m.status', 'membershipStatus')
      .addSelect('m.unit', 'membershipUnit')
      .addSelect('t.id', 'liveTenantId')
      .leftJoin(
        Membership,
        'm',
        'm.userId = p.id AND m.tenantId = :tenantId AND m.deletedAt IS NULL',
        { tenantId },
      )
      .leftJoin(Tenant, 't', 't.id = m.tenantId AND t.deletedAt IS NULL')
      .where('p.id = :personId', { personId })
      .getRawOne<MembershipHolderRow & { liveTenantId: string | null }>();

    if (!row) {
      return null;
    }

    // A membership in a soft-deleted building is no membership.
    const { liveTenantId, ...holder } = row;
    return liveTenantId
      ? holder
      : {
          ...holder,
          membershipId: null,
          membershipRole: null,
          membershipStatus: null,
          membershipUnit: null,
        };
  }

  /**
   * The single definition of ACTIVE for queries that already have the membership
   * as `m` and its person joined as `p`: adds the live-building join and the
   * status conditions. `m` itself is soft-delete filtered by TypeORM as the main
   * alias. The two statuses are different Postgres enum types, so each gets its
   * own parameter: a shared one becomes a single $n typed by its first use, and
   * the other comparison then fails ("operator does not exist").
   */
  private whereActive<T extends object>(query: SelectQueryBuilder<T>): SelectQueryBuilder<T> {
    return query
      .innerJoin(Tenant, 't', 't.id = m.tenantId AND t.deletedAt IS NULL')
      .andWhere('p.deletedAt IS NULL')
      .andWhere('m.status = :activeMembershipStatus', { activeMembershipStatus: UserStatus.ACTIVE })
      .andWhere('p.status = :activePersonStatus', { activePersonStatus: UserStatus.ACTIVE });
  }

  /** A null tenant must never reach a where-clause, where TypeORM would drop it. */
  private assertTenant(tenantId: string): void {
    if (!isUuid(tenantId)) {
      throw new Error('MembershipAccessService: a building id (uuid) is required');
    }
  }

  private em(manager?: EntityManager): EntityManager {
    return manager ?? this.dataSource.manager;
  }
}
