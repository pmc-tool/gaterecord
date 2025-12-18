import { Injectable, Logger } from '@nestjs/common';
import { EventsGateway } from './events.gateway';

@Injectable()
export class GatewayService {
  private readonly logger = new Logger(GatewayService.name);

  constructor(private eventsGateway: EventsGateway) {}

  /**
   * Broadcast a message to all clients in a specific tenant room
   */
  broadcastToTenant(tenantId: string, event: string, data: unknown): void {
    const room = `tenant:${tenantId}`;
    this.logger.log(`=== GatewayService: Broadcasting to room ${room} ===`);
    this.logger.log(`Event: ${event}`);
    this.eventsGateway.broadcastToRoom(room, event, data);
  }

  /**
   * Broadcast to all connected clients
   */
  broadcastToAll(event: string, data: unknown): void {
    this.eventsGateway.broadcastToAll(event, data);
    this.logger.debug(`Broadcast to all: ${event}`);
  }

  /**
   * Send to a specific user by their socket ID
   */
  sendToUser(socketId: string, event: string, data: unknown): void {
    this.eventsGateway.sendToSocket(socketId, event, data);
  }
}
