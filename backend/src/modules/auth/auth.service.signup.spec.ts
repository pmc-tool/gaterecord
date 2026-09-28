import * as bcrypt from 'bcrypt';
import { ConflictException, HttpException } from '@nestjs/common';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import { Tenant, TenantStatus } from '@database/entities/tenant.entity';
import { Membership } from '@database/entities/membership.entity';
import { LoginStatus } from '@database/entities/login-history.entity';
import { SignupDto } from './dto/login.dto';
import { AuthHarness, buildAuthService, queryBuilderReturning } from './auth.service.spec-harness';

/**
 * SEC-1: POST /auth/signup with an existing email never writes the password
 * and never issues tokens unless the caller proves they hold the account.
 */
const REAL_PASSWORD = 'Original#Pass1';
const ATTACKER_PASSWORD = 'Attacker#Pass1';
const PERSON_ID = '0b6f6a3c-8a53-4d8e-9d1f-2c5a7b1e0a01';
const PENDING_TOWER = Object.assign(new Tenant(), {
  id: 'aaaaaaaa-0000-4000-8000-00000000000a',
  name: 'Pending Tower',
  slug: 'pending-tower',
  status: TenantStatus.PENDING_PAYMENT,
  isPaused: false,
});
const ACTIVE_TOWER = Object.assign(new Tenant(), { ...PENDING_TOWER, status: TenantStatus.ACTIVE });
const HASH = bcrypt.hashSync(REAL_PASSWORD, 4);

function existing(tenant: Tenant, overrides: Partial<User> = {}): User {
  return Object.assign(new User(), {
    id: PERSON_ID,
    email: 'owner@example.test',
    firstName: 'Owner',
    lastName: 'Person',
    role: UserRole.BUILDING_ADMIN,
    status: UserStatus.ACTIVE,
    tenantId: tenant.id,
    tenant,
    qrCode: 'GR-qr',
    passwordHash: HASH,
    ...overrides,
  });
}

function signup(password: string): SignupDto {
  return {
    firstName: 'Someone',
    lastName: 'Else',
    email: 'Owner@Example.test',
    password,
    buildingName: 'Another Tower',
    planName: 'starter',
  };
}

function adminMembership(tenant: Tenant): Membership {
  return Object.assign(new Membership(), {
    id: 'aaaaaaaa-1111-4111-8111-111111111111',
    userId: PERSON_ID,
    tenantId: tenant.id,
    tenant,
    role: UserRole.BUILDING_ADMIN,
    status: UserStatus.ACTIVE,
    unit: null,
  });
}

async function statusAndBody(promise: Promise<unknown>) {
  const error = await promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(HttpException);
  return {
    status: (error as HttpException).getStatus(),
    body: (error as HttpException).getResponse(),
  };
}

describe('AuthService.signup with an existing email (SEC-1)', () => {
  const originalFlag = process.env.GATE_MEMBERSHIP_CONTEXT;
  let h: AuthHarness;
  let compare: jest.SpyInstance;

  function withExisting(row: User) {
    h.users.createQueryBuilder.mockReturnValue(queryBuilderReturning(row));
  }

  beforeEach(() => {
    process.env.GATE_MEMBERSHIP_CONTEXT = 'off';
    h = buildAuthService();
    compare = jest.spyOn(bcrypt, 'compare');
  });

  afterEach(() => {
    process.env.GATE_MEMBERSHIP_CONTEXT = originalFlag;
    jest.restoreAllMocks();
  });

  function expectNothingWritten() {
    expect(h.users.update).not.toHaveBeenCalled();
    expect(h.users.save).not.toHaveBeenCalled();
    expect(h.refreshTokens.save).not.toHaveBeenCalled();
    expect(h.dataSource.transaction).not.toHaveBeenCalled();
  }

  it('pending account, wrong password: 409, no update, no token, a FAILED login recorded', async () => {
    withExisting(existing(PENDING_TOWER));
    h.memberships.findAdminMembership.mockResolvedValue(adminMembership(PENDING_TOWER));

    const refusal = await statusAndBody(h.service.signup(signup(ATTACKER_PASSWORD)));

    expect(refusal.status).toBe(409);
    expect(refusal.body).toMatchObject({ message: 'Email already registered' });
    expectNothingWritten();
    expect(compare).toHaveBeenCalledTimes(1);
    expect(h.loginHistory.save).toHaveBeenCalledWith(
      expect.objectContaining({ userId: PERSON_ID, status: LoginStatus.FAILED }),
    );
  });

  it('pending account, correct password: tokens, and the password is not written', async () => {
    withExisting(existing(PENDING_TOWER));
    h.memberships.findAdminMembership.mockResolvedValue(adminMembership(PENDING_TOWER));

    const response = await h.service.signup(signup(REAL_PASSWORD));

    expect(response.accessToken).toEqual(expect.any(String));
    expect(response.user).toMatchObject({ id: PERSON_ID, tenantId: PENDING_TOWER.id });
    expect(h.users.update).not.toHaveBeenCalled();
    expect(h.users.save).not.toHaveBeenCalled();
    expect(h.dataSource.transaction).not.toHaveBeenCalled();
    expect(compare).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(response)).not.toContain(HASH);
  });

  it('non-pending account, wrong password: the identical 409', async () => {
    withExisting(existing(ACTIVE_TOWER));

    const pending = await statusAndBody(
      (async () => {
        withExisting(existing(PENDING_TOWER));
        h.memberships.findAdminMembership.mockResolvedValue(adminMembership(PENDING_TOWER));
        return h.service.signup(signup(ATTACKER_PASSWORD));
      })(),
    );
    withExisting(existing(ACTIVE_TOWER));
    h.memberships.findAdminMembership.mockResolvedValue(null);
    const nonPending = await statusAndBody(h.service.signup(signup(ATTACKER_PASSWORD)));

    expect(nonPending).toEqual(pending);
    expectNothingWritten();
  });

  it('an inactive account with the right password gets the identical 409 and no token', async () => {
    withExisting(existing(PENDING_TOWER, { status: UserStatus.INACTIVE }));
    h.memberships.findAdminMembership.mockResolvedValue(adminMembership(PENDING_TOWER));

    const refusal = await statusAndBody(h.service.signup(signup(REAL_PASSWORD)));

    expect(refusal.status).toBe(409);
    expect(refusal.body).toMatchObject({ message: 'Email already registered' });
    expectNothingWritten();
    expect(h.memberships.findAdminMembership).not.toHaveBeenCalled();
  });

  it('runs exactly one bcrypt compare, against a dummy hash when the row has none', async () => {
    withExisting(existing(PENDING_TOWER, { passwordHash: '' }));

    await expect(h.service.signup(signup(REAL_PASSWORD))).rejects.toBeInstanceOf(ConflictException);

    expect(compare).toHaveBeenCalledTimes(1);
    expect(compare.mock.calls[0][1]).toMatch(/^\$2[aby]\$10\$/);
    expectNothingWritten();
  });
});
