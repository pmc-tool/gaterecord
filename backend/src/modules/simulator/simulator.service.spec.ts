/**
 * GATE-3 — the simulator's personal-QR path decides like the hardware
 * (MembershipAccessService.checkHolder with PERSONAL_QR_ROLES), and records the
 * role and unit held in the GATE's building. GATE-9 — a visitor-entry
 * notification is tagged with the gate's building. GATE-8 — the operator
 * checks follow the overlaid principal.
 *
 * Pure unit tests: repositories and collaborators are jest mocks; holder
 * decisions run the real checkHolder over an in-memory world, in both
 * GATE_MEMBERSHIP_CONTEXT modes.
 *
 * Scenario: P is admin of A, resident of B (unit 12B), security of C, nothing
 * at D; P's legacy gate_users row names A.
 */
import { ForbiddenException, Logger } from '@nestjs/common';
import { UserRole, UserStatus } from '@database/entities/user.entity';
import { GateState } from '@database/entities/gate.entity';
import { AccessResult } from '@database/entities/access-event.entity';
import { VisitorPassStatus } from '@database/entities/visitor-pass.entity';
import { SimulatorService } from './simulator.service';
import { SimulatorEvent } from './dto/simulator.dto';
import {
  MEMBERSHIP_PB,
  TOWER_A,
  TOWER_B,
  TOWER_C,
  TOWER_D,
} from '../memberships/testing/overlaid-user.factory';
import {
  InMemoryMembershipAccessService,
  worldWithScenarioP,
} from '../memberships/testing/membership-world';

const gateOf = (tenantId: string) => ({
  id: `${tenantId.slice(0, 8)}-7777-4777-8777-777777777777`,
  name: `Gate ${tenantId.slice(0, 1).toUpperCase()}`,
  tenantId,
  state: GateState.CLOSED,
  tenant: { id: tenantId, name: `Tower ${tenantId.slice(0, 1).toUpperCase()}` },
});

const GATES = Object.fromEntries(
  [TOWER_A, TOWER_B, TOWER_C, TOWER_D].map((t) => [gateOf(t).id, gateOf(t)]),
);

describe('SimulatorService', () => {
  let scenario: ReturnType<typeof worldWithScenarioP>;
  let service: SimulatorService;
  let savedEvents: Array<Record<string, unknown>>;
  let notificationService: { notifyVisitorEntry: jest.Mock };
  let visitorPass: Record<string, unknown> | null;

  beforeAll(() => Logger.overrideLogger(false));

  beforeEach(() => {
    scenario = worldWithScenarioP();
    savedEvents = [];
    visitorPass = null;
    notificationService = { notifyVisitorEntry: jest.fn().mockResolvedValue(undefined) };

    service = new SimulatorService(
      { sendVisitorEntryNotification: jest.fn().mockResolvedValue(undefined) } as never,
      notificationService as never,
      { generateReportToken: jest.fn().mockReturnValue('token') } as never,
      { get: jest.fn((_key: string, fallback: string) => fallback) } as never,
      {} as never,
      new InMemoryMembershipAccessService(scenario.world),
      {
        findOne: jest.fn(async ({ where: { id } }: { where: { id: string } }) =>
          GATES[id] ? { ...GATES[id] } : null,
        ),
        save: jest.fn(async (g: unknown) => g),
      } as never,
      {} as never,
      {} as never,
      {
        findOne: jest.fn(async () => visitorPass),
        update: jest.fn(),
      } as never,
      {
        create: jest.fn((e: Record<string, unknown>) => e),
        save: jest.fn(async (e: Record<string, unknown>) => {
          const saved = { id: `event-${savedEvents.length + 1}`, createdAt: new Date(), ...e };
          savedEvents.push(saved);
          return saved;
        }),
      } as never,
      {
        findOne: jest.fn(
          async ({ where }: { where: { qrCode: string } }) =>
            [...scenario.world.people.values()].find((p) => p.qrCode === where.qrCode) ?? null,
        ),
      } as never,
    );
  });

  afterEach(() => {
    process.env.GATE_MEMBERSHIP_CONTEXT = 'off';
  });

  const qrAt = (tenantId: string, qrToken = 'GR-PERSON-P') =>
    service.triggerEvent(
      gateOf(tenantId).id,
      { event: SimulatorEvent.QR_VERIFIED, qrToken },
      scenario.as.platform,
    );

  const lastEvent = () => savedEvents[savedEvents.length - 1];

  describe('personal QR, membership source (flag on)', () => {
    beforeEach(() => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
    });

    it("P's QR opens A, B and C and is denied at D", async () => {
      for (const tenantId of [TOWER_A, TOWER_B, TOWER_C]) {
        const result = await qrAt(tenantId);
        expect({ tenantId, success: result.success }).toEqual({ tenantId, success: true });
      }

      const atD = await qrAt(TOWER_D);
      expect(atD.success).toBe(false);
      expect(atD.message).toBe('Access denied - Wrong building');
      expect(lastEvent().denialReason).toBe('User does not belong to this building');
    });

    it("records the role and unit held in the gate's building", async () => {
      const atB = await qrAt(TOWER_B);
      expect(lastEvent().metadata).toEqual(
        expect.objectContaining({ userRole: UserRole.RESIDENT, unit: '12B' }),
      );
      expect(atB.message).toBe('Access granted - Pat Person (Unit 12B)');

      await qrAt(TOWER_C);
      expect(lastEvent().metadata).toEqual(
        expect.objectContaining({ userRole: UserRole.SECURITY, unit: null }),
      );
    });

    it('matches the hardware on an inactive role and on a ban', async () => {
      scenario.world.setMembershipStatus(MEMBERSHIP_PB, UserStatus.INACTIVE);
      const atB = await qrAt(TOWER_B);
      expect(atB.success).toBe(false);
      expect(atB.message).toBe('Access denied - Account inactive');
      expect((await qrAt(TOWER_A)).success).toBe(true);

      scenario.person.status = UserStatus.INACTIVE;
      expect((await qrAt(TOWER_A)).success).toBe(false);
      expect((await qrAt(TOWER_C)).success).toBe(false);
    });
  });

  describe('personal QR, legacy source (flag off)', () => {
    it("follows P's gate_users row: A only, with the row's role", async () => {
      expect((await qrAt(TOWER_A)).success).toBe(true);
      expect(lastEvent().metadata).toEqual(
        expect.objectContaining({ userRole: UserRole.SUPER_ADMIN }),
      );
      expect((await qrAt(TOWER_B)).success).toBe(false);
    });

    it('an unknown code is still an invalid user QR code', async () => {
      const result = await qrAt(TOWER_A, 'GR-NOBODY');
      expect(result.message).toBe('Access denied - Invalid user QR code');
      expect(lastEvent().result).toBe(AccessResult.DENIED);
    });
  });

  describe('operator scope follows the overlaid principal', () => {
    it("P acting in B (resident) or C cannot trigger A's gate; acting in A can", async () => {
      const manual = { event: SimulatorEvent.MANUAL_OPEN };

      await expect(
        service.triggerEvent(gateOf(TOWER_A).id, manual, scenario.as.B),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.triggerEvent(gateOf(TOWER_A).id, manual, scenario.as.C),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.triggerEvent(gateOf(TOWER_A).id, manual, scenario.as.A),
      ).resolves.toEqual(expect.objectContaining({ success: true }));
      await expect(
        service.triggerEvent(gateOf(TOWER_D).id, manual, scenario.as.platform),
      ).resolves.toEqual(expect.objectContaining({ success: true }));
    });
  });

  describe('visitor entry notification (GATE-9)', () => {
    it("is tagged with the gate's building, not the host's legacy row", async () => {
      const HOST = scenario.person;
      visitorPass = {
        id: 'pass-1',
        tenantId: TOWER_B,
        qrToken: 'visitor',
        visitorName: 'Guest',
        status: VisitorPassStatus.ACTIVE,
        validFrom: new Date(Date.now() - 60_000),
        validUntil: new Date(Date.now() + 60_000),
        useCount: 0,
        maxUses: 3,
        createdById: HOST.id,
        residentId: HOST.id,
        resident: HOST,
        createdBy: HOST,
        tenant: { id: TOWER_B, name: 'Tower B' },
      };

      const result = await qrAt(TOWER_B, 'visitor');
      // The notification is sent in the background.
      await new Promise((resolve) => setImmediate(resolve));

      expect(result.success).toBe(true);
      expect(notificationService.notifyVisitorEntry).toHaveBeenCalledWith(
        HOST.id,
        TOWER_B,
        'Guest',
        gateOf(TOWER_B).name,
        expect.any(Object),
        false,
      );
      // P's legacy row names Tower A; the notification must not.
      expect(HOST.tenantId).toBe(TOWER_A);
    });
  });
});
