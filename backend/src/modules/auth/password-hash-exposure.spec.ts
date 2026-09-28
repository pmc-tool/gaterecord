import * as path from 'path';
import { DataSource, ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import { User } from '@database/entities/user.entity';
import { Vehicle } from '@database/entities/vehicle.entity';
import { RfidCard } from '@database/entities/rfid-card.entity';
import { SecurityAlert } from '@database/entities/security-alert.entity';
import { VisitorPass } from '@database/entities/visitor-pass.entity';
import { RefreshToken } from '@database/entities/refresh-token.entity';

/**
 * SEC-2: passwordHash is never serialised.
 *
 * Builds TypeORM metadata for every entity WITHOUT connecting and renders the
 * SQL of the queries behind each listed endpoint, with the same joins and
 * relations the services use. None of them may select gate_users.password_hash
 * any more (select: false also applies to relation joins, which is how a
 * building's admin or security member used to receive every joined person's
 * hash). The code paths that verify a password must still select it
 * explicitly. User.toJSON() strips an in-memory hash from any response body.
 */
describe('passwordHash exposure (SEC-2)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      url: process.env.DATABASE_URL,
      entities: [path.join(__dirname, '../../database/entities/*.entity.ts')],
    });
    // Metadata only; initialize() would connect.
    await (dataSource as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
  });

  function sqlOf<T extends ObjectLiteral>(qb: SelectQueryBuilder<T>): string {
    return qb.getQuery();
  }

  function found<T extends ObjectLiteral>(
    target: new () => T,
    alias: string,
    options: Parameters<SelectQueryBuilder<T>['setFindOptions']>[0],
  ): string {
    return sqlOf(
      dataSource.getRepository(target).createQueryBuilder(alias).setFindOptions(options),
    );
  }

  it('declares the column select: false', () => {
    const column = dataSource.getMetadata(User).findColumnWithPropertyName('passwordHash');
    expect(column?.databaseName).toBe('password_hash');
    expect(column?.isSelect).toBe(false);
  });

  const endpoints: Array<[string, () => string]> = [
    [
      // vehicles.service.ts findAll
      'GET /vehicles',
      () =>
        sqlOf(
          dataSource
            .getRepository(Vehicle)
            .createQueryBuilder('vehicle')
            .leftJoinAndSelect('vehicle.owner', 'owner')
            .leftJoinAndSelect('vehicle.tenant', 'tenant'),
        ),
    ],
    [
      // vehicles.service.ts findOne / findByRfidUid
      'GET /vehicles/:id',
      () => found(Vehicle, 'Vehicle', { where: {}, relations: ['owner', 'tenant'] }),
    ],
    [
      // rfid-cards.controller.ts findAll
      'GET /rfid-cards',
      () => found(RfidCard, 'RfidCard', { where: {}, relations: ['user', 'vehicle'] }),
    ],
    [
      // rfid-cards.controller.ts findOne
      'GET /rfid-cards/:id',
      () => found(RfidCard, 'RfidCard', { where: {}, relations: ['user'] }),
    ],
    [
      // security-alert.service.ts findAll
      'GET /security-alerts',
      () =>
        sqlOf(
          dataSource
            .getRepository(SecurityAlert)
            .createQueryBuilder('alert')
            .leftJoinAndSelect('alert.tenant', 'tenant')
            .leftJoinAndSelect('alert.accessEvent', 'accessEvent')
            .leftJoinAndSelect('alert.resident', 'resident')
            .leftJoinAndSelect('alert.acknowledgedBy', 'acknowledgedBy')
            .leftJoinAndSelect('alert.resolvedBy', 'resolvedBy'),
        ),
    ],
    [
      // visitor-pass.service.ts findAll
      'GET /visitor-passes',
      () =>
        sqlOf(
          dataSource
            .getRepository(VisitorPass)
            .createQueryBuilder('pass')
            .leftJoinAndSelect('pass.createdBy', 'createdBy')
            .leftJoinAndSelect('pass.tenant', 'tenant')
            .leftJoinAndSelect('pass.resident', 'resident'),
        ),
    ],
    [
      // visitor-pass.service.ts findOne
      'GET /visitor-passes/:id',
      () =>
        found(VisitorPass, 'VisitorPass', {
          where: {},
          relations: ['createdBy', 'tenant', 'resident'],
        }),
    ],
    [
      // users.service.ts findOne
      'GET /users/:id',
      () => found(User, 'User', { where: {}, relations: ['tenant', 'vehicles', 'rfidCards'] }),
    ],
    [
      // users.service.ts getProfile, and every strategy / guard person lookup
      'GET /users/profile',
      () => found(User, 'User', { where: {}, relations: ['tenant'] }),
    ],
    [
      // users.service.ts findAll
      'GET /users',
      () =>
        sqlOf(
          dataSource
            .getRepository(User)
            .createQueryBuilder('user')
            .leftJoinAndSelect('user.tenant', 'tenant'),
        ),
    ],
    [
      // auth.service.ts refreshTokens
      'POST /auth/refresh',
      () => found(RefreshToken, 'RefreshToken', { where: {}, relations: ['user', 'user.tenant'] }),
    ],
  ];

  it.each(endpoints)('%s does not select password_hash', (_endpoint, render) => {
    const sql = render();
    expect(sql).toMatch(/SELECT/);
    expect(sql).not.toContain('password_hash');
  });

  it('the password checks select it explicitly (login, signup resume, change-password)', () => {
    const verifying = sqlOf(
      dataSource
        .getRepository(User)
        .createQueryBuilder('user')
        .addSelect('user.passwordHash')
        .leftJoinAndSelect('user.tenant', 'tenant')
        .where('user.email = :email', { email: 'x@example.test' }),
    );
    expect(verifying).toContain('password_hash');
  });

  describe('User.toJSON', () => {
    it('drops an in-memory hash from a serialised person', () => {
      const created = Object.assign(new User(), {
        id: 'p',
        email: 'x@example.test',
        passwordHash: '$2b$10$in-memory-hash',
      });
      const json = JSON.parse(JSON.stringify(created));
      expect(json).toEqual({ id: 'p', email: 'x@example.test' });
      // The entity itself still carries it for the code that saved it.
      expect(created.passwordHash).toBe('$2b$10$in-memory-hash');
    });

    it('drops it from people nested in other payloads (vehicle owner, pass creator)', () => {
      const owner = Object.assign(new User(), { id: 'o', passwordHash: 'secret-hash' });
      const vehicle = Object.assign(new Vehicle(), { id: 'v', owner });
      const pass = Object.assign(new VisitorPass(), { id: 'vp', createdBy: owner });
      expect(JSON.stringify([vehicle, pass])).not.toContain('secret-hash');
      expect(JSON.stringify({ data: [vehicle], total: 1 })).not.toContain('passwordHash');
    });
  });
});
