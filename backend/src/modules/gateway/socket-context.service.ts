/**
 * The membership context of a Socket.IO connection (GATE-11, contract C3).
 *
 * HTTP requests act as the membership named by X-Gate-Membership. A socket acts
 * as the one named in its handshake, `io(url, { auth: { token, membershipId } })`
 * (non-browser clients may send the X-Gate-Membership header instead), resolved
 * by the same MembershipContextService.resolve() the passport strategies use, so
 * both channels agree on the rules (C6): auto-select a single membership, the
 * Platform context for a super admin without one, MEMBERSHIP_REQUIRED for none
 * or several, MEMBERSHIP_INVALID for anything unusable.
 *
 * The context decides the socket's ROOMS (defaultRoomsFor): the person room
 * always, plus the platform room, the building's staff room or its residents
 * room. A resident acting in Tower B is therefore never in B's staff room, even
 * if the same person administers Tower A.
 *
 * Contexts go stale: a membership can be deactivated or ended, a person banned,
 * while a socket stays open for hours. So every join, switch and simulator
 * trigger re-resolves the context against the database first (refresh()), and
 * the rooms are rebuilt whenever the answer changed. The server does the same
 * on its own after every committed membership write: MembershipsService
 * publishes 'membership.changed' once the transaction commits, and
 * onMembershipChanged() refreshes the local sockets of the people (and emptied
 * buildings) concerned, so a removed or deactivated member stops receiving the
 * building's staff or residents events without having to send anything.
 *
 *   attach        handshake middleware: authenticate + resolve; INVALID refuses
 *                 the connection (SocketContextError).
 *   applyRooms    leave every context room, join the current context's rooms;
 *                 emits 'context:required' when there is no building context.
 *   refresh       re-resolve from the database (person still ACTIVE, requested
 *                 membership still usable); rebuilds rooms if it changed.
 *   canJoinTenant / canJoinGate
 *                 refresh, then the room rule of socket-access.ts.
 *   switchContext 'context:switch' { membershipId }: act as another membership
 *                 (or 'platform') without reconnecting; acks
 *                 { ok, tenantId, role } or { ok: false, code }.
 *   revalidatePerson / revalidateTenant
 *                 refresh every local socket of a person, or in a building's
 *                 staff and residents rooms (both namespaces, registered by the
 *                 gateways with registerNamespace).
 *
 * Only sockets connected to THIS process are re-checked (the Socket.IO
 * adapter's local rooms). That is every socket today: there is one backend
 * process and no cross-node adapter. With several nodes, the event would have
 * to reach every node (a broker, or a cross-node adapter plus fetchSockets).
 */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Namespace, Server, Socket } from 'socket.io';
import { Repository } from 'typeorm';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import {
  ActingUser,
  ContextKind,
  GATE_MEMBERSHIP_HEADER,
  MembershipRequiredReason,
  PLATFORM_CONTEXT_ID,
  contextKindOf,
  isUuid,
} from '@common/context/acting-user';
import { MembershipErrorCode } from '@common/context/membership-context.errors';
import { SOCKET_AUTH_FAILED, SocketAuthService } from '../auth/socket-auth.service';
import { MembershipContextService } from '../memberships/membership-context.service';
import {
  MEMBERSHIP_CHANGED_EVENT,
  MembershipChangedEvent,
} from '../memberships/membership-change.events';
import {
  SocketContextError,
  canJoinTenantRoom,
  canWatchGate,
  contextSignature,
  defaultRoomsFor,
  getSocketUser,
  socketDataOf,
} from './socket-access';
import { isContextRoom, personRoom, residentsRoom, staffRoom } from './rooms';

/** Emitted to a socket that has no building context yet. */
export const CONTEXT_REQUIRED_EVENT = 'context:required';

/** The ack of 'context:switch'. */
export type ContextSwitchAck =
  | {
      ok: true;
      contextKind: ContextKind;
      /** The membership now acted as, 'platform', or null in legacy mode. */
      membershipId: string | null;
      tenantId: string | null;
      role: UserRole | null;
    }
  | {
      ok: false;
      code:
        | typeof MembershipErrorCode.MEMBERSHIP_INVALID
        | typeof MembershipErrorCode.MEMBERSHIP_REQUIRED
        | typeof SOCKET_AUTH_FAILED;
      reason?: MembershipRequiredReason | null;
    };

/** The part of a handshake that names a context. */
interface HandshakeLike {
  auth?: Record<string, unknown> | null;
  headers?: Record<string, string | string[] | undefined> | null;
}

/**
 * The context a handshake asks for: auth.membershipId (browsers), else the
 * X-Gate-Membership header (non-browser clients). Returned raw; resolve()
 * validates it and never passes a non-uuid to Postgres.
 */
export function requestedContextOf(handshake: HandshakeLike | null | undefined): unknown {
  const fromAuth = handshake?.auth?.membershipId;
  if (fromAuth !== undefined && fromAuth !== null) {
    return fromAuth;
  }
  return handshake?.headers?.[GATE_MEMBERSHIP_HEADER];
}

/**
 * The namespace behind what a gateway's afterInit receives. The default
 * namespace gateway gets either the Server or its '/' namespace, depending on
 * which gateway NestJS created first. Anything else (a test double without
 * sockets) gives null.
 */
function namespaceOf(server: Namespace | Server | null | undefined): Namespace | null {
  const sockets = (server as { sockets?: unknown } | null | undefined)?.sockets;
  if (sockets instanceof Map) {
    return server as Namespace;
  }
  const inner = (sockets as { sockets?: unknown } | undefined)?.sockets;
  return inner instanceof Map ? (sockets as Namespace) : null;
}

/** The membership id (or 'platform') a principal acts as; null otherwise. */
function actingContextIdOf(user: ActingUser): string | null {
  if (user.contextKind === 'membership') {
    return user.activeMembership?.id ?? null;
  }
  return user.contextKind === 'platform' ? PLATFORM_CONTEXT_ID : null;
}

@Injectable()
export class SocketContextService {
  private readonly logger = new Logger(SocketContextService.name);

  /** The namespaces whose local sockets revalidate*() walks. */
  private readonly namespaces = new Set<Namespace>();

  constructor(
    private readonly socketAuthService: SocketAuthService,
    private readonly membershipContextService: MembershipContextService,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  /**
   * Handshake: authenticates the token (SocketAuthError) and resolves the
   * requested context. MEMBERSHIP_INVALID refuses the connection
   * (SocketContextError); MEMBERSHIP_REQUIRED is accepted without a building.
   */
  async attach(socket: Socket): Promise<ActingUser> {
    const person = await this.socketAuthService.authenticate(socket.handshake);
    const requested = requestedContextOf(socket.handshake);
    const acting = await this.membershipContextService.resolve(person, requested);

    if (acting.contextProblem === MembershipErrorCode.MEMBERSHIP_INVALID) {
      throw new SocketContextError();
    }

    this.remember(socket, acting, requested);
    return acting;
  }

  /**
   * Resets the socket's rooms to its current context: leaves every context room
   * (including gate and building rooms joined by request) and joins
   * defaultRoomsFor(). Tells a socket without a building context so, with
   * 'context:required' { code: 'MEMBERSHIP_REQUIRED', reason }.
   */
  applyRooms(socket: Socket): void {
    const data = socketDataOf(socket);
    const user = data.user;
    if (!user) {
      return;
    }

    const wanted = defaultRoomsFor(user);
    for (const room of [...socket.rooms]) {
      if (isContextRoom(room) && !wanted.includes(room)) {
        socket.leave(room);
      }
    }
    for (const room of wanted) {
      socket.join(room);
    }
    data.roomsBuiltFor = contextSignature(user);

    if (data.contextRequired) {
      socket.emit(CONTEXT_REQUIRED_EVENT, {
        code: MembershipErrorCode.MEMBERSHIP_REQUIRED,
        reason: user.contextProblemReason ?? 'NO_MEMBERSHIPS',
      });
    }
  }

  /**
   * Re-resolves the socket's context from the database. Returns the fresh
   * principal, or null when the socket may no longer act:
   *   - the person is gone or no longer ACTIVE: the socket is disconnected;
   *   - the requested membership is no longer usable (ended, deactivated,
   *     building deleted): the socket drops to its person room and gets
   *     'error' { code: 'MEMBERSHIP_INVALID' } so the client can choose again.
   * When the context changed (another role, another building), the rooms are
   * rebuilt.
   */
  async refresh(socket: Socket): Promise<ActingUser | null> {
    const data = socketDataOf(socket);
    const person = await this.loadActivePerson(data.personId);
    if (!person) {
      this.logger.warn(`Socket ${socket.id} dropped: its person is no longer active`);
      socket.disconnect(true);
      return null;
    }

    const acting = await this.membershipContextService.resolve(person, data.requestedContext);
    if (acting.contextProblem === MembershipErrorCode.MEMBERSHIP_INVALID) {
      data.user = acting;
      data.contextRequired = false;
      if (data.roomsBuiltFor !== contextSignature(acting)) {
        this.applyRooms(socket);
        socket.emit('error', {
          code: MembershipErrorCode.MEMBERSHIP_INVALID,
          message: 'The selected building access is no longer valid. Please choose again.',
        });
      }
      return null;
    }

    this.remember(socket, acting, data.requestedContext);
    if (data.roomsBuiltFor !== contextSignature(acting)) {
      this.applyRooms(socket);
    }
    return acting;
  }

  /** join:tenant: may this socket, as it acts NOW, sit in tenant:{tenantId}? */
  async canJoinTenant(socket: Socket, tenantId: unknown): Promise<boolean> {
    if (!isUuid(tenantId)) {
      return false;
    }
    const acting = await this.refresh(socket);
    return canJoinTenantRoom(acting, tenantId);
  }

  /** join:gate: may this socket, as it acts NOW, watch a gate of `gateTenantId`? */
  async canJoinGate(socket: Socket, gateTenantId: string | null | undefined): Promise<boolean> {
    if (!isUuid(gateTenantId)) {
      return false;
    }
    const acting = await this.refresh(socket);
    return canWatchGate(acting, gateTenantId);
  }

  /**
   * 'context:switch' { membershipId }: act as another membership (a uuid),
   * 'platform' (super admins), or nothing in particular (null / absent, which
   * auto-selects like a fresh connection). The same socket stays connected.
   *
   *   usable context      rooms rebuilt, ack { ok: true, tenantId, role, ... }
   *   MEMBERSHIP_INVALID  nothing changes, ack { ok: false, code }
   *   MEMBERSHIP_REQUIRED rooms reduced to the person room,
   *                       ack { ok: false, code, reason }
   */
  async switchContext(socket: Socket, membershipId: unknown): Promise<ContextSwitchAck> {
    const data = socketDataOf(socket);
    const person = await this.loadActivePerson(data.personId);
    if (!person) {
      socket.disconnect(true);
      return { ok: false, code: SOCKET_AUTH_FAILED };
    }

    const acting = await this.membershipContextService.resolve(person, membershipId);
    if (acting.contextProblem === MembershipErrorCode.MEMBERSHIP_INVALID) {
      return { ok: false, code: MembershipErrorCode.MEMBERSHIP_INVALID };
    }

    this.remember(socket, acting, membershipId);
    this.applyRooms(socket);
    this.logger.log(
      `Socket ${socket.id} switched to ${contextKindOf(acting)} ${acting.tenantId ?? ''} ${
        acting.role ?? ''
      }`,
    );

    if (acting.contextProblem === MembershipErrorCode.MEMBERSHIP_REQUIRED) {
      return {
        ok: false,
        code: MembershipErrorCode.MEMBERSHIP_REQUIRED,
        reason: acting.contextProblemReason,
      };
    }

    return {
      ok: true,
      contextKind: contextKindOf(acting),
      membershipId: actingContextIdOf(acting),
      tenantId: acting.tenantId ?? null,
      role: acting.role ?? null,
    };
  }

  /**
   * Called from each gateway's afterInit, so revalidatePerson/revalidateTenant
   * reach the sockets of both namespaces (/events and the default one).
   */
  registerNamespace(server: Namespace | Server): void {
    const namespace = namespaceOf(server);
    if (namespace) {
      this.namespaces.add(namespace);
    }
  }

  /**
   * refresh() for every local socket of the person, in both namespaces: rooms
   * follow the committed memberships, an unusable context drops to the person
   * room with 'error' MEMBERSHIP_INVALID, a banned or deleted person is
   * disconnected. Resolves to the number of sockets checked.
   */
  revalidatePerson(personId: string): Promise<number> {
    return isUuid(personId) ? this.revalidateRooms([personRoom(personId)]) : Promise.resolve(0);
  }

  /** refresh() for every local socket in the building's staff and residents rooms. */
  revalidateTenant(tenantId: string): Promise<number> {
    return isUuid(tenantId)
      ? this.revalidateRooms([staffRoom(tenantId), residentsRoom(tenantId)])
      : Promise.resolve(0);
  }

  /**
   * After a membership write has COMMITTED (the event is published from the
   * transaction's commit, see membership-change.events.ts): re-check the
   * sockets of the people concerned and of any building emptied as a whole.
   * Runs on its own tick ({ async: true }), off the request that committed, and
   * a failure is only logged: the next join, switch or trigger re-checks anyway.
   */
  @OnEvent(MEMBERSHIP_CHANGED_EVENT, { async: true })
  async onMembershipChanged(change: MembershipChangedEvent): Promise<void> {
    const rooms = [
      ...(change?.personIds ?? []).filter((id) => isUuid(id)).map(personRoom),
      ...(change?.tenantIds ?? [])
        .filter((id) => isUuid(id))
        .flatMap((id) => [staffRoom(id), residentsRoom(id)]),
    ];
    if (rooms.length > 0) {
      await this.revalidateRooms(rooms);
    }
  }

  /** The socket's current principal without a database round trip. */
  current(socket: Socket): ActingUser | undefined {
    return getSocketUser(socket);
  }

  // ---------------------------------------------------------------------------

  /**
   * refresh() once for each distinct local socket found in any of the rooms,
   * in every registered namespace. The socket ids are copied first: refresh()
   * may leave rooms (and a disconnect removes the socket) while this runs.
   */
  private async revalidateRooms(rooms: readonly string[]): Promise<number> {
    const sockets = new Set<Socket>();
    for (const namespace of this.namespaces) {
      for (const room of rooms) {
        for (const socketId of [...(namespace.adapter.rooms.get(room) ?? [])]) {
          const socket = namespace.sockets.get(socketId);
          if (socket) {
            sockets.add(socket);
          }
        }
      }
    }

    for (const socket of sockets) {
      try {
        await this.refresh(socket);
      } catch (error) {
        this.logger.warn(
          `Re-checking socket ${socket.id} failed: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    }
    return sockets.size;
  }

  private remember(socket: Socket, acting: ActingUser, requested: unknown): void {
    const data = socketDataOf(socket);
    data.user = acting;
    data.personId = acting.id;
    // Pin what the socket actually acts as, so a person who gains a second
    // membership later does not turn this socket ambiguous on its next refresh.
    data.requestedContext = actingContextIdOf(acting) ?? requested;
    data.contextRequired = acting.contextProblem === MembershipErrorCode.MEMBERSHIP_REQUIRED;
  }

  /** The person row, live and ACTIVE (a platform ban drops the socket). */
  private async loadActivePerson(personId: string | undefined): Promise<User | null> {
    if (!isUuid(personId)) {
      return null;
    }
    const person = await this.userRepository.findOne({ where: { id: personId } });
    return person && person.status === UserStatus.ACTIVE ? person : null;
  }
}
