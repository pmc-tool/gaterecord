/**
 * What the people endpoints return, built field by field.
 *
 * Returning User entities as they are sent everything the row holds: the
 * Keycloak sub (userId), notification settings, the personal QR token, and (for
 * an entity built in memory) the password hash. Under memberships a building's
 * admin lists people who also belong to OTHER buildings, so each of those is a
 * cross-building leak: the QR token opens gates wherever the person is active.
 * These projections pick an explicit allow-list instead, so a column added to
 * gate_users later is private until someone decides otherwise.
 *
 * Never included: passwordHash, userId (the sub), notificationSettings, qrCode.
 * The person's own profile (PPL-9) adds qrCode on top of toPersonView.
 */
import { Membership } from '@database/entities/membership.entity';
import { Tenant } from '@database/entities/tenant.entity';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';

/** The building a row belongs to, as the Users page names it. */
export interface MembershipRowTenant {
  id: string;
  name: string;
  slug: string;
}

/**
 * One person in one building: the UserResponseDto shape, one row per
 * membership (a person in two buildings a super admin lists appears twice).
 *
 * id is the PERSON (gate_users.id), so PATCH/DELETE /users/:id and
 * /residents/:id keep taking the id the web already has; membershipId is the
 * row's own identity. role, status, unit and tenantId are the membership's.
 */
export interface MembershipRow {
  id: string;
  membershipId: string | null;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  role: UserRole;
  status: UserStatus;
  tenantId: string | null;
  tenant: MembershipRowTenant | null;
  unit: string | null;
  profileImageUrl: string | null;
  /** The person's timestamps, so a single-building person's row is what it was. */
  createdAt: Date;
  updatedAt: Date;
}

/** The person alone, with nothing that belongs to a building. */
export interface PersonView {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  profileImageUrl: string | null;
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function tenantView(tenant: Tenant | null | undefined): MembershipRowTenant | null {
  return tenant ? { id: tenant.id, name: tenant.name, slug: tenant.slug } : null;
}

/** The person-level fields every projection shares. */
function personFields(person: User) {
  return {
    id: person.id,
    email: person.email,
    firstName: person.firstName,
    lastName: person.lastName,
    phone: person.phone ?? null,
    profileImageUrl: person.profileImageUrl ?? null,
  };
}

/** The person alone (profile, "who is this" lookups). */
export function toPersonView(person: User): PersonView {
  return {
    ...personFields(person),
    mustChangePassword: person.mustChangePassword === true,
    lastLoginAt: person.lastLoginAt ?? null,
    createdAt: person.createdAt,
    updatedAt: person.updatedAt,
  };
}

/**
 * One membership as a people-list row. The person comes from
 * `membership.user` unless passed; `tenant` is filled when `membership.tenant`
 * is loaded, and null otherwise.
 *
 * Throws when neither the relation nor the argument supplies the person: a row
 * without one would silently list a nameless user.
 */
export function toMembershipRow(
  membership: Membership,
  person: User = membership.user,
): MembershipRow {
  if (!person) {
    throw new Error(`toMembershipRow: membership ${membership.id} has no person loaded`);
  }

  return {
    ...personFields(person),
    membershipId: membership.id,
    role: membership.role,
    status: membership.status,
    tenantId: membership.tenantId,
    tenant: tenantView(membership.tenant),
    unit: membership.unit ?? null,
    createdAt: person.createdAt,
    updatedAt: person.updatedAt,
  };
}

/**
 * A person listed WITHOUT a membership: the super admins a platform listing
 * shows next to building members. Role and status are the person's own
 * (super_admin, and the platform ban); there is no building, unit or
 * membershipId.
 */
export function toPlatformPersonRow(person: User): MembershipRow {
  return {
    ...personFields(person),
    membershipId: null,
    role: person.role,
    status: person.status,
    tenantId: null,
    tenant: null,
    unit: null,
    createdAt: person.createdAt,
    updatedAt: person.updatedAt,
  };
}
