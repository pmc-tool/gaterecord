import * as bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from '../../src/modules/auth/auth.service';
import { SettingsService } from '../../src/modules/settings/settings.service';
import { MembershipsService } from '../../src/modules/memberships/memberships.service';
import { MembershipContextService } from '../../src/modules/memberships/membership-context.service';
import { Membership } from '../../src/database/entities/membership.entity';
import { SubscriptionPlan } from '../../src/database/entities/subscription-plan.entity';
import { Tenant, TenantStatus } from '../../src/database/entities/tenant.entity';
import { User, UserRole, UserStatus } from '../../src/database/entities/user.entity';
import { RefreshToken } from '../../src/database/entities/refresh-token.entity';
import { LoginHistory } from '../../src/database/entities/login-history.entity';
import { PasswordResetToken } from '../../src/database/entities/password-reset-token.entity';
import { createTestDataSource, describeDb, rebuildSchema } from './test-data-source';
import { makeMembership, makePerson, makePlan, makeTenant } from './fixtures';

/**
 * SEC-1 / SEC-2 / AUTH-11 against Postgres: signup's single transaction really
 * rolls back, the password columns are select: false yet login and
 * change-password still work, and the resume path never writes the password.
 */
describeDb('AuthService signup and password reads (database)', () => {
  const originalFlag = process.env.GATE_MEMBERSHIP_CONTEXT;
  let dataSource: DataSource;
  let memberships: MembershipsService;
  let auth: AuthService;
  let settings: SettingsService;
  let plan: SubscriptionPlan;

  beforeAll(async () => {
    dataSource = await createTestDataSource();
    await rebuildSchema(dataSource);
    plan = await makePlan(dataSource, {
      name: 'starter',
      isActive: true,
    } as Partial<SubscriptionPlan>);
    memberships = new MembershipsService(dataSource);
    const context = new MembershipContextService(memberships, dataSource.getRepository(Tenant));
    auth = new AuthService(
      dataSource.getRepository(User),
      dataSource.getRepository(RefreshToken),
      dataSource.getRepository(Tenant),
      dataSource.getRepository(SubscriptionPlan),
      dataSource.getRepository(LoginHistory),
      dataSource.getRepository(PasswordResetToken),
      new JwtService({ secret: 'db-spec-secret', signOptions: { expiresIn: '1h' } }),
      { get: (_key: string, fallback?: unknown) => fallback } as never,
      { sendWelcomeEmail: jest.fn().mockResolvedValue(undefined) } as never,
      dataSource,
      memberships,
      context,
    );
    settings = new SettingsService(
      dataSource.getRepository(User),
      dataSource.getRepository(LoginHistory),
    );
  });

  beforeEach(() => {
    process.env.GATE_MEMBERSHIP_CONTEXT = 'off';
  });

  afterAll(async () => {
    process.env.GATE_MEMBERSHIP_CONTEXT = originalFlag;
    await dataSource?.destroy();
  });

  const signupDto = (email: string, buildingName: string, password = 'Signup#Pass1') => ({
    firstName: 'New',
    lastName: 'Admin',
    email,
    password,
    buildingName,
    planName: 'starter',
  });

  it('signup writes one tenant, one person and one admin membership, mirrored', async () => {
    const response = await auth.signup(signupDto('one@example.test', 'One Tower'));

    const person = await dataSource
      .getRepository(User)
      .findOneOrFail({ where: { email: 'one@example.test' } });
    const tenant = await dataSource
      .getRepository(Tenant)
      .findOneOrFail({ where: { name: 'One Tower' } });
    const rows = await dataSource.getRepository(Membership).find({ where: { userId: person.id } });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: tenant.id,
      role: UserRole.BUILDING_ADMIN,
      status: UserStatus.ACTIVE,
    });
    expect(person).toMatchObject({ tenantId: tenant.id, role: UserRole.BUILDING_ADMIN });
    expect(response.user).toMatchObject({ id: person.id, tenantId: tenant.id });
  });

  it('a failed membership insert rolls the tenant and the person back', async () => {
    const add = jest
      .spyOn(memberships, 'add')
      .mockRejectedValueOnce(new Error('membership insert failed'));
    const tenantsBefore = await dataSource.getRepository(Tenant).count();

    await expect(auth.signup(signupDto('rollback@example.test', 'Rollback Tower'))).rejects.toThrow(
      'membership insert failed',
    );

    expect(await dataSource.getRepository(Tenant).count()).toBe(tenantsBefore);
    expect(
      await dataSource.getRepository(User).count({ where: { email: 'rollback@example.test' } }),
    ).toBe(0);
    add.mockRestore();
  });

  it('login and change-password still read the hash; plain reads never do', async () => {
    await auth.signup(signupDto('login@example.test', 'Login Tower', 'First#Pass1'));

    const plain = await dataSource.getRepository(User).findOneOrFail({
      where: { email: 'login@example.test' },
      relations: ['tenant'],
    });
    expect(plain.passwordHash).toBeUndefined();

    const session = await auth.login({ email: 'login@example.test', password: 'First#Pass1' });
    expect(session.accessToken).toEqual(expect.any(String));
    expect(JSON.stringify(session)).not.toContain('$2');

    await settings.changePassword(plain.id, {
      currentPassword: 'First#Pass1',
      newPassword: 'Second#Pass2',
      confirmPassword: 'Second#Pass2',
    });
    await expect(
      auth.login({ email: 'login@example.test', password: 'Second#Pass2' }),
    ).resolves.toBeDefined();
  });

  it('resume: the right password gets tokens and the stored hash is unchanged; a wrong one is refused', async () => {
    const hash = bcrypt.hashSync('Resume#Pass1', 4);
    const tower = await makeTenant(dataSource, plan, { status: TenantStatus.PENDING_PAYMENT });
    const person = await makePerson(dataSource, {
      email: 'resume@example.test',
      passwordHash: hash,
      tenantId: tower.id,
    });
    await makeMembership(dataSource, person, tower, { role: UserRole.BUILDING_ADMIN });

    await expect(
      auth.signup(signupDto('resume@example.test', 'Whatever', 'Attacker#Pass1')),
    ).rejects.toThrow('Email already registered');
    const resumed = await auth.signup(signupDto('resume@example.test', 'Whatever', 'Resume#Pass1'));
    expect(resumed.accessToken).toEqual(expect.any(String));

    const stored = await dataSource
      .getRepository(User)
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.id = :id', { id: person.id })
      .getOneOrFail();
    expect(stored.passwordHash).toBe(hash);
  });
});
