/**
 * GATE-8 — overlay regression: security alerts scope by the OVERLAID principal
 * (contract C5). P (admin of A, resident of B, security of C, and a super
 * admin) sees and acts on A's alerts as A's admin, only their own reports as
 * B's resident, C's alerts as C's security, and everything in the Platform
 * context.
 *
 * GATE-9 — the unauthorized-visitor EMAIL goes to the building's active admins
 * and security (from memberships) plus super admins, once per address.
 *
 * Pure unit tests: repositories are jest mocks, recipients come from the
 * in-memory MembershipAccessService (memberships/testing).
 */
import { ForbiddenException, Logger } from '@nestjs/common';
import { UserRole, UserStatus } from '@database/entities/user.entity';
import { SecurityAlertStatus } from '@database/entities/security-alert.entity';
import { SecurityAlertService } from './security-alert.service';
import {
  PERSON_P,
  TOWER_A,
  TOWER_B,
  TOWER_C,
  TOWER_D,
  makeMembership,
} from '../memberships/testing/overlaid-user.factory';
import {
  InMemoryMembershipAccessService,
  MembershipWorld,
  addPlainPerson,
  worldWithScenarioP,
} from '../memberships/testing/membership-world';
import {
  RecordingQueryBuilder,
  recordingQueryBuilder,
} from '../memberships/testing/recording-query-builder';

const ADMIN_OF_C = '12340000-0000-4000-8000-00000000000c';
const BANNED_OF_C = '12340000-0000-4000-8000-0000000000bc';
const RESIDENT_OF_C = '12340000-0000-4000-8000-0000000000ac';
const OTHER_SUPER_ADMIN = '12340000-0000-4000-8000-0000000000ff';

describe('SecurityAlertService', () => {
  let scenario: ReturnType<typeof worldWithScenarioP>;
  let world: MembershipWorld;
  let recorder: RecordingQueryBuilder;
  let alertRepository: { findOne: jest.Mock; save: jest.Mock; createQueryBuilder: jest.Mock };
  let userRepository: { find: jest.Mock; findOne: jest.Mock };
  let service: SecurityAlertService;

  beforeAll(() => Logger.overrideLogger(false));

  beforeEach(() => {
    scenario = worldWithScenarioP();
    world = scenario.world;
    recorder = recordingQueryBuilder();

    alertRepository = {
      findOne: jest.fn(async ({ where: { id } }: { where: { id: string } }) => {
        const [tenantId, residentId] = id.split('|');
        return {
          id,
          tenantId,
          residentId: residentId || null,
          status: SecurityAlertStatus.ACTIVE,
          buzzerTriggered: false,
          hardwareAlarmSent: false,
        };
      }),
      save: jest.fn(async (a: unknown) => a),
      createQueryBuilder: jest.fn(() => recorder.qb),
    };
    userRepository = {
      find: jest.fn(async ({ where }: { where: { role: UserRole; status: UserStatus } }) =>
        [...world.people.values()].filter(
          (p) => p.role === where.role && p.status === where.status && !p.deletedAt,
        ),
      ),
      findOne: jest.fn(),
    };

    service = new SecurityAlertService(
      alertRepository as never,
      {} as never,
      userRepository as never,
      {} as never,
      { find: jest.fn().mockResolvedValue([]) } as never,
      {
        broadcastSecurityAlert: jest.fn(),
        broadcastSecurityAlertUpdate: jest.fn(),
        stopBuzzer: jest.fn(),
      } as never,
      { sendSecurityAlertEmail: jest.fn() } as never,
      { notifySecurityAlert: jest.fn().mockResolvedValue(undefined) } as never,
      {} as never,
      { disarm: jest.fn() } as never,
      new InMemoryMembershipAccessService(world),
    );
  });

  const alertId = (tenantId: string, residentId = '') => `${tenantId}|${residentId}`;
  const tenantFilter = () => recorder.matching('alert.tenantId').map((c) => c.params?.tenantId);
  const residentFilter = () =>
    recorder.matching('alert.residentId').map((c) => c.params?.residentId);

  describe('listing (findAll / getStats) — GATE-8', () => {
    it('A context: all of A; B context: own reports in B; C context: all of C', async () => {
      await service.findAll(scenario.as.A, undefined, TOWER_D);
      expect(tenantFilter()).toEqual([TOWER_A]);
      expect(residentFilter()).toEqual([]);

      recorder.conditions.length = 0;
      await service.findAll(scenario.as.B);
      expect(tenantFilter()).toEqual([TOWER_B]);
      expect(residentFilter()).toEqual([PERSON_P]);

      recorder.conditions.length = 0;
      await service.getStats(scenario.as.C);
      expect(new Set(tenantFilter())).toEqual(new Set([TOWER_C]));
      expect(residentFilter()).toEqual([]);
    });

    it('Platform context: everything, or the building it names', async () => {
      await service.findAll(scenario.as.platform);
      expect(tenantFilter()).toEqual([]);

      await service.findAll(scenario.as.platform, undefined, TOWER_D);
      expect(tenantFilter()).toEqual([TOWER_D]);

      recorder.conditions.length = 0;
      await service.getStats(scenario.as.platform);
      expect(tenantFilter()).toEqual([]);
    });
  });

  describe('acting on an alert — GATE-8', () => {
    it("acknowledge / resolve: only the acting building's alerts (any for the Platform context)", async () => {
      await expect(service.acknowledge(alertId(TOWER_C), scenario.as.A)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(service.resolve(alertId(TOWER_C), scenario.as.B)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(service.acknowledge(alertId(TOWER_C), scenario.as.C)).resolves.toEqual(
        expect.objectContaining({ status: SecurityAlertStatus.ACKNOWLEDGED }),
      );
      await expect(service.resolve(alertId(TOWER_D), scenario.as.platform)).resolves.toEqual(
        expect.objectContaining({ status: SecurityAlertStatus.RESOLVED }),
      );
    });

    it("false alarm as B's resident: own report in B only, not their report in C", async () => {
      await expect(
        service.markFalseAlarm(alertId(TOWER_B, PERSON_P), scenario.as.B),
      ).resolves.toEqual(expect.objectContaining({ status: SecurityAlertStatus.FALSE_ALARM }));
      await expect(
        service.markFalseAlarm(alertId(TOWER_C, PERSON_P), scenario.as.B),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.markFalseAlarm(alertId(TOWER_B, ADMIN_OF_C), scenario.as.B),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // As C's security, any alert of C.
      await expect(
        service.markFalseAlarm(alertId(TOWER_C, ADMIN_OF_C), scenario.as.C),
      ).resolves.toBeDefined();
    });
  });

  describe('alert email recipients — GATE-9', () => {
    beforeEach(() => {
      for (const [id, role, status] of [
        [ADMIN_OF_C, UserRole.BUILDING_ADMIN, UserStatus.ACTIVE],
        [BANNED_OF_C, UserRole.SECURITY, UserStatus.INACTIVE],
        [RESIDENT_OF_C, UserRole.RESIDENT, UserStatus.ACTIVE],
      ] as const) {
        // Legacy rows name Tower A: the recipients must come from memberships.
        addPlainPerson(world, id, { role, status, tenantId: TOWER_A });
        world.addMembership(
          makeMembership(`${id.slice(0, 8)}-cccc-4ccc-8ccc-cccccccccccc`, id, TOWER_C, role),
        );
      }
      // Same address as P, different case: emailed once.
      addPlainPerson(world, OTHER_SUPER_ADMIN, {
        role: UserRole.SUPER_ADMIN,
        email: 'P@Example.Test',
      });
    });

    it("C's active admin and security plus super admins, once per address", async () => {
      const emails = await service.findAlertEmailRecipients(TOWER_C);

      expect(emails.map((e) => e.toLowerCase()).sort()).toEqual(
        [`${ADMIN_OF_C.slice(0, 8)}@example.test`, 'p@example.test'].sort(),
      );
    });

    it('a building with nobody gets the super admins only; a bad id reads no memberships', async () => {
      await expect(service.findAlertEmailRecipients(TOWER_D)).resolves.toEqual(['p@example.test']);
      await expect(service.findAlertEmailRecipients('nope')).resolves.toEqual(['p@example.test']);
    });
  });
});
