import { Injectable, Logger } from '@nestjs/common';
import { EventsGateway } from './events.gateway';
import { SecurityAlert } from '@database/entities/security-alert.entity';
import { DeviceStatus } from '@database/entities/device-config.entity';

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

  // ==================== Device Status Events ====================

  /**
   * Broadcast when a device comes online
   */
  broadcastDeviceOnline(
    tenantId: string,
    deviceId: string,
    deviceName: string,
    gateId?: string,
  ): void {
    this.logger.log(`Device ${deviceId} (${deviceName}) is now online`);

    this.broadcastToTenant(tenantId, 'device:status', {
      deviceId,
      deviceName,
      gateId,
      status: DeviceStatus.ONLINE,
      timestamp: new Date(),
    });
  }

  /**
   * Broadcast when a device goes offline
   */
  broadcastDeviceOffline(
    tenantId: string,
    deviceId: string,
    deviceName: string,
    gateId?: string,
  ): void {
    this.logger.warn(`Device ${deviceId} (${deviceName}) went offline`);

    this.broadcastToTenant(tenantId, 'device:status', {
      deviceId,
      deviceName,
      gateId,
      status: DeviceStatus.OFFLINE,
      timestamp: new Date(),
    });
  }

  /**
   * Broadcast device heartbeat/metrics update
   */
  broadcastDeviceHeartbeat(
    tenantId: string,
    deviceId: string,
    metrics: {
      firmwareVersion?: string;
      wifiSignalStrength?: number;
      uptime?: number;
      freeHeap?: number;
      ipAddress?: string;
    },
  ): void {
    this.broadcastToTenant(tenantId, 'device:heartbeat', {
      deviceId,
      ...metrics,
      timestamp: new Date(),
    });
  }

  /**
   * Broadcast OTA update progress
   */
  broadcastOtaProgress(
    tenantId: string,
    deviceId: string,
    updateId: string,
    status: string,
    progress?: number,
  ): void {
    this.logger.log(`OTA update ${updateId}: ${status} (${progress || 0}%)`);

    this.broadcastToTenant(tenantId, 'device:ota:progress', {
      deviceId,
      updateId,
      status,
      progress: progress || 0,
      timestamp: new Date(),
    });
  }

  /**
   * Broadcast device paired/claimed
   */
  broadcastDevicePaired(
    tenantId: string,
    deviceId: string,
    deviceName: string,
    gateId?: string,
  ): void {
    this.logger.log(`Device ${deviceId} paired successfully`);

    this.broadcastToTenant(tenantId, 'device:paired', {
      deviceId,
      deviceName,
      gateId,
      timestamp: new Date(),
    });
  }

  /**
   * Broadcast device removed/unpaired
   */
  broadcastDeviceRemoved(tenantId: string, deviceId: string): void {
    this.logger.log(`Device ${deviceId} removed`);

    this.broadcastToTenant(tenantId, 'device:removed', {
      deviceId,
      timestamp: new Date(),
    });
  }
}
