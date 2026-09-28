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
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserRole } from '@database/entities/user.entity';
import { Gate, GateState } from '@database/entities/gate.entity';
import { isPlatformContext } from '@common/context/assert-building-context';
import { SimulatorService } from './simulator.service';
import { TriggerEventDto } from './dto/simulator.dto';
import {
  createSocketAuthMiddleware,
  emitRoomForbidden,
  gateRoom,
  getSocketUser,
  isUuid,
  staffRoom,
} from '../gateway/socket-access';
import { SIMULATOR_ADMIN_ROOM } from '../gateway/rooms';
import { ContextSwitchAck, SocketContextService } from '../gateway/socket-context.service';

/** Same roles as POST /simulator/:gateId/trigger (simulator.controller.ts). */
const SIMULATOR_TRIGGER_ROLES: readonly UserRole[] = [
  UserRole.SUPER_ADMIN,
  UserRole.BUILDING_ADMIN,
  UserRole.SECURITY,
];

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
 * Default-namespace ("/") simulator socket.
 *
 * SEC-8: authentication moved from handleConnection (HS256 only, no status
 * check, so every Keycloak user was refused and a deactivated one was not) into
 * namespace middleware — the same HS256 / Keycloak RS256 + ACTIVE rules as HTTP.
 * A refused handshake gets connect_error { code: 'AUTH_FAILED' }.
 *
 * GATE-12: the socket acts as one membership, resolved by SocketContextService
 * exactly as on /events (auth.membershipId or X-Gate-Membership; connect_error
 * { code: 'MEMBERSHIP_INVALID' } for an unusable one), and sits in that
 * context's rooms only. Platform super admins also join the legacy 'admin'
 * room. join:gate and simulator:trigger re-resolve the context from the
 * database first, so a trigger after the membership was deactivated (or the
 * role changed) is refused, and the trigger requires the same roles as the HTTP
 * route; the service then checks that the gate is in the acting building.
 */
@WebSocketGateway({
  cors: {
    origin: parseOrigins(),
    credentials: true,
  },
})
export class SimulatorGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(SimulatorGateway.name);

  constructor(
    private readonly socketContextService: SocketContextService,
    @InjectRepository(Gate)
    private readonly gateRepository: Repository<Gate>,
    private simulatorService: SimulatorService,
  ) {}

  afterInit(server: Server): void {
    server.use(createSocketAuthMiddleware(this.socketContextService, this.logger));
    // So membership writes re-check this namespace's sockets once they commit.
    this.socketContextService.registerNamespace(server);
  }

  handleConnection(client: Socket) {
    const user = getSocketUser(client);
    if (!user) {
      // Unreachable while the middleware is installed; fail closed regardless.
      client.emit('error', { code: 'AUTH_FAILED', message: 'Not authenticated' });
      client.disconnect(true);
      return;
    }

    this.socketContextService.applyRooms(client);

    // Platform super admins also join the legacy admin room.
    if (isPlatformContext(user)) {
      client.join(SIMULATOR_ADMIN_ROOM);
    }

    this.logger.log(`Client connected: ${client.id} (user ${user.id})`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  /** Same contract as /events: act as another membership without reconnecting. */
  @SubscribeMessage('context:switch')
  async handleContextSwitch(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { membershipId?: unknown } | null,
  ): Promise<ContextSwitchAck> {
    const ack = await this.socketContextService.switchContext(client, data?.membershipId);
    const user = getSocketUser(client);
    if (ack.ok && user && isPlatformContext(user)) {
      client.join(SIMULATOR_ADMIN_ROOM);
    }
    return ack;
  }

  @SubscribeMessage('join:gate')
  async handleJoinGate(@ConnectedSocket() client: Socket, @MessageBody() data: { gateId: string }) {
    const gateId = data?.gateId;
    const gate = isUuid(gateId)
      ? await this.gateRepository.findOne({ where: { id: gateId } })
      : null;

    // An unknown gate is refused exactly like a foreign one, so ids cannot be probed.
    if (!gate || !(await this.socketContextService.canJoinGate(client, gate.tenantId))) {
      emitRoomForbidden(client, 'You cannot watch this gate');
      return;
    }

    client.join(gateRoom(gate.id));
    client.emit('joined:gate', { gateId: gate.id });
  }

  @SubscribeMessage('leave:gate')
  handleLeaveGate(@ConnectedSocket() client: Socket, @MessageBody() data: { gateId: string }) {
    if (!isUuid(data?.gateId)) {
      return;
    }
    client.leave(gateRoom(data.gateId));
  }

  @SubscribeMessage('simulator:trigger')
  async handleSimulatorTrigger(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { gateId: string } & TriggerEventDto,
  ) {
    if (!getSocketUser(client)) {
      client.emit('error', { code: 'AUTH_FAILED', message: 'Not authenticated' });
      return;
    }

    // MANUAL_OPEN and friends drive a real gate, so the context is re-resolved
    // from the database first: the connect-time principal may be hours old, and
    // its membership deactivated or its role changed since.
    const user = await this.socketContextService.refresh(client);
    if (!user || !user.role || !SIMULATOR_TRIGGER_ROLES.includes(user.role)) {
      client.emit('error', { code: 'TRIGGER_FORBIDDEN', message: 'Insufficient permissions' });
      return;
    }

    if (!isUuid(data?.gateId)) {
      client.emit('error', { code: 'TRIGGER_FAILED', message: 'Gate not found' });
      return;
    }

    try {
      // The service checks that the gate belongs to the building acted in.
      const result = await this.simulatorService.triggerEvent(
        data.gateId,
        { event: data.event, rfidUid: data.rfidUid, qrToken: data.qrToken },
        user,
      );

      // Emit feedback to the triggering client
      client.emit('simulator:feedback', result);

      // Broadcast state change to all clients watching this gate
      this.emitGateStateChange(data.gateId, result.gateState as GateState);
    } catch (error) {
      client.emit('error', {
        code: 'TRIGGER_FAILED',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  // Methods for broadcasting events
  emitGateStateChange(gateId: string, newState: GateState, previousState?: GateState) {
    this.server.to(gateRoom(gateId)).emit('gate:state-change', {
      gateId,
      previousState,
      newState,
      timestamp: new Date().toISOString(),
      trigger: 'simulator',
    });
  }

  emitAccessEvent(
    gateId: string,
    tenantId: string,
    event: {
      eventId: string;
      gateName: string;
      method: string;
      subjectType: string;
      subjectName: string;
      result: string;
      denialReason?: string;
      operatorName?: string;
    },
  ) {
    const payload = {
      ...event,
      gateId,
      timestamp: new Date().toISOString(),
    };

    // One emit to the union, so a socket watching the gate AND sitting in the
    // staff room gets the event once.
    this.server.to([gateRoom(gateId), staffRoom(tenantId)]).emit('access:event', payload);
  }

  emitHealthUpdate(
    gateId: string,
    tenantId: string,
    data: {
      type: 'controller' | 'sensor';
      sensorType?: string;
      previousStatus: string;
      newStatus: string;
      notes?: string;
    },
  ) {
    const payload = {
      gateId,
      ...data,
      timestamp: new Date().toISOString(),
    };

    this.server.to([gateRoom(gateId), staffRoom(tenantId)]).emit('health:update', payload);
  }
}
