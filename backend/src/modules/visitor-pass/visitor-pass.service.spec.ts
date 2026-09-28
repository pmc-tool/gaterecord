/**
 * SEC-3 / GATE-6 — visitor passes are scoped to the building the request acts
 * in.
 *
 * Pure unit tests: the repositories are jest mocks and MembershipAccessService
 * reads an in-memory world (memberships/testing), so no database is needed.
 * They pin that:
 *   - a caller without a building context is refused with 409
 *     MEMBERSHIP_REQUIRED (the code the web opens the picker on) before any
 *     query runs, and ?tenantId= only narrows the Platform context's view;
 *   - a pass is created in the building acted in, with the host unit held there;
 *   - an on-premise host must be an ACTIVE resident of that building;
 *   - staff (and residents) only see the passes they created or host;
 *   - the public token routes are untouched.
 */
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { VisitorPassService } from './visitor-pass.service';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import {
  RegistrationType,
  VisitorPass,
  VisitorPassStatus,
} from '@database/entities/visitor-pass.entity';
import { membershipErrorCodeOf } from '@common/context/membership-context.errors';
import { CreateVisitorPassDto, ValidityType } from './dto/visitor-pass.dto';
import {
  MEMBERSHIP_PB,
  TOWER_A,
  TOWER_B,
  TOWER_C,
  makeMembership,
  overlaidUser,
} from '../memberships/testing/overlaid-user.factory';
import {
  InMemoryMembershipAccessService,
  addPlainPerson,
  worldWithScenarioP,
} from '../memberships/testing/membership-world';

const HOST_ID = '44444444-4444-4444-8444-444444444444';
const STAFF_ID = '55555555-5555-4555-8555-555555555555';

type QueryBuilderMock = {
  leftJoinAndSelect: jest.Mock;
  andWhere: jest.Mock;
  orderBy: jest.Mock;
  getMany: jest.Mock;
};

function makeQueryBuilder(): QueryBuilderMock {
  const qb = {} as QueryBuilderMock;
  qb.leftJoinAndSelect = jest.fn().mockReturnValue(qb);
  qb.andWhere = jest.fn().mockReturnValue(qb);
  qb.orderBy = jest.fn().mockReturnValue(qb);
  qb.getMany = jest.fn().mockResolvedValue([]);
  return qb;
}

/** A plain gate_users row (the legacy principal when the flag is off). */
function makeUser(overrides: Partial<User>): User {
  return {
    id: 'user-1',
    firstName: 'Test',
    lastName: 'User',
    email: 'test@example.com',
    role: UserRole.BUILDING_ADMIN,
    tenantId: TOWER_A,
    ...overrides,
  } as User;
}

function makePass(overrides: Partial<VisitorPass> = {}): VisitorPass {
  return {
    id: 'pass-1',
    qrToken: 'qr-token-1',
    tenantId: TOWER_A,
    createdById: 'someone-else',
    residentId: null,
    status: VisitorPassStatus.ACTIVE,
    ...overrides,
  } as unknown as VisitorPass;
}

function codeOf(promise: Promise<unknown>): Promise<string | null> {
  return promise.then(
    () => null,
    (error: unknown) => membershipErrorCodeOf(error),
  );
}

describe('VisitorPassService — building scope (SEC-3, GATE-6)', () => {
  let passRepository: {
    createQueryBuilder: jest.Mock;
    findOne: jest.Mock;
    count: jest.Mock;
    save: jest.Mock;
    remove: jest.Mock;
    create: jest.Mock;
  };
  let tenantRepository: { findOne: jest.Mock };
  let service: VisitorPassService;
  let qb: QueryBuilderMock;
  let scenario: ReturnType<typeof worldWithScenarioP>;

  beforeEach(() => {
    qb = makeQueryBuilder();
    passRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
      findOne: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      save: jest.fn(async (p: unknown) => p),
      remove: jest.fn(),
      create: jest.fn((p: unknown) => p),
    };
    tenantRepository = {
      findOne: jest.fn(async ({ where: { id } }: { where: { id: string } }) => ({
        id,
        subscriptionPlan: { maxVisitorPassesPerMonth: 100 },
      })),
    };

    scenario = worldWithScenarioP();
    service = new VisitorPassService(
      passRepository as never,
      tenantRepository as never,
      { get: jest.fn() } as never,
      new InMemoryMembershipAccessService(scenario.world),
    );
  });

  afterEach(() => {
    process.env.GATE_MEMBERSHIP_CONTEXT = 'off';
  });

  const tenantless = makeUser({ tenantId: null as unknown as string });
  const tenantlessResident = makeUser({
    role: UserRole.RESIDENT,
    tenantId: null as unknown as string,
  });

  describe('a caller without a building context gets 409 MEMBERSHIP_REQUIRED on every authenticated route', () => {
    it.each([
      ['findAll', () => service.findAll(tenantless, {})],
      ['getStats', () => service.getStats(tenantless)],
      ['findOne', () => service.findOne('pass-1', tenantless)],
      ['update', () => service.update('pass-1', {}, tenantless)],
      ['cancel', () => service.cancel('pass-1', tenantless)],
      ['remove', () => service.remove('pass-1', tenantless)],
      ['getQrCode', () => service.getQrCode('pass-1', tenantless)],
      ['findByTokenProtected', () => service.findByTokenProtected('qr-token-1', tenantless)],
      [
        'create',
        () =>
          service.create(
            {
              visitorName: 'Guest',
              validityType: ValidityType.SINGLE_USE,
            } as never,
            tenantlessResident,
          ),
      ],
    ])('%s', async (_name, call) => {
      const attempt = call();
      await expect(attempt).rejects.toBeInstanceOf(ConflictException);
      await expect(codeOf(attempt)).resolves.toBe('MEMBERSHIP_REQUIRED');

      // Refused before any repository access.
      expect(passRepository.createQueryBuilder).not.toHaveBeenCalled();
      expect(passRepository.findOne).not.toHaveBeenCalled();
      expect(passRepository.save).not.toHaveBeenCalled();
      expect(passRepository.remove).not.toHaveBeenCalled();
      expect(tenantRepository.findOne).not.toHaveBeenCalled();
    });

    it('also refuses a tenantless resident, and a request with no context at all', async () => {
      const none = overlaidUser(scenario.person, {
        kind: 'none',
        problem: 'MEMBERSHIP_REQUIRED',
        reason: 'AMBIGUOUS',
      });

      await expect(codeOf(service.findAll(tenantlessResident, {}))).resolves.toBe(
        'MEMBERSHIP_REQUIRED',
      );
      await expect(codeOf(service.findAll(none, {}))).resolves.toBe('MEMBERSHIP_REQUIRED');
    });
  });

  describe('findAll tenant filter', () => {
    const tenantCalls = () =>
      qb.andWhere.mock.calls.filter(([sql]) => String(sql).includes('pass.tenantId'));

    it('scopes a building admin to their own tenant and ignores ?tenantId=', async () => {
      await service.findAll(makeUser({}), { tenantId: TOWER_B });

      expect(tenantCalls()).toEqual([['pass.tenantId = :tenantId', { tenantId: TOWER_A }]]);
    });

    it('scopes P to the building P acts in, and ignores ?tenantId=', async () => {
      await service.findAll(scenario.as.C, { tenantId: TOWER_A });

      expect(tenantCalls()).toEqual([['pass.tenantId = :tenantId', { tenantId: TOWER_C }]]);
    });

    it('lets the Platform context narrow by ?tenantId=', async () => {
      await service.findAll(scenario.as.platform, { tenantId: TOWER_B });

      expect(qb.andWhere).toHaveBeenCalledWith('pass.tenantId = :tenantId', {
        tenantId: TOWER_B,
      });
    });

    it('gives a legacy super admin without ?tenantId= an unfiltered view', async () => {
      const superAdmin = makeUser({
        role: UserRole.SUPER_ADMIN,
        tenantId: null as unknown as string,
      });

      await service.findAll(superAdmin, {});

      expect(tenantCalls()).toHaveLength(0);
    });
  });

  describe('own-pass lens (STAFF_PASS_ROLES)', () => {
    const ownLens = () =>
      qb.andWhere.mock.calls.filter(([sql]) => String(sql).includes('pass.createdById'));

    it.each([
      ['resident', UserRole.RESIDENT, 1],
      ['staff', UserRole.STAFF, 1],
      ['security', UserRole.SECURITY, 0],
      ['building admin', UserRole.BUILDING_ADMIN, 0],
    ])('%s: %p own-pass filters', async (_label, role, expected) => {
      await service.findAll(makeUser({ id: STAFF_ID, role }), {});
      expect(ownLens()).toHaveLength(expected);
      await service.getStats(makeUser({ id: STAFF_ID, role }));
      expect(ownLens()).toHaveLength(expected * 2);
    });

    it("refuses staff another person's pass in their own building", async () => {
      passRepository.findOne.mockResolvedValue(makePass({ createdById: 'someone-else' }));

      await expect(
        service.findOne('pass-1', makeUser({ id: STAFF_ID, role: UserRole.STAFF })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('lets staff read a pass they created', async () => {
      const pass = makePass({ createdById: STAFF_ID });
      passRepository.findOne.mockResolvedValue(pass);

      await expect(
        service.findOne('pass-1', makeUser({ id: STAFF_ID, role: UserRole.STAFF })),
      ).resolves.toBe(pass);
    });

    it("refuses staff updating another person's pass", async () => {
      passRepository.findOne.mockResolvedValue(makePass({ createdById: 'someone-else' }));

      await expect(
        service.update('pass-1', {}, makeUser({ id: STAFF_ID, role: UserRole.STAFF })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('by-id access', () => {
    it("refuses another building's pass", async () => {
      passRepository.findOne.mockResolvedValue(makePass({ tenantId: TOWER_B }));

      await expect(service.findOne('pass-1', makeUser({}))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('refuses P acting as security of C a pass of B, where P is a resident', async () => {
      passRepository.findOne.mockResolvedValue(makePass({ tenantId: TOWER_B }));

      await expect(service.findOne('pass-1', scenario.as.C)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it("returns the caller's own-building pass", async () => {
      const pass = makePass();
      passRepository.findOne.mockResolvedValue(pass);

      await expect(service.findOne('pass-1', makeUser({}))).resolves.toBe(pass);
    });

    it('lets the Platform context read any building', async () => {
      const pass = makePass({ tenantId: TOWER_B });
      passRepository.findOne.mockResolvedValue(pass);

      await expect(service.findOne('pass-1', scenario.as.platform)).resolves.toBe(pass);
    });

    it("refuses another building's pass by token", async () => {
      passRepository.findOne.mockResolvedValue(makePass({ tenantId: TOWER_B }));

      await expect(service.findByTokenProtected('qr-token-1', makeUser({}))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('create in the acting building', () => {
    const selfService = {
      visitorName: 'Guest',
      validityType: ValidityType.SINGLE_USE,
    } as CreateVisitorPassDto;

    it('P acting as resident of B creates a B pass with host unit 12B', async () => {
      const pass = await service.create({ ...selfService, tenantId: TOWER_A }, scenario.as.B);

      expect(pass.tenantId).toBe(TOWER_B);
      expect(pass.hostUnit).toBe('12B');
      expect(pass.registrationType).toBe(RegistrationType.SELF_SERVICE);
      expect(pass.createdById).toBe(scenario.person.id);
    });

    describe('on-premise registration by staff', () => {
      const onPremise = (residentId?: string) =>
        ({
          visitorName: 'Guest',
          validityType: ValidityType.SINGLE_USE,
          registrationType: RegistrationType.ON_PREMISE,
          residentConfirmed: true,
          confirmationNotes: 'Called the flat',
          residentId,
        }) as CreateVisitorPassDto;

      const securityOfB = () =>
        makeUser({ id: STAFF_ID, role: UserRole.SECURITY, tenantId: TOWER_B });

      beforeEach(() => {
        process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
        addPlainPerson(scenario.world, HOST_ID, { tenantId: TOWER_A, role: UserRole.RESIDENT });
        scenario.world.addMembership(
          makeMembership(
            '66666666-6666-4666-8666-666666666666',
            HOST_ID,
            TOWER_B,
            UserRole.RESIDENT,
            {
              unit: '7C',
            },
          ),
        );
      });

      it("defaults the host unit to the host's unit in this building", async () => {
        const pass = await service.create(onPremise(HOST_ID), securityOfB());

        expect(pass.tenantId).toBe(TOWER_B);
        expect(pass.residentId).toBe(HOST_ID);
        expect(pass.hostUnit).toBe('7C');
      });

      it('names P as host in B with unit 12B', async () => {
        const pass = await service.create(onPremise(scenario.person.id), securityOfB());
        expect(pass.hostUnit).toBe('12B');
      });

      it('keeps a typed host unit', async () => {
        const pass = await service.create(
          { ...onPremise(HOST_ID), hostUnit: '1A' } as CreateVisitorPassDto,
          securityOfB(),
        );
        expect(pass.hostUnit).toBe('1A');
      });

      it("never uses the staff member's own unit", async () => {
        const pass = await service.create(
          onPremise(undefined),
          makeUser({ id: STAFF_ID, role: UserRole.SECURITY, tenantId: TOWER_B, unit: '99' }),
        );
        expect(pass.hostUnit).toBeUndefined();
      });

      it.each([
        ['a person with no role in the building', '77777777-7777-4777-8777-777777777777'],
        ['a resident of another building', HOST_ID],
      ])('refuses %s as host with 400', async (_label, residentId) => {
        const securityOfC = makeUser({ id: STAFF_ID, role: UserRole.SECURITY, tenantId: TOWER_C });
        const target = residentId === HOST_ID ? securityOfC : securityOfB();

        await expect(service.create(onPremise(residentId), target)).rejects.toBeInstanceOf(
          BadRequestException,
        );
        expect(passRepository.save).not.toHaveBeenCalled();
      });

      it('refuses a host whose resident role here is inactive', async () => {
        scenario.world.setMembershipStatus(MEMBERSHIP_PB, UserStatus.INACTIVE);

        await expect(
          service.create(onPremise(scenario.person.id), securityOfB()),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('refuses a host who is not a RESIDENT here (P is security of C)', async () => {
        const securityOfC = makeUser({ id: STAFF_ID, role: UserRole.SECURITY, tenantId: TOWER_C });

        await expect(
          service.create(onPremise(scenario.person.id), securityOfC),
        ).rejects.toBeInstanceOf(BadRequestException);
      });
    });
  });

  describe('public token routes are unchanged', () => {
    it('findByToken needs no caller', async () => {
      const pass = makePass({ tenantId: TOWER_B });
      passRepository.findOne.mockResolvedValue(pass);

      await expect(service.findByToken('qr-token-1')).resolves.toBe(pass);
    });

    it('getQrCodeByToken needs no caller', async () => {
      passRepository.findOne.mockResolvedValue(makePass({ tenantId: TOWER_B }));

      await expect(service.getQrCodeByToken('qr-token-1')).resolves.toMatch(/^data:image\/png/);
    });
  });
});
