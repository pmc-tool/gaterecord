/**
 * SEC-8 / GATE-11 / GATE-12 — authenticated sockets that act as ONE membership.
 *
 * Pure unit tests. SocketAuthService and the Gate repository are jest mocks;
 * the context is resolved by the REAL MembershipContextService and
 * SocketContextService over an in-memory world (memberships/testing), in both
 * GATE_MEMBERSHIP_CONTEXT modes. The Socket.IO namespace is a tiny in-memory
 * fake that delivers `to(rooms)` emits to the fake sockets in those rooms (once
 * per socket, like Socket.IO), so the tests can assert who actually receives an
 * event. No server, no database.
 */
import { Logger } from '@nestjs/common';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import { SecurityAlert } from '@database/entities/security-alert.entity';
import { EventsGateway } from './events.gateway';
import { GatewayService } from './gateway.service';
import { PLATFORM_ROOM, ROOM_FORBIDDEN, residentsRoom, tenantRoom } from './socket-access';
import { personRoom } from './rooms';
import { SocketContextService } from './socket-context.service';
import { SimulatorGateway } from '../simulator/simulator.gateway';
import { SocketAuthError } from '../auth/socket-auth.service';
import {
  MEMBERSHIP_PA,
  MEMBERSHIP_PB,
  MEMBERSHIP_PC,
  PERSON_P,
  TOWER_A,
  TOWER_B,
  TOWER_C,
  makeMembership,
} from '../memberships/testing/overlaid-user.factory';
import {
  MembershipWorld,
  addPlainPerson,
  inMemoryContextService,
  worldWithScenarioP,
} from '../memberships/testing/membership-world';

const GATE_A = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const GATE_B = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';
const GATE_C = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const GATE_TENANTS: Record<string, string> = {
  [GATE_A]: TOWER_A,
  [GATE_B]: TOWER_B,
  [GATE_C]: TOWER_C,
};

interface Received {
  event: string;
  data: unknown;
}

interface FakeSocket {
  id: string;
  data: Record<string, unknown>;
  handshake: {
    auth: Record<string, unknown>;
    headers: Record<string, string | string[] | undefined>;
  };
  rooms: Set<string>;
  received: Received[];
  join: jest.Mock;
  leave: jest.Mock;
  emit: jest.Mock;
  disconnect: jest.Mock;
}

let socketSeq = 0;
let personSeq = 0;

function makeSocket(
  personId?: string,
  auth: Record<string, unknown> = {},
  headers: Record<string, string | string[] | undefined> = {},
): FakeSocket {
  const socket = {
    id: `socket-${++socketSeq}`,
    data: {},
    handshake: { auth: { token: personId ?? 'no-token', ...auth }, headers },
    rooms: new Set<string>(),
    received: [] as Received[],
  } as unknown as FakeSocket;
  socket.rooms.add(socket.id);
  socket.join = jest.fn((room: string) => socket.rooms.add(room));
  socket.leave = jest.fn((room: string) => socket.rooms.delete(room));
  socket.emit = jest.fn((event: string, data: unknown) => socket.received.push({ event, data }));
  socket.disconnect = jest.fn();
  return socket;
}

function makeNamespace(sockets: FakeSocket[]) {
  const deliver = (rooms: string[] | null, event: string, data: unknown) => {
    for (const socket of sockets) {
      if (!rooms || rooms.some((room) => socket.rooms.has(room))) {
        socket.received.push({ event, data });
      }
    }
  };
  return {
    use: jest.fn(),
    to: (rooms: string | string[]) => ({
      emit: (event: string, data: unknown) =>
        deliver(Array.isArray(rooms) ? rooms : [rooms], event, data),
    }),
    emit: (event: string, data: unknown) => deliver(null, event, data),
  };
}

const eventsOf = (socket: FakeSocket, event: string) =>
  socket.received.filter((r) => r.event === event);

const errorCodesOf = (socket: FakeSocket) =>
  eventsOf(socket, 'error').map((e) => (e.data as { code: string }).code);

/** A uuid-shaped id per test person. */
const nextPersonId = () => `00000000-0000-4000-8000-${String(++personSeq).padStart(12, '0')}`;

/**
 * The collaborators every test builds: a world, SocketAuthService resolving the
 * handshake token (the person id) to the person row, and the real
 * SocketContextService on top.
 */
function buildContext(world: MembershipWorld) {
  const socketAuthService = {
    authenticate: jest.fn(async (handshake: { auth?: { token?: unknown } }) => {
      const person = world.livePerson(String(handshake?.auth?.token));
      if (!person) throw new SocketAuthError('User not found');
      if (person.status !== UserStatus.ACTIVE) throw new SocketAuthError('User is not active');
      return person;
    }),
  };
  const userRepository = {
    findOne: jest.fn(async ({ where: { id } }: { where: { id: string } }) => world.livePerson(id)),
  };
  const socketContextService = new SocketContextService(
    socketAuthService as never,
    inMemoryContextService(world),
    userRepository as never,
  );
  return { socketAuthService, socketContextService };
}

const gateRepository = () => ({
  findOne: jest.fn(async ({ where: { id } }: { where: { id: string } }) =>
    GATE_TENANTS[id] ? { id, tenantId: GATE_TENANTS[id] } : null,
  ),
});

describe('EventsGateway', () => {
  let world: MembershipWorld;
  let sockets: FakeSocket[];
  let socketAuthService: ReturnType<typeof buildContext>['socketAuthService'];
  let socketContextService: SocketContextService;
  let gates: ReturnType<typeof gateRepository>;
  let gateway: EventsGateway;
  let middleware: (socket: unknown, next: (err?: Error) => void) => void;

  beforeAll(() => Logger.overrideLogger(false));

  afterEach(() => {
    process.env.GATE_MEMBERSHIP_CONTEXT = 'off';
  });

  function setUp(w: MembershipWorld) {
    world = w;
    for (const tenant of [TOWER_A, TOWER_B, TOWER_C]) {
      if (!world.tenants.has(tenant)) world.addTenant(tenant);
    }
    sockets = [];
    ({ socketAuthService, socketContextService } = buildContext(world));
    gates = gateRepository();
    gateway = new EventsGateway(socketContextService, gates as never);
    gateway.server = makeNamespace(sockets) as never;
    const ns = makeNamespace(sockets);
    gateway.afterInit(ns as never);
    middleware = ns.use.mock.calls[0][0];
  }

  /** Runs the handshake middleware; resolves to the refusal, or undefined. */
  function handshake(socket: FakeSocket): Promise<(Error & { data?: unknown }) | undefined> {
    return new Promise((resolve) => middleware(socket, (err) => resolve(err)));
  }

  /** A socket that went through the auth middleware and the connection hook. */
  async function connect(
    personId: string,
    auth: Record<string, unknown> = {},
    headers: Record<string, string | string[] | undefined> = {},
  ): Promise<FakeSocket> {
    const socket = makeSocket(personId, auth, headers);
    const refusal = await handshake(socket);
    if (refusal) throw refusal;
    sockets.push(socket);
    gateway.handleConnection(socket as never);
    return socket;
  }

  /** A legacy (flag off) person: their gate_users row is the context. */
  function legacyPerson(role: UserRole, tenantId: string | null): string {
    return addPlainPerson(world, nextPersonId(), { role, tenantId }).id;
  }

  // -------------------------------------------------------------------------
  // SEC-8 behaviour, legacy mode (GATE_MEMBERSHIP_CONTEXT off)
  // -------------------------------------------------------------------------

  describe('handshake authentication (SEC-8)', () => {
    beforeEach(() => setUp(new MembershipWorld()));

    it('refuses an unauthenticated socket with connect_error AUTH_FAILED', async () => {
      socketAuthService.authenticate.mockRejectedValueOnce(
        new SocketAuthError('No token provided'),
      );
      const socket = makeSocket();

      const err = await handshake(socket);

      expect(err).toBeInstanceOf(Error);
      expect(err?.message).toBe('No token provided');
      expect(err?.data).toEqual({ code: 'AUTH_FAILED', message: 'No token provided' });
      expect(socket.data.user).toBeUndefined();
    });

    it('hides unexpected failures behind a generic reason', async () => {
      socketAuthService.authenticate.mockRejectedValueOnce(new Error('database is down'));

      const err = await handshake(makeSocket());

      expect(err?.data).toEqual({ code: 'AUTH_FAILED', message: 'Authentication failed' });
    });

    it('stores the acting principal (legacy overlay of the person) on socket.data.user', async () => {
      const personId = legacyPerson(UserRole.BUILDING_ADMIN, TOWER_A);
      const socket = makeSocket(personId);

      const err = await handshake(socket);

      expect(err).toBeUndefined();
      expect(socket.data.user).toEqual(
        expect.objectContaining({
          id: personId,
          contextKind: 'legacy',
          role: UserRole.BUILDING_ADMIN,
          tenantId: TOWER_A,
        }),
      );
      expect(socketAuthService.authenticate).toHaveBeenCalledWith(socket.handshake);
    });

    it('drops a connection that somehow arrives without a user', () => {
      const socket = makeSocket();
      gateway.handleConnection(socket as never);
      expect(socket.disconnect).toHaveBeenCalledWith(true);
    });
  });

  describe('default rooms on connect (legacy mode)', () => {
    beforeEach(() => setUp(new MembershipWorld()));

    it('staff roles join their building staff room, residents the residents room, super admins platform', async () => {
      const adminId = legacyPerson(UserRole.BUILDING_ADMIN, TOWER_A);
      const admin = await connect(adminId);
      const security = await connect(legacyPerson(UserRole.SECURITY, TOWER_A));
      const staff = await connect(legacyPerson(UserRole.STAFF, TOWER_A));
      const superAdmin = await connect(legacyPerson(UserRole.SUPER_ADMIN, null));
      const resident = await connect(legacyPerson(UserRole.RESIDENT, TOWER_A));

      expect(admin.rooms.has(tenantRoom(TOWER_A))).toBe(true);
      expect(admin.rooms.has(personRoom(adminId))).toBe(true);
      expect(security.rooms.has(tenantRoom(TOWER_A))).toBe(true);
      expect(staff.rooms.has(tenantRoom(TOWER_A))).toBe(true);
      expect(superAdmin.rooms.has(PLATFORM_ROOM)).toBe(true);
      expect(resident.rooms.has(tenantRoom(TOWER_A))).toBe(false);
      expect(resident.rooms.has(residentsRoom(TOWER_A))).toBe(true);
      expect(resident.rooms.has(PLATFORM_ROOM)).toBe(false);
    });

    it('a tenantless building admin sits in their person room only', async () => {
      const id = legacyPerson(UserRole.BUILDING_ADMIN, null);
      const socket = await connect(id);

      expect([...socket.rooms].sort()).toEqual([personRoom(id), socket.id].sort());
    });
  });

  describe('join:tenant (legacy mode)', () => {
    beforeEach(() => setUp(new MembershipWorld()));

    it('refuses a resident, even for their own building', async () => {
      const resident = await connect(legacyPerson(UserRole.RESIDENT, TOWER_A));

      await gateway.handleJoinTenant(resident as never, { tenantId: TOWER_A });

      expect(resident.rooms.has(tenantRoom(TOWER_A))).toBe(false);
      expect(errorCodesOf(resident)).toEqual([ROOM_FORBIDDEN]);
    });

    it("refuses a building admin joining another building's room", async () => {
      const admin = await connect(legacyPerson(UserRole.BUILDING_ADMIN, TOWER_A));

      await gateway.handleJoinTenant(admin as never, { tenantId: TOWER_C });

      expect(admin.rooms.has(tenantRoom(TOWER_C))).toBe(false);
      expect(errorCodesOf(admin)).toEqual([ROOM_FORBIDDEN]);
    });

    it('refuses a tenantless caller', async () => {
      const tenantless = await connect(legacyPerson(UserRole.BUILDING_ADMIN, null));

      await gateway.handleJoinTenant(tenantless as never, { tenantId: TOWER_A });

      expect(tenantless.rooms.has(tenantRoom(TOWER_A))).toBe(false);
    });

    it('refuses a malformed tenant id without touching the database', async () => {
      const superAdmin = await connect(legacyPerson(UserRole.SUPER_ADMIN, null));
      const lookups = socketContextService['userRepository'] as unknown as { findOne: jest.Mock };
      lookups.findOne.mockClear();

      await gateway.handleJoinTenant(superAdmin as never, { tenantId: 'tenant:*' });

      expect(errorCodesOf(superAdmin)).toEqual([ROOM_FORBIDDEN]);
      expect(lookups.findOne).not.toHaveBeenCalled();
    });

    it("lets a super admin join any building's room", async () => {
      const superAdmin = await connect(legacyPerson(UserRole.SUPER_ADMIN, null));

      await gateway.handleJoinTenant(superAdmin as never, { tenantId: TOWER_C });

      expect(superAdmin.rooms.has(tenantRoom(TOWER_C))).toBe(true);
      expect(eventsOf(superAdmin, 'joined')).toHaveLength(1);
    });

    it("keeps the admin RFID modal working: rfid:registration-scan reaches the admin's own building", async () => {
      const admin = await connect(legacyPerson(UserRole.BUILDING_ADMIN, TOWER_A));
      const otherAdmin = await connect(legacyPerson(UserRole.BUILDING_ADMIN, TOWER_C));
      const residentA = await connect(legacyPerson(UserRole.RESIDENT, TOWER_A));

      // What the modal does (RfidRegistrationModal → socketService.joinTenant).
      await gateway.handleJoinTenant(admin as never, { tenantId: TOWER_A });
      expect(eventsOf(admin, 'error')).toHaveLength(0);

      new GatewayService(gateway).broadcastToTenant(TOWER_A, 'rfid:registration-scan', {
        uid: 'CARD-1',
      });

      expect(eventsOf(admin, 'rfid:registration-scan')).toHaveLength(1);
      expect(eventsOf(otherAdmin, 'rfid:registration-scan')).toHaveLength(0);
      expect(eventsOf(residentA, 'rfid:registration-scan')).toHaveLength(0);
    });

    it('re-reads the person on every join: a role change since connecting is honoured', async () => {
      const id = legacyPerson(UserRole.SECURITY, TOWER_A);
      const socket = await connect(id);
      expect(socket.rooms.has(tenantRoom(TOWER_A))).toBe(true);

      world.people.get(id)!.role = UserRole.RESIDENT;
      await gateway.handleJoinTenant(socket as never, { tenantId: TOWER_A });

      expect(errorCodesOf(socket)).toEqual([ROOM_FORBIDDEN]);
      // The rooms were rebuilt for the new role.
      expect(socket.rooms.has(tenantRoom(TOWER_A))).toBe(false);
      expect(socket.rooms.has(residentsRoom(TOWER_A))).toBe(true);
    });

    it('drops the socket of a person banned since connecting', async () => {
      const id = legacyPerson(UserRole.BUILDING_ADMIN, TOWER_A);
      const socket = await connect(id);

      world.people.get(id)!.status = UserStatus.INACTIVE;
      await gateway.handleJoinTenant(socket as never, { tenantId: TOWER_A });

      expect(socket.disconnect).toHaveBeenCalledWith(true);
      expect(errorCodesOf(socket)).toEqual([ROOM_FORBIDDEN]);
    });
  });

  describe('join:gate / leave:gate (legacy mode)', () => {
    beforeEach(() => setUp(new MembershipWorld()));

    it("lets security watch their own building's gate", async () => {
      const security = await connect(legacyPerson(UserRole.SECURITY, TOWER_A));

      await gateway.handleJoinGate(security as never, { gateId: GATE_A });

      expect(security.rooms.has(`gate:${GATE_A}`)).toBe(true);
    });

    it("refuses another building's gate, an unknown gate and a malformed id alike", async () => {
      const admin = await connect(legacyPerson(UserRole.BUILDING_ADMIN, TOWER_A));

      await gateway.handleJoinGate(admin as never, { gateId: GATE_C });
      await gateway.handleJoinGate(admin as never, {
        gateId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      });
      await gateway.handleJoinGate(admin as never, { gateId: 'not-a-uuid' });

      expect(admin.rooms.has(`gate:${GATE_C}`)).toBe(false);
      expect(errorCodesOf(admin)).toEqual([ROOM_FORBIDDEN, ROOM_FORBIDDEN, ROOM_FORBIDDEN]);
      // The malformed id never reached the database.
      expect(gates.findOne).toHaveBeenCalledTimes(2);
    });

    it("refuses a resident watching their building's gate", async () => {
      const resident = await connect(legacyPerson(UserRole.RESIDENT, TOWER_A));

      await gateway.handleJoinGate(resident as never, { gateId: GATE_A });

      expect(resident.rooms.has(`gate:${GATE_A}`)).toBe(false);
    });

    it('leave:gate leaves the room', async () => {
      const admin = await connect(legacyPerson(UserRole.BUILDING_ADMIN, TOWER_A));
      await gateway.handleJoinGate(admin as never, { gateId: GATE_A });

      gateway.handleLeaveGate(admin as never, { gateId: GATE_A });

      expect(admin.rooms.has(`gate:${GATE_A}`)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // GATE-11: membership context (GATE_MEMBERSHIP_CONTEXT on)
  // -------------------------------------------------------------------------

  describe('membership context (GATE-11)', () => {
    /** P is NOT a super admin here: admin of A, resident of B, security of C. */
    beforeEach(() => {
      setUp(worldWithScenarioP({ role: UserRole.BUILDING_ADMIN }).world);
      process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
    });

    it('auto-selects the single membership of a one-building person', async () => {
      const id = addPlainPerson(world, nextPersonId()).id;
      world.addMembership(
        makeMembership('12121212-1212-4121-8121-121212121212', id, TOWER_C, UserRole.SECURITY),
      );

      const socket = await connect(id);

      expect(socket.data.user).toEqual(
        expect.objectContaining({ contextKind: 'membership', tenantId: TOWER_C }),
      );
      expect(socket.rooms.has(tenantRoom(TOWER_C))).toBe(true);
      expect(eventsOf(socket, 'context:required')).toHaveLength(0);
    });

    it('keeps an ambiguous socket in its person room and says context:required', async () => {
      const socket = await connect(PERSON_P);

      expect([...socket.rooms].sort()).toEqual([personRoom(PERSON_P), socket.id].sort());
      expect(eventsOf(socket, 'context:required')).toEqual([
        { event: 'context:required', data: { code: 'MEMBERSHIP_REQUIRED', reason: 'AMBIGUOUS' } },
      ]);
    });

    it('joins only the rooms of the requested membership', async () => {
      const asC = await connect(PERSON_P, { membershipId: MEMBERSHIP_PC });
      const asB = await connect(PERSON_P, { membershipId: MEMBERSHIP_PB });

      expect(asC.rooms.has(tenantRoom(TOWER_C))).toBe(true);
      // P administers A, but this socket acts as security of C.
      expect(asC.rooms.has(tenantRoom(TOWER_A))).toBe(false);
      expect(asB.rooms.has(residentsRoom(TOWER_B))).toBe(true);
      expect(asB.rooms.has(tenantRoom(TOWER_B))).toBe(false);
    });

    it('accepts the X-Gate-Membership header from non-browser clients', async () => {
      const socket = await connect(PERSON_P, {}, { 'x-gate-membership': MEMBERSHIP_PA });

      expect(socket.rooms.has(tenantRoom(TOWER_A))).toBe(true);
    });

    it('a resident-context socket cannot join a staff room or watch a gate', async () => {
      const asB = await connect(PERSON_P, { membershipId: MEMBERSHIP_PB });

      await gateway.handleJoinTenant(asB as never, { tenantId: TOWER_B });
      await gateway.handleJoinGate(asB as never, { gateId: GATE_B });
      // Nor another of P's buildings from this context.
      await gateway.handleJoinTenant(asB as never, { tenantId: TOWER_A });

      expect(asB.rooms.has(tenantRoom(TOWER_B))).toBe(false);
      expect(asB.rooms.has(`gate:${GATE_B}`)).toBe(false);
      expect(asB.rooms.has(tenantRoom(TOWER_A))).toBe(false);
      expect(errorCodesOf(asB)).toEqual([ROOM_FORBIDDEN, ROOM_FORBIDDEN, ROOM_FORBIDDEN]);
    });

    it.each([
      ['a foreign membership id', '99999999-0000-4000-8000-000000000099'],
      ['a malformed id', 'not-a-uuid'],
      ['an array', [MEMBERSHIP_PA, MEMBERSHIP_PB]],
      ["'platform' from a non super admin", 'platform'],
    ])('refuses %s with connect_error MEMBERSHIP_INVALID', async (_label, membershipId) => {
      const socket = makeSocket(PERSON_P, { membershipId });

      const err = await handshake(socket);

      expect(err?.data).toEqual(expect.objectContaining({ code: 'MEMBERSHIP_INVALID' }));
      expect(socket.data.user).toBeUndefined();
    });

    it('refuses a membership of another person', async () => {
      const otherId = addPlainPerson(world, nextPersonId()).id;
      const socket = makeSocket(otherId, { membershipId: MEMBERSHIP_PA });

      const err = await handshake(socket);

      expect(err?.data).toEqual(expect.objectContaining({ code: 'MEMBERSHIP_INVALID' }));
    });

    it('refuses a deactivated membership', async () => {
      world.setMembershipStatus(MEMBERSHIP_PC, UserStatus.INACTIVE);

      const err = await handshake(makeSocket(PERSON_P, { membershipId: MEMBERSHIP_PC }));

      expect(err?.data).toEqual(expect.objectContaining({ code: 'MEMBERSHIP_INVALID' }));
    });

    describe('context:switch', () => {
      it('moves the rooms without a reconnect and acks { ok, tenantId, role }', async () => {
        const socket = await connect(PERSON_P, { membershipId: MEMBERSHIP_PC });
        await gateway.handleJoinGate(socket as never, { gateId: GATE_C });
        expect(socket.rooms.has(`gate:${GATE_C}`)).toBe(true);

        const ack = await gateway.handleContextSwitch(socket as never, {
          membershipId: MEMBERSHIP_PA,
        });

        expect(ack).toEqual({
          ok: true,
          contextKind: 'membership',
          membershipId: MEMBERSHIP_PA,
          tenantId: TOWER_A,
          role: UserRole.BUILDING_ADMIN,
        });
        expect(socket.rooms.has(tenantRoom(TOWER_A))).toBe(true);
        expect(socket.rooms.has(tenantRoom(TOWER_C))).toBe(false);
        expect(socket.rooms.has(`gate:${GATE_C}`)).toBe(false);
        expect(socket.rooms.has(personRoom(PERSON_P))).toBe(true);
        expect(socket.disconnect).not.toHaveBeenCalled();
      });

      it('refuses a foreign membership and leaves the context unchanged', async () => {
        const socket = await connect(PERSON_P, { membershipId: MEMBERSHIP_PC });

        const ack = await gateway.handleContextSwitch(socket as never, {
          membershipId: '99999999-0000-4000-8000-000000000099',
        });

        expect(ack).toEqual({ ok: false, code: 'MEMBERSHIP_INVALID' });
        expect(socket.rooms.has(tenantRoom(TOWER_C))).toBe(true);
        expect((socket.data.user as User).tenantId).toBe(TOWER_C);
      });

      it('to no membership with several: MEMBERSHIP_REQUIRED, person room only', async () => {
        const socket = await connect(PERSON_P, { membershipId: MEMBERSHIP_PC });

        const ack = await gateway.handleContextSwitch(socket as never, { membershipId: null });

        expect(ack).toEqual({ ok: false, code: 'MEMBERSHIP_REQUIRED', reason: 'AMBIGUOUS' });
        expect([...socket.rooms].sort()).toEqual([personRoom(PERSON_P), socket.id].sort());
      });

      it('lets an ambiguous socket choose afterwards', async () => {
        const socket = await connect(PERSON_P);

        const ack = await gateway.handleContextSwitch(socket as never, {
          membershipId: MEMBERSHIP_PB,
        });

        expect(ack).toEqual(expect.objectContaining({ ok: true, tenantId: TOWER_B }));
        expect(socket.rooms.has(residentsRoom(TOWER_B))).toBe(true);
      });
    });

    it('re-validates on join: a membership deactivated since connecting drops the staff room', async () => {
      const socket = await connect(PERSON_P, { membershipId: MEMBERSHIP_PC });
      expect(socket.rooms.has(tenantRoom(TOWER_C))).toBe(true);

      world.setMembershipStatus(MEMBERSHIP_PC, UserStatus.INACTIVE);
      await gateway.handleJoinGate(socket as never, { gateId: GATE_C });

      expect(socket.rooms.has(`gate:${GATE_C}`)).toBe(false);
      expect(socket.rooms.has(tenantRoom(TOWER_C))).toBe(false);
      expect(errorCodesOf(socket)).toEqual(['MEMBERSHIP_INVALID', ROOM_FORBIDDEN]);
    });

    it('pins an auto-selected membership: a second membership later does not make it ambiguous', async () => {
      const id = addPlainPerson(world, nextPersonId()).id;
      world.addMembership(
        makeMembership('34343434-3434-4343-8343-343434343434', id, TOWER_C, UserRole.SECURITY),
      );
      const socket = await connect(id);

      world.addMembership(
        makeMembership('56565656-5656-4565-8565-565656565656', id, TOWER_A, UserRole.RESIDENT, {
          createdAt: new Date('2026-06-01T00:00:00Z'),
        }),
      );
      await gateway.handleJoinGate(socket as never, { gateId: GATE_C });

      expect(socket.rooms.has(`gate:${GATE_C}`)).toBe(true);
    });

    describe('fan-out (GATE-12)', () => {
      const alertOfC = {
        id: 'alert-1',
        tenantId: TOWER_C,
        type: 'unauthorized_visitor',
        status: 'active',
        title: 'UNAUTHORIZED VISITOR',
      } as unknown as SecurityAlert;

      it("an alert in C reaches only C's staff sockets and platform sockets, once each", async () => {
        const pAsA = await connect(PERSON_P, { membershipId: MEMBERSHIP_PA });
        const pAsC = await connect(PERSON_P, { membershipId: MEMBERSHIP_PC });
        const pAsB = await connect(PERSON_P, { membershipId: MEMBERSHIP_PB });

        const residentOfC = addPlainPerson(world, nextPersonId()).id;
        world.addMembership(
          makeMembership(
            '78787878-7878-4787-8787-787878787878',
            residentOfC,
            TOWER_C,
            UserRole.RESIDENT,
          ),
        );
        const residentSocket = await connect(residentOfC);

        const superAdminId = addPlainPerson(world, nextPersonId(), {
          role: UserRole.SUPER_ADMIN,
        }).id;
        const platform = await connect(superAdminId);
        // A platform super admin who ALSO joined C's room must not get a duplicate.
        await gateway.handleJoinTenant(platform as never, { tenantId: TOWER_C });

        const service = new GatewayService(gateway);
        service.broadcastSecurityAlert(alertOfC);
        service.broadcastSecurityAlertUpdate(alertOfC);

        for (const socket of [pAsC, platform]) {
          expect(eventsOf(socket, 'security:alert:new')).toHaveLength(1);
          expect(eventsOf(socket, 'security:alert:update')).toHaveLength(1);
        }
        for (const socket of [pAsA, pAsB, residentSocket]) {
          expect(eventsOf(socket, 'security:alert:new')).toHaveLength(0);
          expect(eventsOf(socket, 'security:alert:update')).toHaveLength(0);
        }
        expect(eventsOf(platform, 'security:alert:new')[0].data).toEqual(
          expect.objectContaining({ id: 'alert-1', tenantId: TOWER_C }),
        );
      });

      it('sendToPerson reaches every socket of the person, broadcastToTenantResidents only residents', async () => {
        const pAsA = await connect(PERSON_P, { membershipId: MEMBERSHIP_PA });
        const pAsB = await connect(PERSON_P, { membershipId: MEMBERSHIP_PB });
        const pAsC = await connect(PERSON_P, { membershipId: MEMBERSHIP_PC });
        const service = new GatewayService(gateway);

        service.sendToPerson(PERSON_P, 'personal', { hello: true });
        service.broadcastToTenantResidents(TOWER_B, 'residents:b', {});
        service.broadcastToTenant(TOWER_B, 'staff:b', {});

        for (const socket of [pAsA, pAsB, pAsC]) {
          expect(eventsOf(socket, 'personal')).toHaveLength(1);
        }
        expect(eventsOf(pAsB, 'residents:b')).toHaveLength(1);
        expect(eventsOf(pAsA, 'residents:b')).toHaveLength(0);
        for (const socket of [pAsA, pAsB, pAsC]) {
          expect(eventsOf(socket, 'staff:b')).toHaveLength(0);
        }
      });
    });
  });
});

describe('SimulatorGateway', () => {
  let world: MembershipWorld;
  let simulatorService: { triggerEvent: jest.Mock };
  let socketContextService: SocketContextService;
  let gateway: SimulatorGateway;

  beforeAll(() => Logger.overrideLogger(false));

  afterEach(() => {
    process.env.GATE_MEMBERSHIP_CONTEXT = 'off';
  });

  beforeEach(() => {
    world = worldWithScenarioP({ role: UserRole.BUILDING_ADMIN }).world;
    simulatorService = {
      triggerEvent: jest.fn().mockResolvedValue({ success: true, gateState: 'open' }),
    };
    ({ socketContextService } = buildContext(world));
    gateway = new SimulatorGateway(
      socketContextService,
      gateRepository() as never,
      simulatorService as never,
    );
    gateway.server = makeNamespace([]) as never;
  });

  async function connect(personId: string, auth: Record<string, unknown> = {}) {
    const socket = makeSocket(personId, auth);
    await socketContextService.attach(socket as never);
    gateway.handleConnection(socket as never);
    return socket;
  }

  it('installs the handshake middleware on the default namespace', () => {
    const ns = makeNamespace([]);
    gateway.afterInit(ns as never);
    expect(ns.use).toHaveBeenCalledTimes(1);
  });

  it("rejects a resident's simulator:trigger", async () => {
    const id = addPlainPerson(world, nextPersonId(), {
      role: UserRole.RESIDENT,
      tenantId: TOWER_A,
    }).id;
    const resident = await connect(id);

    await gateway.handleSimulatorTrigger(
      resident as never,
      {
        gateId: GATE_A,
        event: 'MANUAL_OPEN',
      } as never,
    );

    expect(simulatorService.triggerEvent).not.toHaveBeenCalled();
    expect(errorCodesOf(resident)).toEqual(['TRIGGER_FORBIDDEN']);
  });

  it('lets security trigger and passes the acting principal to the service', async () => {
    const id = addPlainPerson(world, nextPersonId(), {
      role: UserRole.SECURITY,
      tenantId: TOWER_A,
    }).id;
    const security = await connect(id);

    await gateway.handleSimulatorTrigger(
      security as never,
      {
        gateId: GATE_A,
        event: 'MANUAL_OPEN',
      } as never,
    );

    expect(simulatorService.triggerEvent).toHaveBeenCalledWith(
      GATE_A,
      expect.objectContaining({ event: 'MANUAL_OPEN' }),
      expect.objectContaining({ id, role: UserRole.SECURITY, tenantId: TOWER_A }),
    );
    expect(eventsOf(security, 'simulator:feedback')).toHaveLength(1);
  });

  it('acts as the chosen membership: P as security of C triggers with C, as resident of B cannot', async () => {
    process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
    const asC = await connect(PERSON_P, { membershipId: MEMBERSHIP_PC });
    const asB = await connect(PERSON_P, { membershipId: MEMBERSHIP_PB });

    await gateway.handleSimulatorTrigger(
      asC as never,
      { gateId: GATE_C, event: 'MANUAL_OPEN' } as never,
    );
    await gateway.handleSimulatorTrigger(
      asB as never,
      { gateId: GATE_B, event: 'MANUAL_OPEN' } as never,
    );

    expect(simulatorService.triggerEvent).toHaveBeenCalledTimes(1);
    expect(simulatorService.triggerEvent.mock.calls[0][2]).toEqual(
      expect.objectContaining({ role: UserRole.SECURITY, tenantId: TOWER_C }),
    );
    expect(errorCodesOf(asB)).toEqual(['TRIGGER_FORBIDDEN']);
  });

  it('refuses a trigger after the membership was deactivated', async () => {
    process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
    const asC = await connect(PERSON_P, { membershipId: MEMBERSHIP_PC });

    world.setMembershipStatus(MEMBERSHIP_PC, UserStatus.INACTIVE);
    await gateway.handleSimulatorTrigger(
      asC as never,
      { gateId: GATE_C, event: 'MANUAL_OPEN' } as never,
    );

    expect(simulatorService.triggerEvent).not.toHaveBeenCalled();
    expect(errorCodesOf(asC)).toContain('TRIGGER_FORBIDDEN');
  });

  it('joins residents to no staff room on connect', async () => {
    const id = addPlainPerson(world, nextPersonId(), {
      role: UserRole.RESIDENT,
      tenantId: TOWER_A,
    }).id;
    const resident = await connect(id);
    expect(resident.rooms.has(tenantRoom(TOWER_A))).toBe(false);
  });

  it('joins a platform super admin to platform and the legacy admin room', async () => {
    const id = addPlainPerson(world, nextPersonId(), { role: UserRole.SUPER_ADMIN }).id;
    const superAdmin = await connect(id);

    expect(superAdmin.rooms.has(PLATFORM_ROOM)).toBe(true);
    expect(superAdmin.rooms.has('admin')).toBe(true);
  });

  it('validates join:gate through the gate tenant', async () => {
    const adminC = await connect(
      addPlainPerson(world, nextPersonId(), { role: UserRole.BUILDING_ADMIN, tenantId: TOWER_C })
        .id,
    );
    const adminA = await connect(
      addPlainPerson(world, nextPersonId(), { role: UserRole.BUILDING_ADMIN, tenantId: TOWER_A })
        .id,
    );

    await gateway.handleJoinGate(adminC as never, { gateId: GATE_A });
    await gateway.handleJoinGate(adminA as never, { gateId: GATE_A });

    expect(adminC.rooms.has(`gate:${GATE_A}`)).toBe(false);
    expect(errorCodesOf(adminC)).toEqual([ROOM_FORBIDDEN]);
    expect(adminA.rooms.has(`gate:${GATE_A}`)).toBe(true);
  });
});
