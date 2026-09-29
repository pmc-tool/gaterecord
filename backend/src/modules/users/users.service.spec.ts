import { HttpException, ValidationPipe } from '@nestjs/common';
import { Membership } from '@database/entities/membership.entity';
import { RfidCard } from '@database/entities/rfid-card.entity';
import { SubscriptionPlan } from '@database/entities/subscription-plan.entity';
import { Tenant } from '@database/entities/tenant.entity';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import { Vehicle } from '@database/entities/vehicle.entity';
import { membershipErrorCodeOf } from '@common/context/membership-context.errors';
import { ROLES_KEY } from '@common/decorators/roles.decorator';
import { ResidentRemovalService } from '../residents/resident-removal.service';
import {
  FakePeopleManager,
  LifecycleHarness,
  buildLifecycle,
  peopleFixtures,
} from '../people/people.spec-harness';
import { CreateUserDto, UpdateUserDto } from './dto/user.dto';
import { UsersController } from './users.controller';
import { ADMIN_ASSIGNABLE_ROLES, UsersService } from './users.service';
import {
  FakePlatformAdminQuery,
  acceptTargetedSave,
  actingIn,
  actingLegacy,
  actingOnPlatform,
  actingWithoutContext,
  dataSourceOver,
  membershipQueryRepository,
  repositoryOver,
  stubMembershipReads,
} from './people-api.spec-harness';

/**
 * PPL-6..9: the Users page on memberships. The real MembershipsService and
 * MembershipLifecycleService run underneath over the in-memory manager, so the
 * membership rules (one role per building, the flag-off refusal, the mirror,
 * the status dual-write, seats) are exercised together with UsersService's.
 */

// bcrypt at cost 10 is slow and irrelevant here.
jest.mock('bcrypt', () => ({ hash: jest.fn(async () => 'hashed-unguessable') }));

async function failure(promise: Promise<unknown>): Promise<HttpException> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    return error as HttpException;
  }
  throw new Error('expected the call to fail');
}

describe('UsersService (memberships)', () => {
  const originalFlag = process.env.GATE_MEMBERSHIP_CONTEXT;
  let h: LifecycleHarness;
  let m: FakePeopleManager;
  let fx: ReturnType<typeof peopleFixtures>;
  let service: UsersService;
  let sendNewUserCredentialsEmail: jest.Mock;
  let plan: SubscriptionPlan;
  let towerA: Tenant;
  let towerC: Tenant;
  let towerD: Tenant;

  const liveMemberships = (userId: string) =>
    m.rows(Membership).filter((row) => row.deletedAt == null && row.userId === userId);

  beforeEach(() => {
    process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
    h = buildLifecycle();
    m = acceptTargetedSave(h.m);
    fx = peopleFixtures(m);
    stubMembershipReads(h.memberships, m);
    sendNewUserCredentialsEmail = jest.fn(async () => true);

    const userRepository = {
      ...repositoryOver(m, User),
      createQueryBuilder: jest.fn(() => new FakePlatformAdminQuery(m)),
    };
    service = new UsersService(
      userRepository as never,
      membershipQueryRepository(m) as never,
      repositoryOver(m, Vehicle) as never,
      repositoryOver(m, RfidCard) as never,
      dataSourceOver(m),
      h.memberships,
      h.service,
      new ResidentRemovalService(h.service),
      { provisionUser: h.provisionUser } as never,
      { sendNewUserCredentialsEmail } as never,
      { get: (_key: string, fallback?: unknown) => fallback } as never,
    );

    plan = fx.plan({ maxUsers: 10 });
    towerA = fx.tenant(plan, { name: 'Tower A' });
    towerC = fx.tenant(plan, { name: 'Tower C' });
    towerD = fx.tenant(plan, { name: 'Tower D' });
  });

  afterAll(() => {
    process.env.GATE_MEMBERSHIP_CONTEXT = originalFlag;
  });

  /** P: admin of A and D. Q: resident of A. R: security of D. */
  function scenario() {
    const p = fx.person({ email: 'p@example.test', firstName: 'Pat', tenantId: towerA.id });
    const pa = fx.membership(p, towerA, { role: UserRole.BUILDING_ADMIN });
    const pd = fx.membership(p, towerD, { role: UserRole.BUILDING_ADMIN });
    const q = fx.person({ email: 'q@example.test', firstName: 'Quinn', role: UserRole.RESIDENT });
    const qa = fx.membership(q, towerA, { role: UserRole.RESIDENT, unit: '4B' });
    const r = fx.person({ email: 'r@example.test', firstName: 'Rae', role: UserRole.SECURITY });
    const rd = fx.membership(r, towerD, { role: UserRole.SECURITY });
    return { p, pa, pd, q, qa, r, rd };
  }

  // ------------------------------------------------------------ email lookup

  describe('lookupByEmail (Add User form)', () => {
    it('an existing person: exists, with their own name and nothing else', async () => {
      scenario();

      const found = await service.lookupByEmail('  Q@Example.TEST ');

      expect(found).toEqual({ exists: true, firstName: 'Quinn', lastName: expect.any(String) });
    });

    it('an unknown email: exists false and no name', async () => {
      scenario();

      await expect(service.lookupByEmail('nobody@example.test')).resolves.toEqual({
        exists: false,
      });
    });

    it('is open to the same roles as POST /users', () => {
      expect(Reflect.getMetadata(ROLES_KEY, UsersController.prototype.lookupByEmail)).toEqual([
        UserRole.SUPER_ADMIN,
        UserRole.BUILDING_ADMIN,
      ]);
    });
  });

  // ------------------------------------------------------------------ PPL-6

  describe('reads (PPL-6)', () => {
    it('the admin of A and D acting in D lists only D, one row per membership', async () => {
      const { p, pd, rd } = scenario();

      const rows = await service.findAll({}, actingIn(m, pd));

      expect(rows.map((row) => row.tenantId)).toEqual([towerD.id, towerD.id]);
      expect(rows.map((row) => row.membershipId).sort()).toEqual([pd.id, rd.id].sort());
      const self = rows.find((row) => row.id === p.id);
      expect(self).toMatchObject({ role: UserRole.BUILDING_ADMIN, membershipId: pd.id });
      for (const row of rows) {
        expect(row).not.toHaveProperty('passwordHash');
        expect(row).not.toHaveProperty('userId');
        expect(row).not.toHaveProperty('notificationSettings');
      }
    });

    it('filters by the membership role and status, not the legacy columns', async () => {
      const { pa, q } = scenario();
      // Q's legacy row says resident; their membership in A is made inactive.
      const qa = m.rows(Membership).find((row) => row.userId === q.id);
      (qa as Record<string, unknown>).status = UserStatus.INACTIVE;

      const inactive = await service.findAll({ status: UserStatus.INACTIVE }, actingIn(m, pa));
      expect(inactive.map((row) => row.id)).toEqual([q.id]);

      const admins = await service.findAll({ role: UserRole.BUILDING_ADMIN }, actingIn(m, pa));
      expect(admins.map((row) => row.membershipId)).toEqual([pa.id]);
    });

    it('a resident context is refused with 403 ROLE_NOT_ALLOWED_IN_BUILDING, and GET :id is admin-only', async () => {
      const { qa, p } = scenario();

      const error = await failure(service.findOne(p.id, actingIn(m, qa)));
      expect(error.getStatus()).toBe(403);
      expect(membershipErrorCodeOf(error)).toBe('ROLE_NOT_ALLOWED_IN_BUILDING');

      expect(Reflect.getMetadata(ROLES_KEY, UsersController.prototype.findOne)).toEqual([
        UserRole.SUPER_ADMIN,
        UserRole.BUILDING_ADMIN,
      ]);
    });

    it('GET :id returns only the assets the person holds in the active building', async () => {
      const { p, pd } = scenario();
      const inA = m.insert(Vehicle, { ownerId: p.id, tenantId: towerA.id, licensePlate: 'A-1' });
      const inD = m.insert(Vehicle, { ownerId: p.id, tenantId: towerD.id, licensePlate: 'D-1' });
      m.insert(RfidCard, { userId: p.id, tenantId: towerA.id, uid: 'CARD-A' });
      const cardD = m.insert(RfidCard, { userId: p.id, tenantId: towerD.id, uid: 'CARD-D' });

      const detail = await service.findOne(p.id, actingIn(m, pd));

      expect(detail.membershipId).toBe(pd.id);
      expect(detail.vehicles.map((vehicle) => vehicle.id)).toEqual([inD.id]);
      expect(detail.rfidCards.map((card) => card.id)).toEqual([cardD.id]);
      expect(detail.vehicles.map((vehicle) => vehicle.id)).not.toContain(inA.id);
    });

    it('a person with no role in the active building is 404, not their row elsewhere', async () => {
      const { q, pd } = scenario();
      const error = await failure(service.findOne(q.id, actingIn(m, pd)));
      expect(error.getStatus()).toBe(404);
    });

    it('flag off: the legacy listing is unchanged for single-membership people', async () => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'off';
      const admin = fx.person({ email: 'admin@example.test', tenantId: towerA.id });
      fx.membership(admin, towerA, { role: UserRole.BUILDING_ADMIN });
      const resident = fx.person({
        email: 'res@example.test',
        role: UserRole.RESIDENT,
        tenantId: towerA.id,
        unit: '7C',
      });
      fx.membership(resident, towerA, { role: UserRole.RESIDENT, unit: '7C' });
      const elsewhere = fx.person({ email: 'x@example.test', tenantId: towerC.id });
      fx.membership(elsewhere, towerC, { role: UserRole.BUILDING_ADMIN });

      const rows = await service.findAll({}, actingLegacy(m, admin.id));

      expect(rows.map((row) => row.id).sort()).toEqual([admin.id, resident.id].sort());
      const row = rows.find((candidate) => candidate.id === resident.id);
      expect(row).toMatchObject({
        role: UserRole.RESIDENT,
        status: UserStatus.ACTIVE,
        tenantId: towerA.id,
        unit: '7C',
        email: 'res@example.test',
      });
    });

    it('platform: every building plus the platform admins, or one building with ?tenantId', async () => {
      const { pa, pd, qa, rd } = scenario();
      const root = fx.person({ email: 'root@example.test', role: UserRole.SUPER_ADMIN });

      const all = await service.findAll({}, actingOnPlatform(m, root.id));
      const ids = (values: (string | null)[]) => values.map(String).sort();
      expect(ids(all.map((row) => row.membershipId))).toEqual(
        ids([null, pa.id, pd.id, qa.id, rd.id]),
      );
      expect(all.find((row) => row.membershipId === null)).toMatchObject({
        id: root.id,
        role: UserRole.SUPER_ADMIN,
        tenantId: null,
      });

      const onlyD = await service.findAll({ tenantId: towerD.id }, actingOnPlatform(m, root.id));
      expect(onlyD.map((row) => row.membershipId).sort()).toEqual([pd.id, rd.id].sort());
    });

    it('platform: a person in several buildings needs ?tenantId (400 TENANT_REQUIRED)', async () => {
      const { p, pa } = scenario();
      const root = fx.person({ email: 'root@example.test', role: UserRole.SUPER_ADMIN });

      const error = await failure(service.findOne(p.id, actingOnPlatform(m, root.id)));
      expect(error.getStatus()).toBe(400);
      expect(membershipErrorCodeOf(error)).toBe('TENANT_REQUIRED');

      const detail = await service.findOne(p.id, actingOnPlatform(m, root.id), {
        tenantId: towerA.id,
      });
      expect(detail.membershipId).toBe(pa.id);
    });
  });

  // ------------------------------------------------------------------ PPL-7

  describe('create (PPL-7)', () => {
    it('the admin of C adds the admin of A as security: 201, existingAccount, A untouched', async () => {
      const p = fx.person({ email: 'p@example.test', tenantId: towerA.id });
      const pa = fx.membership(p, towerA, { role: UserRole.BUILDING_ADMIN });
      const c = fx.person({ email: 'c@example.test', tenantId: towerC.id });
      const cc = fx.membership(c, towerC, { role: UserRole.BUILDING_ADMIN });

      const created = await service.create(
        {
          email: 'P@Example.test',
          firstName: 'Ignored',
          lastName: 'Ignored',
          role: UserRole.SECURITY,
        },
        actingIn(m, cc),
      );

      expect(created).toMatchObject({
        id: p.id,
        existingAccount: true,
        role: UserRole.SECURITY,
        tenantId: towerC.id,
      });
      expect(h.provisionUser).not.toHaveBeenCalled();
      expect(h.sendAddedToBuildingEmail).toHaveBeenCalled();
      const live = liveMemberships(p.id);
      expect(live).toHaveLength(2);
      expect(live.find((row) => row.id === pa.id)).toMatchObject({
        role: UserRole.BUILDING_ADMIN,
        status: UserStatus.ACTIVE,
      });

      // Adding again: one role per building.
      const again = await failure(
        service.create(
          { email: 'p@example.test', firstName: 'P', lastName: 'P', role: UserRole.RESIDENT },
          actingIn(m, cc),
        ),
      );
      expect(again.getStatus()).toBe(409);
      expect(membershipErrorCodeOf(again)).toBe('MEMBERSHIP_EXISTS');
    });

    it('a new email is provisioned with a person and a membership in the active building', async () => {
      const c = fx.person({ email: 'c@example.test', tenantId: towerC.id });
      const cc = fx.membership(c, towerC, { role: UserRole.BUILDING_ADMIN });

      const created = await service.create(
        { email: 'new@example.test', firstName: 'New', lastName: 'Guard', role: UserRole.SECURITY },
        actingIn(m, cc),
      );

      expect(created).toMatchObject({ existingAccount: false, tenantId: towerC.id });
      expect(liveMemberships(created.id)).toHaveLength(1);
      expect(m.row(User, created.id)?.qrCode).toMatch(/^GR-/);
    });

    it('an admin cannot choose the password: stripped from the body, ignored by the service', async () => {
      const pipe = new ValidationPipe({ whitelist: true, transform: true });
      const dto = (await pipe.transform(
        {
          email: 'new@example.test',
          firstName: 'New',
          lastName: 'Guard',
          role: UserRole.SECURITY,
          password: 'Admin@12345',
        },
        { type: 'body', metatype: CreateUserDto },
      )) as CreateUserDto & Record<string, unknown>;
      expect(dto).not.toHaveProperty('password');

      const c = fx.person({ email: 'c@example.test', tenantId: towerC.id });
      const cc = fx.membership(c, towerC, { role: UserRole.BUILDING_ADMIN });
      // Even if one reached the service, it is never forwarded.
      await service.create({ ...dto, password: 'Admin@12345' } as CreateUserDto, actingIn(m, cc));

      expect(h.provisionUser).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(h.provisionUser.mock.calls)).not.toContain('Admin@12345');
    });

    it('a building admin cannot create a building admin, staff, or into another building', async () => {
      const c = fx.person({ email: 'c@example.test', tenantId: towerC.id });
      const cc = fx.membership(c, towerC, { role: UserRole.BUILDING_ADMIN });
      const base = { email: 'x@example.test', firstName: 'X', lastName: 'Y' };

      for (const role of [UserRole.BUILDING_ADMIN, UserRole.STAFF, UserRole.SUPER_ADMIN]) {
        const error = await failure(service.create({ ...base, role }, actingIn(m, cc)));
        expect(error.getStatus()).toBe(403);
      }

      const elsewhere = await failure(
        service.create({ ...base, role: UserRole.RESIDENT, tenantId: towerA.id }, actingIn(m, cc)),
      );
      expect(elsewhere.getStatus()).toBe(403);
      expect(ADMIN_ASSIGNABLE_ROLES[UserRole.BUILDING_ADMIN]).toEqual([
        UserRole.SECURITY,
        UserRole.RESIDENT,
      ]);
    });

    it('a platform admin must name the building (400 TENANT_REQUIRED)', async () => {
      const root = fx.person({ email: 'root@example.test', role: UserRole.SUPER_ADMIN });
      const error = await failure(
        service.create(
          { email: 'x@example.test', firstName: 'X', lastName: 'Y', role: UserRole.RESIDENT },
          actingOnPlatform(m, root.id),
        ),
      );
      expect(error.getStatus()).toBe(400);
      expect(membershipErrorCodeOf(error)).toBe('TENANT_REQUIRED');
    });

    it('role super_admin is person-level: no membership, gate_users.role set', async () => {
      const root = fx.person({ email: 'root@example.test', role: UserRole.SUPER_ADMIN });

      const created = await service.create(
        { email: 'ops@example.test', firstName: 'Op', lastName: 'S', role: UserRole.SUPER_ADMIN },
        actingOnPlatform(m, root.id),
      );

      expect(created).toMatchObject({
        role: UserRole.SUPER_ADMIN,
        membershipId: null,
        tenantId: null,
        existingAccount: false,
      });
      expect(m.row(User, created.id)?.role).toBe(UserRole.SUPER_ADMIN);
      expect(liveMemberships(created.id)).toHaveLength(0);
      expect(sendNewUserCredentialsEmail).toHaveBeenCalled();
      // A platform admin never gets the shared default: the account service generates one.
      expect(h.provisionUser.mock.calls[0][0]).not.toHaveProperty('password');

      // An existing person keeps their buildings and gains the platform role.
      const p = fx.person({ email: 'p@example.test', tenantId: towerA.id });
      fx.membership(p, towerA, { role: UserRole.BUILDING_ADMIN });
      const granted = await service.create(
        { email: 'p@example.test', firstName: 'P', lastName: 'P', role: UserRole.SUPER_ADMIN },
        actingOnPlatform(m, root.id),
      );
      expect(granted).toMatchObject({ id: p.id, existingAccount: true });
      expect(m.row(User, p.id)?.role).toBe(UserRole.SUPER_ADMIN);
      expect(liveMemberships(p.id)).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------------ PPL-8

  describe('update and remove (PPL-8)', () => {
    it('deactivating P in C changes only the C membership', async () => {
      const p = fx.person({
        email: 'p@example.test',
        role: UserRole.SECURITY,
        tenantId: towerA.id,
      });
      const pa = fx.membership(p, towerA, { role: UserRole.SECURITY });
      const pc = fx.membership(p, towerC, { role: UserRole.SECURITY });
      const admin = fx.person({ email: 'c@example.test' });
      const cc = fx.membership(admin, towerC, { role: UserRole.BUILDING_ADMIN });

      const row = await service.update(p.id, { status: UserStatus.INACTIVE }, actingIn(m, cc));

      expect(row).toMatchObject({ membershipId: pc.id, status: UserStatus.INACTIVE });
      expect(m.row(Membership, pa.id)?.status).toBe(UserStatus.ACTIVE);
      // Two buildings: the platform-wide status is not touched.
      expect(m.row(User, p.id)?.status).toBe(UserStatus.ACTIVE);
    });

    it('before the flip, a single-membership person also gets gate_users.status', async () => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'off';
      const admin = fx.person({ email: 'c@example.test', tenantId: towerC.id });
      fx.membership(admin, towerC, { role: UserRole.BUILDING_ADMIN });
      const p = fx.person({
        email: 'p@example.test',
        role: UserRole.SECURITY,
        tenantId: towerC.id,
      });
      fx.membership(p, towerC, { role: UserRole.SECURITY });

      await service.update(p.id, { status: UserStatus.INACTIVE }, actingLegacy(m, admin.id));

      expect(m.row(User, p.id)?.status).toBe(UserStatus.INACTIVE);
    });

    it('never writes a password or an email (stripped by the whitelist, ignored by the service)', async () => {
      const pipe = new ValidationPipe({ whitelist: true, transform: true });
      const dto = (await pipe.transform(
        { password: 'Secret#123', email: 'evil@example.test', unit: '9A' },
        { type: 'body', metatype: UpdateUserDto },
      )) as UpdateUserDto & Record<string, unknown>;
      expect(dto).not.toHaveProperty('password');
      expect(dto).not.toHaveProperty('email');

      const admin = fx.person({ email: 'c@example.test' });
      const cc = fx.membership(admin, towerC, { role: UserRole.BUILDING_ADMIN });
      const p = fx.person({ email: 'p@example.test', role: UserRole.RESIDENT });
      fx.membership(p, towerC, { role: UserRole.RESIDENT });

      await service.update(
        p.id,
        { unit: '9A', password: 'x', email: 'evil@example.test' } as UpdateUserDto,
        actingIn(m, cc),
      );

      expect(m.row(User, p.id)?.email).toBe('p@example.test');
      expect(m.row(User, p.id)).not.toHaveProperty('passwordHash');
    });

    it('a building admin gets 403 PERSON_FIELDS_READ_ONLY for a changed name; equal values pass', async () => {
      const admin = fx.person({ email: 'c@example.test' });
      const cc = fx.membership(admin, towerC, { role: UserRole.BUILDING_ADMIN });
      const p = fx.person({ email: 'p@example.test', firstName: 'Pat', role: UserRole.RESIDENT });
      fx.membership(p, towerC, { role: UserRole.RESIDENT });

      const error = await failure(service.update(p.id, { firstName: 'Mallory' }, actingIn(m, cc)));
      expect(error.getStatus()).toBe(403);
      expect(membershipErrorCodeOf(error)).toBe('PERSON_FIELDS_READ_ONLY');

      await expect(
        service.update(p.id, { firstName: 'Pat', unit: '1A' }, actingIn(m, cc)),
      ).resolves.toMatchObject({ unit: '1A', firstName: 'Pat' });
    });

    it('a building admin may not change a building admin row or their own role', async () => {
      const admin = fx.person({ email: 'c@example.test' });
      const cc = fx.membership(admin, towerC, { role: UserRole.BUILDING_ADMIN });
      const other = fx.person({ email: 'o@example.test' });
      fx.membership(other, towerC, { role: UserRole.BUILDING_ADMIN });

      const coAdmin = await failure(
        service.update(other.id, { status: UserStatus.INACTIVE }, actingIn(m, cc)),
      );
      expect(coAdmin.getStatus()).toBe(403);

      const self = await failure(
        service.update(admin.id, { role: UserRole.SECURITY }, actingIn(m, cc)),
      );
      expect(self.getStatus()).toBe(403);
    });

    it('a platform admin cannot demote the last active admin (409 LAST_BUILDING_ADMIN)', async () => {
      const root = fx.person({ email: 'root@example.test', role: UserRole.SUPER_ADMIN });
      const admin = fx.person({ email: 'c@example.test' });
      fx.membership(admin, towerC, { role: UserRole.BUILDING_ADMIN });

      const error = await failure(
        service.update(admin.id, { role: UserRole.SECURITY }, actingOnPlatform(m, root.id)),
      );
      expect(error.getStatus()).toBe(409);
      expect(membershipErrorCodeOf(error)).toBe('LAST_BUILDING_ADMIN');
    });

    it('deleting P from C keeps the A membership and the person', async () => {
      const p = fx.person({ email: 'p@example.test', tenantId: towerA.id });
      const pa = fx.membership(p, towerA, { role: UserRole.BUILDING_ADMIN });
      const pc = fx.membership(p, towerC, { role: UserRole.SECURITY });
      const admin = fx.person({ email: 'c@example.test' });
      const cc = fx.membership(admin, towerC, { role: UserRole.BUILDING_ADMIN });

      await service.remove(p.id, actingIn(m, cc));

      expect(m.row(Membership, pc.id)?.deletedAt).not.toBeNull();
      expect(m.row(Membership, pa.id)?.deletedAt).toBeNull();
      expect(m.row(User, p.id)?.deletedAt).toBeNull();
    });

    it('a platform DELETE without tenantId on a two-building person is 400; with one it removes it', async () => {
      const root = fx.person({ email: 'root@example.test', role: UserRole.SUPER_ADMIN });
      const p = fx.person({ email: 'p@example.test', role: UserRole.SECURITY });
      const pa = fx.membership(p, towerA, { role: UserRole.SECURITY });
      const pc = fx.membership(p, towerC, { role: UserRole.SECURITY });

      const error = await failure(service.remove(p.id, actingOnPlatform(m, root.id)));
      expect(error.getStatus()).toBe(400);
      expect(membershipErrorCodeOf(error)).toBe('TENANT_REQUIRED');

      await service.remove(p.id, actingOnPlatform(m, root.id), { tenantId: towerC.id });
      expect(m.row(Membership, pc.id)?.deletedAt).not.toBeNull();
      expect(m.row(Membership, pa.id)?.deletedAt).toBeNull();

      // Now only one is left: no tenantId needed.
      await service.remove(p.id, actingOnPlatform(m, root.id));
      expect(m.row(Membership, pa.id)?.deletedAt).not.toBeNull();
      expect(m.row(User, p.id)?.deletedAt).toBeNull();
    });

    it('removing the last admin is 409 LAST_BUILDING_ADMIN', async () => {
      const root = fx.person({ email: 'root@example.test', role: UserRole.SUPER_ADMIN });
      const admin = fx.person({ email: 'c@example.test' });
      const cc = fx.membership(admin, towerC, { role: UserRole.BUILDING_ADMIN });

      const error = await failure(
        service.remove(admin.id, actingOnPlatform(m, root.id), { tenantId: towerC.id }),
      );
      expect(membershipErrorCodeOf(error)).toBe('LAST_BUILDING_ADMIN');
      expect(m.row(Membership, cc.id)?.deletedAt).toBeNull();
    });

    it('scope=platform: 403 for a building admin, platform removal for a platform admin', async () => {
      const root = fx.person({ email: 'root@example.test', role: UserRole.SUPER_ADMIN });
      const admin = fx.person({ email: 'c@example.test' });
      const cc = fx.membership(admin, towerC, { role: UserRole.BUILDING_ADMIN });
      const p = fx.person({ email: 'p@example.test', role: UserRole.RESIDENT });
      fx.membership(p, towerC, { role: UserRole.RESIDENT });
      fx.membership(p, towerA, { role: UserRole.RESIDENT });

      const refused = await failure(service.remove(p.id, actingIn(m, cc), { scope: 'platform' }));
      expect(refused.getStatus()).toBe(403);

      await service.remove(p.id, actingOnPlatform(m, root.id), { scope: 'platform' });
      expect(m.row(User, p.id)?.deletedAt).not.toBeNull();
      expect(liveMemberships(p.id)).toHaveLength(0);
    });

    it('a person with no building: status is the platform ban; no role, never oneself', async () => {
      const root = fx.person({ email: 'root@example.test', role: UserRole.SUPER_ADMIN });
      const ops = fx.person({ email: 'ops@example.test', role: UserRole.SUPER_ADMIN });

      const row = await service.update(
        ops.id,
        { status: UserStatus.INACTIVE, role: UserRole.SUPER_ADMIN },
        actingOnPlatform(m, root.id),
      );
      expect(row).toMatchObject({ membershipId: null, status: UserStatus.INACTIVE });
      expect(m.row(User, ops.id)?.status).toBe(UserStatus.INACTIVE);

      const role = await failure(
        service.update(ops.id, { role: UserRole.RESIDENT }, actingOnPlatform(m, root.id)),
      );
      expect(role.getStatus()).toBe(400);

      const self = await failure(
        service.update(root.id, { status: UserStatus.INACTIVE }, actingOnPlatform(m, root.id)),
      );
      expect(self.getStatus()).toBe(403);
      expect(m.row(User, root.id)?.status).toBe(UserStatus.ACTIVE);
    });

    it('a building admin may not remove a co-admin (403, as update); a platform admin may', async () => {
      const root = fx.person({ email: 'root@example.test', role: UserRole.SUPER_ADMIN });
      const admin = fx.person({ email: 'c@example.test' });
      const cc = fx.membership(admin, towerC, { role: UserRole.BUILDING_ADMIN });
      const coAdmin = fx.person({ email: 'o@example.test' });
      const oc = fx.membership(coAdmin, towerC, { role: UserRole.BUILDING_ADMIN });

      const refused = await failure(service.remove(coAdmin.id, actingIn(m, cc)));
      expect(refused.getStatus()).toBe(403);
      expect(refused.message).toBe(
        "A building admin's role in this building can only be changed by a platform admin.",
      );
      expect(m.row(Membership, oc.id)?.deletedAt).toBeNull();

      await service.remove(coAdmin.id, actingOnPlatform(m, root.id), { tenantId: towerC.id });
      expect(m.row(Membership, oc.id)?.deletedAt).not.toBeNull();
      expect(m.row(Membership, cc.id)?.deletedAt).toBeNull();
    });

    describe('scope=platform on GET and PATCH: the person, never a membership', () => {
      /** Sam: a platform admin who is also the only admin of Tower A. */
      function platformAdminWithBuilding() {
        const root = fx.person({ email: 'root@example.test', role: UserRole.SUPER_ADMIN });
        const sam = fx.person({ email: 'sam@example.test', role: UserRole.SUPER_ADMIN });
        const sa = fx.membership(sam, towerA, { role: UserRole.BUILDING_ADMIN });
        return { root, sam, sa };
      }

      it('PATCH status is the platform ban; the membership is untouched', async () => {
        const { root, sam, sa } = platformAdminWithBuilding();

        const row = await service.update(
          sam.id,
          { status: UserStatus.INACTIVE },
          actingOnPlatform(m, root.id),
          { scope: 'platform' },
        );

        expect(row).toMatchObject({
          id: sam.id,
          membershipId: null,
          role: UserRole.SUPER_ADMIN,
          status: UserStatus.INACTIVE,
        });
        expect(m.row(User, sam.id)?.status).toBe(UserStatus.INACTIVE);
        expect(m.row(Membership, sa.id)).toMatchObject({
          status: UserStatus.ACTIVE,
          deletedAt: null,
        });
      });

      it('works for a person in several buildings (no 400 TENANT_REQUIRED)', async () => {
        const { root, sam, sa } = platformAdminWithBuilding();
        const sc = fx.membership(sam, towerC, { role: UserRole.RESIDENT });

        const row = await service.update(
          sam.id,
          { firstName: 'Samantha' },
          actingOnPlatform(m, root.id),
          { scope: 'platform' },
        );
        expect(row).toMatchObject({ membershipId: null, firstName: 'Samantha' });

        const detail = await service.findOne(sam.id, actingOnPlatform(m, root.id), {
          scope: 'platform',
        });
        expect(detail).toMatchObject({
          id: sam.id,
          membershipId: null,
          role: UserRole.SUPER_ADMIN,
          tenantId: null,
          vehicles: [],
          rfidCards: [],
        });
        expect(m.row(Membership, sa.id)?.deletedAt).toBeNull();
        expect(m.row(Membership, sc.id)?.deletedAt).toBeNull();
      });

      it('still refuses a building role or unit, and a ban on oneself', async () => {
        const { root, sam } = platformAdminWithBuilding();

        const role = await failure(
          service.update(sam.id, { role: UserRole.RESIDENT }, actingOnPlatform(m, root.id), {
            scope: 'platform',
          }),
        );
        expect(role.getStatus()).toBe(400);

        const self = await failure(
          service.update(root.id, { status: UserStatus.INACTIVE }, actingOnPlatform(m, root.id), {
            scope: 'platform',
          }),
        );
        expect(self.getStatus()).toBe(403);
      });

      it('is 403 outside the Platform context and 404 for an unknown person', async () => {
        const { sam, sa } = platformAdminWithBuilding();
        const admin = fx.person({ email: 'a2@example.test' });
        const aa = fx.membership(admin, towerA, { role: UserRole.BUILDING_ADMIN });

        const patch = await failure(
          service.update(sam.id, { status: UserStatus.INACTIVE }, actingIn(m, aa), {
            scope: 'platform',
          }),
        );
        expect(patch.getStatus()).toBe(403);
        const read = await failure(service.findOne(sam.id, actingIn(m, aa), { scope: 'platform' }));
        expect(read.getStatus()).toBe(403);
        expect(m.row(User, sam.id)?.status).toBe(UserStatus.ACTIVE);
        expect(m.row(Membership, sa.id)?.status).toBe(UserStatus.ACTIVE);

        const root = fx.person({ email: 'root2@example.test', role: UserRole.SUPER_ADMIN });
        const missing = await failure(
          service.findOne('0f0e0d0c-0b0a-4908-8706-050403020100', actingOnPlatform(m, root.id), {
            scope: 'platform',
          }),
        );
        expect(missing.getStatus()).toBe(404);
      });

      it('the controller passes ?scope through on GET and PATCH', async () => {
        const users = {
          findOne: jest.fn(async () => ({})),
          update: jest.fn(async () => ({})),
        };
        const controller = new UsersController(users as never, {} as never);
        const caller = { id: 'caller' } as User;
        const id = '0f0e0d0c-0b0a-4908-8706-050403020100';

        await controller.findOne(id, { scope: 'platform' }, caller);
        await controller.update(id, { status: UserStatus.INACTIVE }, { scope: 'platform' }, caller);

        expect(users.findOne).toHaveBeenCalledWith(id, caller, {
          tenantId: undefined,
          scope: 'platform',
        });
        expect(users.update).toHaveBeenCalledWith(id, { status: UserStatus.INACTIVE }, caller, {
          tenantId: undefined,
          scope: 'platform',
        });
      });
    });
  });

  // ------------------------------------------------------------------ PPL-9

  describe('profile (PPL-9)', () => {
    it('flag off: today’s values from the legacy row, and no password hash', async () => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'off';
      const p = fx.person({
        email: 'p@example.test',
        role: UserRole.RESIDENT,
        tenantId: towerA.id,
        unit: '4B',
        passwordHash: 'secret-hash',
      } as Partial<User>);
      fx.membership(p, towerA, { role: UserRole.RESIDENT, unit: '4B' });

      const profile = await service.getProfile(actingLegacy(m, p.id));

      expect(profile).toMatchObject({
        id: p.id,
        email: 'p@example.test',
        role: UserRole.RESIDENT,
        tenantId: towerA.id,
        unit: '4B',
        status: UserStatus.ACTIVE,
        activeMembershipId: null,
        isSuperAdmin: false,
        tenant: { id: towerA.id, name: 'Tower A' },
      });
      expect(profile.qrCode).toMatch(/^GR-/);
      expect(profile).not.toHaveProperty('passwordHash');
      expect(JSON.stringify(profile)).not.toContain('secret-hash');
    });

    it('flag on with D active shows D and building_admin, whatever the legacy columns say', async () => {
      const { p, pd } = scenario();

      const profile = await service.getProfile(actingIn(m, pd));

      expect(profile).toMatchObject({
        id: p.id,
        role: UserRole.BUILDING_ADMIN,
        tenantId: towerD.id,
        tenant: { id: towerD.id, name: 'Tower D' },
        activeMembershipId: pd.id,
      });
    });

    it('two memberships and no header: 200 with no building', async () => {
      const { p } = scenario();

      const profile = await service.getProfile(actingWithoutContext(m, p.id, 'AMBIGUOUS'));

      expect(profile).toMatchObject({
        id: p.id,
        role: null,
        tenantId: null,
        tenant: null,
        unit: null,
        activeMembershipId: null,
      });
    });

    it('updateProfile changes only names and phone', async () => {
      const { p, pd } = scenario();

      const profile = await service.updateProfile(actingIn(m, pd), {
        firstName: 'Patricia',
        phone: '+100',
      });

      expect(profile).toMatchObject({ firstName: 'Patricia', phone: '+100', tenantId: towerD.id });
      // The person's legacy building (A) is not rewritten from the acting context (D).
      const stored = m.row(User, p.id);
      expect(stored).toMatchObject({ firstName: 'Patricia', phone: '+100', tenantId: towerA.id });
    });
  });
});
