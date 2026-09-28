/**
 * Resolves WHO a request acts as: the person plus one of their memberships
 * (contract C5, rules C6).
 *
 * Both passport strategies call resolve() at the end of validate() (they run
 * with passReqToCallback so they can read the X-Gate-Membership header), so
 * every authentication, including the controller-level re-runs of JwtAuthGuard,
 * yields the same overlaid principal. The resolver itself NEVER throws for a
 * context problem: it records the problem on the principal (contextProblem /
 * contextProblemReason) and JwtAuthGuard.handleRequest decides, using the
 * route's @ContextOptional metadata, whether that is a 409 / 403 or fine.
 * Database errors do propagate, exactly as the old strategy lookups did.
 *
 * GATE_MEMBERSHIP_CONTEXT off (the default) gives the LEGACY overlay: role,
 * tenantId, unit and tenant straight from the gate_users row, i.e. the same
 * values req.user carried before this feature. The one exception is the
 * rollback safety net: when the person's membership in that building exists
 * and is not active, no building is granted (see legacy()). That single read
 * of gate_memberships happens only once the boot check has seen the table
 * (membership-table.ts), so this mode works before the migrations have run.
 *
 * On, the header decides:
 *
 *   header                       person                  context
 *   ---------------------------  ----------------------  ---------------------------
 *   malformed / array            anyone                  none, MEMBERSHIP_INVALID
 *   'platform'                   super admin             platform
 *   'platform'                   anyone else             none, MEMBERSHIP_INVALID
 *   a uuid: own, ACTIVE,         anyone                  membership
 *     selectable role, live
 *     building
 *   any other uuid               anyone                  none, MEMBERSHIP_INVALID
 *   absent                       super admin             platform (L7)
 *   absent, 1 usable membership  anyone else             membership (auto-select)
 *   absent, 0 usable             anyone else             none, REQUIRED NO_MEMBERSHIPS
 *   absent, several usable       anyone else             none, REQUIRED AMBIGUOUS
 *
 * Suspended, pending-payment and paused buildings are valid contexts (D6):
 * SubscriptionGuard answers 402 to their writes, so an admin can always reach
 * billing.
 */
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import { Tenant } from '@database/entities/tenant.entity';
import { Membership } from '@database/entities/membership.entity';
import {
  ACTING_USER_MARK,
  ActingUser,
  ContextKind,
  ContextProblem,
  MembershipRequiredReason,
  parseMembershipHeader,
} from '@common/context/acting-user';
import { isMembershipContextEnabled } from '@common/context/membership-flags';
import { MembershipsService, isSelectableMembership } from './memberships.service';
import { isMembershipTableKnownPresent } from './membership-table';

/** The values laid over the person to build req.user. */
export interface ActingOverlay {
  contextKind: ContextKind;
  /** null only in the 'none' context and in legacy() when no building is granted. */
  role: UserRole | null;
  tenantId: string | null;
  tenant: Tenant | null;
  unit: string | null;
  isSuperAdmin: boolean;
  contextProblem?: ContextProblem | null;
  contextProblemReason?: MembershipRequiredReason | null;
  activeMembership?: Membership | null;
}

/**
 * Clones the person and lays the overlay on top (contract C5). The person
 * entity is never mutated.
 *
 *   - Object.create(User.prototype), so instanceof User and User methods (toJSON)
 *     keep working for existing consumers;
 *   - ACTING_USER_MARK is an ENUMERABLE own symbol, so spreads and Object.assign
 *     copies carry it and ActingUserWriteGuardSubscriber refuses to persist them;
 *   - activeMembership is NON-enumerable (not serialised, not spread);
 *   - passwordHash is never carried, whatever the caller loaded.
 */
export function buildActingUser(person: User, overlay: ActingOverlay): ActingUser {
  const acting = Object.assign(Object.create(User.prototype) as User, person);
  Reflect.deleteProperty(acting, 'passwordHash');

  Object.assign(acting, {
    role: overlay.role,
    tenantId: overlay.tenantId,
    tenant: overlay.tenant,
    unit: overlay.unit,
    contextKind: overlay.contextKind,
    contextProblem: overlay.contextProblem ?? null,
    contextProblemReason: overlay.contextProblemReason ?? null,
    isSuperAdmin: overlay.isSuperAdmin,
    [ACTING_USER_MARK]: true,
  });

  Object.defineProperty(acting, 'activeMembership', {
    value: overlay.activeMembership ?? null,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return acting as ActingUser;
}

@Injectable()
export class MembershipContextService {
  constructor(
    private readonly membershipsService: MembershipsService,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) {}

  /**
   * Whether the person is a platform admin (A1: super_admin on gate_users.role,
   * never a membership). The single flip point if platform admin ever becomes
   * something else.
   */
  isPlatformAdmin(person: Pick<User, 'role'> | null | undefined): boolean {
    return person?.role === UserRole.SUPER_ADMIN;
  }

  /**
   * The acting principal for `person` (an authenticated, ACTIVE gate_users row
   * loaded without relations) and the raw X-Gate-Membership value (or socket
   * auth.membershipId). Never throws for a context problem; see the table at the
   * top of this file.
   */
  async resolve(person: User, rawHeader?: unknown): Promise<ActingUser> {
    const isSuperAdmin = this.isPlatformAdmin(person);

    if (!isMembershipContextEnabled()) {
      return this.legacy(person, isSuperAdmin);
    }

    const header = parseMembershipHeader(rawHeader);
    switch (header.kind) {
      case 'malformed':
        return this.invalid(person, isSuperAdmin);

      case 'platform':
        return isSuperAdmin ? this.platform(person) : this.invalid(person, isSuperAdmin);

      case 'membership': {
        const membership = await this.membershipsService.findOwnedWithTenant(
          header.membershipId,
          person.id,
        );
        return membership && membership.userId === person.id && isSelectableMembership(membership)
          ? this.forMembership(person, membership, isSuperAdmin)
          : this.invalid(person, isSuperAdmin);
      }

      case 'absent': {
        if (isSuperAdmin) {
          return this.platform(person);
        }

        const usable = (await this.membershipsService.listActiveForPerson(person.id)).filter(
          isSelectableMembership,
        );
        if (usable.length === 1) {
          return this.forMembership(person, usable[0], isSuperAdmin);
        }
        return this.required(
          person,
          isSuperAdmin,
          usable.length === 0 ? 'NO_MEMBERSHIPS' : 'AMBIGUOUS',
        );
      }
    }
  }

  // ---------------------------------------------------------------------------

  /**
   * Flag off: exactly what req.user carried before (the gate_users row with its
   * tenant relation). The tenant is loaded here rather than by the strategies so
   * both strategies and both modes share one code path. A soft-deleted tenant
   * loads as null, as the old relations: ['tenant'] join did.
   *
   * Rollback safety net: when a non-super-admin's live membership in the
   * building gate_users names exists and is NOT active, the principal gets no
   * building at all (role, tenantId, tenant and unit null), the shape of a
   * person who holds nothing. Routes then fail closed: RolesGuard refuses a null
   * role and assertBuildingContext answers 409 MEMBERSHIP_REQUIRED, while the
   * context-optional routes (profile, /auth/me, onboarding status) keep working
   * and the person stays signed in. This only differs from the row for people
   * whose memberships were written while the flag was on (the dual-write keeps
   * the two equal otherwise): someone deactivated in B who also held another
   * building kept gate_users.status 'active', and after a flag-off rollback
   * would have been signed in as an active member of B. The gate check applies
   * the same rule (decideLegacyHolder).
   */
  private async legacy(person: User, isSuperAdmin: boolean): Promise<ActingUser> {
    if (!isSuperAdmin && (await this.legacyMembershipInactive(person))) {
      return buildActingUser(person, {
        contextKind: 'legacy',
        role: null,
        tenantId: null,
        tenant: null,
        unit: null,
        isSuperAdmin,
      });
    }

    const tenant = person.tenantId
      ? await this.tenantRepository.findOne({ where: { id: person.tenantId } })
      : null;

    return buildActingUser(person, {
      contextKind: 'legacy',
      role: person.role,
      tenantId: person.tenantId,
      tenant,
      unit: person.unit ?? null,
      isSuperAdmin,
    });
  }

  /** Whether the person's live membership in their legacy building exists and is not active. */
  private async legacyMembershipInactive(person: User): Promise<boolean> {
    if (!person.tenantId || !isMembershipTableKnownPresent()) {
      return false;
    }
    const membership = await this.membershipsService.findLive(person.id, person.tenantId);
    return !!membership && membership.status !== UserStatus.ACTIVE;
  }

  private forMembership(person: User, membership: Membership, isSuperAdmin: boolean): ActingUser {
    return buildActingUser(person, {
      contextKind: 'membership',
      role: membership.role,
      tenantId: membership.tenantId,
      tenant: membership.tenant,
      unit: membership.unit ?? null,
      isSuperAdmin,
      activeMembership: membership,
    });
  }

  private platform(person: User): ActingUser {
    return buildActingUser(person, {
      contextKind: 'platform',
      role: UserRole.SUPER_ADMIN,
      tenantId: null,
      tenant: null,
      unit: null,
      isSuperAdmin: true,
    });
  }

  private required(
    person: User,
    isSuperAdmin: boolean,
    reason: MembershipRequiredReason,
  ): ActingUser {
    return this.none(person, isSuperAdmin, 'MEMBERSHIP_REQUIRED', reason);
  }

  private invalid(person: User, isSuperAdmin: boolean): ActingUser {
    return this.none(person, isSuperAdmin, 'MEMBERSHIP_INVALID', null);
  }

  private none(
    person: User,
    isSuperAdmin: boolean,
    problem: ContextProblem,
    reason: MembershipRequiredReason | null,
  ): ActingUser {
    return buildActingUser(person, {
      contextKind: 'none',
      role: null,
      tenantId: null,
      tenant: null,
      unit: null,
      isSuperAdmin,
      contextProblem: problem,
      contextProblemReason: reason,
    });
  }
}
