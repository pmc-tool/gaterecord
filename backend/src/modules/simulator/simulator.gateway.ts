import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '@database/entities/user.entity';
import { GateState } from '@database/entities/gate.entity';
import { SimulatorService } from './simulator.service';
import { TriggerEventDto } from './dto/simulator.dto';

interface AuthenticatedSocket extends Socket {
  user?: User;
}

@WebSocketGateway({
  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
    credentials: true,
  },
})
export class SimulatorGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  constructor(
    private jwtService: JwtService,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private simulatorService: SimulatorService,
  ) {}

  async handleConnection(client: AuthenticatedSocket) {
    try {
      const token =
        client.handshake.auth?.token ||
        client.handshake.headers?.authorization?.replace('Bearer ', '');

      if (!token) {
        client.emit('error', { code: 'AUTH_FAILED', message: 'No token provided' });
        client.disconnect();
        return;
      }

      const payload = this.jwtService.verify(token);
      const user = await this.userRepository.findOne({
        where: { id: payload.sub },
        relations: ['tenant'],
      });

      if (!user) {
        client.emit('error', { code: 'AUTH_FAILED', message: 'User not found' });
        client.disconnect();
        return;
      }

      client.user = user;

      // Join tenant room
      if (user.tenantId) {
        client.join(`tenant:${user.tenantId}`);
      }

      // Super admin joins admin room
      if (user.role === 'super_admin') {
        client.join('admin');
      }

      console.log(`Client connected: ${client.id}, User: ${user.email}`);
    } catch (error) {
      client.emit('error', { code: 'AUTH_FAILED', message: 'Invalid token' });
      client.disconnect();
    }
  }

  handleDisconnect(client: AuthenticatedSocket) {
    console.log(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('join:gate')
  handleJoinGate(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { gateId: string },
  ) {
    client.join(`gate:${data.gateId}`);
    client.emit('joined:gate', { gateId: data.gateId });
  }

  @SubscribeMessage('leave:gate')
  handleLeaveGate(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { gateId: string },
  ) {
    client.leave(`gate:${data.gateId}`);
  }

  @SubscribeMessage('simulator:trigger')
  async handleSimulatorTrigger(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { gateId: string } & TriggerEventDto,
  ) {
    if (!client.user) {
      client.emit('error', { code: 'AUTH_FAILED', message: 'Not authenticated' });
      return;
    }

    try {
      const result = await this.simulatorService.triggerEvent(
        data.gateId,
        { event: data.event, rfidUid: data.rfidUid, qrToken: data.qrToken },
        client.user,
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
    this.server.to(`gate:${gateId}`).emit('gate:state-change', {
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

    this.server.to(`gate:${gateId}`).emit('access:event', payload);
    this.server.to(`tenant:${tenantId}`).emit('access:event', payload);
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

    this.server.to(`gate:${gateId}`).emit('health:update', payload);
    this.server.to(`tenant:${tenantId}`).emit('health:update', payload);
  }
}
