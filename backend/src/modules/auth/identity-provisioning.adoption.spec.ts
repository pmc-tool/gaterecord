import { UnauthorizedException } from '@nestjs/common';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import { IdentityProvisioningService } from './identity-provisioning.service';
import { queryBuilderReturning } from './auth.service.spec-harness';

/**
 * SEC-9 (ordering only, O6) and AUTH-7: how a verified Keycloak token becomes a
 * person. Linked rows are untouched, a row linked to a different identity is
 * refused, the email fallbacks are deterministic (oldest first), and the
 * person is returned as loaded (no tenant reload, no hash).
 */
const SUB = '7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d';
const OTHER_SUB = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e';
const PERSON_ID = '0b6f6a3c-8a53-4d8e-9d1f-2c5a7b1e0a01';

function row(overrides: Partial<User> = {}): User {
  return Object.assign(new User(), {
    id: PERSON_ID,
    email: 'person@example.test',
    firstName: 'P',
    lastName: 'Person',
    role: UserRole.RESIDENT,
    status: UserStatus.ACTIVE,
    tenantId: 'aaaaaaaa-0000-4000-8000-00000000000a',
    userId: SUB,
    ...overrides,
  });
}

describe('IdentityProvisioningService adoption (SEC-9)', () => {
  let users: {
    findOne: jest.Mock;
    update: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let globalUsers: { findOne: jest.Mock; save: jest.Mock; create: jest.Mock };
  let removal: { restoreDeletedUser: jest.Mock };
  let service: IdentityProvisioningService;
  let builders: Array<ReturnType<typeof queryBuilderReturning>>;

  beforeEach(() => {
    builders = [];
    users = {
      findOne: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
      save: jest.fn(async (entity: User) => Object.assign(entity, { id: PERSON_ID })),
      create: jest.fn((values: Partial<User>) => Object.assign(new User(), values)),
      createQueryBuilder: jest.fn(() => {
        const qb = queryBuilderReturning<User | null>(null);
        qb.withDeleted = jest.fn(() => qb);
        builders.push(qb);
        return qb;
      }),
    };
    globalUsers = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn(async (entity: object) => entity),
      create: jest.fn((values: object) => values),
    };
    removal = { restoreDeletedUser: jest.fn() };
    service = new IdentityProvisioningService(
      users as never,
      globalUsers as never,
      removal as never,
    );
  });

  const token = (overrides: Record<string, unknown> = {}) => ({
    sub: SUB,
    email: 'Person@Example.test',
    email_verified: true,
    ...overrides,
  });

  it('returns an already linked row untouched, without an email lookup or a tenant reload', async () => {
    const linked = row();
    users.findOne.mockImplementation(async ({ where }: { where: Partial<User> }) =>
      where.userId === SUB ? linked : null,
    );

    const person = await service.provisionFromToken(token());

    expect(person).toBe(linked);
    expect(users.update).not.toHaveBeenCalled();
    expect(users.createQueryBuilder).not.toHaveBeenCalled();
    expect(users.findOne).toHaveBeenCalledTimes(1);
    expect(users.findOne).not.toHaveBeenCalledWith(
      expect.objectContaining({ relations: ['tenant'] }),
    );
  });

  it('adopts an unlinked row found by email by stamping userId', async () => {
    const unlinked = row({ userId: null });
    users.findOne.mockImplementation(async ({ where }: { where: Partial<User> }) =>
      where.email === 'person@example.test' ? unlinked : null,
    );

    const person = await service.provisionFromToken(token());

    expect(users.update).toHaveBeenCalledWith(PERSON_ID, { userId: SUB });
    expect(person.userId).toBe(SUB);
  });

  it('refuses (401) an email whose row is linked to a different identity, and changes nothing', async () => {
    users.findOne.mockImplementation(async ({ where }: { where: Partial<User> }) =>
      where.email === 'person@example.test' ? row({ userId: OTHER_SUB }) : null,
    );

    await expect(service.provisionFromToken(token())).rejects.toThrow(
      new UnauthorizedException('User not found'),
    );
    expect(users.update).not.toHaveBeenCalled();
    expect(users.save).not.toHaveBeenCalled();
  });

  it('the case-insensitive email fallback is deterministic: oldest row first', async () => {
    const legacy = row({ userId: null, email: 'PERSON@example.test' });
    users.createQueryBuilder.mockImplementationOnce(() => {
      const qb = queryBuilderReturning<User | null>(legacy);
      builders.push(qb);
      return qb;
    });

    await service.provisionFromToken(token());

    const [fallback] = builders;
    expect(fallback.where).toHaveBeenCalledWith('LOWER(user.email) = :email', {
      email: 'person@example.test',
    });
    expect(fallback.orderBy).toHaveBeenCalledWith('user.createdAt', 'ASC');
    expect(fallback.addOrderBy).toHaveBeenCalledWith('user.id', 'ASC');
    expect(users.update).toHaveBeenCalledWith(PERSON_ID, { userId: SUB });
  });

  it('the soft-deleted email lookup is deterministic too', async () => {
    users.save.mockImplementation(async (entity: User) => Object.assign(entity, { id: PERSON_ID }));

    await service.provisionFromToken(token());

    // [0] live email fallback, [1] soft-deleted email fallback
    const deleted = builders[1];
    expect(deleted.withDeleted).toHaveBeenCalled();
    expect(deleted.orderBy).toHaveBeenCalledWith('user.createdAt', 'ASC');
    expect(deleted.addOrderBy).toHaveBeenCalledWith('user.id', 'ASC');
  });

  it('creates a new person without handing the hash to the request', async () => {
    const person = await service.provisionFromToken(token());

    expect(users.save).toHaveBeenCalledTimes(1);
    const saved = users.save.mock.calls[0][0] as User;
    expect(saved).toMatchObject({
      email: 'person@example.test',
      userId: SUB,
      role: UserRole.BUILDING_ADMIN,
      tenantId: null,
    });
    expect('passwordHash' in person).toBe(false);
  });

  it('refuses a non-ACTIVE person with 401', async () => {
    users.findOne.mockResolvedValue(row({ status: UserStatus.INACTIVE }));
    await expect(service.provisionFromToken(token())).rejects.toThrow('User is not active');
  });

  it.todo(
    'refuses adoption when email_verified === false (deferred by O6; realm precondition in the runbook)',
  );
});
