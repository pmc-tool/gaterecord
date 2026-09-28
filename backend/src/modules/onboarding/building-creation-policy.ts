/**
 * Who may create a building from Get Started (POST /onboarding/building), now
 * that one person can hold roles in several buildings.
 *
 * Before memberships, onboarding was once-only: anyone whose gate_users row had
 * a tenant was refused. Now a resident of Tower B, or the admin of Tower A, may
 * create Tower E and becomes its building admin. Two operator settings bound it:
 *
 *   ONBOARDING_MULTI_BUILDING_POLICY   who may create an ADDITIONAL building
 *     'open'  (default) anyone signed in;
 *     'plan'  only an ACTIVE building admin of a building whose plan has the
 *             multi_building feature (the flag the pricing pages advertise);
 *     'off'   nobody: only a person with no membership at all may create one,
 *             the pre-membership once-only rule.
 *     Any other value fails CLOSED to 'off' (and is logged): a typo in a setting
 *     meant to restrict must never open it up.
 *
 *   MAX_BUILDINGS_CREATED_PER_PERSON   how many live buildings one person may
 *     have created this way (tenants.settings.createdByUserId), default 5. A
 *     negative value means no limit; 0 means none at all. Buildings a super
 *     admin created for them, or paid signups, do not count: they did not come
 *     through this route.
 *
 * The first building (zero memberships) is always allowed by the policy, so the
 * zero-membership Get Started flow (D8) never depends on it; only the cap
 * applies to it.
 *
 * While GATE_MEMBERSHIP_CONTEXT is off a person with any building is refused
 * before the policy is consulted (409 MULTI_MEMBERSHIP_DISABLED), exactly as
 * MembershipsService.add() would refuse the second membership.
 *
 * Pure functions: the service gathers the facts and turns a refusal into an
 * HTTP error, so the rules are unit-tested without a database.
 */
import { ForbiddenException, HttpStatus } from '@nestjs/common';

export const ONBOARDING_MULTI_BUILDING_POLICY_ENV = 'ONBOARDING_MULTI_BUILDING_POLICY';
export const MAX_BUILDINGS_CREATED_PER_PERSON_ENV = 'MAX_BUILDINGS_CREATED_PER_PERSON';
export const DEFAULT_MAX_BUILDINGS_CREATED_PER_PERSON = 5;

export type BuildingCreationPolicy = 'open' | 'plan' | 'off';

export const BUILDING_CREATION_POLICIES: readonly BuildingCreationPolicy[] = [
  'open',
  'plan',
  'off',
];

export interface ParsedBuildingCreationPolicy {
  policy: BuildingCreationPolicy;
  /** The raw value when it was not recognised (and 'off' was used instead). */
  unrecognised: string | null;
}

/** Unset or blank is 'open'; an unrecognised value is 'off' (fail closed). */
export function parseBuildingCreationPolicy(raw: unknown): ParsedBuildingCreationPolicy {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!value) {
    return { policy: 'open', unrecognised: null };
  }
  if ((BUILDING_CREATION_POLICIES as readonly string[]).includes(value)) {
    return { policy: value as BuildingCreationPolicy, unrecognised: null };
  }
  return { policy: 'off', unrecognised: String(raw) };
}

/**
 * The cap, or null for "no limit". Unset, blank or not a whole number gives the
 * default; a negative number is unlimited.
 */
export function parseMaxBuildingsCreated(raw: unknown): number | null {
  const value = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!/^-?\d+$/.test(value)) {
    return DEFAULT_MAX_BUILDINGS_CREATED_PER_PERSON;
  }
  const max = Number(value);
  return max < 0 ? null : max;
}

/** What the decision needs to know about the person. */
export interface BuildingCreationFacts {
  policy: BuildingCreationPolicy;
  /** null = no limit. */
  maxCreated: number | null;
  /** The person's live memberships, any role and status. */
  liveMemberships: number;
  /** Live buildings this person created through onboarding. */
  createdSoFar: number;
  /** An ACTIVE building_admin membership in a building on a multi_building plan. Read for 'plan' only. */
  adminOfMultiBuildingPlan: boolean;
}

export type BuildingCreationRefusal = 'LIMIT_REACHED' | 'POLICY_OFF' | 'PLAN_REQUIRED';

/** null when the person may create the building, otherwise why not. */
export function decideBuildingCreation(
  facts: BuildingCreationFacts,
): BuildingCreationRefusal | null {
  if (facts.maxCreated !== null && facts.createdSoFar >= facts.maxCreated) {
    return 'LIMIT_REACHED';
  }
  if (facts.liveMemberships === 0) {
    return null;
  }
  if (facts.policy === 'off') {
    return 'POLICY_OFF';
  }
  if (facts.policy === 'plan' && !facts.adminOfMultiBuildingPlan) {
    return 'PLAN_REQUIRED';
  }
  return null;
}

/** Codes of the refusals, at the top level of the body like every membership error. */
export const BuildingCreationErrorCode = {
  BUILDING_LIMIT_REACHED: 'BUILDING_LIMIT_REACHED',
  BUILDING_CREATION_NOT_ALLOWED: 'BUILDING_CREATION_NOT_ALLOWED',
} as const;

/** The 403 for a refusal. */
export function buildingCreationRefused(
  refusal: BuildingCreationRefusal,
  maxCreated: number | null,
): ForbiddenException {
  const status = HttpStatus.FORBIDDEN;
  switch (refusal) {
    case 'LIMIT_REACHED':
      return new ForbiddenException({
        statusCode: status,
        code: BuildingCreationErrorCode.BUILDING_LIMIT_REACHED,
        message:
          `You can create at most ${maxCreated ?? 0} building${maxCreated === 1 ? '' : 's'}. ` +
          'Contact support to add more.',
      });
    case 'PLAN_REQUIRED':
      return new ForbiddenException({
        statusCode: status,
        code: BuildingCreationErrorCode.BUILDING_CREATION_NOT_ALLOWED,
        message:
          'Adding another building needs a plan with multi-building support on a building you administer.',
      });
    case 'POLICY_OFF':
    default:
      return new ForbiddenException({
        statusCode: status,
        code: BuildingCreationErrorCode.BUILDING_CREATION_NOT_ALLOWED,
        message: 'Creating another building is not available. Contact support.',
      });
  }
}
