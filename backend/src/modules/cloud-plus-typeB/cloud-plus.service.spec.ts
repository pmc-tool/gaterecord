/**
 * GATE-2 — Cloud Plus hardware decisions go through
 * MembershipAccessService.checkHolder.
 *
 * Pure unit tests: repositories and collaborators are jest mocks, and the
 * holder decisions run the REAL checkHolder over an in-memory world
 * (memberships/testing), in both GATE_MEMBERSHIP_CONTEXT modes. Scans are
 * driven through processSearchCardAcs with an explicit gate, the path the
 * simulator uses and the same validators real controllers reach.
 *
 * Scenario: P is admin of A, resident of B (unit 12B), security of C, nothing
 * at D. P owns a vehicle (tag and extra card) and a personal card in B.
 */
import { Logger } from '@nestjs/common';
import { UserRole, UserStatus } from '@database/entities/user.entity';
import { VehicleStatus } from '@database/entities/vehicle.entity';
import { RfidCardStatus } from '@database/entities/rfid-card.entity';
import { VisitorPassStatus } from '@database/entities/visitor-pass.entity';
import { AccessResult } from '@database/entities/access-event.entity';
import { CloudPlusService } from './cloud-plus.service';
import { CloudPlusCredentialType } from './dto/cloud-plus.dto';
import {
  MEMBERSHIP_PB,
  TOWER_A,
  TOWER_B,
  TOWER_C,
  TOWER_D,
} from '../memberships/testing/overlaid-user.factory';
import {
  InMemoryMembershipAccessService,
  addPlainPerson,
  worldWithScenarioP,
} from '../memberships/testing/membership-world';

const gate = (tenantId: string) => ({
  id: `${tenantId.slice(0, 8)}-9999-4999-8999-999999999999`,
  name: `Gate of ${tenantId.slice(0, 1).toUpperCase()}`,
  tenantId,
});

const VEHICLE_TAG = 'AA11BB22';
const VEHICLE_CARD = 'CC33DD44';
const PERSONAL_CARD = 'EE55FF66';
const LEGACY_RESIDENT = '88888888-8888-4888-8888-888888888888';

const b64 = (value: string) => Buffer.from(value, 'utf-8').toString('base64');

describe('CloudPlusService — holder decisions (GATE-2)', () => {
  let scenario: ReturnType<typeof worldWithScenarioP>;
  let service: CloudPlusService;
  let savedEvents: Array<Record<string, unknown>>;
  let visitorPass: Record<string, unknown> | null;

  beforeAll(() => Logger.overrideLogger(false));

  beforeEach(() => {
    scenario = worldWithScenarioP();
    const { world, person } = scenario;
    addPlainPerson(world, LEGACY_RESIDENT, {
      role: UserRole.RESIDENT,
      tenantId: TOWER_B,
      unit: '5A',
      qrCode: 'GR-LEGACY',
    } as never);

    const vehicleOfP = {
      id: 'vehicle-p',
      tenantId: TOWER_B,
      ownerId: person.id,
      owner: person,
      licensePlate: 'P-123',
      rfidUid: VEHICLE_TAG,
      status: VehicleStatus.ACTIVE,
    };

    savedEvents = [];
    visitorPass = null;

    const vehicleRepository = {
      findOne: jest.fn(async ({ where }: { where: { tenantId: string; rfidUid: string } }) =>
        where.tenantId === TOWER_B && where.rfidUid === VEHICLE_TAG ? vehicleOfP : null,
      ),
    };
    const rfidCardRepository = {
      findOne: jest.fn(async ({ where }: { where: { tenantId: string; uid: string } }) => {
        if (where.tenantId !== TOWER_B) return null;
        if (where.uid === VEHICLE_CARD) {
          return {
            id: 'card-vehicle',
            tenantId: TOWER_B,
            uid: VEHICLE_CARD,
            status: RfidCardStatus.ACTIVE,
            vehicleId: vehicleOfP.id,
            vehicle: vehicleOfP,
          };
        }
        if (where.uid === PERSONAL_CARD) {
          return {
            id: 'card-person',
            tenantId: TOWER_B,
            uid: PERSONAL_CARD,
            status: RfidCardStatus.ACTIVE,
            userId: person.id,
            user: person,
          };
        }
        return null;
      }),
    };
    const userRepository = {
      findOne: jest.fn(
        async ({ where }: { where: { qrCode: string } }) =>
          [...world.people.values()].find((p) => p.qrCode === where.qrCode && !p.deletedAt) ?? null,
      ),
    };
    const visitorPassRepository = {
      findOne: jest.fn(async () => visitorPass),
      save: jest.fn(async (p: unknown) => p),
    };
    const accessEventRepository = {
      create: jest.fn((e: Record<string, unknown>) => e),
      save: jest.fn(async (e: Record<string, unknown>) => {
        const saved = { id: `event-${savedEvents.length + 1}`, ...e };
        savedEvents.push(saved);
        return saved;
      }),
    };

    service = new CloudPlusService(
      { findOne: jest.fn().mockResolvedValue(null), save: jest.fn() } as never,
      { save: jest.fn() } as never,
      vehicleRepository as never,
      rfidCardRepository as never,
      visitorPassRepository as never,
      accessEventRepository as never,
      userRepository as never,
      { broadcastToTenant: jest.fn() } as never,
      { hasActiveSession: jest.fn().mockReturnValue(false) } as never,
      { consume: jest.fn() } as never,
      new InMemoryMembershipAccessService(world),
    );
  });

  afterEach(() => {
    process.env.GATE_MEMBERSHIP_CONTEXT = 'off';
  });

  const scanQr = (tenantId: string, token = 'GR-PERSON-P') =>
    service.processSearchCardAcs(
      { Serial: '', Card: b64(token), type: CloudPlusCredentialType.QR_BASE64 } as never,
      '',
      undefined,
      gate(tenantId) as never,
    );

  const scanCard = (tenantId: string, uid: string, handleType?: 'vehicle' | 'human') =>
    service.processSearchCardAcs(
      { Serial: '', Card: uid, type: CloudPlusCredentialType.CARD } as never,
      '',
      handleType,
      gate(tenantId) as never,
    );

  const lastEvent = () => savedEvents[savedEvents.length - 1];

  describe('membership source (GATE_MEMBERSHIP_CONTEXT=on)', () => {
    beforeEach(() => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
    });

    it("P's one QR code opens A, B and C and is denied at D", async () => {
      for (const tenantId of [TOWER_A, TOWER_B, TOWER_C]) {
        const response = await scanQr(tenantId);
        expect({ tenantId, allowed: response.AcsRes }).toEqual({ tenantId, allowed: '1' });
        expect(lastEvent().result).toBe(AccessResult.ALLOWED);
      }

      const atD = await scanQr(TOWER_D);
      expect(atD.AcsRes).toBe('0');
      expect(lastEvent()).toEqual(
        expect.objectContaining({
          tenantId: TOWER_D,
          result: AccessResult.DENIED,
          denialReason: 'User does not belong to this building',
          residentId: scenario.person.id,
        }),
      );
    });

    it('greets with the unit held in the gate building', async () => {
      await scanQr(TOWER_B);
      expect((lastEvent().metadata as { info: string }).info).toBe('Unit 12B');

      await scanQr(TOWER_A);
      expect((lastEvent().metadata as { info: string }).info).toBe('Welcome');
    });

    it('P inactive in B: QR, card, vehicle tag and vehicle card are denied at B only', async () => {
      scenario.world.setMembershipStatus(MEMBERSHIP_PB, UserStatus.INACTIVE);

      expect((await scanQr(TOWER_B)).AcsRes).toBe('0');
      expect(lastEvent().denialReason).toBe('User account is inactive');

      expect((await scanCard(TOWER_B, PERSONAL_CARD, 'human')).AcsRes).toBe('0');
      expect(lastEvent().denialReason).toBe('Card holder access inactive');

      expect((await scanCard(TOWER_B, VEHICLE_TAG, 'vehicle')).AcsRes).toBe('0');
      expect(lastEvent().denialReason).toBe('Owner access inactive');

      expect((await scanCard(TOWER_B, VEHICLE_CARD)).AcsRes).toBe('0');
      expect(lastEvent().denialReason).toBe('Owner access inactive');

      // Still fine elsewhere.
      expect((await scanQr(TOWER_A)).AcsRes).toBe('1');
      expect((await scanQr(TOWER_C)).AcsRes).toBe('1');
    });

    it('a pending role in B is denied like an inactive one', async () => {
      scenario.world.setMembershipStatus(MEMBERSHIP_PB, UserStatus.PENDING);

      expect((await scanQr(TOWER_B)).AcsRes).toBe('0');
      expect(lastEvent().denialReason).toBe('User account is pending');
      expect((await scanCard(TOWER_B, PERSONAL_CARD)).AcsRes).toBe('0');
      expect(lastEvent().denialReason).toBe('Card holder access inactive');
    });

    it('a platform ban denies P everywhere, on every credential', async () => {
      scenario.person.status = UserStatus.INACTIVE;

      for (const tenantId of [TOWER_A, TOWER_B, TOWER_C]) {
        expect((await scanQr(tenantId)).AcsRes).toBe('0');
      }
      expect((await scanCard(TOWER_B, PERSONAL_CARD)).AcsRes).toBe('0');
      expect(lastEvent().denialReason).toBe('Card holder account disabled');
      expect((await scanCard(TOWER_B, VEHICLE_TAG)).AcsRes).toBe('0');
      expect(lastEvent().denialReason).toBe('Owner account disabled');
    });

    it('cards and vehicles work while P is active in B, whatever the legacy row says', async () => {
      // P's legacy gate_users row names Tower A.
      expect(scenario.person.tenantId).toBe(TOWER_A);

      expect((await scanCard(TOWER_B, PERSONAL_CARD)).AcsRes).toBe('1');
      expect((await scanCard(TOWER_B, VEHICLE_TAG)).AcsRes).toBe('1');
      expect((await scanCard(TOWER_B, VEHICLE_CARD)).AcsRes).toBe('1');
    });

    it('a card whose holder left the building is denied as before', async () => {
      scenario.memberships.B.deletedAt = new Date();

      expect((await scanCard(TOWER_B, PERSONAL_CARD)).AcsRes).toBe('0');
      expect(lastEvent().denialReason).toBe('Card holder no longer in this building');
      expect((await scanCard(TOWER_B, VEHICLE_TAG)).AcsRes).toBe('0');
      expect(lastEvent().denialReason).toBe('Owner no longer in this building');
    });
  });

  describe('legacy source (flag off): results match the gate_users comparison', () => {
    it("a resident's QR opens only the building on their row, with their unit", async () => {
      const atB = await scanQr(TOWER_B, 'GR-LEGACY');
      expect(atB.AcsRes).toBe('1');
      expect((lastEvent().metadata as { info: string }).info).toBe('Unit 5A');

      const atA = await scanQr(TOWER_A, 'GR-LEGACY');
      expect(atA.AcsRes).toBe('0');
      expect(lastEvent()).toEqual(
        expect.objectContaining({
          denialReason: 'User does not belong to this building',
          subjectName: 'Some One',
        }),
      );
    });

    it('an inactive row is refused with the same wording as before', async () => {
      scenario.world.people.get(LEGACY_RESIDENT)!.status = UserStatus.INACTIVE;

      expect((await scanQr(TOWER_B, 'GR-LEGACY')).AcsRes).toBe('0');
      expect(lastEvent().denialReason).toBe('User account is inactive');
      expect((lastEvent().metadata as { info: string }).info).toBe('Account inactive');
    });

    it("P's QR follows the legacy row (Tower A) and ignores memberships", async () => {
      expect((await scanQr(TOWER_A)).AcsRes).toBe('1');
      expect((await scanQr(TOWER_B)).AcsRes).toBe('0');
    });

    it("cards check the holder's row: P's card in B is refused (row says A)", async () => {
      expect((await scanCard(TOWER_B, PERSONAL_CARD)).AcsRes).toBe('0');
      expect(lastEvent().denialReason).toBe('Card holder no longer in this building');
    });

    it('an unknown QR code is still "Invalid user QR code"', async () => {
      expect((await scanQr(TOWER_B, 'GR-NOBODY')).AcsRes).toBe('0');
      expect(lastEvent().denialReason).toBe('Invalid user QR code');
    });
  });

  describe('visitor passes', () => {
    const HOST = '99999999-9999-4999-8999-999999999999';
    const CREATOR = 'aaaaaaaa-9999-4999-8999-999999999999';

    const pass = (overrides: Record<string, unknown> = {}) => ({
      id: 'pass-1',
      tenantId: TOWER_B,
      qrToken: 'visitor-token',
      visitorName: 'Guest',
      purpose: 'Dinner',
      status: VisitorPassStatus.ACTIVE,
      validFrom: new Date(Date.now() - 60_000),
      validUntil: new Date(Date.now() + 60_000),
      useCount: 0,
      maxUses: 5,
      createdById: CREATOR,
      residentId: HOST,
      ...overrides,
    });

    it("records the host resident on the event, else the pass's creator", async () => {
      visitorPass = pass();
      expect((await scanQr(TOWER_B, 'visitor-token')).AcsRes).toBe('1');
      expect(lastEvent().residentId).toBe(HOST);

      visitorPass = pass({ residentId: null });
      await scanQr(TOWER_B, 'visitor-token');
      expect(lastEvent().residentId).toBe(CREATOR);

      visitorPass = pass({ status: VisitorPassStatus.CANCELLED });
      expect((await scanQr(TOWER_B, 'visitor-token')).AcsRes).toBe('0');
      expect(lastEvent().residentId).toBe(HOST);
    });
  });
});
