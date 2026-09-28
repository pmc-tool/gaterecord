import { UnauthorizedException } from '@nestjs/common';
import { Membership } from '@database/entities/membership.entity';
import { Tenant } from '@database/entities/tenant.entity';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import { LEGACY_SENTINEL } from '../memberships/memberships.service';
import { ResidentRemovalService } from '../residents/resident-removal.service';
import {
  FakePeopleManager,
  LifecycleHarness,
  buildLifecycle,
  peopleFixtures,
} from '../people/people.spec-harness';
import { repositoryOver } from '../users/people-api.spec-harness';
import { IdentityProvisioningService } from './identity-provisioning.service';

/**
 * AUTH-12: identity provisioning under memberships. A brand-new identity is a
 * person with ZERO memberships (onboarding); a restore of a soft-deleted
 * person never brings a membership back; gate_users.status is the platform
 * block (401). The restore runs the real ResidentRemovalService ->
 * MembershipLifecycleService -> MembershipsService over the in-memory manager.
 */

// bcrypt at cost 10 is slow and irrelevant here.
jest.mock('bcrypt', () => ({ hash: jest.fn(async () => 'hashed-unguessable') }));

const SUB = '7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d';

describe('IdentityProvisioningService (memberships, AUTH-12)', () => {
  let h: LifecycleHarness;
  let m: FakePeopleManager;
  let fx: ReturnType<typeof peopleFixtures>;
  let users: ReturnType<typeof repositoryOver<User>> & { createQueryBuilder: jest.Mock };
  let service: IdentityProvisioningService;
  let towerA: Tenant;
  let towerB: Tenant;

  const token = (overrides: Record<string, unknown> = {}) => ({
    sub: SUB,
    email: 'person@example.test',
    email_verified: true,
    given_name: 'Pat',
    family_name: 'Person',
    ...overrides,
  });

  beforeEach(() => {
    h = buildLifecycle();
    m = h.m;
    fx = peopleFixtures(m);
    users = Object.assign(repositoryOver(m, User), {
      createQueryBuilder: jest.fn((alias: string) => m.createQueryBuilder(User, alias)),
    });
    service = new IdentityProvisioningService(
      users as never,
      {
        findOne: jest.fn(async () => null),
        save: jest.fn(async (entity: object) => entity),
        create: jest.fn((values: object) => values),
      } as never,
      new ResidentRemovalService(h.service),
    );

    const plan = fx.plan();
    towerA = fx.tenant(plan, { name: 'Tower A' });
    towerB = fx.tenant(plan, { name: 'Tower B' });
  });

  it('a new sub gets a person row with the no-building sentinel and no membership', async () => {
    const person = await service.provisionFromToken(token());

    const stored = m.row(User, person.id);
    expect(stored).toMatchObject({
      email: 'person@example.test',
      userId: SUB,
      firstName: 'Pat',
      lastName: 'Person',
      role: LEGACY_SENTINEL.role,
      tenantId: LEGACY_SENTINEL.tenantId,
      status: UserStatus.ACTIVE,
    });
    expect(stored?.qrCode).toMatch(/^GR-/);
    expect(m.rows(Membership)).toHaveLength(0);
    expect('passwordHash' in person).toBe(false);
  });

  it('an existing person is returned as it is: an admin-made resident is not promoted', async () => {
    const resident = fx.person({
      email: 'person@example.test',
      userId: SUB,
      role: UserRole.RESIDENT,
      tenantId: towerB.id,
    });
    fx.membership(resident, towerB, { role: UserRole.RESIDENT });

    const person = await service.provisionFromToken(token());

    expect(person.id).toBe(resident.id);
    expect(m.row(User, resident.id)).toMatchObject({
      role: UserRole.RESIDENT,
      tenantId: towerB.id,
    });
    expect(users.save).not.toHaveBeenCalled();
    expect(m.rows(Membership)).toHaveLength(1);
  });

  it('a restore does not un-delete memberships, and ends any still live', async () => {
    const deletedAt = new Date('2026-05-01T00:00:00Z');
    const person = fx.person({
      email: 'person@example.test',
      userId: SUB,
      tenantId: towerA.id,
      deletedAt,
    } as Partial<User>);
    const ended = fx.membership(person, towerA, {
      role: UserRole.SECURITY,
      deletedAt,
    } as Partial<Membership>);
    // Left live by an older backend that soft-deleted only the person.
    const leftover = fx.membership(person, towerB, { role: UserRole.RESIDENT });

    const restored = await service.provisionFromToken(token());

    expect(restored.id).toBe(person.id);
    expect(m.row(User, person.id)).toMatchObject({
      deletedAt: null,
      tenantId: LEGACY_SENTINEL.tenantId,
      role: LEGACY_SENTINEL.role,
    });
    expect(m.row(Membership, ended.id)?.deletedAt).toEqual(deletedAt);
    expect(m.row(Membership, leftover.id)?.deletedAt).not.toBeNull();
    expect(m.rows(Membership).filter((row) => row.deletedAt == null)).toHaveLength(0);
  });

  it('a banned person gets 401, including one restored from deletion (status is kept)', async () => {
    fx.person({ email: 'person@example.test', userId: SUB, status: UserStatus.INACTIVE });
    await expect(service.provisionFromToken(token())).rejects.toThrow(
      new UnauthorizedException('User is not active'),
    );

    const other = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e';
    const deleted = fx.person({
      email: 'gone@example.test',
      userId: other,
      status: UserStatus.INACTIVE,
      deletedAt: new Date(),
    } as Partial<User>);
    await expect(
      service.provisionFromToken(token({ sub: other, email: 'gone@example.test' })),
    ).rejects.toThrow('User is not active');
    expect(m.row(User, deleted.id)).toMatchObject({ deletedAt: null, status: UserStatus.INACTIVE });
  });
});
