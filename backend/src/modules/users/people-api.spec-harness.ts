/**
 * Test-only harness for the people API specs (users, residents, join
 * requests, identity provisioning). Never imported by application code.
 *
 * It builds on people.spec-harness.ts (B0): the in-memory FakePeopleManager
 * with the REAL MembershipsService and MembershipLifecycleService on top, so
 * the specs exercise the real membership rules (one role per building, the
 * flag-off refusal, the legacy mirror, the status dual-write, seat counting)
 * together with the service under test. What this file adds:
 *
 *   - repositoryOver(): a TypeORM-Repository-shaped adapter over one table of
 *     the fake manager (find / findOne / update / save ..., with the 'tenant'
 *     and 'user' relations loaded the way TypeORM loads them: soft-deleted
 *     rows are not loaded);
 *   - membershipQueryRepository(): the membership list queries the people
 *     services build (live membership, inner-joined live person and live
 *     building, filtered by the bound tenantId / personId / role / status /
 *     search parameters, newest person first, skip/take);
 *   - platformAdminQuery(): the "super admins" listing of GET /users;
 *   - stubMembershipReads(): MembershipsService.listForPerson, whose query
 *     builder the fake manager does not implement.
 *
 * The real SQL is covered by the DB suites under test/db.
 */
import { DataSource, EntityManager } from 'typeorm';
import { Membership } from '@database/entities/membership.entity';
import { Tenant } from '@database/entities/tenant.entity';
import { User, UserRole } from '@database/entities/user.entity';
import { ActingUser, MembershipRequiredReason } from '@common/context/acting-user';
import { buildActingUser } from '../memberships/membership-context.service';
import { MembershipsService } from '../memberships/memberships.service';
import { FakePeopleManager, Row } from '../people/people.spec-harness';

type Target = new () => object;

interface FindOptionsLike {
  where?: Record<string, unknown>;
  relations?: string[];
  order?: Record<string, 'ASC' | 'DESC'>;
  take?: number;
  withDeleted?: boolean;
}

/** A DataSource over the fake manager: transactions run the work on it directly. */
export function dataSourceOver(m: FakePeopleManager): DataSource {
  return {
    manager: m,
    transaction: <T>(work: (em: EntityManager) => Promise<T>) => m.transaction(work),
  } as unknown as DataSource;
}

/**
 * The fake manager only knows save(entity). Services also call the
 * save(Target, entity) form; this accepts both.
 */
export function acceptTargetedSave(m: FakePeopleManager): FakePeopleManager {
  const save = m.save.bind(m);
  (m as unknown as { save: (a: unknown, b?: unknown) => Promise<unknown> }).save = (a, b) =>
    save((b ?? a) as { id?: string });
  return m;
}

function liveRow(m: FakePeopleManager, target: Target, id: unknown): Row | undefined {
  const row = typeof id === 'string' ? m.row(target, id) : undefined;
  return row && row.deletedAt == null ? row : undefined;
}

function entityOf<T extends object>(target: new () => T, row: Row): T {
  const entity = Object.assign(new target(), row) as Record<string, unknown>;
  if ((target as Target) === User) delete entity.passwordHash;
  return entity as T;
}

/** Loads 'tenant' and 'user' onto an entity; soft-deleted rows load as null, like TypeORM. */
function loadRelations(
  m: FakePeopleManager,
  entity: Record<string, unknown>,
  relations?: string[],
) {
  for (const relation of relations ?? []) {
    if (relation === 'tenant') {
      const row = liveRow(m, Tenant, entity.tenantId);
      entity.tenant = row ? entityOf(Tenant, row) : null;
    } else if (relation === 'user') {
      const row = liveRow(m, User, entity.userId);
      entity.user = row ? entityOf(User, row) : null;
    }
  }
  return entity;
}

/** A Repository-shaped adapter over one table of the fake manager. */
export function repositoryOver<T extends object>(m: FakePeopleManager, target: new () => T) {
  const find = async (options: FindOptionsLike = {}): Promise<T[]> => {
    let rows = (await m.find(target, {
      where: options.where ?? {},
      withDeleted: options.withDeleted,
    })) as unknown as Record<string, unknown>[];
    if (options.order?.createdAt === 'DESC') {
      rows = [...rows].reverse();
    }
    if (options.take !== undefined) {
      rows = rows.slice(0, options.take);
    }
    return rows.map((row) => loadRelations(m, row, options.relations) as T);
  };

  return {
    find: jest.fn(find),
    findOne: jest.fn(async (options: FindOptionsLike = {}) => (await find(options))[0] ?? null),
    findOneOrFail: jest.fn(async (options: FindOptionsLike = {}) => {
      const [found] = await find(options);
      if (!found) throw new Error(`repositoryOver: no ${target.name} matches`);
      return found;
    }),
    create: jest.fn((values: Partial<T>) => m.create(target, values)),
    save: jest.fn((entity: T) => m.save(entity as T & { id?: string })),
    update: jest.fn((criteria: string | Record<string, unknown>, values: object) =>
      m.update(target, typeof criteria === 'string' ? { id: criteria } : criteria, values),
    ),
    count: jest.fn((options: { where: object }) => m.count(target, options)),
  };
}

/** Strips the LIKE wildcards the services wrap a search term in. */
function searchTerm(value: unknown): string | null {
  return typeof value === 'string' ? value.replace(/%/g, '').toLowerCase() : null;
}

function matchesSearch(person: Row, term: string | null): boolean {
  if (!term) return true;
  return [person.firstName, person.lastName, person.email].some((field) =>
    String(field ?? '')
      .toLowerCase()
      .includes(term),
  );
}

/**
 * The membership list queries of UsersService and ResidentsService, answered
 * from the fake manager: live membership, live person, live building, the
 * bound parameters as filters, newest person first.
 */
export class FakeMembershipQuery {
  readonly params: Record<string, unknown> = {};
  readonly conditions: string[] = [];
  private skipped = 0;
  private taken: number | undefined;

  constructor(private readonly m: FakePeopleManager) {}

  innerJoinAndSelect() {
    return this;
  }
  where(sql: string, params: Record<string, unknown> = {}) {
    this.conditions.push(sql);
    Object.assign(this.params, params);
    return this;
  }
  andWhere(sql: string, params: Record<string, unknown> = {}) {
    return this.where(sql, params);
  }
  orderBy() {
    return this;
  }
  addOrderBy() {
    return this;
  }
  skip(count: number) {
    this.skipped = count;
    return this;
  }
  take(count: number) {
    this.taken = count;
    return this;
  }

  async getMany(): Promise<Membership[]> {
    return this.page(this.all());
  }
  async getOne(): Promise<Membership | null> {
    return this.all()[0] ?? null;
  }
  async getManyAndCount(): Promise<[Membership[], number]> {
    const all = this.all();
    return [this.page(all), all.length];
  }

  private page(all: Membership[]): Membership[] {
    const end = this.taken === undefined ? undefined : this.skipped + this.taken;
    return all.slice(this.skipped, end);
  }

  private all(): Membership[] {
    const { tenantId, personId, role, status } = this.params;
    const term = searchTerm(this.params.search);

    return this.m
      .rows(Membership)
      .filter((row) => row.deletedAt == null)
      .filter((row) => tenantId === undefined || row.tenantId === tenantId)
      .filter((row) => personId === undefined || row.userId === personId)
      .filter((row) => role === undefined || row.role === role)
      .filter((row) => status === undefined || row.status === status)
      .map((row) => ({
        row,
        person: liveRow(this.m, User, row.userId),
        tenant: liveRow(this.m, Tenant, row.tenantId),
      }))
      .filter(({ person, tenant }) => !!person && !!tenant)
      .filter(({ person }) => matchesSearch(person as Row, term))
      .sort(
        (a, b) =>
          ((b.person as Row).createdAt as Date).getTime() -
            ((a.person as Row).createdAt as Date).getTime() || a.row.id.localeCompare(b.row.id),
      )
      .map(({ row, person, tenant }) =>
        Object.assign(entityOf(Membership, row), {
          user: entityOf(User, person as Row),
          tenant: entityOf(Tenant, tenant as Row),
        }),
      );
  }
}

/** A Membership repository whose query builder is FakeMembershipQuery; `queries` records each one. */
export function membershipQueryRepository(m: FakePeopleManager) {
  const queries: FakeMembershipQuery[] = [];
  return {
    queries,
    createQueryBuilder: jest.fn(() => {
      const query = new FakeMembershipQuery(m);
      queries.push(query);
      return query;
    }),
  };
}

/** GET /users' platform-admin listing: live super_admin people, by search and status. */
export class FakePlatformAdminQuery {
  private readonly params: Record<string, unknown> = {};

  constructor(private readonly m: FakePeopleManager) {}

  where(_sql: string, params: Record<string, unknown> = {}) {
    Object.assign(this.params, params);
    return this;
  }
  andWhere(sql: string, params: Record<string, unknown> = {}) {
    return this.where(sql, params);
  }

  async getMany(): Promise<User[]> {
    const term = searchTerm(this.params.search);
    return this.m
      .rows(User)
      .filter((row) => row.deletedAt == null && row.role === UserRole.SUPER_ADMIN)
      .filter((row) => this.params.status === undefined || row.status === this.params.status)
      .filter((row) => matchesSearch(row, term))
      .map((row) => entityOf(User, row));
  }
}

/**
 * MembershipsService.listForPerson over the fake manager: the person's live
 * memberships in live buildings, any status, with the building loaded, sorted
 * by building name then role (the real query's order).
 */
export function stubMembershipReads(memberships: MembershipsService, m: FakePeopleManager) {
  return jest.spyOn(memberships, 'listForPerson').mockImplementation(async (personId: string) =>
    m
      .rows(Membership)
      .filter((row) => row.deletedAt == null && row.userId === personId)
      .map((row) => ({ row, tenant: liveRow(m, Tenant, row.tenantId) }))
      .filter(({ tenant }) => !!tenant)
      .map(({ row, tenant }) =>
        Object.assign(entityOf(Membership, row), { tenant: entityOf(Tenant, tenant as Row) }),
      )
      .sort(
        (a, b) =>
          a.tenant.name.localeCompare(b.tenant.name) || String(a.role).localeCompare(b.role),
      ),
  );
}

// ---------------------------------------------------------------------------
// Principals: req.user as the strategies build it (production buildActingUser)
// ---------------------------------------------------------------------------

/** The stored person, loaded as TypeORM would (no hash). */
export function personOf(m: FakePeopleManager, personId: string): User {
  const row = m.row(User, personId);
  if (!row) throw new Error(`personOf: no person ${personId}`);
  return entityOf(User, row);
}

function tenantOf(m: FakePeopleManager, tenantId: string | null | undefined): Tenant | null {
  const row = liveRow(m, Tenant, tenantId);
  return row ? entityOf(Tenant, row) : null;
}

/** Acting as one membership (the 'membership' context). */
export function actingIn(m: FakePeopleManager, membership: Membership): ActingUser {
  const person = personOf(m, membership.userId);
  const tenant = tenantOf(m, membership.tenantId);
  const active = Object.assign(entityOf(Membership, m.row(Membership, membership.id) as Row), {
    tenant,
  });
  return buildActingUser(person, {
    contextKind: 'membership',
    role: active.role,
    tenantId: active.tenantId,
    tenant,
    unit: active.unit ?? null,
    isSuperAdmin: person.role === UserRole.SUPER_ADMIN,
    activeMembership: active,
  });
}

/** A super admin in the Platform context. */
export function actingOnPlatform(m: FakePeopleManager, personId: string): ActingUser {
  const person = personOf(m, personId);
  return buildActingUser(person, {
    contextKind: 'platform',
    role: UserRole.SUPER_ADMIN,
    tenantId: null,
    tenant: null,
    unit: null,
    isSuperAdmin: person.role === UserRole.SUPER_ADMIN,
  });
}

/** GATE_MEMBERSHIP_CONTEXT off: the gate_users row as it is. */
export function actingLegacy(m: FakePeopleManager, personId: string): ActingUser {
  const person = personOf(m, personId);
  return buildActingUser(person, {
    contextKind: 'legacy',
    role: person.role,
    tenantId: person.tenantId ?? null,
    tenant: tenantOf(m, person.tenantId),
    unit: person.unit ?? null,
    isSuperAdmin: person.role === UserRole.SUPER_ADMIN,
  });
}

/** No usable context (only reachable on @ContextOptional routes). */
export function actingWithoutContext(
  m: FakePeopleManager,
  personId: string,
  reason: MembershipRequiredReason,
): ActingUser {
  const person = personOf(m, personId);
  return buildActingUser(person, {
    contextKind: 'none',
    role: null,
    tenantId: null,
    tenant: null,
    unit: null,
    isSuperAdmin: person.role === UserRole.SUPER_ADMIN,
    contextProblem: 'MEMBERSHIP_REQUIRED',
    contextProblemReason: reason,
  });
}
