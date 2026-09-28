import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Namespace, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Gate } from '@database/entities/gate.entity';
import {
  createSocketAuthMiddleware,
  emitRoomForbidden,
  gateRoom,
  getSocketUser,
  isUuid,
  staffRoom,
} from './socket-access';
import { ContextSwitchAck, SocketContextService } from './socket-context.service';

const parseOrigins = (): string[] | true => {
  const raw = process.env.CORS_ORIGINS || process.env.CORS_ORIGIN;
  if (!raw) {
    return [
      'http://localhost:5173',
      'http://localhost:5174',
      'http://localhost:5175',
      'http://localhost:3000',
      'https://gaterecord.com',
      'https://www.gaterecord.com',
      'https://dev.gaterecord.com',
      'https://www.dev.gaterecord.com',
    ];
  }
  if (raw.trim() === '*') return true;
  return raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
};

/**
 * The realtime channel the web app and the legacy SPA use (namespace /events).
 *
 * SEC-8: the namespace used to accept any connection and let any socket join any
 * `tenant:{id}` room by name, so anyone could subscribe to any building's access
 * events, RFID scans and security alerts. Now:
 *   - every connection is authenticated in namespace middleware (afterInit); a
 *     refused handshake gets connect_error { code: 'AUTH_FAILED' };
 *   - join:tenant / join:gate are checked against the caller (see socket-access.ts)
 *     and refused with 'error' { code: 'ROOM_FORBIDDEN' }.
 *
 * GATE-11: a socket acts as ONE membership, like an HTTP request. The handshake
 * names it (auth.membershipId, or the X-Gate-Membership header) and the
 * middleware resolves it with the same rules as HTTP (SocketContextService);
 * a requested membership that cannot be used refuses the connection with
 * connect_error { code: 'MEMBERSHIP_INVALID' }. On connect the socket joins the
 * rooms of that context only (person room; platform, staff or residents room).
 * 'context:switch' { membershipId } moves it to another context without a
 * reconnect, and every join re-checks the context against the database first.
 * The server also re-checks the sockets of everyone whose memberships a
 * committed write changed (SocketContextService.onMembershipChanged), so a
 * removed or deactivated member leaves the building's rooms without asking.
 */
@WebSocketGateway({
  cors: {
    origin: parseOrigins(),
    credentials: true,
  },
  namespace: '/events',
})
export class EventsGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Namespace;

  private readonly logger = new Logger(EventsGateway.name);

  constructor(
    private readonly socketContextService: SocketContextService,
    @InjectRepository(Gate)
    private readonly gateRepository: Repository<Gate>,
  ) {}

  afterInit(server: Namespace): void {
    server.use(createSocketAuthMiddleware(this.socketContextService, this.logger));
    // So membership writes re-check this namespace's sockets once they commit.
    this.socketContextService.registerNamespace(server);
  }

  handleConnection(client: Socket): void {
    const user = getSocketUser(client);
    if (!user) {
      // Unreachable while the middleware is installed; fail closed regardless.
      client.disconnect(true);
      return;
    }

    this.socketContextService.applyRooms(client);
    this.logger.log(
      `Client connected: ${client.id} (user ${user.id}, ${user.contextKind} ${user.tenantId ?? '-'})`,
    );
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  /**
   * Act as another membership (or 'platform') without reconnecting. The client
   * passes an ack callback and receives { ok, tenantId, role, ... } or
   * { ok: false, code }. The socket's rooms follow the new context.
   */
  @SubscribeMessage('context:switch')
  handleContextSwitch(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { membershipId?: unknown } | null,
  ): Promise<ContextSwitchAck> {
    return this.socketContextService.switchContext(client, data?.membershipId);
  }

  @SubscribeMessage('join:tenant')
  async handleJoinTenant(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { tenantId: string },
  ): Promise<void> {
    const tenantId = data?.tenantId;
    if (!(await this.socketContextService.canJoinTenant(client, tenantId))) {
      emitRoomForbidden(client, 'You cannot join this building room');
      return;
    }

    const room = staffRoom(tenantId);
    client.join(room);
    this.logger.log(`Client ${client.id} joined room ${room}`);
    client.emit('joined', { room });
  }

  @SubscribeMessage('leave:tenant')
  handleLeaveTenant(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { tenantId: string },
  ): void {
    if (!isUuid(data?.tenantId)) {
      return;
    }
    const room = staffRoom(data.tenantId);
    client.leave(room);
    this.logger.log(`Client ${client.id} left room ${room}`);
  }

  @SubscribeMessage('join:gate')
  async handleJoinGate(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { gateId: string },
  ): Promise<void> {
    const gateId = data?.gateId;
    const gate = isUuid(gateId)
      ? await this.gateRepository.findOne({ where: { id: gateId } })
      : null;

    // An unknown gate is refused exactly like a foreign one, so ids cannot be probed.
    if (!gate || !(await this.socketContextService.canJoinGate(client, gate.tenantId))) {
      emitRoomForbidden(client, 'You cannot watch this gate');
      return;
    }

    const room = gateRoom(gate.id);
    client.join(room);
    this.logger.log(`Client ${client.id} joined gate room ${room}`);
    client.emit('joined', { room });
  }

  @SubscribeMessage('leave:gate')
  handleLeaveGate(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { gateId: string },
  ): void {
    if (!isUuid(data?.gateId)) {
      return;
    }
    client.leave(gateRoom(data.gateId));
  }

  broadcastToRoom(room: string, event: string, data: unknown): void {
    this.logger.log(`=== EventsGateway: Broadcasting to room ${room} ===`);
    this.logger.log(`Event: ${event}, Data: ${JSON.stringify(data)}`);
    this.server.to(room).emit(event, data);
  }

  /**
   * One emit to the UNION of several rooms: a socket in more than one of them
   * (a super admin who also joined a tenant room) receives the event once.
   */
  broadcastToRooms(rooms: string[], event: string, data: unknown): void {
    this.logger.log(`=== EventsGateway: Broadcasting to rooms ${rooms.join(', ')} ===`);
    this.logger.log(`Event: ${event}`);
    this.server.to(rooms).emit(event, data);
  }

  /** @deprecated Every connected socket of every building. Use a context room. */
  broadcastToAll(event: string, data: unknown): void {
    this.server.emit(event, data);
  }

  sendToSocket(socketId: string, event: string, data: unknown): void {
    this.server.to(socketId).emit(event, data);
  }
}
