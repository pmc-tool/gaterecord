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
import { Logger } from '@nestjs/common';

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
  return raw.split(',').map((o) => o.trim()).filter(Boolean);
};

@WebSocketGateway({
  cors: {
    origin: parseOrigins(),
    credentials: true,
  },
  namespace: '/events',
})
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(EventsGateway.name);

  handleConnection(client: Socket): void {
    this.logger.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('join:tenant')
  handleJoinTenant(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { tenantId: string },
  ): void {
    const room = `tenant:${data.tenantId}`;
    client.join(room);
    this.logger.log(`Client ${client.id} joined room ${room}`);
    client.emit('joined', { room });
  }

  @SubscribeMessage('leave:tenant')
  handleLeaveTenant(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { tenantId: string },
  ): void {
    const room = `tenant:${data.tenantId}`;
    client.leave(room);
    this.logger.log(`Client ${client.id} left room ${room}`);
  }

  @SubscribeMessage('join:gate')
  handleJoinGate(@ConnectedSocket() client: Socket, @MessageBody() data: { gateId: string }): void {
    const room = `gate:${data.gateId}`;
    client.join(room);
    this.logger.log(`Client ${client.id} joined gate room ${room}`);
    client.emit('joined', { room });
  }

  broadcastToRoom(room: string, event: string, data: unknown): void {
    this.logger.log(`=== EventsGateway: Broadcasting to room ${room} ===`);
    this.logger.log(`Event: ${event}, Data: ${JSON.stringify(data)}`);
    this.server.to(room).emit(event, data);
  }

  broadcastToAll(event: string, data: unknown): void {
    this.server.emit(event, data);
  }

  sendToSocket(socketId: string, event: string, data: unknown): void {
    this.server.to(socketId).emit(event, data);
  }
}
