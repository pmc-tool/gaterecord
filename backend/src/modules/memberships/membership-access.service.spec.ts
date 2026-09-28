import { DataSource } from 'typeorm';
import { UserRole, UserStatus } from '@database/entities/user.entity';
import { MEMBERSHIP_ROLES } from '@database/entities/membership.entity';
import {
  LegacyHolderRow,
  MembershipAccessService,
  MembershipHolderRow,
  decideLegacyHolder,
  decideMembershipHolder,
} from './membership-access.service';
import {
  CARD_HOLDER_ROLES,
  CARD_ISSUE_ROLES,
  PERSONAL_QR_ROLES,
  VEHICLE_OWNER_ROLES,
} from './membership-access.constants';
import { recordMembershipTablePresence } from './membership-table';

const P = '10000000-0000-4000-8000-000000000001';
const A = 'a0000000-0000-4000-8000-00000000000a';
const B = 'b0000000-0000-4000-8000-00000000000b';
const C = 'c0000000-0000-4000-8000-00000000000c';
const D = 'd0000000-0000-4000-8000-00000000000d';

/** P: admin of A, resident of B (unit 12B), security of C, nothing in D. */
const P_MEMBERSHIPS: Record<string, Partial<MembershipHolderRow>> = {
  [A]: { membershipId: 'mA', membershipRole: UserRole.BUILDING_ADMIN },
  [B]: { membershipId: 'mB', membershipRole: UserRole.RESIDENT, membershipUnit: '12B' },
  [C]: { membershipId: 'mC', membershipRole: UserRole.SECURITY },
};

function membershipRow(
  tenantId: string,
  overrides: Partial<MembershipHolderRow> = {},
): MembershipHolderRow {
  const held = P_MEMBERSHIPS[tenantId];
  return {
    personId: P,
    personStatus: UserStatus.ACTIVE,
    membershipId: held?.membershipId ?? null,
    membershipRole: held?.membershipRole ?? null,
    membershipStatus: held ? UserStatus.ACTIVE : null,
    membershipUnit: held?.membershipUnit ?? null,
    ...overrides,
  };
}

describe('decideMembershipHolder', () => {
  it('allows P at A, B and C and says NO_MEMBERSHIP at D', () => {
    for (const tenant of [A, B, C]) {
      expect(
        decideMembershipHolder(membershipRow(tenant), tenant, PERSONAL_QR_ROLES),
      ).toMatchObject({ allowed: true, reason: null, source: 'membership', tenantId: tenant });
    }
    expect(decideMembershipHolder(membershipRow(D), D, PERSONAL_QR_ROLES)).toMatchObject({
      allowed: false,
      reason: 'NO_MEMBERSHIP',
    });
  });

  it('reports the membership unit and role for the greeting', () => {
    expect(decideMembershipHolder(membershipRow(B), B, CARD_HOLDER_ROLES)).toMatchObject({
      role: UserRole.RESIDENT,
      unit: '12B',
      membershipId: 'mB',
    });
  });

  it('denies only B when B is inactive or pending', () => {
    const inactiveB = membershipRow(B, { membershipStatus: UserStatus.INACTIVE });
    expect(decideMembershipHolder(inactiveB, B, VEHICLE_OWNER_ROLES).reason).toBe(
      'MEMBERSHIP_INACTIVE',
    );
    const pendingB = membershipRow(B, { membershipStatus: UserStatus.PENDING });
    expect(decideMembershipHolder(pendingB, B, VEHICLE_OWNER_ROLES).reason).toBe(
      'MEMBERSHIP_PENDING',
    );
    for (const tenant of [A, C]) {
      expect(
        decideMembershipHolder(membershipRow(tenant), tenant, VEHICLE_OWNER_ROLES).allowed,
      ).toBe(true);
    }
  });

  it('denies everywhere once the person is banned', () => {
    for (const tenant of [A, B, C, D]) {
      const banned = membershipRow(tenant, { personStatus: UserStatus.INACTIVE });
      expect(decideMembershipHolder(banned, tenant, PERSONAL_QR_ROLES).reason).toBe(
        'ACCOUNT_BANNED',
      );
    }
  });

  it('checks the role set', () => {
    expect(decideMembershipHolder(membershipRow(A), A, CARD_ISSUE_ROLES).reason).toBe(
      'ROLE_NOT_ALLOWED',
    );
    expect(decideMembershipHolder(membershipRow(B), B, CARD_ISSUE_ROLES).allowed).toBe(true);
  });

  it('says PERSON_NOT_FOUND without a person row', () => {
    expect(decideMembershipHolder(null, A, PERSONAL_QR_ROLES).reason).toBe('PERSON_NOT_FOUND');
  });
});

describe('decideLegacyHolder (the pre-membership gate_users rule)', () => {
  const row = (overrides: Partial<LegacyHolderRow> = {}): LegacyHolderRow => ({
    personId: P,
    personStatus: UserStatus.ACTIVE,
    tenantId: A,
    role: UserRole.RESIDENT,
    unit: '4B',
    ...overrides,
  });

  it('allows the building on the row and nothing else', () => {
    expect(decideLegacyHolder(row(), A, PERSONAL_QR_ROLES)).toMatchObject({
      allowed: true,
      source: 'legacy',
      unit: '4B',
      membershipId: null,
    });
    expect(decideLegacyHolder(row(), B, PERSONAL_QR_ROLES).reason).toBe('NO_MEMBERSHIP');
  });

  it('checks the building before the status, as the QR check did', () => {
    expect(
      decideLegacyHolder(row({ personStatus: UserStatus.INACTIVE }), B, PERSONAL_QR_ROLES).reason,
    ).toBe('NO_MEMBERSHIP');
    expect(
      decideLegacyHolder(row({ personStatus: UserStatus.INACTIVE }), A, PERSONAL_QR_ROLES).reason,
    ).toBe('MEMBERSHIP_INACTIVE');
    expect(
      decideLegacyHolder(row({ personStatus: UserStatus.PENDING }), A, PERSONAL_QR_ROLES).reason,
    ).toBe('MEMBERSHIP_PENDING');
  });

  it('keeps credential checks role-agnostic, including a super_admin row with a building', () => {
    for (const role of [...MEMBERSHIP_ROLES, UserRole.SUPER_ADMIN]) {
      expect(decideLegacyHolder(row({ role }), A, CARD_HOLDER_ROLES).allowed).toBe(true);
    }
  });

  it('still requires a resident for card issuing', () => {
    expect(decideLegacyHolder(row(), A, CARD_ISSUE_ROLES).allowed).toBe(true);
    for (const role of [UserRole.BUILDING_ADMIN, UserRole.SECURITY, UserRole.SUPER_ADMIN]) {
      expect(decideLegacyHolder(row({ role }), A, CARD_ISSUE_ROLES).reason).toBe(
        'ROLE_NOT_ALLOWED',
      );
    }
  });

  it('also denies when the membership in that building is not active (rollback safety net)', () => {
    expect(
      decideLegacyHolder(
        row({ legacyMembershipStatus: UserStatus.INACTIVE }),
        A,
        PERSONAL_QR_ROLES,
      ),
    ).toMatchObject({ allowed: false, reason: 'MEMBERSHIP_INACTIVE', source: 'legacy' });
    expect(
      decideLegacyHolder(row({ legacyMembershipStatus: UserStatus.PENDING }), A, CARD_HOLDER_ROLES)
        .reason,
    ).toBe('MEMBERSHIP_PENDING');
    // The person's own status still comes first.
    expect(
      decideLegacyHolder(
        row({ personStatus: UserStatus.PENDING, legacyMembershipStatus: UserStatus.INACTIVE }),
        A,
        PERSONAL_QR_ROLES,
      ).reason,
    ).toBe('MEMBERSHIP_PENDING');
  });

  it('is unchanged by an active membership or none at all', () => {
    for (const legacyMembershipStatus of [UserStatus.ACTIVE, null, undefined]) {
      expect(
        decideLegacyHolder(row({ legacyMembershipStatus }), A, PERSONAL_QR_ROLES).allowed,
      ).toBe(true);
    }
  });

  it('says PERSON_NOT_FOUND without a row, and never matches a null building', () => {
    expect(decideLegacyHolder(null, A, PERSONAL_QR_ROLES).reason).toBe('PERSON_NOT_FOUND');
    expect(decideLegacyHolder(row({ tenantId: null }), null, PERSONAL_QR_ROLES).reason).toBe(
      'NO_MEMBERSHIP',
    );
  });
});

/** A chainable stand-in for SelectQueryBuilder that records calls and returns canned rows. */
function fakeQueryBuilder(result: { rawMany?: unknown[]; rawOne?: unknown; many?: unknown[] }) {
  const calls: Array<[string, ...unknown[]]> = [];
  const builder: Record<string, unknown> = new Proxy(
    {},
    {
      get(_target, property: string) {
        if (property === 'getRawMany') return async () => result.rawMany ?? [];
        if (property === 'getRawOne') return async () => result.rawOne;
        if (property === 'getMany') return async () => result.many ?? [];
        if (property === 'then') return undefined;
        return (...args: unknown[]) => {
          calls.push([property, ...args]);
          return builder;
        };
      },
    },
  );
  return { builder, calls };
}

function serviceWith(builder: unknown) {
  const createQueryBuilder = jest.fn(() => builder);
  const dataSource = { manager: { createQueryBuilder } } as unknown as DataSource;
  return { service: new MembershipAccessService(dataSource), createQueryBuilder };
}

describe('MembershipAccessService', () => {
  const original = process.env.GATE_MEMBERSHIP_CONTEXT;
  afterEach(() => {
    process.env.GATE_MEMBERSHIP_CONTEXT = original;
    recordMembershipTablePresence(false);
  });

  describe('checkHolder', () => {
    it('reads the gate_users row only while the flag is off and the table is not known', async () => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'off';
      const { builder, calls } = fakeQueryBuilder({
        rawOne: {
          personId: P,
          personStatus: UserStatus.ACTIVE,
          tenantId: A,
          role: UserRole.RESIDENT,
          unit: '4B',
        },
      });
      const { service } = serviceWith(builder);

      const decision = await service.checkHolder(P, A, { roles: PERSONAL_QR_ROLES });

      expect(decision).toMatchObject({ allowed: true, source: 'legacy' });
      expect(calls.some(([method]) => method === 'leftJoin')).toBe(false);
    });

    it('with the flag off, joins the legacy building membership once the table is known', async () => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'off';
      recordMembershipTablePresence(true);
      const { builder, calls } = fakeQueryBuilder({
        rawOne: {
          personId: P,
          personStatus: UserStatus.ACTIVE,
          tenantId: A,
          role: UserRole.RESIDENT,
          unit: '4B',
          legacyMembershipStatus: UserStatus.INACTIVE,
        },
      });
      const { service } = serviceWith(builder);

      const decision = await service.checkHolder(P, A, { roles: PERSONAL_QR_ROLES });

      expect(decision).toMatchObject({
        allowed: false,
        reason: 'MEMBERSHIP_INACTIVE',
        source: 'legacy',
      });
      const joins = calls.filter(([method]) => method === 'leftJoin');
      expect(joins).toHaveLength(1);
      expect(joins[0][3]).toBe(
        'm.userId = p.id AND m.tenantId = p.tenantId AND m.deletedAt IS NULL',
      );
    });

    it('reads the membership in the credential building when the flag is on', async () => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
      const { builder, calls } = fakeQueryBuilder({
        rawOne: { ...membershipRow(B), liveTenantId: B },
      });
      const { service } = serviceWith(builder);

      const decision = await service.checkHolder(P, B, { roles: CARD_HOLDER_ROLES });

      expect(decision).toMatchObject({ allowed: true, source: 'membership', unit: '12B' });
      expect(calls.filter(([method]) => method === 'leftJoin')).toHaveLength(2);
    });

    it('treats a membership in a soft-deleted building as none', async () => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
      const { builder } = fakeQueryBuilder({ rawOne: { ...membershipRow(B), liveTenantId: null } });
      const { service } = serviceWith(builder);

      expect((await service.checkHolder(P, B, { roles: CARD_HOLDER_ROLES })).reason).toBe(
        'NO_MEMBERSHIP',
      );
    });

    it('never sends a missing or malformed id to the database', async () => {
      for (const flag of ['on', 'off']) {
        process.env.GATE_MEMBERSHIP_CONTEXT = flag;
        const { builder } = fakeQueryBuilder({});
        const { service, createQueryBuilder } = serviceWith(builder);

        expect((await service.checkHolder(null, A, { roles: PERSONAL_QR_ROLES })).reason).toBe(
          'PERSON_NOT_FOUND',
        );
        expect(
          (await service.checkHolder("1' OR '1'='1", A, { roles: PERSONAL_QR_ROLES })).reason,
        ).toBe('PERSON_NOT_FOUND');
        expect(createQueryBuilder).not.toHaveBeenCalled();
      }
    });

    it('hasActiveMembership is the allowed flag', async () => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
      const { builder } = fakeQueryBuilder({ rawOne: { ...membershipRow(A), liveTenantId: A } });
      const { service } = serviceWith(builder);

      await expect(service.hasActiveMembership(P, A, CARD_ISSUE_ROLES)).resolves.toBe(false);
      await expect(service.hasActiveMembership(P, A, VEHICLE_OWNER_ROLES)).resolves.toBe(true);
    });
  });

  describe('recipient queries', () => {
    it('findActivePersonIds refuses a missing building and short-circuits no roles', async () => {
      const { builder } = fakeQueryBuilder({ rawMany: [{ personId: P }] });
      const { service, createQueryBuilder } = serviceWith(builder);

      await expect(
        service.findActivePersonIds(null as unknown as string, CARD_HOLDER_ROLES),
      ).rejects.toThrow();
      await expect(service.findActivePersonIds(A, [])).resolves.toEqual([]);
      expect(createQueryBuilder).not.toHaveBeenCalled();
      await expect(service.findActivePersonIds(A, CARD_HOLDER_ROLES)).resolves.toEqual([P]);
    });

    it('findTenantAdminEmails keys every tenant and de-duplicates case-insensitively', async () => {
      const { builder, calls } = fakeQueryBuilder({
        rawMany: [
          { tenantId: A, email: 'Admin@A.test' },
          { tenantId: A, email: 'admin@a.test' },
          { tenantId: A, email: 'second@a.test' },
          { tenantId: B, email: 'admin@a.test' },
        ],
      });
      const { service } = serviceWith(builder);

      const emails = await service.findTenantAdminEmails([A, B, C, 'not-a-uuid', A]);

      expect([...emails.keys()]).toEqual([A, B, C]);
      expect(emails.get(A)).toEqual(['Admin@A.test', 'second@a.test']);
      expect(emails.get(B)).toEqual(['admin@a.test']);
      expect(emails.get(C)).toEqual([]);
      const whereIn = calls.find(([method]) => method === 'where');
      expect(whereIn?.[2]).toEqual({ tenantIds: [A, B, C] });
    });

    it('findTenantAdminEmails does not query for an empty list', async () => {
      const { builder } = fakeQueryBuilder({});
      const { service, createQueryBuilder } = serviceWith(builder);

      await expect(service.findTenantAdminEmails([])).resolves.toEqual(new Map());
      expect(createQueryBuilder).not.toHaveBeenCalled();
    });
  });
});
