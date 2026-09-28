/**
 * Socket.IO room names, in one place (GATE-11).
 *
 * A socket sits in the rooms of the context it acts in (see
 * SocketContextService.applyRooms), never in every building of its person:
 *
 *   user:{personId}             every authenticated socket of that person
 *                               (gate_users.id), whatever the context. Personal
 *                               events (sendToPerson) only.
 *   platform                    a super admin in the Platform context.
 *                               Platform-wide fan-out (security alerts).
 *   tenant:{tenantId}           the building's STAFF room: building admins,
 *                               security and staff acting in that building (and
 *                               a platform super admin who joins it). Carries
 *                               every access event, alert, device and
 *                               registration event of the building. The string
 *                               is unchanged from before memberships, so the
 *                               legacy SPA's join:tenant keeps working.
 *   tenant:{tenantId}:residents residents acting in that building. Only what a
 *                               resident may see goes here
 *                               (broadcastToTenantResidents).
 *   gate:{gateId}               explicit watchers of one gate (join:gate).
 *
 * Every id is validated as a uuid before it becomes part of a room name, so a
 * client can never address a room by a pattern or a crafted string.
 */
export const PLATFORM_ROOM = 'platform';

/** The default (simulator) namespace's super admin room, kept for older clients. */
export const SIMULATOR_ADMIN_ROOM = 'admin';

export const PERSON_ROOM_PREFIX = 'user:';
export const TENANT_ROOM_PREFIX = 'tenant:';
export const GATE_ROOM_PREFIX = 'gate:';
export const RESIDENTS_ROOM_SUFFIX = ':residents';

/** The building's staff room (admins, security, staff). */
export const staffRoom = (tenantId: string): string => `${TENANT_ROOM_PREFIX}${tenantId}`;

/**
 * Same string as staffRoom. Kept under its pre-membership name for the callers
 * and clients that still say "tenant room".
 */
export const tenantRoom = staffRoom;

/** The building's residents room. */
export const residentsRoom = (tenantId: string): string =>
  `${TENANT_ROOM_PREFIX}${tenantId}${RESIDENTS_ROOM_SUFFIX}`;

/** Every socket of one person (gate_users.id). */
export const personRoom = (personId: string): string => `${PERSON_ROOM_PREFIX}${personId}`;

export const gateRoom = (gateId: string): string => `${GATE_ROOM_PREFIX}${gateId}`;

/**
 * Whether a room is one the context decides (anything but the socket's own
 * private room, which Socket.IO names after the socket id). Used when a context
 * changes: every such room is left before the new context's rooms are joined.
 */
export function isContextRoom(room: string): boolean {
  return (
    room === PLATFORM_ROOM ||
    room.startsWith(PERSON_ROOM_PREFIX) ||
    room.startsWith(TENANT_ROOM_PREFIX) ||
    room.startsWith(GATE_ROOM_PREFIX) ||
    room === SIMULATOR_ADMIN_ROOM
  );
}
