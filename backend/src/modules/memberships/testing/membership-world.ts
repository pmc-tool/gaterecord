/**
 * Test-only: an in-memory stand-in for gate_users + gate_memberships + tenants,
 * and the membership services wired to it, so gate, notification and socket
 * specs can exercise the REAL decision code (checkHolder's flag branching and
 * decide* rules, MembershipContextService.resolve) without a database.
 *
 * Only the SQL reads are replaced, and they follow the same rules as the real
 * queries:
 *   - loadLegacyHolder        the holder's own gate_users row (soft-deleted rows
 *                             are invisible), plus its legacy building's
 *                             membership status once the table is "known";
 *   - loadMembershipHolder    the person plus their live membership in a live
 *                             building;
 *   - findActivePersonIds /
 *     findTenantMembers       the shared ACTIVE definition (membership ACTIVE,
 *                             person ACTIVE and live, building live);
 *   - findOwnedWithTenant /
 *     listActiveForPerson /
 *     findLive                the context resolver's reads.
 * The real SQL is covered by the DB suites under test/db. Never imported by
 * application code.
 */
import { DataSource, Repository } from 'typeorm';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import { Tenant } from '@database/entities/tenant.entity';
import { Membership, MembershipRole, SELECTABLE_ROLES } from '@database/entities/membership.entity';
import { isUuid } from '@common/context/acting-user';
import {
  LegacyHolderRow,
  MembershipAccessService,
  MembershipHolderRow,
} from '../membership-access.service';
import { MembershipContextService } from '../membership-context.service';
import { isMembershipTableKnownPresent } from '../membership-table';
import type { MembershipsService } from '../memberships.service';
import { TOWER_D, makeTenant, scenarioP } from './overlaid-user.factory';

export class MembershipWorld {
  readonly people = new Map<string, User>();
  readonly tenants = new Map<string, Tenant>();
  memberships: Membership[] = [];

  addTenant(tenant: Tenant | string): Tenant {
    const row = typeof tenant === 'string' ? makeTenant(tenant) : tenant;
    this.tenants.set(row.id, row);
    return row;
  }

  addPerson(person: User): User {
    this.people.set(person.id, person);
    return person;
  }

  addMembership(membership: Membership): Membership {
    if (!this.tenants.has(membership.tenantId)) {
      this.addTenant(membership.tenant ?? membership.tenantId);
    }
    membership.tenant = this.tenants.get(membership.tenantId) as Tenant;
    this.memberships.push(membership);
    return membership;
  }

  /** A person as the database returns it: live rows only. */
  livePerson(personId: string): User | null {
    const person = this.people.get(personId);
    return person && !person.deletedAt ? person : null;
  }

  liveTenant(tenantId: string | null | undefined): Tenant | null {
    const tenant = tenantId ? this.tenants.get(tenantId) : undefined;
    return tenant && !tenant.deletedAt ? tenant : null;
  }

  /** The person's live membership in a live building, any status. */
  liveMembership(personId: string, tenantId: string | null): Membership | null {
    if (!tenantId || !this.liveTenant(tenantId)) {
      return null;
    }
    return (
      this.memberships.find(
        (m) => m.userId === personId && m.tenantId === tenantId && !m.deletedAt,
      ) ?? null
    );
  }

  /** The shared ACTIVE definition used by every recipient query. */
  activeMemberships(tenantId: string, roles?: readonly MembershipRole[]): Membership[] {
    return this.memberships.filter((m) => {
      const person = this.livePerson(m.userId);
      return (
        m.tenantId === tenantId &&
        !m.deletedAt &&
        m.status === UserStatus.ACTIVE &&
        (!roles || roles.includes(m.role)) &&
        !!this.liveTenant(m.tenantId) &&
        !!person &&
        person.status === UserStatus.ACTIVE
      );
    });
  }

  /** Mutates a membership's status (and nothing else, unlike the real service). */
  setMembershipStatus(membershipId: string, status: UserStatus): void {
    const membership = this.memberships.find((m) => m.id === membershipId);
    if (!membership) {
      throw new Error(`No membership ${membershipId} in this world`);
    }
    membership.status = status;
  }
}

/** MembershipAccessService whose SQL reads are answered by a MembershipWorld. */
export class InMemoryMembershipAccessService extends MembershipAccessService {
  constructor(readonly world: MembershipWorld) {
    super({} as DataSource);
  }

  protected async loadLegacyHolder(personId: string): Promise<LegacyHolderRow | null> {
    const person = this.world.livePerson(personId);
    if (!person) {
      return null;
    }
    // Like the real query: the legacy building's membership only once the
    // table is known to exist (membership-table.ts).
    const legacyMembership = isMembershipTableKnownPresent()
      ? this.world.memberships.find(
          (m) => m.userId === person.id && m.tenantId === person.tenantId && !m.deletedAt,
        )
      : undefined;
    return {
      personId: person.id,
      personStatus: person.status,
      tenantId: person.tenantId ?? null,
      role: person.role,
      unit: person.unit ?? null,
      legacyMembershipStatus: legacyMembership?.status ?? null,
    };
  }

  protected async loadMembershipHolder(
    personId: string,
    tenantId: string | null,
  ): Promise<MembershipHolderRow | null> {
    const person = this.world.livePerson(personId);
    if (!person) {
      return null;
    }
    const membership = this.world.liveMembership(personId, tenantId);
    return {
      personId: person.id,
      personStatus: person.status,
      membershipId: membership?.id ?? null,
      membershipRole: membership?.role ?? null,
      membershipStatus: membership?.status ?? null,
      membershipUnit: membership?.unit ?? null,
    };
  }

  async findActivePersonIds(tenantId: string, roles: readonly MembershipRole[]): Promise<string[]> {
    if (!isUuid(tenantId)) {
      throw new Error('MembershipAccessService: a building id (uuid) is required');
    }
    if (roles.length === 0) {
      return [];
    }
    const ids = new Set(this.world.activeMemberships(tenantId, roles).map((m) => m.userId));
    return [...ids].sort();
  }

  async findTenantMembers(
    tenantId: string,
    options: { roles?: readonly MembershipRole[]; activeOnly?: boolean } = {},
  ): Promise<Membership[]> {
    if (!isUuid(tenantId)) {
      throw new Error('MembershipAccessService: a building id (uuid) is required');
    }
    const rows = options.activeOnly
      ? this.world.activeMemberships(tenantId, options.roles)
      : this.world.memberships.filter(
          (m) =>
            m.tenantId === tenantId &&
            !m.deletedAt &&
            (!options.roles || options.roles.includes(m.role)) &&
            !!this.world.livePerson(m.userId),
        );
    return rows.map((m) =>
      Object.assign(new Membership(), m, { user: this.world.livePerson(m.userId) }),
    );
  }
}

/** The MembershipsService reads the context resolver uses, over a world. */
export function inMemoryMembershipsService(world: MembershipWorld): MembershipsService {
  const withTenant = (m: Membership): Membership | null => {
    const tenant = world.liveTenant(m.tenantId);
    return !m.deletedAt && tenant ? Object.assign(new Membership(), m, { tenant }) : null;
  };

  return {
    findOwnedWithTenant: async (membershipId: string, personId: string) => {
      if (!isUuid(membershipId) || !isUuid(personId)) return null;
      const row = world.memberships.find((m) => m.id === membershipId && m.userId === personId);
      return row ? withTenant(row) : null;
    },
    listActiveForPerson: async (personId: string) =>
      world.memberships
        .filter(
          (m) =>
            m.userId === personId &&
            m.status === UserStatus.ACTIVE &&
            SELECTABLE_ROLES.includes(m.role),
        )
        .map(withTenant)
        .filter((m): m is Membership => m !== null)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    findLive: async (personId: string, tenantId: string) => {
      if (!isUuid(personId) || !isUuid(tenantId)) return null;
      return (
        world.memberships.find(
          (m) => m.userId === personId && m.tenantId === tenantId && !m.deletedAt,
        ) ?? null
      );
    },
  } as unknown as MembershipsService;
}

/** The real MembershipContextService, reading a world. */
export function inMemoryContextService(world: MembershipWorld): MembershipContextService {
  const tenantRepository = {
    findOne: async ({ where }: { where: { id: string } }) => world.liveTenant(where.id),
  } as unknown as Repository<Tenant>;
  return new MembershipContextService(inMemoryMembershipsService(world), tenantRepository);
}

/**
 * The standard scenario (see overlaid-user.factory.ts) loaded into a world:
 * P with memberships in A, B and C; Tower D exists with no role for P.
 */
export function worldWithScenarioP(personOverrides: Partial<User> = {}) {
  const scenario = scenarioP(personOverrides);
  const world = new MembershipWorld();
  world.addPerson(scenario.person);
  for (const membership of Object.values(scenario.memberships)) {
    world.addMembership(membership);
  }
  world.addTenant(makeTenant(TOWER_D));
  return { world, ...scenario };
}

/** Convenience for specs: a live person row in the world. */
export function addPlainPerson(
  world: MembershipWorld,
  id: string,
  overrides: Partial<User> = {},
): User {
  return world.addPerson(
    Object.assign(new User(), {
      id,
      email: `${id.slice(0, 8)}@example.test`,
      firstName: 'Some',
      lastName: 'One',
      role: UserRole.RESIDENT,
      status: UserStatus.ACTIVE,
      tenantId: null,
      unit: null,
      ...overrides,
    }),
  );
}
