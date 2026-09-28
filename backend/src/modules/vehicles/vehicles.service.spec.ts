/**
 * GATE-4 — a vehicle's owner must be ACTIVE in the vehicle's building, judged
 * by their membership there (MembershipAccessService.hasActiveMembership with
 * VEHICLE_OWNER_ROLES), not by their legacy gate_users row. GATE-8 — list and
 * by-id scoping follow the overlaid principal.
 *
 * Pure unit tests: repositories are jest mocks and the holder check runs the
 * real MembershipAccessService over an in-memory world, in both
 * GATE_MEMBERSHIP_CONTEXT modes.
 *
 * Scenario: P is admin of A, resident of B (unit 12B), security of C; P's
 * legacy gate_users row names A.
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { UserRole, UserStatus } from '@database/entities/user.entity';
import { VehiclesService } from './vehicles.service';
import { CreateVehicleDto } from './dto/vehicle.dto';
import {
  MEMBERSHIP_PB,
  TOWER_A,
  TOWER_B,
  makeMembership,
  overlaidUser,
} from '../memberships/testing/overlaid-user.factory';
import {
  InMemoryMembershipAccessService,
  addPlainPerson,
  worldWithScenarioP,
} from '../memberships/testing/membership-world';

const ADMIN_OF_B = '10101010-1010-4101-8101-101010101010';
const STRANGER = '20202020-2020-4202-8202-202020202020';

describe('VehiclesService', () => {
  let scenario: ReturnType<typeof worldWithScenarioP>;
  let vehicleRepository: {
    findOne: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let qbWhere: jest.Mock;
  let service: VehiclesService;

  beforeEach(() => {
    scenario = worldWithScenarioP();
    qbWhere = jest.fn();
    const qb: Record<string, jest.Mock> = {};
    for (const method of ['leftJoinAndSelect', 'andWhere', 'orderBy', 'skip', 'take']) {
      qb[method] = jest.fn(() => qb);
    }
    qb.where = jest.fn((...args: unknown[]) => {
      qbWhere(...args);
      return qb;
    });
    qb.getManyAndCount = jest.fn().mockResolvedValue([[], 0]);

    vehicleRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn((v: unknown) => v),
      save: jest.fn(async (v: unknown) => v),
      createQueryBuilder: jest.fn(() => qb),
    };
    service = new VehiclesService(
      vehicleRepository as never,
      {
        findOne: jest.fn(async ({ where: { id } }: { where: { id: string } }) => ({
          id,
          subscriptionPlan: { maxVehicles: 10 },
        })),
      } as never,
      new InMemoryMembershipAccessService(scenario.world),
    );
  });

  afterEach(() => {
    process.env.GATE_MEMBERSHIP_CONTEXT = 'off';
  });

  /** B's building admin, acting in B (membership context). */
  const adminOfB = () => {
    const person = addPlainPerson(scenario.world, ADMIN_OF_B, {
      role: UserRole.BUILDING_ADMIN,
      tenantId: TOWER_B,
    });
    const membership = scenario.world.addMembership(
      makeMembership(
        '30303030-3030-4303-8303-303030303030',
        person.id,
        TOWER_B,
        UserRole.BUILDING_ADMIN,
      ),
    );
    return overlaidUser(person, { kind: 'membership', membership });
  };

  const dto = (ownerId: string): CreateVehicleDto =>
    ({
      licensePlate: 'P-123',
      rfidUid: 'AA11BB22',
      ownerId,
    }) as CreateVehicleDto;

  describe('owner check at registration (membership source)', () => {
    beforeEach(() => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
    });

    it("B's admin registers a vehicle for P, an active resident of B whose legacy row says A", async () => {
      expect(scenario.person.tenantId).toBe(TOWER_A);

      const vehicle = await service.create(dto(scenario.person.id), adminOfB());

      expect(vehicle).toEqual(
        expect.objectContaining({ tenantId: TOWER_B, ownerId: scenario.person.id }),
      );
      expect(vehicleRepository.save).toHaveBeenCalledTimes(1);
    });

    it('rejects an owner with no role in the building', async () => {
      addPlainPerson(scenario.world, STRANGER, { tenantId: TOWER_B });

      await expect(service.create(dto(STRANGER), adminOfB())).rejects.toThrow(
        new BadRequestException('The owner must be a resident of this building'),
      );
      expect(vehicleRepository.save).not.toHaveBeenCalled();
    });

    it('rejects an owner whose role in the building is inactive', async () => {
      scenario.world.setMembershipStatus(MEMBERSHIP_PB, UserStatus.INACTIVE);

      await expect(service.create(dto(scenario.person.id), adminOfB())).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects a non-uuid owner id without a query', async () => {
      await expect(service.create(dto('not-a-uuid'), adminOfB())).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('checks a new owner on update in the vehicle building', async () => {
      vehicleRepository.findOne.mockImplementation(async ({ where }: { where: { id?: string } }) =>
        where.id ? { id: where.id, tenantId: TOWER_B, ownerId: ADMIN_OF_B } : null,
      );
      const admin = adminOfB();
      addPlainPerson(scenario.world, STRANGER, { tenantId: TOWER_B });

      await expect(
        service.update('vehicle-1', { ownerId: STRANGER }, admin),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.update('vehicle-1', { ownerId: scenario.person.id }, admin),
      ).resolves.toEqual(expect.objectContaining({ ownerId: scenario.person.id }));
    });
  });

  describe('owner check at registration (legacy source)', () => {
    it("follows the owner's gate_users row, as before", async () => {
      const legacyAdminOfB = addPlainPerson(scenario.world, ADMIN_OF_B, {
        role: UserRole.BUILDING_ADMIN,
        tenantId: TOWER_B,
      });
      addPlainPerson(scenario.world, STRANGER, { tenantId: TOWER_B });

      // P's row says A: refused in B.
      await expect(service.create(dto(scenario.person.id), legacyAdminOfB)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      // A resident whose row says B: accepted.
      await expect(service.create(dto(STRANGER), legacyAdminOfB)).resolves.toEqual(
        expect.objectContaining({ tenantId: TOWER_B }),
      );
    });

    it('now also refuses an owner whose row is inactive', async () => {
      const legacyAdminOfB = addPlainPerson(scenario.world, ADMIN_OF_B, {
        role: UserRole.BUILDING_ADMIN,
        tenantId: TOWER_B,
      });
      addPlainPerson(scenario.world, STRANGER, { tenantId: TOWER_B, status: UserStatus.INACTIVE });

      await expect(service.create(dto(STRANGER), legacyAdminOfB)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('scope follows the overlaid principal (GATE-8)', () => {
    it('lists the building P acts in, and everything in the Platform context', async () => {
      await service.findAll(scenario.as.A, { tenantId: TOWER_B } as never);
      expect(qbWhere).toHaveBeenLastCalledWith('vehicle.tenantId = :tenantId', {
        tenantId: TOWER_A,
      });

      await service.findAll(scenario.as.B);
      expect(qbWhere).toHaveBeenLastCalledWith('vehicle.tenantId = :tenantId', {
        tenantId: TOWER_B,
      });

      qbWhere.mockClear();
      await service.findAll(scenario.as.platform);
      expect(qbWhere).not.toHaveBeenCalled();
    });

    it('refuses P acting in A a vehicle of B, and allows it acting in B', async () => {
      vehicleRepository.findOne.mockResolvedValue({ id: 'vehicle-b', tenantId: TOWER_B });

      await expect(service.findOne('vehicle-b', scenario.as.A)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(service.findOne('vehicle-b', scenario.as.B)).resolves.toEqual(
        expect.objectContaining({ id: 'vehicle-b' }),
      );
    });
  });
});
