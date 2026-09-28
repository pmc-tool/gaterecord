import { Injectable, Logger } from '@nestjs/common';
import { EventsGateway } from './events.gateway';
import { PLATFORM_ROOM, personRoom, residentsRoom, staffRoom } from './rooms';
import { SecurityAlert } from '@database/entities/security-alert.entity';
import { DeviceStatus } from '@database/entities/device-config.entity';

/**
 * Server → client fan-out on the /events namespace. Every method targets the
 * rooms of one context (rooms.ts), so a person who holds roles in several
 * buildings only receives a building's events on sockets acting in it:
 *
 *   broadcastToTenant           the building's STAFF room (admins, security,
 *                               staff acting there; platform super admins who
 *                               joined it). Access events, devices, RFID
 *                               registration, buzzer.
 *   broadcastToTenantResidents  residents acting in the building.
 *   sendToPerson                every socket of one person, any context.
 *   security alerts             staff room + 'platform', one emit.
 */
@Injectable()
export class GatewayService {
  private readonly logger = new Logger(GatewayService.name);

  constructor(private eventsGateway: EventsGateway) {}

  /**
   * Broadcast to the building's staff room, tenant:{tenantId}. The room string
   * is unchanged from before memberships (staffRoom === the old tenant room).
   */
  broadcastToTenant(tenantId: string, event: string, data: unknown): void {
    const room = staffRoom(tenantId);
    this.logger.log(`=== GatewayService: Broadcasting to room ${room} ===`);
    this.logger.log(`Event: ${event}`);
    this.eventsGateway.broadcastToRoom(room, event, data);
  }

  /** Broadcast to the residents acting in a building, tenant:{tenantId}:residents. */
  broadcastToTenantResidents(tenantId: string, event: string, data: unknown): void {
    this.eventsGateway.broadcastToRoom(residentsRoom(tenantId), event, data);
  }

  /** Send to every connected socket of one person (gate_users.id), whatever it acts as. */
  sendToPerson(personId: string, event: string, data: unknown): void {
    this.eventsGateway.broadcastToRoom(personRoom(personId), event, data);
  }

  /**
   * @deprecated Every authenticated socket of every building. Never use it for
   * building data (security alerts stopped in SEC-8); target a context room with
   * broadcastToTenant, broadcastToTenantResidents or sendToPerson instead.
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
   * Security alerts go to the alert's building staff room plus the 'platform'
   * room (super admins only), as ONE emit to the union of the two rooms, so a
   * super admin who also joined the tenant room receives it once.
   *
   * SEC-8: this used to be broadcastToTenant + broadcastToAll, and the global
   * copy reached EVERY connected socket — residents and other buildings' staff
   * included — with the alert title, description and visitor name.
   */
  private broadcastAlertEvent(tenantId: string, event: string, data: unknown): void {
    this.eventsGateway.broadcastToRooms([staffRoom(tenantId), PLATFORM_ROOM], event, data);
  }

  /**
   * Broadcast a new security alert to the building's admin/security clients and
   * to super admins
   */
  broadcastSecurityAlert(alert: SecurityAlert): void {
    this.logger.warn(`=== SECURITY ALERT BROADCAST ===`);
    this.logger.warn(`Alert ID: ${alert.id}, Type: ${alert.type}, Priority: ${alert.priority}`);

    // tenantId is included for the platform view, which mixes buildings.
    this.broadcastAlertEvent(alert.tenantId, 'security:alert:new', {
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
   * Broadcast security alert status update (same audience as the new alert)
   */
  broadcastSecurityAlertUpdate(alert: SecurityAlert): void {
    this.logger.log(`Security alert updated: ${alert.id} - Status: ${alert.status}`);

    this.broadcastAlertEvent(alert.tenantId, 'security:alert:update', {
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
