/**
 * Row builders for database suites. Each call makes unique names, slugs and
 * emails, so fixtures never collide within one schema.
 *
 * makeMembership inserts directly, bypassing MembershipsService on purpose:
 * suites use it to set up states the service itself would refuse (several
 * buildings with the flag off, drift, backfill input) and then call the code
 * under test.
 */
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { SubscriptionPlan } from '../../src/database/entities/subscription-plan.entity';
import { Tenant, TenantStatus } from '../../src/database/entities/tenant.entity';
import { User, UserRole, UserStatus } from '../../src/database/entities/user.entity';
import { Membership } from '../../src/database/entities/membership.entity';
import {
  BuildingJoinRequest,
  JoinRequestStatus,
} from '../../src/database/entities/building-join-request.entity';

type Db = DataSource | EntityManager;

function manager(db: Db): EntityManager {
  return db instanceof DataSource ? db.manager : db;
}

let sequence = 0;
function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}-${randomUUID().slice(0, 8)}`;
}

const PASSWORD_HASH = bcrypt.hashSync('Test@1234', 4);

export async function makePlan(db: Db, overrides: Partial<SubscriptionPlan> = {}) {
  const em = manager(db);
  return em.save(
    em.create(SubscriptionPlan, {
      name: nextId('Plan'),
      maxGates: 10,
      maxUsers: 100,
      logRetentionDays: 30,
      features: {},
      ...overrides,
    } as Partial<SubscriptionPlan>),
  );
}

export async function makeTenant(
  db: Db,
  plan: SubscriptionPlan,
  overrides: Partial<Tenant> = {},
): Promise<Tenant> {
  const em = manager(db);
  const name = overrides.name ?? nextId('Tower');
  return em.save(
    em.create(Tenant, {
      name,
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      contactEmail: `${name.toLowerCase()}@example.test`,
      status: TenantStatus.ACTIVE,
      subscriptionPlanId: plan.id,
      ...overrides,
    }),
  );
}

export async function makePerson(db: Db, overrides: Partial<User> = {}): Promise<User> {
  const em = manager(db);
  const handle = nextId('person');
  return em.save(
    em.create(User, {
      email: `${handle}@example.test`,
      passwordHash: PASSWORD_HASH,
      firstName: 'Test',
      lastName: handle,
      role: UserRole.BUILDING_ADMIN,
      status: UserStatus.ACTIVE,
      tenantId: null,
      qrCode: `GR-${randomUUID()}`,
      ...overrides,
    } as Partial<User>),
  );
}

export async function makeMembership(
  db: Db,
  person: Pick<User, 'id'>,
  tenant: Pick<Tenant, 'id'>,
  overrides: Partial<Membership> = {},
): Promise<Membership> {
  const em = manager(db);
  return em.save(
    em.create(Membership, {
      userId: person.id,
      tenantId: tenant.id,
      role: UserRole.RESIDENT,
      status: UserStatus.ACTIVE,
      unit: null,
      ...overrides,
    }),
  );
}

export async function makeJoinRequest(
  db: Db,
  person: Pick<User, 'id'>,
  tenant: Pick<Tenant, 'id'>,
  overrides: Partial<BuildingJoinRequest> = {},
): Promise<BuildingJoinRequest> {
  const em = manager(db);
  return em.save(
    em.create(BuildingJoinRequest, {
      userId: person.id,
      tenantId: tenant.id,
      status: JoinRequestStatus.PENDING,
      ...overrides,
    }),
  );
}

/** The person row as stored, soft-deleted or not. */
export async function reloadPerson(db: Db, id: string): Promise<User> {
  return manager(db).findOneOrFail(User, { where: { id }, withDeleted: true });
}
