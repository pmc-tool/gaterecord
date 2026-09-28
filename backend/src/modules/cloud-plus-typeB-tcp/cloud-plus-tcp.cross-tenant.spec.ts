/**
 * SEC-5 (TCP half) — tcp/connected scope check, tenantless controller listing,
 * and who a manual TCP open is recorded against. GATE-7: a caller without a
 * building context now gets 409 MEMBERSHIP_REQUIRED (assertBuildingContext),
 * the code the web opens the picker on, instead of a plain 403.
 *
 * Pure unit tests: repositories, the TCP server and collaborators are jest mocks.
 */
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { membershipErrorCodeOf } from '@common/context/membership-context.errors';
import { CloudPlusTcpService } from './cloud-plus-tcp.service';
import { CloudPlusTcpController, TcpServerController } from './cloud-plus-tcp.controller';
import { User, UserRole } from '@database/entities/user.entity';
import { GateAction } from './dto';
import { scenarioP } from '../memberships/testing/overlaid-user.factory';

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const GATE_B = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';

function makeUser(role: UserRole, tenantId: string | null): User {
  return { id: `user-${role}`, firstName: 'Op', lastName: 'Erator', role, tenantId } as User;
}

describe('Cloud Plus TCP — cross-tenant fixes (SEC-5)', () => {
  let tcpServer: {
    isConnected: jest.Mock;
    sendCommand: jest.Mock;
    getConnectedControllers: jest.Mock;
    getStatus: jest.Mock;
  };
  let gateRepository: { findOne: jest.Mock; save: jest.Mock };
  let deviceConfigRepository: { find: jest.Mock; findOne: jest.Mock };
  let accessEventRepository: { create: jest.Mock; save: jest.Mock };
  let service: CloudPlusTcpService;

  beforeEach(() => {
    tcpServer = {
      isConnected: jest.fn().mockReturnValue(true),
      sendCommand: jest.fn().mockReturnValue(true),
      getConnectedControllers: jest.fn().mockReturnValue([]),
      getStatus: jest.fn().mockReturnValue({ controllers: [] }),
    };
    gateRepository = {
      findOne: jest.fn(async ({ where: { id } }: { where: { id: string } }) =>
        id === GATE_B ? { id: GATE_B, name: 'Gate B', tenantId: TENANT_B } : null,
      ),
      save: jest.fn(async (gate: unknown) => gate),
    };
    deviceConfigRepository = {
      find: jest.fn().mockResolvedValue([{ deviceId: 'SERIAL-B', gateId: GATE_B }]),
      findOne: jest.fn(),
    };
    accessEventRepository = {
      create: jest.fn((e: unknown) => e),
      save: jest.fn(async (e: unknown) => e),
    };
    service = new CloudPlusTcpService(
      tcpServer as never,
      { broadcastToTenant: jest.fn() } as never,
      {} as never,
      { emit: jest.fn() } as never,
      deviceConfigRepository as never,
      gateRepository as never,
      accessEventRepository as never,
    );
  });

  describe('GET gates/:gateId/tcp/connected', () => {
    it("is a 403 for another building's gate", async () => {
      const controller = new CloudPlusTcpController(service);

      await expect(
        controller.isGateConnected(GATE_B, { user: makeUser(UserRole.BUILDING_ADMIN, TENANT_A) }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(deviceConfigRepository.find).not.toHaveBeenCalled();
    });

    it('is a 409 MEMBERSHIP_REQUIRED for a tenantless caller, before any lookup', async () => {
      const error = await rejectionOf(
        service.assertGateInScope(GATE_B, makeUser(UserRole.SECURITY, null)),
      );
      expect(error).toBeInstanceOf(ConflictException);
      expect(membershipErrorCodeOf(error)).toBe('MEMBERSHIP_REQUIRED');
      expect(gateRepository.findOne).not.toHaveBeenCalled();
    });

    it('follows the membership context: P as security of C is refused B, the Platform context is not', async () => {
      const { as } = scenarioP();

      await expect(service.assertGateInScope(GATE_B, as.C)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(service.assertGateInScope(GATE_B, as.platform)).resolves.toEqual(
        expect.objectContaining({ id: GATE_B }),
      );
    });

    it('is a 404 for an unknown gate', async () => {
      await expect(
        service.assertGateInScope(
          'ffffffff-ffff-4fff-8fff-ffffffffffff',
          makeUser(UserRole.SUPER_ADMIN, null),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("answers for the caller's own building and for a super admin", async () => {
      const controller = new CloudPlusTcpController(service);

      await expect(
        controller.isGateConnected(GATE_B, { user: makeUser(UserRole.SECURITY, TENANT_B) }),
      ).resolves.toEqual({ connected: true });
      await expect(
        controller.isGateConnected(GATE_B, { user: makeUser(UserRole.SUPER_ADMIN, null) }),
      ).resolves.toEqual({ connected: true });
    });
  });

  describe('GET tcp/controllers', () => {
    it('is a 409 MEMBERSHIP_REQUIRED for a tenantless building admin', async () => {
      const controller = new TcpServerController(service);

      const error = await rejectionOf(
        controller.getConnectedControllers({ user: makeUser(UserRole.BUILDING_ADMIN, null) }),
      );
      expect(error).toBeInstanceOf(ConflictException);
      expect(membershipErrorCodeOf(error)).toBe('MEMBERSHIP_REQUIRED');
      expect(deviceConfigRepository.find).not.toHaveBeenCalled();
    });

    it("lists only the acting building's controllers for P acting in A", async () => {
      const controller = new TcpServerController(service);
      const { as } = scenarioP();

      await controller.getConnectedControllers({ user: as.A });

      expect(deviceConfigRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenantId: as.A.tenantId } }),
      );
    });
  });

  describe('manual TCP open', () => {
    it('records the operator, not a resident', async () => {
      const operator = makeUser(UserRole.BUILDING_ADMIN, TENANT_B);

      await service.controlGate(GATE_B, GateAction.OPEN, operator);

      expect(accessEventRepository.save).toHaveBeenCalledTimes(1);
      const event = accessEventRepository.save.mock.calls[0][0];
      expect(event).toEqual(
        expect.objectContaining({
          operatorId: operator.id,
          operatorName: 'Op Erator',
          subjectId: operator.id,
        }),
      );
      expect(event.residentId ?? null).toBeNull();
    });
  });
});
