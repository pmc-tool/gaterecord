import { Injectable, Logger } from '@nestjs/common';
import { EventsGateway } from './events.gateway';
import { SecurityAlert } from '@database/entities/security-alert.entity';

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

  /**
   * Broadcast a new security alert to all connected admin/security clients
   */
  broadcastSecurityAlert(alert: SecurityAlert): void {
    this.logger.warn(`=== SECURITY ALERT BROADCAST ===`);
    this.logger.warn(`Alert ID: ${alert.id}, Type: ${alert.type}, Priority: ${alert.priority}`);

    // Broadcast to tenant
    this.broadcastToTenant(alert.tenantId, 'security:alert:new', {
      id: alert.id,
      type: alert.type,
      status: alert.status,
      priority: alert.priority,
      title: alert.title,
      description: alert.description,
      visitorName: alert.visitorName,
      gateName: alert.gateName,
      buzzerTriggered: alert.buzzerTriggered,
      createdAt: alert.createdAt,
    });

    // Also broadcast to super admins globally
    this.broadcastToAll('security:alert:new', {
      id: alert.id,
      tenantId: alert.tenantId,
      type: alert.type,
      status: alert.status,
      priority: alert.priority,
      title: alert.title,
      description: alert.description,
      visitorName: alert.visitorName,
      gateName: alert.gateName,
      buzzerTriggered: alert.buzzerTriggered,
      createdAt: alert.createdAt,
    });
  }

  /**
   * Broadcast security alert status update
   */
  broadcastSecurityAlertUpdate(alert: SecurityAlert): void {
    this.logger.log(`Security alert updated: ${alert.id} - Status: ${alert.status}`);

    this.broadcastToTenant(alert.tenantId, 'security:alert:update', {
      id: alert.id,
      status: alert.status,
      acknowledgedAt: alert.acknowledgedAt,
      resolvedAt: alert.resolvedAt,
      resolutionNotes: alert.resolutionNotes,
    });

    this.broadcastToAll('security:alert:update', {
      id: alert.id,
      tenantId: alert.tenantId,
      status: alert.status,
      acknowledgedAt: alert.acknowledgedAt,
      resolvedAt: alert.resolvedAt,
      resolutionNotes: alert.resolutionNotes,
    });
  }

  /**
   * Trigger buzzer/alarm for a security alert
   */
  triggerBuzzer(tenantId: string, alertId: string): void {
    this.logger.warn(`=== TRIGGERING BUZZER for tenant ${tenantId} ===`);

    this.broadcastToTenant(tenantId, 'security:buzzer:start', {
      alertId,
      action: 'start',
      timestamp: new Date(),
    });
  }

  /**
   * Stop buzzer/alarm
   */
  stopBuzzer(tenantId: string, alertId: string): void {
    this.logger.log(`Stopping buzzer for tenant ${tenantId}`);

    this.broadcastToTenant(tenantId, 'security:buzzer:stop', {
      alertId,
      action: 'stop',
      timestamp: new Date(),
    });
  }
}
