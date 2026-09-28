/**
 * SEC-5 (gates half) — GatesService cross-tenant fixes.
 *
 * Pure unit tests with jest-mocked repositories (no database):
 *   - PATCH /gates/:id with a body tenantId leaves the tenant unchanged for a
 *     building admin, and still re-homes the gate for a super admin;
 *   - GET /gates is refused for a non-super-admin without a tenant: 409
 *     MEMBERSHIP_REQUIRED since GATE-7 (it was a plain 403 in SEC-5).
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import { membershipErrorCodeOf } from '@common/context/membership-context.errors';
import { GatesService } from './gates.service';
import { User, UserRole } from '@database/entities/user.entity';

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const GATE_ID = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';

function makeUser(role: UserRole, tenantId: string | null): User {
  return { id: `user-${role}`, role, tenantId } as User;
}

describe('GatesService — cross-tenant fixes (SEC-5)', () => {
  let gateRepository: {
    findOne: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let tenantRepository: { findOne: jest.Mock };
  let deviceConfigRepository: { find: jest.Mock };
  let service: GatesService;

  beforeEach(() => {
    gateRepository = {
      // findOne() by id returns the gate; the name-uniqueness lookup finds nothing.
      findOne: jest.fn(async ({ where }: { where: { id?: string } }) =>
        where.id === GATE_ID
          ? {
              id: GATE_ID,
              name: 'Main Entry',
              tenantId: TENANT_A,
              tenant: { id: TENANT_A },
            }
          : null,
      ),
      save: jest.fn(async (gate: unknown) => gate),
      createQueryBuilder: jest.fn(),
    };
    tenantRepository = {
      findOne: jest.fn(async ({ where: { id } }: { where: { id: string } }) =>
        id === TENANT_B ? { id: TENANT_B, name: 'Tower B' } : null,
      ),
    };
    deviceConfigRepository = { find: jest.fn().mockResolvedValue([]) };
    service = new GatesService(
      gateRepository as never,
      {} as never,
      {} as never,
      tenantRepository as never,
      deviceConfigRepository as never,
    );
  });

  describe('update', () => {
    it("ignores a building admin's body tenantId", async () => {
      const saved = await service.update(
        GATE_ID,
        { tenantId: TENANT_B, location: 'North' },
        makeUser(UserRole.BUILDING_ADMIN, TENANT_A),
      );

      expect(saved.tenantId).toBe(TENANT_A);
      expect(saved.tenant).toEqual({ id: TENANT_A });
      expect(saved.location).toBe('North');
      expect(tenantRepository.findOne).not.toHaveBeenCalled();
    });

    it('lets a super admin re-home the gate into an existing tenant', async () => {
      const saved = await service.update(
        GATE_ID,
        { tenantId: TENANT_B },
        makeUser(UserRole.SUPER_ADMIN, null),
      );

      expect(saved.tenantId).toBe(TENANT_B);
      // The loaded relation is replaced too, so it cannot win over tenant_id on save.
      expect(saved.tenant).toEqual({ id: TENANT_B, name: 'Tower B' });
      // Name uniqueness is checked in the TARGET building.
      expect(gateRepository.findOne).toHaveBeenCalledWith({
        where: { tenantId: TENANT_B, name: 'Main Entry' },
      });
    });

    it('refuses a super admin re-homing into a tenant that does not exist', async () => {
      await expect(
        service.update(
          GATE_ID,
          { tenantId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
          makeUser(UserRole.SUPER_ADMIN, null),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(gateRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('findAll', () => {
    it('is a 409 MEMBERSHIP_REQUIRED for a non-super-admin with a null tenant, before any query', async () => {
      const error = await service.findAll(makeUser(UserRole.BUILDING_ADMIN, null)).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ConflictException);
      expect(membershipErrorCodeOf(error)).toBe('MEMBERSHIP_REQUIRED');
      expect(gateRepository.createQueryBuilder).not.toHaveBeenCalled();
    });
  });
});
