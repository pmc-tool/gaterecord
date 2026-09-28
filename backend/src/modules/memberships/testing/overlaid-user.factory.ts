/**
 * Test-only: builds overlaid principals (contract C5) the way the passport
 * strategies do, so operator-module specs can call services with a realistic
 * req.user for "person P acting in building A / B / C / the platform".
 *
 * Every principal goes through the real buildActingUser(), so it carries the
 * enumerable ACTING_USER_MARK, the non-enumerable activeMembership and no
 * passwordHash, exactly like production. Never imported by application code.
 *
 * The standard scenario, used across the GATE specs:
 *
 *   P is a super admin (gate_users.role) who also holds three building roles:
 *     Tower A  building_admin
 *     Tower B  resident, unit 12B
 *     Tower C  security
 *   Tower D is a building P has nothing to do with.
 *
 * P's legacy gate_users columns mirror the primary membership (A), as
 * MembershipsService.syncLegacyColumns would write them, except role, which
 * stays super_admin (a super admin's role is never mirrored).
 */
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import { Tenant, TenantStatus } from '@database/entities/tenant.entity';
import { Membership, MembershipRole } from '@database/entities/membership.entity';
import type {
  ActingUser,
  ContextProblem,
  MembershipRequiredReason,
} from '@common/context/acting-user';
import { buildActingUser } from '../membership-context.service';

export const TOWER_A = 'a0a0a0a0-0000-4000-8000-00000000000a';
export const TOWER_B = 'b0b0b0b0-0000-4000-8000-00000000000b';
export const TOWER_C = 'c0c0c0c0-0000-4000-8000-00000000000c';
export const TOWER_D = 'd0d0d0d0-0000-4000-8000-00000000000d';

export const PERSON_P = 'f0f0f0f0-0000-4000-8000-0000000000f0';

export const MEMBERSHIP_PA = 'a1a1a1a1-0000-4000-8000-0000000000a1';
export const MEMBERSHIP_PB = 'b1b1b1b1-0000-4000-8000-0000000000b1';
export const MEMBERSHIP_PC = 'c1c1c1c1-0000-4000-8000-0000000000c1';

export function makeTenant(id: string, overrides: Partial<Tenant> = {}): Tenant {
  return Object.assign(new Tenant(), {
    id,
    name: `Tower ${id.slice(0, 1).toUpperCase()}`,
    slug: `tower-${id.slice(0, 4)}`,
    status: TenantStatus.ACTIVE,
    isPaused: false,
    ...overrides,
  });
}

export function makePerson(overrides: Partial<User> = {}): User {
  return Object.assign(new User(), {
    id: PERSON_P,
    email: 'p@example.test',
    firstName: 'Pat',
    lastName: 'Person',
    role: UserRole.SUPER_ADMIN,
    status: UserStatus.ACTIVE,
    tenantId: TOWER_A,
    unit: null,
    qrCode: 'GR-PERSON-P',
    ...overrides,
  });
}

export function makeMembership(
  id: string,
  userId: string,
  tenantId: string,
  role: MembershipRole,
  overrides: Partial<Membership> = {},
): Membership {
  return Object.assign(new Membership(), {
    id,
    userId,
    tenantId,
    tenant: makeTenant(tenantId),
    role,
    status: UserStatus.ACTIVE,
    unit: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    deletedAt: null,
    ...overrides,
  });
}

/** The context an overlaid principal is built for. */
export type OverlayContext =
  | { kind: 'membership'; membership: Membership }
  | { kind: 'platform' }
  | { kind: 'legacy' }
  | { kind: 'none'; problem: ContextProblem; reason?: MembershipRequiredReason | null };

/**
 * req.user for `person` acting in `context`, built with the production
 * buildActingUser (C5 overlay rules):
 *   membership  role / tenantId / tenant / unit from the membership;
 *   platform    super_admin, no tenant (only meaningful for a super admin);
 *   legacy      the gate_users row as it is (GATE_MEMBERSHIP_CONTEXT off);
 *   none        role and tenant null, with the context problem recorded.
 */
export function overlaidUser(person: User, context: OverlayContext): ActingUser {
  const isSuperAdmin = person.role === UserRole.SUPER_ADMIN;

  switch (context.kind) {
    case 'membership':
      return buildActingUser(person, {
        contextKind: 'membership',
        role: context.membership.role,
        tenantId: context.membership.tenantId,
        tenant: context.membership.tenant ?? makeTenant(context.membership.tenantId),
        unit: context.membership.unit ?? null,
        isSuperAdmin,
        activeMembership: context.membership,
      });

    case 'platform':
      return buildActingUser(person, {
        contextKind: 'platform',
        role: UserRole.SUPER_ADMIN,
        tenantId: null,
        tenant: null,
        unit: null,
        isSuperAdmin,
      });

    case 'legacy':
      return buildActingUser(person, {
        contextKind: 'legacy',
        role: person.role,
        tenantId: person.tenantId ?? null,
        tenant: person.tenantId ? makeTenant(person.tenantId) : null,
        unit: person.unit ?? null,
        isSuperAdmin,
      });

    case 'none':
      return buildActingUser(person, {
        contextKind: 'none',
        role: null,
        tenantId: null,
        tenant: null,
        unit: null,
        isSuperAdmin,
        contextProblem: context.problem,
        contextProblemReason: context.reason ?? null,
      });
  }
}

/** Person P, the three memberships and P's principal in every context. */
export interface ScenarioP {
  person: User;
  memberships: { A: Membership; B: Membership; C: Membership };
  as: {
    /** Building admin of Tower A. */
    A: ActingUser;
    /** Resident of Tower B, unit 12B. */
    B: ActingUser;
    /** Security of Tower C. */
    C: ActingUser;
    /** Platform context (P is a super admin). */
    platform: ActingUser;
  };
}

export function scenarioP(personOverrides: Partial<User> = {}): ScenarioP {
  const person = makePerson(personOverrides);
  const memberships = {
    A: makeMembership(MEMBERSHIP_PA, person.id, TOWER_A, UserRole.BUILDING_ADMIN, {
      createdAt: new Date('2026-01-01T00:00:00Z'),
    }),
    B: makeMembership(MEMBERSHIP_PB, person.id, TOWER_B, UserRole.RESIDENT, {
      unit: '12B',
      createdAt: new Date('2026-02-01T00:00:00Z'),
    }),
    C: makeMembership(MEMBERSHIP_PC, person.id, TOWER_C, UserRole.SECURITY, {
      createdAt: new Date('2026-03-01T00:00:00Z'),
    }),
  };

  return {
    person,
    memberships,
    as: {
      A: overlaidUser(person, { kind: 'membership', membership: memberships.A }),
      B: overlaidUser(person, { kind: 'membership', membership: memberships.B }),
      C: overlaidUser(person, { kind: 'membership', membership: memberships.C }),
      platform: overlaidUser(person, { kind: 'platform' }),
    },
  };
}
