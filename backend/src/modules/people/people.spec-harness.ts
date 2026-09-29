/**
 * Test-only harness shared by the people specs (lifecycle, resident removal).
 * Never imported by application code.
 *
 * FakePeopleManager is a small in-memory stand-in for the EntityManager calls
 * MembershipsService and MembershipLifecycleService make, so the REAL
 * MembershipsService runs underneath the lifecycle and the specs exercise its
 * rules (one role per building, the flag-off refusal, the legacy mirror, the
 * status dual-write) together with the lifecycle's. Locks, SQL and rollback are
 * not simulated: a failed "transaction" keeps what it wrote before failing.
 * The database suite (test/db/people-lifecycle.db.spec.ts) covers those.
 */
import { randomUUID } from 'crypto';
import { DataSource, EntityManager, FindOperator } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Membership } from '@database/entities/membership.entity';
import { SubscriptionPlan } from '@database/entities/subscription-plan.entity';
import { Tenant, TenantStatus } from '@database/entities/tenant.entity';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import { MembershipsService } from '../memberships/memberships.service';
import { AccountIdentityClient } from '../account-identity/account-identity.client';
import { EmailService } from '../notification/email.service';
import { MembershipLifecycleService } from './membership-lifecycle.service';

export type Row = Record<string, unknown> & { id: string };
type Target = new () => object;

/** One recorded write: which entity, and the criteria it was scoped by. */
export interface RecordedWrite {
  kind: 'delete' | 'update';
  target: Target;
  criteria: Record<string, unknown>;
}

export class FakePeopleManager {
  readonly queryRunner = { isTransactionActive: true };
  readonly writes: RecordedWrite[] = [];
  private readonly tables = new Map<Target, Row[]>();
  private clock = Date.UTC(2026, 0, 1);

  rows(target: Target): Row[] {
    if (!this.tables.has(target)) this.tables.set(target, []);
    return this.tables.get(target) as Row[];
  }

  /** A stored row as-is (no copy), deleted or not. */
  row(target: Target, id: string): Row | undefined {
    return this.rows(target).find((row) => row.id === id);
  }

  insert<T extends object>(target: new () => T, values: Partial<T>): T {
    const now = new Date((this.clock += 1000));
    const row = {
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      ...values,
    } as unknown as Row;
    this.rows(target).push(row);
    return Object.assign(new target(), row);
  }

  async transaction<T>(work: (m: EntityManager) => Promise<T>): Promise<T> {
    return work(this as unknown as EntityManager);
  }

  create<T extends object>(target: new () => T, values: Partial<T>): T {
    return Object.assign(new target(), values);
  }

  async save<T extends { id?: string }>(entity: T): Promise<T> {
    const target = entity.constructor as Target;
    if (!entity.id) {
      return this.insert(target, { ...entity } as Partial<object>) as unknown as T;
    }
    const row = this.row(target, entity.id);
    Object.assign(row as Row, { ...entity });
    return entity;
  }

  async findOne(target: Target, options: { where: object; withDeleted?: boolean }) {
    const row = this.match(target, options.where, options.withDeleted)[0];
    return row ? this.load(target, row) : null;
  }

  async findOneOrFail(target: Target, options: { where: object; withDeleted?: boolean }) {
    const found = await this.findOne(target, options);
    if (!found) throw new Error(`FakePeopleManager: no ${target.name} matches`);
    return found;
  }

  async find(target: Target, options: { where: object; withDeleted?: boolean }) {
    return this.match(target, options.where, options.withDeleted).map((row) =>
      this.load(target, row),
    );
  }

  /** An entity copy of a row; like the real column, gate_users.password_hash is never selected. */
  private load(target: Target, row: Row) {
    const entity = Object.assign(new target(), row) as Row;
    if (target === User) delete entity.passwordHash;
    return entity;
  }

  async count(target: Target, options: { where: object }) {
    return this.match(target, options.where).length;
  }

  async update(target: Target, criteria: Record<string, unknown>, values: object) {
    this.writes.push({ kind: 'update', target, criteria });
    const rows = this.match(target, criteria, true);
    const resolved = Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        typeof value === 'function' ? null : value,
      ]),
    );
    rows.forEach((row) => Object.assign(row, resolved));
    return { affected: rows.length };
  }

  async delete(target: Target, criteria: Record<string, unknown>) {
    this.writes.push({ kind: 'delete', target, criteria });
    const doomed = new Set(this.match(target, criteria, true));
    const kept = this.rows(target).filter((row) => !doomed.has(row));
    this.tables.set(target, kept);
    return { affected: doomed.size };
  }

  async restore(target: Target, id: string) {
    const row = this.row(target, id);
    if (row) row.deletedAt = null;
    return { affected: row ? 1 : 0 };
  }

  async softDelete(target: Target, criteria: Record<string, unknown>) {
    const rows = this.match(target, criteria);
    rows.forEach((row) => (row.deletedAt = new Date((this.clock += 1000))));
    return { affected: rows.length };
  }

  /** Only the two query shapes the people code builds: email lookup and seat counts. */
  createQueryBuilder(target: Target, alias: string) {
    return new FakeQueryBuilder(this, target, alias);
  }

  match(target: Target, where: object, withDeleted = false): Row[] {
    return this.rows(target)
      .filter((row) => withDeleted || row.deletedAt == null)
      .filter((row) =>
        Object.entries(where).every(([key, condition]) => matches(row[key], condition)),
      )
      .sort(
        (a, b) =>
          (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime() ||
          a.id.localeCompare(b.id),
      );
  }
}

class FakeQueryBuilder {
  private params: Record<string, unknown> = {};
  private includeDeleted = false;

  constructor(
    private readonly m: FakePeopleManager,
    private readonly target: Target,
    readonly alias: string,
  ) {}

  withDeleted() {
    this.includeDeleted = true;
    return this;
  }
  where(_sql: string, params: Record<string, unknown> = {}) {
    Object.assign(this.params, params);
    return this;
  }
  andWhere(sql: string, params: Record<string, unknown> = {}) {
    return this.where(sql, params);
  }
  innerJoin() {
    return this;
  }
  select() {
    return this;
  }
  addSelect() {
    return this;
  }
  groupBy() {
    return this;
  }
  orderBy() {
    return this;
  }
  addOrderBy() {
    return this;
  }
  setLock() {
    return this;
  }

  async getOne() {
    if (this.target !== User) throw new Error('FakeQueryBuilder: getOne only for the email lookup');
    const email = String(this.params.email);
    const row = this.m
      .rows(User)
      .filter((r) => this.includeDeleted || r.deletedAt == null)
      .filter((r) => String(r.email).toLowerCase() === email)
      .sort((a, b) => Number(a.deletedAt != null) - Number(b.deletedAt != null))[0];
    return row ? Object.assign(new User(), row) : null;
  }

  async getCount() {
    return this.seatRows().length;
  }

  async getRawMany() {
    const counts = new Map<string, Set<string>>();
    for (const row of this.seatRows()) {
      const key = String(row.tenantId);
      if (!counts.has(key)) counts.set(key, new Set());
      (counts.get(key) as Set<string>).add(String(row.userId));
    }
    return [...counts].map(([tenantId, people]) => ({ tenantId, seats: String(people.size) }));
  }

  /** Live memberships of live people, filtered by the tenant(s) and roles bound. */
  private seatRows(): Row[] {
    if (this.target !== Membership) throw new Error('FakeQueryBuilder: counts only on Membership');
    const tenants = (this.params.tenantIds as string[] | undefined) ?? [this.params.tenantId];
    const roles = this.params.roles as string[];
    return this.m
      .rows(Membership)
      .filter((row) => row.deletedAt == null)
      .filter((row) => tenants.includes(row.tenantId as string))
      .filter((row) => roles.includes(row.role as string))
      .filter((row) => {
        const person = this.m.row(User, row.userId as string);
        return !!person && person.deletedAt == null;
      });
  }
}

function matches(value: unknown, condition: unknown): boolean {
  if (condition instanceof FindOperator) {
    switch (condition.type) {
      case 'in':
        return (condition.value as unknown as unknown[]).includes(value);
      case 'isNull':
        return value == null;
      case 'not':
        return !matches(value, condition.value);
      default:
        throw new Error(`FakePeopleManager: unsupported operator ${condition.type}`);
    }
  }
  return value === condition;
}

/** Row builders over a FakePeopleManager. */
export function peopleFixtures(m: FakePeopleManager) {
  return {
    plan: (values: Partial<SubscriptionPlan> = {}) =>
      m.insert(SubscriptionPlan, { name: 'Plan', maxUsers: 100, maxGates: 10, ...values }),

    tenant: (plan: SubscriptionPlan | null, values: Partial<Tenant> = {}) =>
      m.insert(Tenant, {
        name: `Tower ${randomUUID().slice(0, 4)}`,
        slug: `tower-${randomUUID().slice(0, 8)}`,
        status: TenantStatus.ACTIVE,
        subscriptionPlanId: (plan?.id ?? null) as unknown as string,
        ...values,
      }),

    person: (values: Partial<User> = {}) =>
      m.insert(User, {
        email: `p-${randomUUID().slice(0, 8)}@example.test`,
        firstName: 'Pat',
        lastName: 'Person',
        role: UserRole.BUILDING_ADMIN,
        status: UserStatus.ACTIVE,
        tenantId: null,
        qrCode: `GR-${randomUUID()}`,
        ...values,
      }),

    membership: (
      person: Pick<User, 'id'>,
      tenant: Pick<Tenant, 'id'>,
      values: Partial<Membership> = {},
    ) =>
      m.insert(Membership, {
        userId: person.id,
        tenantId: tenant.id,
        role: UserRole.RESIDENT,
        status: UserStatus.ACTIVE,
        unit: null,
        ...values,
      }),
  };
}

export interface LifecycleHarness {
  m: FakePeopleManager;
  service: MembershipLifecycleService;
  memberships: MembershipsService;
  provisionUser: jest.Mock;
  sendNewUserCredentialsEmail: jest.Mock;
  sendAddedToBuildingEmail: jest.Mock;
}

/**
 * A MembershipLifecycleService over the fake manager and the real
 * MembershipsService. The account service answers "created, with a password"
 * unless a spec overrides provisionUser. `env` is what ConfigService reads
 * (GATE_DEFAULT_USER_PASSWORD, ...); unset keys fall back to the default.
 */
export function buildLifecycle(
  m = new FakePeopleManager(),
  env: Record<string, string | undefined> = {},
): LifecycleHarness {
  const dataSource = {
    manager: m,
    transaction: <T>(work: (em: EntityManager) => Promise<T>) => m.transaction(work),
  } as unknown as DataSource;

  const memberships = new MembershipsService(dataSource);
  const provisionUser = jest.fn(async (input: { email: string }) => ({
    id: randomUUID(),
    email: input.email,
    created: true,
    emailSent: false,
    password: 'Temp#Pass-1234',
  }));
  const sendNewUserCredentialsEmail = jest.fn(async () => true);
  const sendAddedToBuildingEmail = jest.fn(async () => true);
  const config = {
    get: (key: string, fallback?: unknown) => env[key] ?? fallback,
  } as unknown as ConfigService;

  const service = new MembershipLifecycleService(
    dataSource,
    memberships,
    { provisionUser } as unknown as AccountIdentityClient,
    { sendNewUserCredentialsEmail, sendAddedToBuildingEmail } as unknown as EmailService,
    config,
  );

  return {
    m,
    service,
    memberships,
    provisionUser,
    sendNewUserCredentialsEmail,
    sendAddedToBuildingEmail,
  };
}
