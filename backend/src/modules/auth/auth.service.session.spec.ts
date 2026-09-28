import * as bcrypt from 'bcrypt';
import { UnauthorizedException } from '@nestjs/common';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import { Tenant, TenantStatus } from '@database/entities/tenant.entity';
import { Membership, MembershipRole } from '@database/entities/membership.entity';
import { buildActingUser } from '../memberships/membership-context.service';
import { AuthHarness, buildAuthService, queryBuilderReturning } from './auth.service.spec-harness';

/**
 * AUTH-10 (with O5): login / refresh / me return buildSessionUser, and the
 * HS256 token keeps the legacy claim shape {sub, email, role, tenantId} with
 * role / tenantId taken from the session user (null when ambiguous).
 */
const PASSWORD = 'Correct#Horse1';
const PERSON_ID = '0b6f6a3c-8a53-4d8e-9d1f-2c5a7b1e0a01';
const TOWER_A = Object.assign(new Tenant(), {
  id: 'aaaaaaaa-0000-4000-8000-00000000000a',
  name: 'Tower A',
  slug: 'tower-a',
  address: '1 A Street',
  status: TenantStatus.ACTIVE,
  isPaused: false,
});
const TOWER_B = Object.assign(new Tenant(), {
  id: 'bbbbbbbb-0000-4000-8000-00000000000b',
  name: 'Tower B',
  slug: 'tower-b',
  address: '2 B Street',
  status: TenantStatus.ACTIVE,
  isPaused: false,
});

function membership(id: string, tenant: Tenant, role: MembershipRole): Membership {
  return Object.assign(new Membership(), {
    id,
    userId: PERSON_ID,
    tenantId: tenant.id,
    tenant,
    role,
    status: UserStatus.ACTIVE,
    unit: null,
  });
}

const HASH = bcrypt.hashSync(PASSWORD, 4);

function person(overrides: Partial<User> = {}): User {
  return Object.assign(new User(), {
    id: PERSON_ID,
    email: 'x@example.test',
    firstName: 'X',
    lastName: 'Person',
    phone: '555',
    role: UserRole.BUILDING_ADMIN,
    status: UserStatus.ACTIVE,
    tenantId: TOWER_A.id,
    tenant: TOWER_A,
    unit: null,
    profileImageUrl: null,
    qrCode: 'GR-qr',
    passwordHash: HASH,
    ...overrides,
  });
}

describe('AuthService session user and token claims (AUTH-10)', () => {
  const originalFlag = process.env.GATE_MEMBERSHIP_CONTEXT;
  let h: AuthHarness;
  let loginQuery: ReturnType<typeof queryBuilderReturning>;

  function loginAs(row: User) {
    loginQuery = queryBuilderReturning(row);
    h.users.createQueryBuilder.mockReturnValue(loginQuery);
    return h.service.login({ email: 'X@Example.test', password: PASSWORD });
  }

  const claimsOf = (accessToken: string) => h.jwt.verify(accessToken) as Record<string, unknown>;

  beforeEach(() => {
    h = buildAuthService();
  });

  afterEach(() => {
    process.env.GATE_MEMBERSHIP_CONTEXT = originalFlag;
  });

  describe('flag off: identical to before', () => {
    beforeEach(() => (process.env.GATE_MEMBERSHIP_CONTEXT = 'off'));

    it('login returns the legacy user block, key for key', async () => {
      const response = await loginAs(person());

      expect(Object.keys(response.user)).toEqual([
        'id',
        'email',
        'firstName',
        'lastName',
        'role',
        'tenantId',
        'profileImageUrl',
        'qrCode',
        'tenant',
      ]);
      expect(response.user).toEqual({
        id: PERSON_ID,
        email: 'x@example.test',
        firstName: 'X',
        lastName: 'Person',
        role: UserRole.BUILDING_ADMIN,
        tenantId: TOWER_A.id,
        profileImageUrl: null,
        qrCode: 'GR-qr',
        tenant: { id: TOWER_A.id, name: 'Tower A', slug: 'tower-a' },
      });
      expect(h.memberships.listForPerson).not.toHaveBeenCalled();
      expect(h.memberships.listActiveForPerson).not.toHaveBeenCalled();
    });

    it('signs {sub, email, role, tenantId} from the row', async () => {
      const { accessToken } = await loginAs(person());
      expect(claimsOf(accessToken)).toMatchObject({
        sub: PERSON_ID,
        email: 'x@example.test',
        role: UserRole.BUILDING_ADMIN,
        tenantId: TOWER_A.id,
      });
      expect(Object.keys(claimsOf(accessToken)).sort()).toEqual(
        ['email', 'exp', 'iat', 'role', 'sub', 'tenantId'].sort(),
      );
    });

    it('selects passwordHash explicitly (it is select: false) and never returns it', async () => {
      const response = await loginAs(person());
      expect(loginQuery.addSelect).toHaveBeenCalledWith('user.passwordHash');
      expect(loginQuery.where).toHaveBeenCalledWith('user.email = :email', {
        email: 'x@example.test',
      });
      expect(JSON.stringify(response)).not.toContain(HASH);
    });

    it('POST /auth/me returns the same body as before from the overlay', async () => {
      const row = person({ unit: '4C' });
      const acting = buildActingUser(row, {
        contextKind: 'legacy',
        role: row.role,
        tenantId: row.tenantId,
        tenant: TOWER_A,
        unit: '4C',
        isSuperAdmin: false,
      });
      const body = await h.service.describeActingUser(acting);
      expect(Object.keys(body)).toEqual([
        'id',
        'email',
        'firstName',
        'lastName',
        'phone',
        'role',
        'tenantId',
        'profileImageUrl',
        'qrCode',
        'unit',
        'tenant',
      ]);
      expect(body).toMatchObject({
        role: UserRole.BUILDING_ADMIN,
        unit: '4C',
        tenantId: TOWER_A.id,
      });
    });
  });

  describe('flag on', () => {
    beforeEach(() => (process.env.GATE_MEMBERSHIP_CONTEXT = 'on'));

    it('one usable membership: its role and building, plus the membership list', async () => {
      const only = membership('aaaaaaaa-1111-4111-8111-111111111111', TOWER_B, UserRole.SECURITY);
      h.memberships.listActiveForPerson.mockResolvedValue([only]);
      h.memberships.listForPerson.mockResolvedValue([only]);

      const response = await loginAs(person());

      expect(response.user).toMatchObject({
        role: UserRole.SECURITY,
        tenantId: TOWER_B.id,
        tenant: { id: TOWER_B.id, name: 'Tower B', slug: 'tower-b' },
        activeMembershipId: only.id,
      });
      expect(response.user.memberships).toEqual([
        {
          id: only.id,
          role: UserRole.SECURITY,
          status: UserStatus.ACTIVE,
          unit: null,
          tenant: {
            id: TOWER_B.id,
            name: 'Tower B',
            address: '2 B Street',
            status: 'active',
            isPaused: false,
          },
        },
      ]);
      expect(claimsOf(response.accessToken)).toMatchObject({
        sub: PERSON_ID,
        role: UserRole.SECURITY,
        tenantId: TOWER_B.id,
      });
    });

    it('several buildings: role, tenantId and tenant are null (the picker decides)', async () => {
      const both = [
        membership('aaaaaaaa-1111-4111-8111-111111111111', TOWER_A, UserRole.BUILDING_ADMIN),
        membership('bbbbbbbb-1111-4111-8111-111111111111', TOWER_B, UserRole.RESIDENT),
      ];
      h.memberships.listActiveForPerson.mockResolvedValue(both);
      h.memberships.listForPerson.mockResolvedValue(both);

      const response = await loginAs(person());

      expect(response.user).toMatchObject({
        role: null,
        tenantId: null,
        tenant: null,
        activeMembershipId: null,
      });
      expect(response.user.memberships).toHaveLength(2);
      expect(claimsOf(response.accessToken)).toMatchObject({ role: null, tenantId: null });
    });

    it('no buildings: nulls and an empty list', async () => {
      const response = await loginAs(person({ tenantId: null, tenant: null }));
      expect(response.user).toMatchObject({
        role: null,
        tenantId: null,
        tenant: null,
        memberships: [],
        activeMembershipId: null,
      });
    });

    it("a platform admin: super_admin with no building, activeMembershipId 'platform'", async () => {
      h.memberships.listActiveForPerson.mockResolvedValue([
        membership('aaaaaaaa-1111-4111-8111-111111111111', TOWER_A, UserRole.RESIDENT),
      ]);
      const response = await loginAs(
        person({ role: UserRole.SUPER_ADMIN, tenantId: null, tenant: null }),
      );
      expect(response.user).toMatchObject({
        role: UserRole.SUPER_ADMIN,
        tenantId: null,
        tenant: null,
        activeMembershipId: 'platform',
      });
      expect(claimsOf(response.accessToken)).toMatchObject({
        role: UserRole.SUPER_ADMIN,
        tenantId: null,
      });
    });

    it('POST /auth/me follows the resolved context and lists the memberships', async () => {
      const b = membership('bbbbbbbb-1111-4111-8111-111111111111', TOWER_B, UserRole.RESIDENT);
      h.memberships.listForPerson.mockResolvedValue([b]);
      const acting = buildActingUser(person(), {
        contextKind: 'membership',
        role: UserRole.RESIDENT,
        tenantId: TOWER_B.id,
        tenant: TOWER_B,
        unit: '7',
        isSuperAdmin: false,
        activeMembership: b,
      });

      const body = await h.service.describeActingUser(acting);

      expect(body).toMatchObject({
        role: UserRole.RESIDENT,
        tenantId: TOWER_B.id,
        unit: '7',
        tenant: { id: TOWER_B.id, name: 'Tower B', slug: 'tower-b' },
        activeMembershipId: b.id,
      });
      expect((body as { memberships: unknown[] }).memberships).toHaveLength(1);
    });
  });

  describe('refresh', () => {
    beforeEach(() => (process.env.GATE_MEMBERSHIP_CONTEXT = 'off'));

    it('revokes the old token and returns the session user', async () => {
      h.refreshTokens.findOne.mockResolvedValue({
        id: 'rt-1',
        token: 'old',
        isRevoked: false,
        expiresAt: new Date(Date.now() + 60_000),
        user: person({ passwordHash: undefined as unknown as string }),
      });

      const response = await h.service.refreshTokens('old');

      expect(h.refreshTokens.update).toHaveBeenCalledWith('rt-1', { isRevoked: true });
      expect(response.user).toMatchObject({
        id: PERSON_ID,
        role: UserRole.BUILDING_ADMIN,
        tenantId: TOWER_A.id,
      });
      expect(claimsOf(response.accessToken)).toMatchObject({
        sub: PERSON_ID,
        tenantId: TOWER_A.id,
      });
    });

    it('refuses a token whose person is gone (soft-deleted) with a 401, not a crash', async () => {
      h.refreshTokens.findOne.mockResolvedValue({
        id: 'rt-2',
        token: 'old',
        isRevoked: false,
        expiresAt: new Date(Date.now() + 60_000),
        user: null,
      });
      await expect(h.service.refreshTokens('old')).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });
});
