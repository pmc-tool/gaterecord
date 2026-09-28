/**
 * GATE-4 — a personal card is only issued to an ACTIVE resident of the
 * session's building (CARD_ISSUE_ROLES), judged by membership, not by the
 * legacy gate_users row.
 * GATE-5 — registration sessions are bound to the building the request acts
 * in: a session started in one context cannot be scanned, cancelled or listed
 * from another, while a hardware tap in the session's building still completes
 * it.
 *
 * Pure unit tests: repositories and the gateway are jest mocks; the holder
 * check runs the real MembershipAccessService over an in-memory world. The
 * service's cleanup interval runs on fake timers so jest can exit.
 *
 * Scenario: P is admin of A, resident of B (unit 12B), security of C; P's
 * legacy gate_users row names A.
 */
import { BadRequestException, ConflictException } from '@nestjs/common';
import { UserRole, UserStatus } from '@database/entities/user.entity';
import { membershipErrorCodeOf } from '@common/context/membership-context.errors';
import { RegistrationActor, RfidRegistrationService } from './rfid-registration.service';
import { RfidRegistrationController } from './rfid-registration.controller';
import {
  MEMBERSHIP_PB,
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

const VEHICLE_IN_C = '40404040-4040-4404-8404-404040404040';
const STRANGER = '50505050-5050-4505-8505-505050505050';

const actorIn = (tenantId: string | null): RegistrationActor => ({
  userId: 'actor',
  tenantId,
});

describe('RfidRegistrationService / RfidRegistrationController', () => {
  let scenario: ReturnType<typeof worldWithScenarioP>;
  let rfidCardRepository: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock };
  let vehicleRepository: { findOne: jest.Mock; save: jest.Mock };
  let gatewayService: { broadcastToTenant: jest.Mock };
  let service: RfidRegistrationService;
  let controller: RfidRegistrationController;

  beforeEach(() => {
    jest.useFakeTimers();
    scenario = worldWithScenarioP();

    rfidCardRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((c: unknown) => c),
      save: jest.fn(async (c: unknown) => c),
    };
    vehicleRepository = {
      findOne: jest.fn(async ({ where }: { where: { id?: string } }) =>
        where.id === VEHICLE_IN_C ? { id: VEHICLE_IN_C, tenantId: TOWER_C } : null,
      ),
      save: jest.fn(async (v: unknown) => v),
    };
    gatewayService = { broadcastToTenant: jest.fn() };

    service = new RfidRegistrationService(
      rfidCardRepository as never,
      vehicleRepository as never,
      { findOne: jest.fn() } as never,
      { findOne: jest.fn() } as never,
      gatewayService as never,
      new InMemoryMembershipAccessService(scenario.world),
    );
    controller = new RfidRegistrationController(service);
  });

  afterEach(() => {
    jest.useRealTimers();
    process.env.GATE_MEMBERSHIP_CONTEXT = 'off';
  });

  describe('resident card issue (GATE-4)', () => {
    const startForResident = (residentId: string, tenantId = TOWER_B) =>
      service.startSession('resident', residentId, tenantId);

    describe('membership source', () => {
      beforeEach(() => {
        process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
      });

      it('issues a card in B to P, an active resident of B whose legacy row says A', async () => {
        const { sessionId } = await startForResident(scenario.person.id);

        await expect(service.submitManualScan(sessionId, '1234', true)).resolves.toEqual({
          targetType: 'resident',
          uid: '1234',
        });
        expect(rfidCardRepository.save).toHaveBeenCalledWith(
          expect.objectContaining({ userId: scenario.person.id, tenantId: TOWER_B }),
        );
      });

      it('refuses someone with no resident role in the building', async () => {
        addPlainPerson(scenario.world, STRANGER, { tenantId: TOWER_B, role: UserRole.RESIDENT });
        const { sessionId } = await startForResident(STRANGER);

        await expect(service.submitManualScan(sessionId, '1234', true)).rejects.toThrow(
          'This resident is no longer in the building',
        );
        expect(rfidCardRepository.save).not.toHaveBeenCalled();
      });

      it('refuses P in C, where P is security, not a resident', async () => {
        const { sessionId } = await startForResident(scenario.person.id, TOWER_C);

        await expect(service.submitManualScan(sessionId, '1234', true)).rejects.toThrow(
          'This resident is no longer in the building',
        );
      });

      it('refuses a resident deactivated in the building', async () => {
        scenario.world.setMembershipStatus(MEMBERSHIP_PB, UserStatus.INACTIVE);
        const { sessionId } = await startForResident(scenario.person.id);

        await expect(service.submitManualScan(sessionId, '1234', true)).rejects.toThrow(
          'This resident is no longer in the building',
        );
      });
    });

    it("legacy source: follows the resident's gate_users row", async () => {
      addPlainPerson(scenario.world, STRANGER, { tenantId: TOWER_B, role: UserRole.RESIDENT });

      const forStranger = await startForResident(STRANGER);
      await expect(service.submitManualScan(forStranger.sessionId, '1111', true)).resolves.toEqual(
        expect.objectContaining({ uid: '1111' }),
      );

      // P's row names A, so not in B.
      const forP = await startForResident(scenario.person.id);
      await expect(service.submitManualScan(forP.sessionId, '2222', true)).rejects.toThrow(
        'This resident is no longer in the building',
      );
    });
  });

  describe('sessions are bound to the acting building (GATE-5)', () => {
    const startInC = () =>
      service.startSession('vehicle', VEHICLE_IN_C, TOWER_C, undefined, 'admin-c');

    it('a session started in C cannot be scanned from the B context', async () => {
      const { sessionId } = await startInC();

      await expect(
        service.submitManualScan(sessionId, 'AB12', true, actorIn(TOWER_B)),
      ).rejects.toThrow('Registration session not found or already completed');
      expect(vehicleRepository.save).not.toHaveBeenCalled();
    });

    it('a session started in C cannot be cancelled from the B context', async () => {
      const { sessionId } = await startInC();

      expect(service.cancelSession(sessionId, actorIn(TOWER_B))).toBe(false);
      // Still there for C.
      expect(service.cancelSession(sessionId, actorIn(TOWER_C))).toBe(true);
    });

    it('a same-context scan completes it', async () => {
      const { sessionId } = await startInC();

      await expect(
        service.submitManualScan(sessionId, 'AB12', true, actorIn(TOWER_C)),
      ).resolves.toEqual({ targetType: 'vehicle', uid: 'AB12' });
      expect(vehicleRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: VEHICLE_IN_C, rfidUid: 'AB12' }),
      );
    });

    it('the Platform context may act on any building', async () => {
      const { sessionId } = await startInC();
      expect(service.cancelSession(sessionId, actorIn(null))).toBe(true);
    });

    it('a Cloud Plus tap in C still completes it (no caller involved)', async () => {
      await startInC();

      await expect(service.processRegistrationScan(TOWER_C, 'CD34', 'vehicle', {})).resolves.toBe(
        true,
      );
      expect(vehicleRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ rfidUid: 'CD34' }),
      );
      expect(gatewayService.broadcastToTenant).toHaveBeenCalledWith(
        TOWER_C,
        'rfid:registration-scan',
        expect.objectContaining({ rfidUid: 'CD34' }),
      );
    });

    it('a tap in another building does not complete it', async () => {
      await startInC();
      await expect(service.processRegistrationScan(TOWER_B, 'CD34', 'vehicle', {})).resolves.toBe(
        false,
      );
    });

    it("the debug listing shows only the actor's building", async () => {
      await startInC();
      await service.startSession('resident', scenario.person.id, TOWER_B);

      expect(service.getActiveSessionsDebug(actorIn(TOWER_B))).toHaveLength(1);
      expect(service.getActiveSessionsDebug(actorIn(TOWER_C))).toEqual([
        expect.objectContaining({ tenantId: TOWER_C, startedById: 'admin-c' }),
      ]);
      expect(service.getActiveSessionsDebug(actorIn(null))).toHaveLength(2);
    });
  });

  describe('controller', () => {
    /** An admin of C, acting in C. */
    const adminOfC = () => {
      const person = addPlainPerson(scenario.world, STRANGER, {
        role: UserRole.BUILDING_ADMIN,
        tenantId: TOWER_C,
      });
      const membership = scenario.world.addMembership(
        makeMembership(
          '60606060-6060-4606-8606-606060606060',
          STRANGER,
          TOWER_C,
          UserRole.BUILDING_ADMIN,
        ),
      );
      return overlaidUser(person, { kind: 'membership', membership });
    };

    it('starts the session in the acting building, ignoring a body tenantId', async () => {
      const { sessionId } = await controller.startRegistration(adminOfC(), {
        targetType: 'vehicle',
        targetId: VEHICLE_IN_C,
        tenantId: TOWER_B,
      });

      expect(service.getActiveSessionsDebug()).toEqual([
        expect.objectContaining({ sessionId, tenantId: TOWER_C, startedById: STRANGER }),
      ]);
    });

    it('P acting as admin of A cannot scan or cancel a session of C', async () => {
      const { sessionId } = await controller.startRegistration(adminOfC(), {
        targetType: 'vehicle',
        targetId: VEHICLE_IN_C,
      });

      await expect(
        controller.submitScan(scenario.as.A, { sessionId, uid: 'AB12', raw: true }),
      ).rejects.toThrow(
        new BadRequestException('Registration session not found or already completed'),
      );
      expect(() => controller.cancelRegistration(scenario.as.A, { sessionId })).toThrow(
        new BadRequestException('Registration session not found or already expired'),
      );
      expect(controller.getStatus(scenario.as.A).hasActiveSessions).toEqual([]);
    });

    it('a platform super admin must name the building', async () => {
      const error = await controller
        .startRegistration(scenario.as.platform, { targetType: 'vehicle', targetId: VEHICLE_IN_C })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(membershipErrorCodeOf(error)).toBe('TENANT_REQUIRED');

      const { sessionId } = await controller.startRegistration(scenario.as.platform, {
        targetType: 'vehicle',
        targetId: VEHICLE_IN_C,
        tenantId: TOWER_C,
      });
      expect(service.getActiveSessionsDebug(actorIn(TOWER_C))).toEqual([
        expect.objectContaining({ sessionId }),
      ]);
    });

    it('a request without a building context is 409 MEMBERSHIP_REQUIRED', async () => {
      const none = overlaidUser(scenario.person, {
        kind: 'none',
        problem: 'MEMBERSHIP_REQUIRED',
        reason: 'AMBIGUOUS',
      });
      const tenantlessAdmin = addPlainPerson(
        scenario.world,
        '70707070-7070-4707-8707-707070707070',
        {
          role: UserRole.BUILDING_ADMIN,
          tenantId: null,
        },
      );

      for (const caller of [none, tenantlessAdmin]) {
        const error = await controller
          .startRegistration(caller, { targetType: 'vehicle', targetId: VEHICLE_IN_C })
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ConflictException);
        expect(membershipErrorCodeOf(error)).toBe('MEMBERSHIP_REQUIRED');
      }
    });
  });
});
