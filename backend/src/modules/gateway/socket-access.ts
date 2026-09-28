/**
 * Socket authentication middleware and room access rules, shared by the
 * /events gateway (EventsGateway) and the default-namespace SimulatorGateway.
 *
 * SEC-8: every Socket.IO connection is authenticated in a namespace middleware
 * (namespace.use) BEFORE the connection event. GATE-11: the same middleware
 * also resolves the MEMBERSHIP CONTEXT the socket acts in (SocketContextService
 * .attach), exactly as the passport strategies do for HTTP, so a socket's rooms
 * follow the building and role the tab acts as, not every building its person
 * belongs to. A refused handshake never becomes a connection; the client gets
 * `connect_error` with `err.data = { code, message }`:
 *   AUTH_FAILED          no, bad or expired token, or an inactive person;
 *   MEMBERSHIP_INVALID   the requested membership (auth.membershipId or the
 *                        X-Gate-Membership header) is foreign, ended, inactive,
 *                        pending, malformed, or 'platform' from a non super
 *                        admin. The client should pick again.
 * A socket with NO usable context (MEMBERSHIP_REQUIRED: none or several
 * memberships and none requested) is accepted, sits only in its person room and
 * receives 'context:required' { code, reason }.
 *
 * Room rules (room names in rooms.ts), judged on the ACTING principal (C5):
 *   - 'platform'                   : a super admin in the Platform context.
 *   - 'tenant:{id}' (staff room)   : a platform super admin (any building), or a
 *                                    building admin / security / staff acting in
 *                                    that building (STAFF_ROOM_ROLES).
 *   - 'tenant:{id}:residents'      : joined automatically by a resident acting in
 *                                    that building; never joinable by request.
 *   - 'user:{personId}'            : joined automatically, every context.
 *   - 'gate:{gateId}'              : same rule as the staff room, checked through
 *                                    the gate's building.
 * A refused join emits 'error' { code: 'ROOM_FORBIDDEN', message }.
 */
import { Logger } from '@nestjs/common';
import { Socket } from 'socket.io';
import { UserRole } from '@database/entities/user.entity';
import { MembershipRole } from '@database/entities/membership.entity';
import { ActingUser, contextKindOf, isUuid } from '@common/context/acting-user';
import { isPlatformContext } from '@common/context/assert-building-context';
import { MembershipErrorCode } from '@common/context/membership-context.errors';
import { STAFF_ROOM_ROLES } from '../memberships/membership-access.constants';
import { SOCKET_AUTH_FAILED, SocketAuthError } from '../auth/socket-auth.service';
import { PLATFORM_ROOM, gateRoom, personRoom, residentsRoom, staffRoom, tenantRoom } from './rooms';

export { PLATFORM_ROOM, gateRoom, personRoom, residentsRoom, staffRoom, tenantRoom, isUuid };

export const ROOM_FORBIDDEN = 'ROOM_FORBIDDEN';

/** The code a handshake refused for its requested membership carries. */
export const SOCKET_MEMBERSHIP_INVALID = MembershipErrorCode.MEMBERSHIP_INVALID;

/**
 * Thrown by SocketContextService.attach when the requested membership cannot be
 * acted as. `message` is fixed and safe to send to the client.
 */
export class SocketContextError extends Error {
  readonly code = SOCKET_MEMBERSHIP_INVALID;

  constructor(message = 'The selected building access is no longer valid. Please choose again.') {
    super(message);
    this.name = 'SocketContextError';
  }
}

/** What the handshake middleware and SocketContextService keep on socket.data. */
export interface AuthenticatedSocketData {
  /** The acting principal (C5 overlay): who the socket acts as right now. */
  user?: ActingUser;
  /** gate_users.id of the authenticated person. */
  personId?: string;
  /**
   * The context the socket asked for (handshake auth.membershipId or header,
   * then the last successful context:switch), pinned to the membership it
   * resolved to so a later second membership cannot make it ambiguous.
   */
  requestedContext?: unknown;
  /** True while the socket has no building context (MEMBERSHIP_REQUIRED). */
  contextRequired?: boolean;
  /** The context the socket's rooms were last built for (see contextSignature). */
  roomsBuiltFor?: string;
}

export function socketDataOf(client: Socket): AuthenticatedSocketData {
  if (!client.data) {
    client.data = {};
  }
  return client.data as AuthenticatedSocketData;
}

/** The acting principal of a socket, or undefined if the middleware did not run. */
export function getSocketUser(client: Socket): ActingUser | undefined {
  return (client.data as AuthenticatedSocketData | undefined)?.user;
}

/** The building a principal acts in, or null (platform context, no context). */
export function actingBuildingOf(user: ActingUser | undefined | null): string | null {
  const kind = contextKindOf(user);
  return user && (kind === 'membership' || kind === 'legacy') && user.tenantId
    ? user.tenantId
    : null;
}

function isStaffRole(role: UserRole | null | undefined): boolean {
  return STAFF_ROOM_ROLES.includes(role as MembershipRole);
}

/** May `user` sit in the staff room tenant:{tenantId}? */
export function canJoinTenantRoom(user: ActingUser | undefined | null, tenantId: unknown): boolean {
  if (!user || !isUuid(tenantId)) {
    return false;
  }
  if (isPlatformContext(user)) {
    return true;
  }
  return actingBuildingOf(user) === tenantId && isStaffRole(user.role);
}

/** May `user` watch a gate of `gateTenantId`? Same rule as the staff room. */
export function canWatchGate(
  user: ActingUser | undefined | null,
  gateTenantId: string | null | undefined,
): boolean {
  return !!gateTenantId && canJoinTenantRoom(user, gateTenantId);
}

/**
 * The rooms of a principal's context: always its person room, plus 'platform'
 * for the Platform context, the staff room for staff roles acting in a
 * building, or the residents room for a resident acting in a building.
 */
export function defaultRoomsFor(user: ActingUser): string[] {
  const rooms = [personRoom(user.id)];

  if (isPlatformContext(user)) {
    rooms.push(PLATFORM_ROOM);
    return rooms;
  }

  const tenantId = actingBuildingOf(user);
  if (!tenantId) {
    return rooms;
  }

  if (isStaffRole(user.role)) {
    rooms.push(staffRoom(tenantId));
  } else if (user.role === UserRole.RESIDENT) {
    rooms.push(residentsRoom(tenantId));
  }
  return rooms;
}

/**
 * Identifies a context for room purposes: two principals with the same
 * signature sit in the same default rooms.
 */
export function contextSignature(user: ActingUser): string {
  return [user.id, contextKindOf(user), actingBuildingOf(user) ?? '', user.role ?? ''].join('|');
}

type SocketMiddleware = (socket: Socket, next: (err?: Error) => void) => void;

/** What the middleware needs: SocketContextService satisfies it. */
export interface SocketContextAttacher {
  attach(socket: Socket): Promise<unknown>;
}

/**
 * Namespace middleware: authenticates the handshake and resolves its context
 * (attacher.attach stores both on socket.data), or refuses the connection with
 * connect_error { code: 'AUTH_FAILED' | 'MEMBERSHIP_INVALID', message }. Never
 * logs the token.
 */
export function createSocketAuthMiddleware(
  attacher: SocketContextAttacher,
  logger: Logger,
): SocketMiddleware {
  return (socket, next) => {
    attacher
      .attach(socket)
      .then(() => next())
      .catch((error: unknown) => {
        const known = error instanceof SocketAuthError || error instanceof SocketContextError;
        const code = error instanceof SocketContextError ? error.code : SOCKET_AUTH_FAILED;
        const message = known ? error.message : 'Authentication failed';
        logger.warn(`Socket ${socket.id} refused: ${message}`);

        const refusal = new Error(message) as Error & { data?: unknown };
        refusal.data = { code, message };
        next(refusal);
      });
  };
}

/** Emits the standard refused-join error to one socket. */
export function emitRoomForbidden(client: Socket, message: string): void {
  client.emit('error', { code: ROOM_FORBIDDEN, message });
}
