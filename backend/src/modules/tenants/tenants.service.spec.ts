/**
 * PPL-15: super-admin tenant creation, member listing / counts and the delete
 * cascade, on memberships.
 *
 * Runs the REAL TenantsService, MembershipsService and MembershipLifecycleService
 * over the in-memory RollbackPeopleManager (no database). A failing transaction
 * restores every table, so "no orphan tenant" is observable here; SQL, locks and
 * the grouped seat query itself are covered by the database suites.
 */
jest.mock('bcrypt', () => ({
  hash: jest.fn(async (value: string) => `hashed:${value}`),
  compare: jest.fn(async () => false),
}));

import { ConflictException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import {
  BuildingJoinRequest,
  JoinRequestStatus,
} from '@database/entities/building-join-request.entity';
import { Membership } from '@database/entities/membership.entity';
import { SubscriptionPlan } from '@database/entities/subscription-plan.entity';
import { Tenant } from '@database/entities/tenant.entity';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import { membershipErrorCodeOf } from '@common/context/membership-context.errors';
import { MembershipAccessService } from '../memberships/membership-access.service';
import { EmailService } from '../notification/email.service';
import { peopleFixtures } from '../people/people.spec-harness';
import { CreateTenantDto } from './dto/tenant.dto';
import { TenantsService } from './tenants.service';
import { MembershipStack, buildMembershipStack } from './tenant-lifecycle.spec-harness';

function repositoryOver<T extends object>(stack: MembershipStack, target: new () => T) {
  return {
    findOne: (options: { where: object }) => stack.m.findOne(target, options),
    find: async () => stack.m.live(target).map((row) => Object.assign(new target(), row)),
    count: jest.fn(async (options?: { where: object }) =>
      options ? stack.m.count(target, options) : stack.m.live(target).length,
    ),
    manager: stack.m,
  } as unknown as Repository<T>;
}

describe('TenantsService on memberships (PPL-15)', () => {
  const originalFlag = process.env.GATE_MEMBERSHIP_CONTEXT;
  let stack: MembershipStack;
  let fx: ReturnType<typeof peopleFixtures>;
  let plan: SubscriptionPlan;
  let email: {
    sendNewUserCredentialsEmail: jest.Mock;
    sendAddedToBuildingEmail: jest.Mock;
  };
  let access: { findTenantMembers: jest.Mock };
  let service: TenantsService;

  function dto(overrides: Partial<CreateTenantDto> = {}): CreateTenantDto {
    return {
      name: 'Harbour View',
      slug: 'harbour-view',
      contactEmail: 'office@harbour.test',
      address: '1 Quay',
      subscriptionPlanId: plan.id,
      adminEmail: 'Admin@Harbour.test',
      adminFirstName: 'Hana',
      adminLastName: 'Admin',
      ...overrides,
    } as CreateTenantDto;
  }

  beforeEach(() => {
    process.env.GATE_MEMBERSHIP_CONTEXT = 'off';
    stack = buildMembershipStack();
    fx = peopleFixtures(stack.m);
    plan = fx.plan({ trialDays: 14 });

    email = {
      sendNewUserCredentialsEmail: jest.fn(async () => true),
      sendAddedToBuildingEmail: jest.fn(async () => true),
    };
    access = { findTenantMembers: jest.fn(async () => []) };

    service = new TenantsService(
      repositoryOver(stack, Tenant),
      repositoryOver(stack, SubscriptionPlan),
      repositoryOver(stack, User),
      { count: jest.fn(async () => 2) } as never,
      { count: jest.fn(async () => 7) } as never,
      {} as never,
      email as unknown as EmailService,
      { get: (_key: string, fallback?: unknown) => fallback } as unknown as ConfigService,
      stack.dataSource,
      stack.memberships,
      access as unknown as MembershipAccessService,
      stack.service,
    );
  });

  afterEach(() => {
    process.env.GATE_MEMBERSHIP_CONTEXT = originalFlag;
  });

  describe('createTenant', () => {
    it('a new email gets a temporary-password person with a QR code and an admin membership', async () => {
      const result = await service.createTenant(dto());

      expect(result.existingAccount).toBe(false);
      expect(result.adminPassword).toEqual(expect.any(String));

      const people = stack.m.live(User);
      expect(people).toHaveLength(1);
      expect(people[0]).toMatchObject({
        email: 'admin@harbour.test',
        mustChangePassword: true,
        status: UserStatus.ACTIVE,
        passwordHash: `hashed:${result.adminPassword}`,
        // Mirrored from the membership by MembershipsService, never written directly.
        tenantId: result.tenant.id,
        role: UserRole.BUILDING_ADMIN,
      });
      expect(String(people[0].qrCode)).toMatch(/^GR-/);

      expect(stack.m.live(Membership)).toEqual([
        expect.objectContaining({
          id: result.membershipId,
          userId: people[0].id,
          tenantId: result.tenant.id,
          role: UserRole.BUILDING_ADMIN,
          status: UserStatus.ACTIVE,
        }),
      ]);
      expect(email.sendNewUserCredentialsEmail).toHaveBeenCalledWith(
        'admin@harbour.test',
        'Hana Admin',
        UserRole.BUILDING_ADMIN,
        result.adminPassword,
        'Harbour View',
        'Yaad Admin',
        expect.any(String),
      );
      expect(email.sendAddedToBuildingEmail).not.toHaveBeenCalled();
    });

    it('an existing email creates NO new gate_users row: it adds a membership and keeps the password', async () => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
      const other = fx.tenant(plan, { name: 'Tower A' });
      const existing = fx.person({
        email: 'admin@harbour.test',
        firstName: 'Existing',
        lastName: 'Person',
        passwordHash: 'original-hash',
        tenantId: other.id,
        role: UserRole.RESIDENT,
      } as Partial<User>);
      fx.membership(existing, other, { role: UserRole.RESIDENT });

      const result = await service.createTenant(dto({ adminFirstName: 'Ignored' }));

      expect(result.existingAccount).toBe(true);
      expect(result.adminPassword).toBeNull();
      expect(result.adminUserId).toBe(existing.id);
      expect(stack.m.rows(User)).toHaveLength(1);

      const row = stack.m.row(User, existing.id);
      expect(row).toMatchObject({ passwordHash: 'original-hash', firstName: 'Existing' });

      const memberships = stack.m.live(Membership).filter((m) => m.userId === existing.id);
      expect(memberships.map((m) => [m.tenantId, m.role])).toEqual(
        expect.arrayContaining([
          [other.id, UserRole.RESIDENT],
          [result.tenant.id, UserRole.BUILDING_ADMIN],
        ]),
      );
      expect(email.sendAddedToBuildingEmail).toHaveBeenCalledWith(
        'admin@harbour.test',
        'Existing Person',
        UserRole.BUILDING_ADMIN,
        'Harbour View',
        'Yaad Admin',
        expect.any(String),
      );
      expect(email.sendNewUserCredentialsEmail).not.toHaveBeenCalled();
    });

    it('matches the existing email case-insensitively', async () => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
      fx.person({ email: 'ADMIN@harbour.TEST' });

      const result = await service.createTenant(dto());

      expect(result.existingAccount).toBe(true);
      expect(stack.m.rows(User)).toHaveLength(1);
    });

    it('a refusal inside the transaction leaves no orphan tenant (flag off, admin of another building)', async () => {
      const other = fx.tenant(plan, { name: 'Tower A' });
      const existing = fx.person({ email: 'admin@harbour.test', tenantId: other.id });
      fx.membership(existing, other, { role: UserRole.BUILDING_ADMIN });
      const tenantsBefore = stack.m.rows(Tenant).length;

      const error = await service.createTenant(dto()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect(membershipErrorCodeOf(error)).toBe('MULTI_MEMBERSHIP_DISABLED');
      expect(stack.m.rows(Tenant)).toHaveLength(tenantsBefore);
      expect(stack.m.rows(Tenant).some((t) => t.name === 'Harbour View')).toBe(false);
      expect(email.sendAddedToBuildingEmail).not.toHaveBeenCalled();
    });

    it('refuses a banned existing account with 403 ACCOUNT_SUSPENDED and creates nothing', async () => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
      fx.person({ email: 'admin@harbour.test', status: UserStatus.INACTIVE });

      const error = await service.createTenant(dto()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ForbiddenException);
      expect(membershipErrorCodeOf(error)).toBe('ACCOUNT_SUSPENDED');
      expect(stack.m.rows(Tenant).some((t) => t.name === 'Harbour View')).toBe(false);
      expect(stack.m.rows(Membership)).toHaveLength(0);
    });

    it('restores a soft-deleted account instead of inserting a duplicate row', async () => {
      const removed = fx.person({
        email: 'admin@harbour.test',
        passwordHash: 'kept',
      } as Partial<User>);
      stack.m.row(User, removed.id)!.deletedAt = new Date();

      const result = await service.createTenant(dto());

      expect(result.existingAccount).toBe(true);
      expect(stack.m.rows(User)).toHaveLength(1);
      expect(stack.m.row(User, removed.id)).toMatchObject({
        deletedAt: null,
        passwordHash: 'kept',
      });
      expect(stack.m.live(Membership)).toEqual([
        expect.objectContaining({ userId: removed.id, tenantId: result.tenant.id }),
      ]);
    });

    it('still refuses a taken tenant name before anything is written', async () => {
      fx.tenant(plan, { name: 'Harbour View' });

      await expect(service.createTenant(dto())).rejects.toThrow('Tenant name already exists');
      expect(stack.m.rows(User)).toHaveLength(0);
    });
  });

  describe('remove', () => {
    it('ends every membership, re-mirrors the people and cancels pending requests, in one go', async () => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
      const doomed = fx.tenant(plan, { name: 'Doomed' });
      const other = fx.tenant(plan, { name: 'Other' });

      // Only here: back to the sentinel.
      const admin = fx.person({ tenantId: doomed.id, role: UserRole.BUILDING_ADMIN });
      fx.membership(admin, doomed, { role: UserRole.BUILDING_ADMIN });
      // Here and in Other: re-mirrored onto Other.
      const resident = fx.person({ tenantId: doomed.id, role: UserRole.RESIDENT, unit: '4B' });
      fx.membership(resident, doomed, { role: UserRole.RESIDENT, unit: '4B' });
      fx.membership(resident, other, { role: UserRole.SECURITY });

      const applicant = fx.person();
      const pending = stack.m.insert(BuildingJoinRequest, {
        userId: applicant.id,
        tenantId: doomed.id,
        status: JoinRequestStatus.PENDING,
      });
      const elsewhere = stack.m.insert(BuildingJoinRequest, {
        userId: applicant.id,
        tenantId: other.id,
        status: JoinRequestStatus.PENDING,
      });

      await service.remove(doomed.id);

      expect(stack.m.row(Tenant, doomed.id)?.deletedAt).toBeInstanceOf(Date);
      expect(stack.m.live(Membership).filter((m) => m.tenantId === doomed.id)).toHaveLength(0);
      expect(stack.m.live(Membership).filter((m) => m.tenantId === other.id)).toHaveLength(1);

      expect(stack.m.row(User, admin.id)).toMatchObject({
        tenantId: null,
        role: UserRole.BUILDING_ADMIN,
        unit: null,
      });
      expect(stack.m.row(User, resident.id)).toMatchObject({
        tenantId: other.id,
        role: UserRole.SECURITY,
        unit: null,
      });

      expect(stack.m.row(BuildingJoinRequest, pending.id)?.status).toBe(
        JoinRequestStatus.CANCELLED,
      );
      expect(stack.m.row(BuildingJoinRequest, elsewhere.id)?.status).toBe(
        JoinRequestStatus.PENDING,
      );
    });

    it('404s an unknown tenant without cancelling anything', async () => {
      await expect(service.remove('3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f')).rejects.toThrow(
        'Tenant not found',
      );
    });
  });

  describe('members and counts', () => {
    it('findOne lists members from memberships as safe rows, under the legacy users key', async () => {
      const tower = fx.tenant(plan, { name: 'Tower' });
      const person = fx.person({ firstName: 'Mo', passwordHash: 'secret' } as Partial<User>);
      const membership = Object.assign(new Membership(), {
        id: 'm-1',
        userId: person.id,
        tenantId: tower.id,
        role: UserRole.SECURITY,
        status: UserStatus.ACTIVE,
        unit: null,
        user: Object.assign(new User(), stack.m.row(User, person.id)),
      });
      access.findTenantMembers.mockResolvedValue([membership]);

      const detail = await service.findOne(tower.id);

      expect(access.findTenantMembers).toHaveBeenCalledWith(tower.id);
      expect(detail.users).toEqual([
        expect.objectContaining({
          id: person.id,
          membershipId: 'm-1',
          role: UserRole.SECURITY,
          tenantId: tower.id,
        }),
      ]);
      expect(detail.users[0]).not.toHaveProperty('passwordHash');
      expect(detail.users[0]).not.toHaveProperty('qrCode');
    });

    it('getTenantStats counts seats from memberships (a second-building member included)', async () => {
      const tower = fx.tenant(plan, { name: 'Tower' });
      const other = fx.tenant(plan, { name: 'Other' });
      // Row points at Other, but also holds a role in Tower: counted in Tower.
      const commuter = fx.person({ tenantId: other.id });
      fx.membership(commuter, other, { role: UserRole.BUILDING_ADMIN });
      fx.membership(commuter, tower, { role: UserRole.RESIDENT });
      const local = fx.person({ tenantId: tower.id });
      fx.membership(local, tower, { role: UserRole.SECURITY, status: UserStatus.INACTIVE });

      const stats = await service.getTenantStats(tower.id);

      expect(stats).toEqual({ userCount: 2, gateCount: 2, eventCount: 7 });
    });
  });
});
