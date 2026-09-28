/**
 * The one way services find "the building this request acts in".
 *
 * Every tenant-scoped service calls assertBuildingContext(user, roles?) instead
 * of reading `user.tenantId` and testing it for truthiness. A falsy tenant must
 * never mean "unscoped": TypeORM silently drops a where-condition whose value is
 * null or undefined, so a tenantless caller would otherwise read or write every
 * building's rows.
 *
 * It reads only the overlay fields (tenantId, role, contextKind), never
 * activeMembership, so the same call works whether GATE_MEMBERSHIP_CONTEXT is on
 * (membership context) or off (legacy: the gate_users row). A principal without
 * a contextKind is a plain gate_users row and is treated as legacy.
 */
import { UserRole } from '@database/entities/user.entity';
import { ContextKind, MembershipRequiredReason, contextKindOf } from './acting-user';
import { membershipInvalid, membershipRequired, roleNotAllowed } from './membership-context.errors';

/** The fields these helpers read. Satisfied by User, ActingUser and test doubles. */
export interface BuildingContextSubject {
  tenantId?: string | null;
  role?: UserRole | string | null;
  contextKind?: ContextKind;
  contextProblemReason?: MembershipRequiredReason | null;
}

/**
 * Returns the tenant id the request acts in, or throws:
 *   - 409 MEMBERSHIP_REQUIRED when there is no building context (the 'none' and
 *     'platform' contexts, or a legacy row without a tenant). The web reacts by
 *     opening the role/building picker.
 *   - 403 MEMBERSHIP_INVALID for a 'membership' context without a tenant, which
 *     can only be a resolver bug; never MEMBERSHIP_REQUIRED for a caller that did
 *     choose a membership.
 *   - 403 ROLE_NOT_ALLOWED_IN_BUILDING when `roles` is given and the role held in
 *     this building is not one of them.
 *
 * Callers that also serve the Platform context (a super admin passing
 * ?tenantId=) branch on isPlatformContext(user) BEFORE calling this.
 */
export function assertBuildingContext(
  user: BuildingContextSubject | null | undefined,
  roles?: readonly UserRole[],
): string {
  const kind = contextKindOf(user);
  const tenantId = user?.tenantId;

  if (kind === 'membership' && !tenantId) {
    throw membershipInvalid();
  }

  if (!user || (kind !== 'membership' && kind !== 'legacy') || !tenantId) {
    throw membershipRequired(requiredReasonFor(user, kind));
  }

  if (roles && !roles.includes(user.role as UserRole)) {
    throw roleNotAllowed();
  }

  return tenantId;
}

/**
 * True when the request acts platform-wide as a super admin: the explicit
 * Platform context, or a legacy-mode super_admin row. A super admin acting
 * inside one of their buildings is NOT in the platform context.
 */
export function isPlatformContext(user: BuildingContextSubject | null | undefined): boolean {
  if (!user || user.role !== UserRole.SUPER_ADMIN) {
    return false;
  }

  const kind = contextKindOf(user);
  return kind === 'platform' || kind === 'legacy';
}

function requiredReasonFor(
  user: BuildingContextSubject | null | undefined,
  kind: ContextKind,
): MembershipRequiredReason {
  if (user?.contextProblemReason) {
    return user.contextProblemReason;
  }

  // A super admin in the platform context does have buildings to choose from
  // (or can pick one in the admin app); what is missing is the choice.
  return isPlatformContext(user) || kind === 'platform' ? 'AMBIGUOUS' : 'NO_MEMBERSHIPS';
}
