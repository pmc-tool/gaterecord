import { DataSource, EntityManager } from 'typeorm';
import * as bcrypt from 'bcrypt';
import * as dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import { User, UserRole, UserStatus } from '../entities/user.entity';
import { SubscriptionPlan } from '../entities/subscription-plan.entity';
import { Tenant, TenantStatus } from '../entities/tenant.entity';
import { Membership, MembershipRole } from '../entities/membership.entity';
import { BuildingJoinRequest, JoinRequestStatus } from '../entities/building-join-request.entity';
import { describeDatabaseUrl, isLocalDatabaseUrl, resolveSynchronize } from '../database-host';
import { MembershipsService } from '../../modules/memberships/memberships.service';

dotenv.config();

const databaseUrl = process.env.DATABASE_URL;

// The seed builds the schema with synchronize and writes fixed credentials, so
// it only runs against a local database unless SEED_ALLOW_REMOTE=1. Even then
// synchronize stays off on a remote host unless ALLOW_REMOTE_SYNC=1: pointed at
// the shared staging database it would create tables without their migration
// backfill and drop indexes only migrations declare.
const schemaSync = resolveSynchronize({
  wanted: true,
  url: databaseUrl,
  allowRemoteSync: process.env.ALLOW_REMOTE_SYNC === '1',
});

const dataSource = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  entities: [__dirname + '/../entities/*.entity{.ts,.js}'],
  synchronize: schemaSync.synchronize,
});

/** Exits before connecting when the target is not a local database. */
function assertSeedTarget(): void {
  if (isLocalDatabaseUrl(databaseUrl) || process.env.SEED_ALLOW_REMOTE === '1') {
    return;
  }

  console.error(
    `Refusing to seed ${describeDatabaseUrl(databaseUrl)}: it is not a local database ` +
      '(localhost, 127.0.0.1, ::1 or gate_postgres). Set SEED_ALLOW_REMOTE=1 only with the ' +
      "database owner's approval.",
  );
  process.exit(1);
}

async function seed() {
  assertSeedTarget();

  console.log(`Connecting to database ${describeDatabaseUrl(databaseUrl)}...`);
  if (schemaSync.refusedReason) {
    console.warn(schemaSync.refusedReason);
  }
  await dataSource.initialize();

  console.log('Seeding database...');

  const userRepo = dataSource.getRepository(User);

  // Check if super admin already exists
  const existingAdmin = await userRepo.findOne({
    where: { email: 'admin@gaterecord.com' },
  });

  if (existingAdmin) {
    console.log('Super admin already exists, skipping...');
  } else {
    // Create Super Admin
    console.log('Creating super admin...');
    const superAdminPassword = await bcrypt.hash('Admin@123', 10);
    const qrCode = `GR-${uuidv4()}`;
    await userRepo.save({
      email: 'admin@gaterecord.com',
      passwordHash: superAdminPassword,
      firstName: 'Super',
      lastName: 'Admin',
      role: UserRole.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
      tenantId: null,
      qrCode,
    });
  }

  // Ensure the system Default (Free) plan exists. In dev the schema comes from
  // `synchronize` (migrations are not run), so the seed is what guarantees the
  // default plan row. Idempotent: never creates a second default.
  const planRepo = dataSource.getRepository(SubscriptionPlan);
  const existingDefault = await planRepo.findOne({ where: { isDefault: true } });
  if (existingDefault) {
    console.log('Default plan already exists, skipping...');
  } else {
    const existingFree = await planRepo.findOne({ where: { name: 'Free' } });
    if (existingFree) {
      existingFree.isDefault = true;
      existingFree.isSystem = true;
      existingFree.defaultValidityDays = 60;
      await planRepo.save(existingFree);
      console.log('Promoted existing "Free" plan to the system default.');
    } else {
      console.log('Creating system Default (Free) plan...');
      await planRepo.save(
        planRepo.create({
          name: 'Free',
          description: 'Default free plan auto-assigned to new buildings',
          monthlyPrice: 0,
          yearlyPrice: 0,
          trialDays: 0,
          maxGates: 1,
          maxUsers: 3,
          maxVehicles: 10,
          maxVisitorPassesPerMonth: 20,
          logRetentionDays: 7,
          displayOrder: 0,
          isActive: true,
          isPublic: true,
          isFeatured: false,
          isDefault: true,
          isSystem: true,
          defaultValidityDays: 60,
          features: {},
        }),
      );
    }
  }

  if (process.env.SEED_MULTI_MEMBERSHIP === '1') {
    await seedMultiMembership();
  }

  console.log('Seeding complete!');
  console.log('');
  console.log('===========================================');
  console.log('SUPER ADMIN CREDENTIALS');
  console.log('===========================================');
  console.log('Email:    admin@gaterecord.com');
  console.log('Password: Admin@123');
  console.log('===========================================');

  await dataSource.destroy();
}

// ============ Multi-building memberships (opt-in, local only) ============

/** Password of every account the multi-membership block creates. */
const MULTI_SEED_PASSWORD = 'Test@1234';

/**
 * SEED_MULTI_MEMBERSHIP=1 adds the people and buildings the role/building picker
 * is exercised with. Local databases only, whatever SEED_ALLOW_REMOTE says.
 *
 * Buildings: A (suspended), B, C, D (paused), E, F.
 * The multi-building person (SEED_MULTI_MEMBERSHIP_EMAIL, default
 * multi.person@gaterecord.test; user_id left empty, so their first Keycloak
 * login with that email adopts the row) holds Building Admin of A and D,
 * Resident of B (unit 12B), Security of C, an INACTIVE Resident of F, and has a
 * pending request to join E.
 * Also: a single-building resident of B, a person with no building at all, and
 * a super admin who is also a resident of B. admin@gaterecord.com, seeded above,
 * is the plain super admin.
 *
 * Idempotent: everything is looked up before it is created. Memberships are
 * inserted directly rather than through MembershipsService.add(), which refuses
 * a second building while GATE_MEMBERSHIP_CONTEXT is off; the legacy gate_users
 * columns are then derived through MembershipsService.syncLegacyColumns exactly
 * as the service would.
 */
async function seedMultiMembership(): Promise<void> {
  if (!isLocalDatabaseUrl(databaseUrl)) {
    console.warn('SEED_MULTI_MEMBERSHIP ignored: the multi-membership fixtures are local-only.');
    return;
  }

  console.log('Seeding multi-building memberships...');
  const memberships = new MembershipsService(dataSource);
  const passwordHash = await bcrypt.hash(MULTI_SEED_PASSWORD, 10);
  const multiEmail = (process.env.SEED_MULTI_MEMBERSHIP_EMAIL || 'multi.person@gaterecord.test')
    .trim()
    .toLowerCase();

  const emails = await dataSource.transaction(async (m) => {
    const plan = await m.findOne(SubscriptionPlan, { where: { isDefault: true } });
    if (!plan) {
      throw new Error('The default plan is missing; it is seeded above.');
    }

    const now = new Date();
    const towerA = await ensureTenant(m, plan, 'A', { status: TenantStatus.SUSPENDED });
    const towerB = await ensureTenant(m, plan, 'B');
    const towerC = await ensureTenant(m, plan, 'C');
    const towerD = await ensureTenant(m, plan, 'D', {
      isPaused: true,
      pausedAt: now,
      pauseReason: 'Seeded as paused',
    });
    const towerE = await ensureTenant(m, plan, 'E');
    const towerF = await ensureTenant(m, plan, 'F');

    const multi = await ensurePerson(m, passwordHash, multiEmail, 'Multi', 'Building');
    await ensureMembership(m, multi, towerA, UserRole.BUILDING_ADMIN);
    await ensureMembership(m, multi, towerD, UserRole.BUILDING_ADMIN);
    await ensureMembership(m, multi, towerB, UserRole.RESIDENT, { unit: '12B' });
    await ensureMembership(m, multi, towerC, UserRole.SECURITY);
    await ensureMembership(m, multi, towerF, UserRole.RESIDENT, { status: UserStatus.INACTIVE });
    await ensurePendingJoinRequest(m, multi, towerE);

    const resident = await ensurePerson(
      m,
      passwordHash,
      'resident.b@gaterecord.test',
      'Single',
      'Resident',
    );
    await ensureMembership(m, resident, towerB, UserRole.RESIDENT, { unit: '3A' });

    const newcomer = await ensurePerson(
      m,
      passwordHash,
      'newcomer@gaterecord.test',
      'No',
      'Building',
    );

    const superResident = await ensurePerson(
      m,
      passwordHash,
      'super.resident@gaterecord.test',
      'Super',
      'Resident',
      UserRole.SUPER_ADMIN,
    );
    await ensureMembership(m, superResident, towerB, UserRole.RESIDENT, { unit: '7C' });

    for (const person of [multi, resident, newcomer, superResident]) {
      await memberships.syncLegacyColumns(person.id, m);
    }

    return [multi.email, resident.email, newcomer.email, superResident.email];
  });

  console.log('');
  console.log('===========================================');
  console.log('MULTI-BUILDING TEST ACCOUNTS');
  console.log('===========================================');
  for (const email of emails) {
    console.log(`Email:    ${email}`);
  }
  console.log(`Password: ${MULTI_SEED_PASSWORD}`);
  console.log('===========================================');
}

async function ensureTenant(
  m: EntityManager,
  plan: SubscriptionPlan,
  letter: string,
  overrides: Partial<Tenant> = {},
): Promise<Tenant> {
  const slug = `seed-tower-${letter.toLowerCase()}`;
  const existing = await m.findOne(Tenant, { where: { slug }, withDeleted: true });
  if (existing) {
    return existing;
  }

  return m.save(
    m.create(Tenant, {
      name: `Seed Tower ${letter}`,
      slug,
      contactEmail: `tower-${letter.toLowerCase()}@gaterecord.test`,
      address: `${letter} Street 1`,
      status: TenantStatus.ACTIVE,
      subscriptionPlanId: plan.id,
      ...overrides,
    }),
  );
}

async function ensurePerson(
  m: EntityManager,
  passwordHash: string,
  email: string,
  firstName: string,
  lastName: string,
  role: UserRole = UserRole.BUILDING_ADMIN,
): Promise<User> {
  const existing = await m.findOne(User, { where: { email }, withDeleted: true });
  if (existing) {
    return existing;
  }

  // Legacy columns start as the "no building" sentinel; syncLegacyColumns fills
  // them from the memberships afterwards (super admins keep their platform role).
  return m.save(
    m.create(User, {
      email,
      passwordHash,
      firstName,
      lastName,
      role,
      status: UserStatus.ACTIVE,
      tenantId: null,
      qrCode: `GR-${uuidv4()}`,
      userId: null,
    }),
  );
}

async function ensureMembership(
  m: EntityManager,
  person: User,
  tenant: Tenant,
  role: MembershipRole,
  extra: { unit?: string; status?: UserStatus } = {},
): Promise<void> {
  const existing = await m.findOne(Membership, {
    where: { userId: person.id, tenantId: tenant.id },
  });
  if (existing) {
    return;
  }

  await m.save(
    m.create(Membership, {
      userId: person.id,
      tenantId: tenant.id,
      role,
      status: extra.status ?? UserStatus.ACTIVE,
      unit: extra.unit ?? null,
    }),
  );
}

async function ensurePendingJoinRequest(
  m: EntityManager,
  person: User,
  tenant: Tenant,
): Promise<void> {
  const existing = await m.findOne(BuildingJoinRequest, {
    where: { userId: person.id, tenantId: tenant.id, status: JoinRequestStatus.PENDING },
  });
  if (existing) {
    return;
  }

  await m.save(
    m.create(BuildingJoinRequest, {
      userId: person.id,
      tenantId: tenant.id,
      status: JoinRequestStatus.PENDING,
      note: 'Seeded pending request',
    }),
  );
}

seed().catch((error) => {
  console.error('Seed failed:', error);
  process.exit(1);
});
