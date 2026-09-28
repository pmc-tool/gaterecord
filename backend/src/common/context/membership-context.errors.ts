/**
 * The membership error bodies the web recognises, in one place.
 *
 * Same style as SUBSCRIPTION_INACTIVE (common/guards/subscription.guard.ts): a
 * stable machine-readable `code` at the TOP level of the JSON body, next to the
 * human `message`, plus any extra fields the contract names (`reason`, `role`).
 * The web branches on (HTTP status, code) only, so a code must never be reused
 * with a different status.
 *
 * Each factory RETURNS the exception; callers `throw` it. MEMBERSHIP_REQUIRED
 * is always a 409 and is raised only through membershipRequired().
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { MembershipRequiredReason } from './acting-user';

export const MembershipErrorCode = {
  MEMBERSHIP_REQUIRED: 'MEMBERSHIP_REQUIRED',
  MEMBERSHIP_INVALID: 'MEMBERSHIP_INVALID',
  ROLE_NOT_ALLOWED_IN_BUILDING: 'ROLE_NOT_ALLOWED_IN_BUILDING',
  MEMBERSHIP_EXISTS: 'MEMBERSHIP_EXISTS',
  MULTI_MEMBERSHIP_DISABLED: 'MULTI_MEMBERSHIP_DISABLED',
  PERSON_FIELDS_READ_ONLY: 'PERSON_FIELDS_READ_ONLY',
  LAST_BUILDING_ADMIN: 'LAST_BUILDING_ADMIN',
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  JOIN_REQUEST_PENDING: 'JOIN_REQUEST_PENDING',
  TENANT_REQUIRED: 'TENANT_REQUIRED',
  EMAIL_HAS_ACCOUNT: 'EMAIL_HAS_ACCOUNT',
} as const;

export type MembershipErrorCode = (typeof MembershipErrorCode)[keyof typeof MembershipErrorCode];

/** The JSON body every factory below produces. */
export interface MembershipErrorBody {
  statusCode: number;
  code: MembershipErrorCode;
  message: string;
  [extra: string]: unknown;
}

function body(
  status: HttpStatus,
  code: MembershipErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
): MembershipErrorBody {
  return { statusCode: status, code, message, ...extra };
}

const REQUIRED_MESSAGES: Record<MembershipRequiredReason, string> = {
  NO_MEMBERSHIPS: 'You do not have access to a building yet.',
  AMBIGUOUS: 'Choose a building and role to continue.',
};

/** 409: the request needs a building context and none was chosen (or none exists). */
export function membershipRequired(reason: MembershipRequiredReason): ConflictException {
  return new ConflictException(
    body(HttpStatus.CONFLICT, MembershipErrorCode.MEMBERSHIP_REQUIRED, REQUIRED_MESSAGES[reason], {
      reason,
    }),
  );
}

/**
 * 403: the chosen membership is not usable (foreign, removed, inactive, pending,
 * malformed id, deleted building). Deliberately carries no reason, so a caller
 * cannot probe other people's membership ids.
 */
export function membershipInvalid(): ForbiddenException {
  return new ForbiddenException(
    body(
      HttpStatus.FORBIDDEN,
      MembershipErrorCode.MEMBERSHIP_INVALID,
      'The selected building access is no longer valid. Please choose again.',
    ),
  );
}

/** 403: a valid context, but the role held in this building may not do this. */
export function roleNotAllowed(): ForbiddenException {
  return new ForbiddenException(
    body(
      HttpStatus.FORBIDDEN,
      MembershipErrorCode.ROLE_NOT_ALLOWED_IN_BUILDING,
      'Your role in this building does not allow this action.',
    ),
  );
}

/**
 * 409: the person already holds a role in this building (one role per building).
 * `role` is the role they hold, or null when it could not be read.
 */
export function membershipExists(role: string | null): ConflictException {
  return new ConflictException(
    body(
      HttpStatus.CONFLICT,
      MembershipErrorCode.MEMBERSHIP_EXISTS,
      'This person already has a role in this building.',
      { role },
    ),
  );
}

/** 409: a second building for one person while GATE_MEMBERSHIP_CONTEXT is off. */
export function multiMembershipDisabled(): ConflictException {
  return new ConflictException(
    body(
      HttpStatus.CONFLICT,
      MembershipErrorCode.MULTI_MEMBERSHIP_DISABLED,
      'This person already belongs to another building. Holding roles in several buildings is not enabled yet.',
    ),
  );
}

/** 403: name, phone and similar belong to the person, not to one building's admin. */
export function personFieldsReadOnly(): ForbiddenException {
  return new ForbiddenException(
    body(
      HttpStatus.FORBIDDEN,
      MembershipErrorCode.PERSON_FIELDS_READ_ONLY,
      "A person's name and contact details can only be changed by that person.",
    ),
  );
}

/** 409: removing or demoting would leave the building without an admin. */
export function lastBuildingAdmin(): ConflictException {
  return new ConflictException(
    body(
      HttpStatus.CONFLICT,
      MembershipErrorCode.LAST_BUILDING_ADMIN,
      'A building must keep at least one building admin.',
    ),
  );
}

/** 403: the person is suspended platform-wide (gate_users.status is not active). */
export function accountSuspended(): ForbiddenException {
  return new ForbiddenException(
    body(HttpStatus.FORBIDDEN, MembershipErrorCode.ACCOUNT_SUSPENDED, 'This account is suspended.'),
  );
}

/** 409: a request to join this building is already waiting for approval. */
export function joinRequestPending(): ConflictException {
  return new ConflictException(
    body(
      HttpStatus.CONFLICT,
      MembershipErrorCode.JOIN_REQUEST_PENDING,
      'A request to join this building is already pending.',
    ),
  );
}

/** 400: a super admin acted on a person with several buildings without naming one. */
export function tenantRequired(): BadRequestException {
  return new BadRequestException(
    body(
      HttpStatus.BAD_REQUEST,
      MembershipErrorCode.TENANT_REQUIRED,
      'This person belongs to several buildings. Pass tenantId to choose one.',
    ),
  );
}

/** 409: signup with an email that already has an account. */
export function emailHasAccount(): ConflictException {
  return new ConflictException(
    body(
      HttpStatus.CONFLICT,
      MembershipErrorCode.EMAIL_HAS_ACCOUNT,
      'An account with this email already exists. Sign in and add a building from Get Started.',
    ),
  );
}

/** The code of a membership error body, or null for anything else. */
export function membershipErrorCodeOf(error: unknown): MembershipErrorCode | null {
  if (!(error instanceof HttpException)) {
    return null;
  }

  const response = error.getResponse();
  if (typeof response !== 'object' || response === null) {
    return null;
  }

  const code = (response as { code?: unknown }).code;
  return (Object.values(MembershipErrorCode) as unknown[]).includes(code)
    ? (code as MembershipErrorCode)
    : null;
}
