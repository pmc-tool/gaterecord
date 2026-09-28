/**
 * SEC-6 — security-alert cross-tenant fixes.
 *
 * Pure unit tests: every repository and collaborator is a jest mock.
 *   - a test alert naming another building's gate (or controller) is a 403;
 *   - a resident cannot false-alarm another building's alert;
 *   - a report created from a visitor-pass access event carries its host resident.
 */
import { BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { SecurityAlertService } from './security-alert.service';
import { SecurityAlertController } from './security-alert.controller';
import { User, UserRole } from '@database/entities/user.entity';
import { SecurityAlertStatus, SecurityAlertType } from '@database/entities/security-alert.entity';

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const GATE_A = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const GATE_B = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';
const DEVICE_B = 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2';
const RESIDENT_ID = 'd1d1d1d1-0000-4000-8000-000000000001';
const EVENT_ID = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1';

function makeUser(role: UserRole, tenantId: string | null, id = `user-${role}`): User {
  return { id, role, tenantId, email: `${id}@example.com` } as User;
}

describe('Security alerts — cross-tenant fixes (SEC-6)', () => {
  let alertRepository: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
  };
  let accessEventRepository: { findOne: jest.Mock };
  let userRepository: { findOne: jest.Mock; find: jest.Mock };
  let gateRepository: { findOne: jest.Mock };
  let deviceRepository: { findOne: jest.Mock; find: jest.Mock };
  let service: SecurityAlertService;
  let controller: SecurityAlertController;

  beforeAll(() => Logger.overrideLogger(false));

  beforeEach(() => {
    alertRepository = {
      create: jest.fn((a: Record<string, unknown>) => ({ id: 'alert-new', ...a })),
      save: jest.fn(async (a: unknown) => a),
      findOne: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
    };
    accessEventRepository = { findOne: jest.fn() };
    userRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
    };
    gateRepository = {
      findOne: jest.fn(async ({ where: { id } }: { where: { id: string } }) => {
        if (id === GATE_A) return { id: GATE_A, tenantId: TENANT_A };
        if (id === GATE_B) return { id: GATE_B, tenantId: TENANT_B };
        return null;
      }),
    };
    deviceRepository = {
      findOne: jest.fn(async ({ where }: { where: { id?: string; deviceId?: string } }) =>
        where.id === DEVICE_B || where.deviceId === 'SERIAL-B'
          ? { id: DEVICE_B, deviceId: 'SERIAL-B', tenantId: TENANT_B }
          : null,
      ),
      find: jest.fn().mockResolvedValue([]),
    };

    service = new SecurityAlertService(
      alertRepository as never,
      accessEventRepository as never,
      userRepository as never,
      gateRepository as never,
      deviceRepository as never,
      {
        broadcastSecurityAlert: jest.fn(),
        broadcastSecurityAlertUpdate: jest.fn(),
        triggerBuzzer: jest.fn(),
        stopBuzzer: jest.fn(),
      } as never,
      { sendSecurityAlertEmail: jest.fn() } as never,
      { notifySecurityAlert: jest.fn().mockResolvedValue(undefined) } as never,
      {
        triggerGateAlarm: jest.fn().mockResolvedValue({ successCount: 0, serials: [] }),
        triggerSecurityAlarm: jest.fn().mockResolvedValue({ success: false }),
      } as never,
      { arm: jest.fn(), disarm: jest.fn() } as never,
      { findTenantMembers: jest.fn().mockResolvedValue([]) } as never,
    );
    controller = new SecurityAlertController(service);
  });

  const asRequest = (user: User) => ({ user }) as never;

  describe('test endpoints', () => {
    const admin = makeUser(UserRole.BUILDING_ADMIN, TENANT_A);

    it("refuses a test alert on another building's gate", async () => {
      await expect(
        controller.createTestAlert(
          {
            type: SecurityAlertType.TAILGATING,
            title: 't',
            description: 'd',
            gateId: GATE_B,
          } as never,
          asRequest(admin),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(alertRepository.save).not.toHaveBeenCalled();
    });

    it("refuses a test alert on another building's controller (by id or serial)", async () => {
      for (const ref of [{ deviceId: DEVICE_B }, { controllerSerial: 'SERIAL-B' }]) {
        await expect(
          controller.createTestAlert(
            { type: SecurityAlertType.TAILGATING, title: 't', description: 'd', ...ref } as never,
            asRequest(admin),
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
      }
      expect(alertRepository.save).not.toHaveBeenCalled();
    });

    it("refuses a simulated denial on another building's gate, and a malformed gate id", async () => {
      await expect(
        controller.simulateDeniedAccess({ gateId: GATE_B }, asRequest(admin)),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        controller.simulateDeniedAccess({ gateId: 'not-a-uuid' }, asRequest(admin)),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(gateRepository.findOne).toHaveBeenCalledTimes(1);
      expect(alertRepository.save).not.toHaveBeenCalled();
    });

    it("allows a test alert on the caller's own gate", async () => {
      await expect(
        controller.createTestAlert(
          {
            type: SecurityAlertType.TAILGATING,
            title: 't',
            description: 'd',
            gateId: GATE_A,
          } as never,
          asRequest(admin),
        ),
      ).resolves.toMatchObject({ success: true });
      expect(alertRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT_A, gateId: GATE_A }),
      );
    });

    it('still refuses a tenantless caller with 400', async () => {
      await expect(
        controller.createTestAlert(
          { type: SecurityAlertType.TAILGATING, title: 't', description: 'd' } as never,
          asRequest(makeUser(UserRole.BUILDING_ADMIN, null)),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('markFalseAlarm (resident)', () => {
    it("refuses the resident's own report when it belongs to another building", async () => {
      const resident = makeUser(UserRole.RESIDENT, TENANT_A, RESIDENT_ID);
      alertRepository.findOne.mockResolvedValue({
        id: 'alert-1',
        tenantId: TENANT_B,
        residentId: RESIDENT_ID,
        status: SecurityAlertStatus.ACTIVE,
      });

      await expect(service.markFalseAlarm('alert-1', resident)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(alertRepository.save).not.toHaveBeenCalled();
    });

    it("still refuses someone else's report in the same building", async () => {
      const resident = makeUser(UserRole.RESIDENT, TENANT_A, RESIDENT_ID);
      alertRepository.findOne.mockResolvedValue({
        id: 'alert-1',
        tenantId: TENANT_A,
        residentId: 'someone-else',
      });

      await expect(service.markFalseAlarm('alert-1', resident)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('lets the resident cancel their own report in the building they act in', async () => {
      const resident = makeUser(UserRole.RESIDENT, TENANT_A, RESIDENT_ID);
      alertRepository.findOne.mockResolvedValue({
        id: 'alert-1',
        tenantId: TENANT_A,
        residentId: RESIDENT_ID,
      });

      await expect(service.markFalseAlarm('alert-1', resident)).resolves.toMatchObject({
        status: SecurityAlertStatus.FALSE_ALARM,
      });
    });
  });

  describe('reportUnauthorizedVisitor', () => {
    it("takes the host from the access event's resident_id (simulator visitor-pass events)", async () => {
      accessEventRepository.findOne.mockResolvedValue({
        id: EVENT_ID,
        tenantId: TENANT_A,
        gateId: GATE_A,
        residentId: RESIDENT_ID,
        subjectName: 'Visitor V',
        metadata: { source: 'simulator' },
        gate: { name: 'Main' },
        tenant: { name: 'Tower A' },
        timestamp: new Date(),
      });
      userRepository.findOne.mockResolvedValue({
        id: RESIDENT_ID,
        firstName: 'Host',
        lastName: 'Resident',
        email: 'host@example.com',
      });

      const token = service.generateReportToken(EVENT_ID);
      await service.reportUnauthorizedVisitor(EVENT_ID, token);

      expect(alertRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          residentId: RESIDENT_ID,
          reportedByEmail: 'host@example.com',
          tenantId: TENANT_A,
        }),
      );
    });

    it('falls back to metadata.residentId', async () => {
      accessEventRepository.findOne.mockResolvedValue({
        id: EVENT_ID,
        tenantId: TENANT_A,
        gateId: GATE_A,
        residentId: null,
        subjectName: 'Visitor V',
        metadata: { residentId: RESIDENT_ID },
        gate: { name: 'Main' },
        tenant: { name: 'Tower A' },
        timestamp: new Date(),
      });

      await service.reportUnauthorizedVisitor(EVENT_ID, service.generateReportToken(EVENT_ID));

      expect(alertRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ residentId: RESIDENT_ID }),
      );
    });
  });
});
