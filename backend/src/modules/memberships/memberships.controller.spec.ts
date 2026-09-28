import { NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import { Tenant, TenantStatus } from '@database/entities/tenant.entity';
import { Membership, MembershipRole } from '@database/entities/membership.entity';
import {
  BuildingJoinRequest,
  JoinRequestStatus,
} from '@database/entities/building-join-request.entity';
import { CONTEXT_OPTIONAL_KEY } from '@common/decorators/context-optional.decorator';
import { SUBSCRIPTION_EXEMPT_KEY } from '@common/decorators/subscription-exempt.decorator';
import { ActingUser } from '@common/context/acting-user';
import { MembershipsController } from './memberships.controller';
import { MembershipsService } from './memberships.service';
import { buildActingUser } from './membership-context.service';

/**
 * AUTH-9: the C4 shape of GET /memberships/me. The reads are stubbed here; that
 * they exclude soft-deleted memberships and buildings is checked against
 * Postgres in test/db/membership-reads.db.spec.ts.
 */
const PERSON_ID = '0b6f6a3c-8a53-4d8e-9d1f-2c5a7b1e0a01';

function tower(letter: string, overrides: Partial<Tenant> = {}): Tenant {
  return Object.assign(new Tenant(), {
    id: `${letter.toLowerCase().repeat(8)}-0000-4000-8000-000000000000`,
    name: `Tower ${letter}`,
    slug: `tower-${letter}`,
    address: `${letter} Street 1`,
    status: TenantStatus.ACTIVE,
    isPaused: false,
    contactEmail: 'billing@example.test',
    stripeCustomerId: 'cus_secret',
    settings: { secret: true },
    ...overrides,
  });
}

function membership(
  id: string,
  tenant: Tenant,
  role: MembershipRole,
  status: UserStatus = UserStatus.ACTIVE,
  unit: string | null = null,
): Membership {
  return Object.assign(new Membership(), {
    id,
    userId: PERSON_ID,
    tenantId: tenant.id,
    tenant,
    role,
    status,
    unit,
  });
}

const person = Object.assign(new User(), {
  id: PERSON_ID,
  email: 'x@example.test',
  firstName: 'X',
  lastName: 'Person',
  phone: '555',
  role: UserRole.BUILDING_ADMIN,
  status: UserStatus.ACTIVE,
  userId: 'keycloak-sub-never-exposed',
});

function actingAs(
  kind: 'membership' | 'platform' | 'none',
  active: Membership | null = null,
  isSuperAdmin = false,
): ActingUser {
  return buildActingUser(person, {
    contextKind: kind,
    role: active?.role ?? (kind === 'platform' ? UserRole.SUPER_ADMIN : null),
    tenantId: active?.tenantId ?? null,
    tenant: active?.tenant ?? null,
    unit: active?.unit ?? null,
    isSuperAdmin,
    activeMembership: active,
    contextProblem: kind === 'none' ? 'MEMBERSHIP_INVALID' : null,
  });
}

describe('GET /memberships/me (AUTH-9)', () => {
  const originalFlag = process.env.GATE_MEMBERSHIP_CONTEXT;
  let service: MembershipsService;
  let controller: MembershipsController;
  let listForPerson: jest.SpyInstance;
  let listPendingJoinRequests: jest.SpyInstance;

  beforeEach(() => {
    process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
    service = new MembershipsService({} as never);
    listForPerson = jest.spyOn(service, 'listForPerson').mockResolvedValue([]);
    listPendingJoinRequests = jest.spyOn(service, 'listPendingJoinRequests').mockResolvedValue([]);
    controller = new MembershipsController(service);
  });

  afterEach(() => {
    process.env.GATE_MEMBERSHIP_CONTEXT = originalFlag;
    jest.restoreAllMocks();
  });

  it('is context-optional and subscription-exempt', () => {
    const reflector = new Reflector();
    const targets = [MembershipsController.prototype.getMine, MembershipsController];
    expect(reflector.getAllAndOverride(CONTEXT_OPTIONAL_KEY, targets)).toBe(true);
    expect(reflector.getAllAndOverride(SUBSCRIPTION_EXEMPT_KEY, targets)).toBe(true);
  });

  it('answers 404 while GATE_MEMBERSHIP_CONTEXT is off, without reading anything', async () => {
    process.env.GATE_MEMBERSHIP_CONTEXT = 'off';
    await expect(controller.getMine(actingAs('none'))).rejects.toBeInstanceOf(NotFoundException);
    expect(listForPerson).not.toHaveBeenCalled();
  });

  it('zero memberships: empty lists, no active membership', async () => {
    const body = await controller.getMine(
      buildActingUser(person, {
        contextKind: 'none',
        role: null,
        tenantId: null,
        tenant: null,
        unit: null,
        isSuperAdmin: false,
        contextProblem: 'MEMBERSHIP_REQUIRED',
        contextProblemReason: 'NO_MEMBERSHIPS',
      }),
    );

    expect(body).toEqual({
      isSuperAdmin: false,
      activeMembershipId: null,
      multiMembershipEnabled: true,
      user: { id: PERSON_ID, email: 'x@example.test', firstName: 'X', lastName: 'Person' },
      memberships: [],
      pendingJoinRequests: [],
    });
    expect(listForPerson).toHaveBeenCalledWith(PERSON_ID);
    expect(listPendingJoinRequests).toHaveBeenCalledWith(PERSON_ID);
  });

  it('the D1 example: admin of A, resident of B, security of C, acting as resident of B', async () => {
    const a = membership(
      'aaaaaaaa-1111-4111-8111-111111111111',
      tower('A'),
      UserRole.BUILDING_ADMIN,
    );
    const b = membership(
      'bbbbbbbb-1111-4111-8111-111111111111',
      tower('B'),
      UserRole.RESIDENT,
      UserStatus.ACTIVE,
      '4C',
    );
    const c = membership(
      'cccccccc-1111-4111-8111-111111111111',
      tower('C', { status: TenantStatus.SUSPENDED }),
      UserRole.SECURITY,
    );
    listForPerson.mockResolvedValue([a, b, c]);

    const body = await controller.getMine(actingAs('membership', b));

    expect(body.activeMembershipId).toBe(b.id);
    expect(body.memberships).toEqual([
      {
        id: a.id,
        role: UserRole.BUILDING_ADMIN,
        status: UserStatus.ACTIVE,
        unit: null,
        tenant: {
          id: a.tenantId,
          name: 'Tower A',
          address: 'A Street 1',
          status: TenantStatus.ACTIVE,
          isPaused: false,
        },
      },
      {
        id: b.id,
        role: UserRole.RESIDENT,
        status: UserStatus.ACTIVE,
        unit: '4C',
        tenant: {
          id: b.tenantId,
          name: 'Tower B',
          address: 'B Street 1',
          status: TenantStatus.ACTIVE,
          isPaused: false,
        },
      },
      {
        id: c.id,
        role: UserRole.SECURITY,
        status: UserStatus.ACTIVE,
        unit: null,
        tenant: {
          id: c.tenantId,
          name: 'Tower C',
          address: 'C Street 1',
          status: TenantStatus.SUSPENDED,
          isPaused: false,
        },
      },
    ]);
  });

  it('projects the building to exactly {id, name, address, status, isPaused}', async () => {
    listForPerson.mockResolvedValue([
      membership(
        'aaaaaaaa-1111-4111-8111-111111111111',
        tower('A', { status: TenantStatus.PENDING_PAYMENT, isPaused: true }),
        UserRole.BUILDING_ADMIN,
      ),
    ]);
    const body = await controller.getMine(actingAs('none'));
    expect(Object.keys(body.memberships[0].tenant).sort()).toEqual(
      ['address', 'id', 'isPaused', 'name', 'status'].sort(),
    );
    expect(body.memberships[0].tenant).toMatchObject({ status: 'pending_payment', isPaused: true });
    expect(JSON.stringify(body)).not.toContain('cus_secret');
    expect(JSON.stringify(body)).not.toContain('keycloak-sub-never-exposed');
  });

  it('lists inactive, pending and staff rows with their status', async () => {
    listForPerson.mockResolvedValue([
      membership(
        'aaaaaaaa-1111-4111-8111-111111111111',
        tower('A'),
        UserRole.RESIDENT,
        UserStatus.INACTIVE,
      ),
      membership(
        'bbbbbbbb-1111-4111-8111-111111111111',
        tower('B'),
        UserRole.SECURITY,
        UserStatus.PENDING,
      ),
      membership('cccccccc-1111-4111-8111-111111111111', tower('C'), UserRole.STAFF),
    ]);
    const body = await controller.getMine(actingAs('none'));
    expect(body.memberships.map((m) => [m.role, m.status])).toEqual([
      [UserRole.RESIDENT, UserStatus.INACTIVE],
      [UserRole.SECURITY, UserStatus.PENDING],
      [UserRole.STAFF, UserStatus.ACTIVE],
    ]);
  });

  it('lists pending join requests as {id, status, tenant {id, name}}', async () => {
    const d = tower('D');
    listPendingJoinRequests.mockResolvedValue([
      Object.assign(new BuildingJoinRequest(), {
        id: 'dddddddd-2222-4222-8222-222222222222',
        userId: PERSON_ID,
        tenantId: d.id,
        tenant: d,
        status: JoinRequestStatus.PENDING,
        unit: '9',
        phone: '555',
        note: 'private note',
      }),
    ]);
    const body = await controller.getMine(actingAs('none'));
    expect(body.pendingJoinRequests).toEqual([
      {
        id: 'dddddddd-2222-4222-8222-222222222222',
        status: 'pending',
        tenant: { id: d.id, name: 'Tower D' },
      },
    ]);
  });

  it("a super admin: isSuperAdmin and activeMembershipId 'platform'", async () => {
    const body = await controller.getMine(actingAs('platform', null, true));
    expect(body).toMatchObject({ isSuperAdmin: true, activeMembershipId: 'platform' });
  });

  it('a stale header (resolved to an invalid context) gives activeMembershipId null, not an error', async () => {
    listForPerson.mockResolvedValue([
      membership('aaaaaaaa-1111-4111-8111-111111111111', tower('A'), UserRole.RESIDENT),
    ]);
    const body = await controller.getMine(actingAs('none'));
    expect(body.activeMembershipId).toBeNull();
    expect(body.memberships).toHaveLength(1);
  });
});
