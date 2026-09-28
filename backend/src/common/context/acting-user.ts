/**
 * The acting principal: who the request acts AS.
 *
 * One person (one gate_users row, one Keycloak identity) can hold roles in many
 * buildings, one role per building. Every authenticated request acts as ONE of
 * those memberships, chosen by the X-Gate-Membership header, and req.user is an
 * ActingUser: a clone of the person with the chosen membership's role, tenantId,
 * tenant and unit overlaid on top (contract C5). Services keep reading
 * req.user.role / req.user.tenantId exactly as before, and scope with
 * assertBuildingContext() rather than with truthy tenantId checks.
 *
 * The person entity itself is never mutated. The clone carries the enumerable
 * ACTING_USER_MARK so that ActingUserWriteGuardSubscriber can refuse to persist
 * it (or a spread copy of it) back into gate_users, which would write the
 * chosen building into the legacy columns or demote a super admin.
 *
 * Nothing here reads the database; MembershipContextService builds the value.
 */
import type { User } from '@database/entities/user.entity';
import type { Membership } from '@database/entities/membership.entity';

/** Request header naming the membership to act as (contract C3). Lower case, as Node exposes it. */
export const GATE_MEMBERSHIP_HEADER = 'x-gate-membership';

/** Header value selecting the Platform context. Only a super admin may send it. */
export const PLATFORM_CONTEXT_ID = 'platform';

/**
 * Marks an overlaid principal. Symbol.for so the same symbol is shared across
 * module copies (jest, ts-node), and set as an ENUMERABLE own property so that
 * `{ ...req.user }` and Object.assign copies still carry it.
 */
export const ACTING_USER_MARK: unique symbol = Symbol.for('gaterecord.actingUser');

/**
 * Per-request memo key: set on the request once JwtAuthGuard has authenticated
 * it and resolved the context, so the controller-level @UseGuards(JwtAuthGuard)
 * re-runs return early instead of authenticating (and resolving) a second time.
 */
export const GATE_AUTHENTICATED: unique symbol = Symbol.for('gaterecord.gateAuthenticated');

/**
 * How req.user was built:
 *   membership  acting as one membership (role/tenant/unit from it);
 *   platform    a super admin acting platform-wide (role super_admin, no tenant);
 *   none        no usable context (role and tenant null); the guard answers 409
 *               or 403 on routes that are not @ContextOptional;
 *   legacy      GATE_MEMBERSHIP_CONTEXT is off: the values come from the
 *               gate_users row exactly as before the feature.
 */
export type ContextKind = 'membership' | 'platform' | 'none' | 'legacy';

export type ContextProblem = 'MEMBERSHIP_REQUIRED' | 'MEMBERSHIP_INVALID';

/** reason carried by 409 MEMBERSHIP_REQUIRED. */
export type MembershipRequiredReason = 'NO_MEMBERSHIPS' | 'AMBIGUOUS';

export interface ActingContext {
  contextKind: ContextKind;
  contextProblem: ContextProblem | null;
  contextProblemReason: MembershipRequiredReason | null;
  /** From the person's own gate_users.role, computed before the overlay. */
  isSuperAdmin: boolean;
  /**
   * The membership being acted as (non-enumerable, so it is not serialised and
   * not copied by spreads); null outside the 'membership' context.
   * activeMembership.userId === req.user.id (gate_users.id).
   */
  readonly activeMembership: Membership | null;
  [ACTING_USER_MARK]: true;
}

/**
 * req.user after context resolution. Typed as a User so existing signatures keep
 * accepting it; note that in the 'none' context role and tenantId are null at
 * runtime (only reachable on @ContextOptional routes).
 */
export type ActingUser = User & ActingContext;

/** What the header can arrive as: Node gives string | string[] | undefined. */
export type RawMembershipHeader = string | string[] | undefined;

export type ParsedMembershipHeader =
  | { kind: 'absent' }
  | { kind: 'platform' }
  | { kind: 'membership'; membershipId: string }
  | { kind: 'malformed' };

/** Canonical 8-4-4-4-12 hex uuid, any version. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** The raw X-Gate-Membership value of an HTTP request (or socket handshake headers). */
export function readMembershipHeader(
  req: { headers?: Record<string, string | string[] | undefined> } | null | undefined,
): RawMembershipHeader {
  return req?.headers?.[GATE_MEMBERSHIP_HEADER];
}

/**
 * Classifies a header (or socket auth.membershipId) value without touching the
 * database. Only a well-formed uuid is ever passed on to a query:
 *   - missing, null or blank            -> absent (auto-select / platform);
 *   - 'platform' (any case)              -> platform;
 *   - a uuid                             -> membership (lower-cased);
 *   - an array, any other type or text   -> malformed (403 MEMBERSHIP_INVALID).
 */
export function parseMembershipHeader(raw: unknown): ParsedMembershipHeader {
  if (raw === undefined || raw === null) {
    return { kind: 'absent' };
  }

  if (typeof raw !== 'string') {
    return { kind: 'malformed' };
  }

  const value = raw.trim();
  if (value === '') {
    return { kind: 'absent' };
  }

  if (value.toLowerCase() === PLATFORM_CONTEXT_ID) {
    return { kind: 'platform' };
  }

  if (isUuid(value)) {
    return { kind: 'membership', membershipId: value.toLowerCase() };
  }

  return { kind: 'malformed' };
}

export function isActingUser(value: unknown): value is ActingUser {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Partial<ActingContext>)[ACTING_USER_MARK] === true
  );
}

/**
 * The context kind of any principal. A plain gate_users row (no overlay yet, for
 * example while the strategies still return the entity) is the legacy shape.
 */
export function contextKindOf(user: { contextKind?: ContextKind } | null | undefined): ContextKind {
  return user?.contextKind ?? 'legacy';
}
