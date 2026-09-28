/**
 * SOCKET-STALE-ROOMS: a committed membership write re-checks the connected
 * sockets of the people concerned, so a removed or deactivated member (or a
 * banned person) stops receiving the building's staff / residents events
 * without the client sending anything.
 *
 * The real SocketContextService and MembershipContextService run over an
 * in-memory world (memberships/testing). The namespaces are fakes with the two
 * things revalidation reads from Socket.IO: adapter.rooms and sockets. The
 * last block wires the real MembershipChangePublisher to the @OnEvent listener
 * through EventEmitterModule, as the application does.
 */
import { Logger } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import { SocketContextService } from './socket-context.service';
import { personRoom, residentsRoom, staffRoom } from './rooms';
import { SocketAuthService } from '../auth/socket-auth.service';
import { MembershipContextService } from '../memberships/membership-context.service';
import {
  MembershipChangePublisher,
  queueMembershipChange,
} from '../memberships/membership-change.events';
import { TOWER_A, TOWER_B, makeMembership } from '../memberships/testing/overlaid-user.factory';
import {
  MembershipWorld,
  addPlainPerson,
  inMemoryContextService,
} from '../memberships/testing/membership-world';

const GUARD = '00000000-0000-4000-8000-00000000a001';
const RESIDENT = '00000000-0000-4000-8000-00000000a002';
const OTHER_GUARD = '00000000-0000-4000-8000-00000000a003';
const M_GUARD_A = '00000000-0000-4000-8000-0000000000a1';
const M_RESIDENT_A = '00000000-0000-4000-8000-0000000000a2';
const M_OTHER_A = '00000000-0000-4000-8000-0000000000a3';

interface FakeSocket {
  id: string;
  data: Record<string, unknown>;
  handshake: { auth: Record<string, unknown>; headers: Record<string, string> };
  rooms: Set<string>;
  received: Array<{ event: string; data: unknown }>;
  connected: boolean;
  join: jest.Mock;
  leave: jest.Mock;
  emit: jest.Mock;
  disconnect: jest.Mock;
}

let socketSeq = 0;

function makeSocket(personId: string): FakeSocket {
  const socket = {
    id: `socket-${++socketSeq}`,
    data: {},
    handshake: { auth: { token: personId }, headers: {} },
    rooms: new Set<string>(),
    received: [],
    connected: true,
  } as unknown as FakeSocket;
  socket.rooms.add(socket.id);
  socket.join = jest.fn((room: string) => socket.rooms.add(room));
  socket.leave = jest.fn((room: string) => socket.rooms.delete(room));
  socket.emit = jest.fn((event: string, data: unknown) => socket.received.push({ event, data }));
  socket.disconnect = jest.fn(() => {
    socket.connected = false;
    socket.rooms.clear();
  });
  return socket;
}

/** What revalidation reads from a Socket.IO namespace, derived from the fake sockets. */
function makeNamespace(sockets: FakeSocket[]) {
  return {
    use: jest.fn(),
    get sockets() {
      return new Map(sockets.filter((s) => s.connected).map((s) => [s.id, s]));
    },
    adapter: {
      get rooms() {
        const rooms = new Map<string, Set<string>>();
        for (const socket of sockets) {
          for (const room of socket.rooms) {
            rooms.set(room, (rooms.get(room) ?? new Set<string>()).add(socket.id));
          }
        }
        return rooms;
      },
    },
  };
}

function buildWorld(): MembershipWorld {
  const world = new MembershipWorld();
  world.addTenant(TOWER_A);
  world.addTenant(TOWER_B);
  addPlainPerson(world, GUARD, { role: UserRole.SECURITY, tenantId: TOWER_A });
  addPlainPerson(world, RESIDENT, { role: UserRole.RESIDENT, tenantId: TOWER_A, unit: '4B' });
  addPlainPerson(world, OTHER_GUARD, { role: UserRole.SECURITY, tenantId: TOWER_A });
  world.addMembership(makeMembership(M_GUARD_A, GUARD, TOWER_A, UserRole.SECURITY));
  world.addMembership(
    makeMembership(M_RESIDENT_A, RESIDENT, TOWER_A, UserRole.RESIDENT, { unit: '4B' }),
  );
  world.addMembership(makeMembership(M_OTHER_A, OTHER_GUARD, TOWER_A, UserRole.SECURITY));
  return world;
}

function contextServiceFor(world: MembershipWorld) {
  const socketAuthService = {
    authenticate: jest.fn(async (handshake: { auth?: { token?: unknown } }) => {
      const person = world.livePerson(String(handshake?.auth?.token));
      if (!person || person.status !== UserStatus.ACTIVE) throw new Error('not active');
      return person;
    }),
  };
  const userRepository = {
    findOne: jest.fn(async ({ where: { id } }: { where: { id: string } }) => world.livePerson(id)),
  };
  const service = new SocketContextService(
    socketAuthService as never,
    inMemoryContextService(world),
    userRepository as never,
  );
  return { service, socketAuthService, userRepository };
}

describe('SocketContextService revalidation (SOCKET-STALE-ROOMS)', () => {
  const originalFlag = process.env.GATE_MEMBERSHIP_CONTEXT;
  let world: MembershipWorld;
  let sockets: FakeSocket[];
  let service: SocketContextService;
  let userRepository: { findOne: jest.Mock };

  beforeAll(() => Logger.overrideLogger(false));

  beforeEach(() => {
    process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
    world = buildWorld();
    sockets = [];
    ({ service, userRepository } = contextServiceFor(world));
    service.registerNamespace(makeNamespace(sockets) as never);
  });

  afterAll(() => {
    process.env.GATE_MEMBERSHIP_CONTEXT = originalFlag;
  });

  /** A socket that went through attach() and the connection hook. */
  async function connect(personId: string): Promise<FakeSocket> {
    const socket = makeSocket(personId);
    await service.attach(socket as never);
    service.applyRooms(socket as never);
    sockets.push(socket);
    return socket;
  }

  const errorCodesOf = (socket: FakeSocket) =>
    socket.received
      .filter((r) => r.event === 'error')
      .map((r) => (r.data as { code: string }).code);

  it('moves a removed staff member out of the staff room, with no message from the client', async () => {
    const guard = await connect(GUARD);
    expect(guard.rooms.has(staffRoom(TOWER_A))).toBe(true);

    world.memberships.find((m) => m.id === M_GUARD_A)!.deletedAt = new Date();
    await service.onMembershipChanged({ personIds: [GUARD], tenantIds: [] });

    expect(guard.rooms.has(staffRoom(TOWER_A))).toBe(false);
    expect([...guard.rooms]).toEqual([guard.id, personRoom(GUARD)]);
    expect(errorCodesOf(guard)).toEqual(['MEMBERSHIP_INVALID']);
    expect(guard.disconnect).not.toHaveBeenCalled();
  });

  it('does the same for a deactivated membership', async () => {
    const guard = await connect(GUARD);

    world.setMembershipStatus(M_GUARD_A, UserStatus.INACTIVE);
    await expect(service.revalidatePerson(GUARD)).resolves.toBe(1);

    expect(guard.rooms.has(staffRoom(TOWER_A))).toBe(false);
  });

  it('disconnects a person who is banned or deleted', async () => {
    const guard = await connect(GUARD);

    world.people.get(GUARD)!.status = UserStatus.INACTIVE;
    await service.revalidatePerson(GUARD);

    expect(guard.disconnect).toHaveBeenCalledWith(true);
  });

  it('leaves a still-valid socket exactly as it is, including rooms joined on request', async () => {
    const guard = await connect(GUARD);
    guard.join('gate:watched');
    guard.emit.mockClear();

    await service.revalidatePerson(GUARD);

    expect(guard.rooms.has(staffRoom(TOWER_A))).toBe(true);
    expect(guard.rooms.has('gate:watched')).toBe(true);
    expect(guard.emit).not.toHaveBeenCalled();
  });

  it("re-checks only the people named, never another member's socket", async () => {
    await connect(GUARD);
    const other = await connect(OTHER_GUARD);
    userRepository.findOne.mockClear();

    world.memberships.find((m) => m.id === M_GUARD_A)!.deletedAt = new Date();
    await service.revalidatePerson(GUARD);

    expect(userRepository.findOne).toHaveBeenCalledTimes(1);
    expect(userRepository.findOne).toHaveBeenCalledWith({ where: { id: GUARD } });
    expect(other.rooms.has(staffRoom(TOWER_A))).toBe(true);
  });

  it('a person who gains a building auto-selects it on the next check, like a fresh connection', async () => {
    const newcomer = addPlainPerson(world, '00000000-0000-4000-8000-00000000a004');
    const socket = await connect(newcomer.id);
    expect(socket.rooms.has(staffRoom(TOWER_B))).toBe(false);

    world.addMembership(
      makeMembership(
        '00000000-0000-4000-8000-0000000000b4',
        newcomer.id,
        TOWER_B,
        UserRole.SECURITY,
      ),
    );
    await service.onMembershipChanged({ personIds: [newcomer.id], tenantIds: [] });

    expect(socket.rooms.has(staffRoom(TOWER_B))).toBe(true);
  });

  it('revalidateTenant re-checks the staff and residents rooms of an emptied building', async () => {
    const guard = await connect(GUARD);
    const resident = await connect(RESIDENT);
    expect(resident.rooms.has(residentsRoom(TOWER_A))).toBe(true);

    world.tenants.get(TOWER_A)!.deletedAt = new Date();
    await expect(service.revalidateTenant(TOWER_A)).resolves.toBe(2);

    expect(guard.rooms.has(staffRoom(TOWER_A))).toBe(false);
    expect(resident.rooms.has(residentsRoom(TOWER_A))).toBe(false);
  });

  it('walks every registered namespace, the Server form included, once per socket', async () => {
    const guard = await connect(GUARD);
    const simulatorSockets: FakeSocket[] = [];
    // The default-namespace gateway may be handed the Server (whose .sockets is the namespace).
    service.registerNamespace({ sockets: makeNamespace(simulatorSockets) } as never);
    const simulatorSocket = makeSocket(GUARD);
    await service.attach(simulatorSocket as never);
    service.applyRooms(simulatorSocket as never);
    simulatorSockets.push(simulatorSocket);

    world.setMembershipStatus(M_GUARD_A, UserStatus.INACTIVE);
    await expect(
      service.onMembershipChanged({ personIds: [GUARD], tenantIds: [TOWER_A] }),
    ).resolves.toBeUndefined();

    expect(guard.rooms.has(staffRoom(TOWER_A))).toBe(false);
    expect(simulatorSocket.rooms.has(staffRoom(TOWER_A))).toBe(false);
    expect(errorCodesOf(guard)).toEqual(['MEMBERSHIP_INVALID']);
  });

  it('ignores junk ids and namespace doubles it cannot read', async () => {
    service.registerNamespace({ use: jest.fn() } as never);
    await expect(service.revalidatePerson('not-a-uuid')).resolves.toBe(0);
    await expect(service.revalidateTenant('')).resolves.toBe(0);
    await expect(
      service.onMembershipChanged({ personIds: ['x'], tenantIds: ['y'] }),
    ).resolves.toBeUndefined();
  });

  it('one failing socket does not stop the others', async () => {
    const guard = await connect(GUARD);
    const other = await connect(OTHER_GUARD);
    userRepository.findOne.mockRejectedValueOnce(new Error('database is down'));

    world.tenants.get(TOWER_A)!.deletedAt = new Date();
    await service.revalidateTenant(TOWER_A);

    // The first socket re-checked failed and kept its rooms; the second moved.
    const [failed, moved] = [guard, other];
    expect(failed.rooms.has(staffRoom(TOWER_A))).toBe(true);
    expect(moved.rooms.has(staffRoom(TOWER_A))).toBe(false);
  });

  it('legacy mode (flag off): a removed resident leaves the residents room', async () => {
    process.env.GATE_MEMBERSHIP_CONTEXT = 'off';
    const resident = await connect(RESIDENT);
    expect(resident.rooms.has(residentsRoom(TOWER_A))).toBe(true);

    // What MembershipsService.remove() leaves behind: the sentinel on gate_users.
    Object.assign(world.people.get(RESIDENT)!, {
      role: UserRole.BUILDING_ADMIN,
      tenantId: null,
      unit: null,
    });
    await service.revalidatePerson(RESIDENT);

    expect(resident.rooms.has(residentsRoom(TOWER_A))).toBe(false);
    expect(resident.rooms.has(personRoom(RESIDENT))).toBe(true);
  });

  describe('wired through EventEmitterModule, after a commit', () => {
    it('the published event reaches onMembershipChanged', async () => {
      const guard = await connect(GUARD);
      const subscribers: unknown[] = [];

      const moduleRef = await Test.createTestingModule({
        imports: [EventEmitterModule.forRoot()],
        providers: [
          SocketContextService,
          MembershipChangePublisher,
          { provide: SocketAuthService, useValue: {} },
          { provide: MembershipContextService, useValue: inMemoryContextService(world) },
          { provide: getRepositoryToken(User), useValue: userRepository },
          { provide: DataSource, useValue: { subscribers } },
        ],
      }).compile();
      const app = moduleRef.createNestApplication({ logger: false });
      await app.init();
      try {
        const wired = moduleRef.get(SocketContextService);
        wired.registerNamespace(makeNamespace(sockets) as never);
        const publisher = moduleRef.get(MembershipChangePublisher);
        expect(subscribers).toContain(publisher);

        world.memberships.find((m) => m.id === M_GUARD_A)!.deletedAt = new Date();
        const queryRunner = { isTransactionActive: true } as unknown as QueryRunner;
        queueMembershipChange({ queryRunner } as unknown as EntityManager, {
          personIds: [GUARD],
        });
        expect(guard.rooms.has(staffRoom(TOWER_A))).toBe(true);

        (queryRunner as { isTransactionActive: boolean }).isTransactionActive = false;
        publisher.afterTransactionCommit({ queryRunner } as never);

        // The listener runs on its own tick ({ async: true }).
        for (let i = 0; i < 20 && guard.rooms.has(staffRoom(TOWER_A)); i++) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        expect(guard.rooms.has(staffRoom(TOWER_A))).toBe(false);
      } finally {
        await app.close();
      }
    });
  });
});
