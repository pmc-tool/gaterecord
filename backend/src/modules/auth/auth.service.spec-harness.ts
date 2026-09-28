/**
 * Test-only harness shared by the AuthService specs (session, signup, signup
 * membership). Builds an AuthService over jest doubles: no database, no mail,
 * a real JwtService so issued tokens can be decoded. Never imported by
 * application code.
 */
import { randomUUID } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { EntityManager } from 'typeorm';
import { User } from '@database/entities/user.entity';
import { Tenant } from '@database/entities/tenant.entity';
import { Membership } from '@database/entities/membership.entity';
import { MembershipContextService } from '../memberships/membership-context.service';
import { AuthService } from './auth.service';

export const AUTH_SPEC_JWT_SECRET = 'auth-service-spec-secret';

/** A chainable QueryBuilder double whose getOne() resolves to `result`. */
export function queryBuilderReturning<T>(result: T) {
  const qb: Record<string, jest.Mock> = {};
  for (const method of [
    'addSelect',
    'leftJoinAndSelect',
    'innerJoinAndSelect',
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
  ]) {
    qb[method] = jest.fn(() => qb);
  }
  qb.getOne = jest.fn(async () => result);
  return qb;
}

/** What the fake transaction wrote, in order. */
export interface TransactionLog {
  tenants: Tenant[];
  users: User[];
  committed: boolean;
}

export function buildAuthService() {
  const tx: TransactionLog = { tenants: [], users: [], committed: false };

  const manager = {
    create: jest.fn((target: new () => object, values: object) =>
      Object.assign(new target(), values),
    ),
    save: jest.fn(async (entity: { id?: string }) => {
      entity.id = entity.id ?? randomUUID();
      if (entity instanceof Tenant) tx.tenants.push(entity);
      if (entity instanceof User) tx.users.push(entity);
      return entity;
    }),
  };

  const dataSource = {
    // Like TypeORM: the work runs with the transaction's manager and nothing
    // "commits" if it throws.
    transaction: jest.fn(async (work: (m: EntityManager) => Promise<unknown>) => {
      const result = await work(manager as unknown as EntityManager);
      tx.committed = true;
      return result;
    }),
  };

  const users = {
    findOne: jest.fn(),
    update: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
    createQueryBuilder: jest.fn(() => queryBuilderReturning(null)),
  };
  const refreshTokens = {
    findOne: jest.fn(),
    update: jest.fn(),
    save: jest.fn(async (row: object) => row),
  };
  const tenants = {
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn(),
    create: jest.fn(),
  };
  const plans = {
    find: jest.fn().mockResolvedValue([{ id: randomUUID(), name: 'Starter', trialDays: 14 }]),
  };
  const loginHistory = {
    create: jest.fn((row: object) => row),
    save: jest.fn(async (row: object) => row),
  };
  const resetTokens = { findOne: jest.fn(), update: jest.fn(), save: jest.fn() };
  // As AuthModule registers it (JWT_ACCESS_EXPIRATION defaults to 7d).
  const jwt = new JwtService({ secret: AUTH_SPEC_JWT_SECRET, signOptions: { expiresIn: '7d' } });
  const config = { get: jest.fn((_key: string, fallback?: unknown) => fallback) };
  const email = { sendWelcomeEmail: jest.fn().mockResolvedValue(undefined) };
  const memberships = {
    add: jest.fn(async (input: Partial<Membership>) =>
      Object.assign(new Membership(), { id: randomUUID(), status: 'active', unit: null, ...input }),
    ),
    listActiveForPerson: jest.fn().mockResolvedValue([]),
    listForPerson: jest.fn().mockResolvedValue([]),
    findAdminMembership: jest.fn().mockResolvedValue(null),
  };
  // Only isPlatformAdmin is used by AuthService; the real one has no dependencies for it.
  const context = new MembershipContextService({} as never, {} as never);

  const service = new AuthService(
    users as never,
    refreshTokens as never,
    tenants as never,
    plans as never,
    loginHistory as never,
    resetTokens as never,
    jwt,
    config as never,
    email as never,
    dataSource as never,
    memberships as never,
    context,
  );

  return {
    service,
    users,
    refreshTokens,
    tenants,
    plans,
    loginHistory,
    jwt,
    email,
    memberships,
    dataSource,
    manager,
    tx,
  };
}

export type AuthHarness = ReturnType<typeof buildAuthService>;
