import * as bcrypt from 'bcrypt';
import { HttpException } from '@nestjs/common';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import { Tenant, TenantStatus } from '@database/entities/tenant.entity';
import { Membership } from '@database/entities/membership.entity';
import { membershipExists } from '@common/context/membership-context.errors';
import { SignupDto } from './dto/login.dto';
import { AuthHarness, buildAuthService, queryBuilderReturning } from './auth.service.spec-harness';

/**
 * AUTH-11: a local signup writes the building, the person and the person's
 * building-admin membership in ONE transaction, and the resume path finds the
 * pending building through that membership. The rollback itself (a failed
 * membership leaves no tenant) is exercised against Postgres in
 * test/db/auth-signup.db.spec.ts; here the membership failure is shown to
 * escape the transaction callback before anything outside it runs.
 */
const PASSWORD = 'Brand#New1pass';

function signup(overrides: Partial<SignupDto> = {}): SignupDto {
  return {
    firstName: 'New',
    lastName: 'Admin',
    email: 'New.Admin@Example.test',
    password: PASSWORD,
    phone: '555',
    buildingName: 'Fresh Tower',
    buildingAddress: '1 Fresh Street',
    planName: 'starter',
    ...overrides,
  };
}

describe('AuthService.signup creates the admin membership (AUTH-11)', () => {
  const originalFlag = process.env.GATE_MEMBERSHIP_CONTEXT;
  let h: AuthHarness;

  beforeEach(() => {
    process.env.GATE_MEMBERSHIP_CONTEXT = 'off';
    h = buildAuthService();
    // No existing account for the email.
    h.users.createQueryBuilder.mockReturnValue(queryBuilderReturning(null));
  });

  afterEach(() => {
    process.env.GATE_MEMBERSHIP_CONTEXT = originalFlag;
    jest.restoreAllMocks();
  });

  it('inserts exactly one tenant, one person and one admin membership, in one transaction', async () => {
    const response = await h.service.signup(signup());

    expect(h.dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(h.tx.committed).toBe(true);
    expect(h.tx.tenants).toHaveLength(1);
    expect(h.tx.users).toHaveLength(1);
    expect(h.memberships.add).toHaveBeenCalledTimes(1);

    const [tenant] = h.tx.tenants;
    const [person] = h.tx.users;
    expect(h.memberships.add).toHaveBeenCalledWith(
      {
        userId: person.id,
        tenantId: tenant.id,
        role: UserRole.BUILDING_ADMIN,
        status: UserStatus.ACTIVE,
      },
      h.manager,
    );
    // Nothing is written outside the transaction's manager.
    expect(h.tenants.save).not.toHaveBeenCalled();
    expect(h.users.save).not.toHaveBeenCalled();

    // The person is created with the sentinel; add() mirrors the building.
    expect(person).toMatchObject({
      email: 'new.admin@example.test',
      role: UserRole.BUILDING_ADMIN,
      status: UserStatus.ACTIVE,
    });
    const createdPerson = h.manager.create.mock.calls[1][1] as Partial<User>;
    expect(await bcrypt.compare(PASSWORD, createdPerson.passwordHash as string)).toBe(true);
    expect(createdPerson).toMatchObject({ tenantId: null });
    expect(tenant).toMatchObject({ name: 'Fresh Tower', status: TenantStatus.TRIAL });

    // Flag off: the legacy response, as before (role, tenantId, tenant of the new building).
    expect(response.user).toEqual({
      id: person.id,
      email: 'new.admin@example.test',
      firstName: 'New',
      lastName: 'Admin',
      role: UserRole.BUILDING_ADMIN,
      tenantId: tenant.id,
      profileImageUrl: undefined,
      qrCode: expect.stringMatching(/^GR-/),
      tenant: { id: tenant.id, name: 'Fresh Tower', slug: tenant.slug },
    });
    expect(JSON.stringify(response)).not.toContain('passwordHash');
    expect(h.refreshTokens.save).toHaveBeenCalledTimes(1);
    expect(h.email.sendWelcomeEmail).toHaveBeenCalledTimes(1);
  });

  it('a pending-payment signup creates a PENDING_PAYMENT building with an active admin membership', async () => {
    await h.service.signup(signup({ requiresPayment: true }));
    expect(h.tx.tenants[0].status).toBe(TenantStatus.PENDING_PAYMENT);
    expect(h.memberships.add).toHaveBeenCalledWith(
      expect.objectContaining({ role: UserRole.BUILDING_ADMIN, status: UserStatus.ACTIVE }),
      h.manager,
    );
  });

  it('a failed membership insert fails the transaction: no commit, no token, no email', async () => {
    h.memberships.add.mockRejectedValue(membershipExists(UserRole.RESIDENT));

    await expect(h.service.signup(signup())).rejects.toBeInstanceOf(HttpException);

    expect(h.tx.committed).toBe(false);
    expect(h.refreshTokens.save).not.toHaveBeenCalled();
    expect(h.email.sendWelcomeEmail).not.toHaveBeenCalled();
  });

  it('flag on: the session user comes from the new membership', async () => {
    process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
    h.memberships.listActiveForPerson.mockImplementation(async (personId: string) => {
      const tenant = h.tx.tenants[0];
      return [
        Object.assign(new Membership(), {
          id: 'aaaaaaaa-1111-4111-8111-111111111111',
          userId: personId,
          tenantId: tenant.id,
          tenant,
          role: UserRole.BUILDING_ADMIN,
          status: UserStatus.ACTIVE,
          unit: null,
        }),
      ];
    });

    const response = await h.service.signup(signup());

    expect(response.user).toMatchObject({
      role: UserRole.BUILDING_ADMIN,
      tenantId: h.tx.tenants[0].id,
      activeMembershipId: 'aaaaaaaa-1111-4111-8111-111111111111',
    });
  });

  describe('resume goes through the membership', () => {
    const PERSON_ID = '0b6f6a3c-8a53-4d8e-9d1f-2c5a7b1e0a01';
    const pendingTower = Object.assign(new Tenant(), {
      id: 'aaaaaaaa-0000-4000-8000-00000000000a',
      name: 'Pending Tower',
      slug: 'pending-tower',
      status: TenantStatus.PENDING_PAYMENT,
    });

    function existingPerson(tenant: Tenant | null): User {
      return Object.assign(new User(), {
        id: PERSON_ID,
        email: 'new.admin@example.test',
        firstName: 'New',
        lastName: 'Admin',
        role: UserRole.BUILDING_ADMIN,
        status: UserStatus.ACTIVE,
        tenantId: tenant?.id ?? null,
        tenant,
        passwordHash: bcrypt.hashSync(PASSWORD, 4),
      });
    }

    it('looks the pending building up as an ACTIVE admin membership in a PENDING_PAYMENT building', async () => {
      h.users.createQueryBuilder.mockReturnValue(
        queryBuilderReturning(existingPerson(pendingTower)),
      );
      h.memberships.findAdminMembership.mockResolvedValue(
        Object.assign(new Membership(), {
          id: 'm',
          userId: PERSON_ID,
          tenantId: pendingTower.id,
          tenant: pendingTower,
        }),
      );

      const response = await h.service.signup(signup());

      expect(h.memberships.findAdminMembership).toHaveBeenCalledWith({
        personId: PERSON_ID,
        status: UserStatus.ACTIVE,
        tenantStatus: TenantStatus.PENDING_PAYMENT,
      });
      expect(response.accessToken).toEqual(expect.any(String));
      expect(h.dataSource.transaction).not.toHaveBeenCalled();
    });

    it('right password but no pending building: 409 EMAIL_HAS_ACCOUNT (sign in and add a building)', async () => {
      // Even if the legacy column still pointed at a pending building, only the
      // membership counts.
      h.users.createQueryBuilder.mockReturnValue(
        queryBuilderReturning(existingPerson(pendingTower)),
      );
      h.memberships.findAdminMembership.mockResolvedValue(null);

      const error = await h.service.signup(signup()).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(409);
      expect((error as HttpException).getResponse()).toMatchObject({
        code: 'EMAIL_HAS_ACCOUNT',
        message: expect.stringContaining('add a building from Get Started'),
      });
      expect(h.refreshTokens.save).not.toHaveBeenCalled();
    });
  });
});
