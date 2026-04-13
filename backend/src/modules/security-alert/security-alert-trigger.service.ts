/**
 * Security Alert Trigger Service
 * 
 * Production-grade real-time security alert detection and triggering
 * Integrates with Cloud Plus TypeB controllers via TCP/HTTP
 * 
 * Responsibilities:
 * - Detects security-relevant events from controller events
 * - Creates security alerts with proper building/gate/device relationships
 * - Triggers hardware alarms on Cloud Plus controllers
 * - Implements alert escalation logic
 * - Handles repeated denied access detection
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan, LessThan } from 'typeorm';
import { OnEvent, EventEmitter2 } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';

import {
  SecurityAlert,
  SecurityAlertType,
  SecurityAlertStatus,
  SecurityAlertPriority,
  SecurityAlertSource,
} from '@database/entities/security-alert.entity';
import { AccessEvent, AccessResult } from '@database/entities/access-event.entity';
import { DeviceConfig } from '@database/entities/device-config.entity';
import { Gate } from '@database/entities/gate.entity';
import { Tenant } from '@database/entities/tenant.entity';

import { CloudPlusTcpService } from '../cloud-plus-typeB-tcp/cloud-plus-tcp.service';
import { GatewayService } from '../gateway/gateway.service';
import { EmailService } from '../notification/email.service';
import { ControllerEvent } from '../cloud-plus-typeB-tcp/dto';

// Configuration constants
const ALERT_CONFIG = {
  // Number of denied attempts before triggering repeated denial alert
  REPEATED_DENIAL_THRESHOLD: 3,
  // Time window for counting repeated denials (minutes)
  REPEATED_DENIAL_WINDOW_MINUTES: 5,
  // Default alarm duration on hardware (seconds)
  DEFAULT_ALARM_DURATION: 30,
  // Critical alert alarm duration (seconds)
  CRITICAL_ALARM_DURATION: 60,
  // Auto-escalation time for unacknowledged alerts (minutes)
  ESCALATION_TIMEOUT_MINUTES: 10,
  // Auto-resolve time for low priority alerts (hours)
  AUTO_RESOLVE_HOURS: 24,
  // Offline detection threshold (minutes)
  OFFLINE_DETECTION_MINUTES: 5,
};

interface AlertCreationParams {
  tenantId: string;
  gateId?: string;
  deviceId?: string;
  type: SecurityAlertType;
  priority: SecurityAlertPriority;
  source: SecurityAlertSource;
  title: string;
  description: string;
  accessEventId?: string;
  visitorName?: string;
  residentId?: string;
  controllerSerial?: string;
  credentialType?: string;
  credentialValue?: string;
  triggerHardwareAlarm?: boolean;
  alarmDuration?: number;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class SecurityAlertTriggerService {
  private readonly logger = new Logger(SecurityAlertTriggerService.name);

  // In-memory tracking for repeated denial detection
  private denialTracker = new Map<string, { count: number; firstDenied: Date; lastCredential: string }>();

  constructor(
    @InjectRepository(SecurityAlert)
    private readonly alertRepository: Repository<SecurityAlert>,
    @InjectRepository(AccessEvent)
    private readonly accessEventRepository: Repository<AccessEvent>,
    @InjectRepository(DeviceConfig)
    private readonly deviceRepository: Repository<DeviceConfig>,
    @InjectRepository(Gate)
    private readonly gateRepository: Repository<Gate>,
    private readonly tcpService: CloudPlusTcpService,
    private readonly gatewayService: GatewayService,
    private readonly emailService: EmailService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ==================== Event Handlers ====================

  /**
   * Handle access denied events - check for patterns that indicate security threats
   */
  @OnEvent('access.denied')
  async handleAccessDenied(event: {
    accessEvent: AccessEvent;
    gate: Gate;
    device?: DeviceConfig;
    credential: string;
    credentialType: string;
  }): Promise<void> {
    this.logger.debug(`Access denied at gate ${event.gate.name}: ${event.credentialType}`);

    // Track repeated denials per gate
    await this.trackDeniedAccess(event);

    // Check for suspicious patterns
    await this.checkDenialPatterns(event);
  }

  /**
   * Handle controller events directly from TCP server
   * This is the primary entry point for real-time event processing
   */
  @OnEvent('tcp.controller.event.processed')
  async handleControllerEventProcessed(payload: {
    event: ControllerEvent;
    accessEvent: AccessEvent;
    result: 'allowed' | 'denied';
    device: DeviceConfig;
    gate: Gate;
  }): Promise<void> {
    if (payload.result === 'denied') {
      // Emit access.denied event for pattern detection
      this.eventEmitter.emit('access.denied', {
        accessEvent: payload.accessEvent,
        gate: payload.gate,
        device: payload.device,
        credential: payload.event.card,
        credentialType: String(payload.event.dataType),
      });
    }
  }

  /**
   * Handle controller disconnection - may indicate tampering or failure
   */
  @OnEvent('tcp.controller.disconnected')
  async handleControllerDisconnect(payload: {
    serial: string;
    gateId?: string;
    tenantId?: string;
    reason?: string;
  }): Promise<void> {
    this.logger.warn(`Controller disconnected: ${payload.serial}`);

    // Only create alert if we have tenant context
    if (!payload.tenantId) {
      const device = await this.deviceRepository.findOne({
        where: { deviceId: payload.serial },
        relations: ['gate', 'tenant'],
      });

      if (device) {
        payload.tenantId = device.tenantId;
        payload.gateId = device.gateId || undefined;
      }
    }

    if (payload.tenantId) {
      // Schedule offline alert (only if still offline after threshold)
      setTimeout(async () => {
        const isStillOffline = !this.tcpService.getServerStatus().controllers
          .some((c) => c.serial === payload.serial);

        if (isStillOffline) {
          await this.createAlert({
            tenantId: payload.tenantId!,
            gateId: payload.gateId,
            type: SecurityAlertType.CONTROLLER_OFFLINE,
            priority: SecurityAlertPriority.MEDIUM,
            source: SecurityAlertSource.SYSTEM,
            title: `Controller Offline: ${payload.serial}`,
            description: `Controller ${payload.serial} has been offline for more than ${ALERT_CONFIG.OFFLINE_DETECTION_MINUTES} minutes. Reason: ${payload.reason || 'Unknown'}`,
            controllerSerial: payload.serial,
            triggerHardwareAlarm: false,
          });
        }
      }, ALERT_CONFIG.OFFLINE_DETECTION_MINUTES * 60 * 1000);
    }
  }

  // ==================== Scheduled Tasks ====================

  /**
   * Check for unacknowledged alerts that need escalation
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async checkAlertEscalation(): Promise<void> {
    const escalationTime = new Date();
    escalationTime.setMinutes(escalationTime.getMinutes() - ALERT_CONFIG.ESCALATION_TIMEOUT_MINUTES);

    const unacknowledgedAlerts = await this.alertRepository.find({
      where: {
        status: SecurityAlertStatus.ACTIVE,
        escalated: false,
        createdAt: LessThan(escalationTime),
        priority: SecurityAlertPriority.HIGH,
      },
      relations: ['tenant', 'gate'],
    });

    for (const alert of unacknowledgedAlerts) {
      await this.escalateAlert(alert);
    }
  }

  /**
   * Auto-resolve old low-priority alerts
   */
  @Cron(CronExpression.EVERY_HOUR)
  async autoResolveOldAlerts(): Promise<void> {
    const autoResolveTime = new Date();
    autoResolveTime.setHours(autoResolveTime.getHours() - ALERT_CONFIG.AUTO_RESOLVE_HOURS);

    await this.alertRepository.update(
      {
        status: SecurityAlertStatus.ACTIVE,
        priority: SecurityAlertPriority.LOW,
        createdAt: LessThan(autoResolveTime),
      },
      {
        status: SecurityAlertStatus.RESOLVED,
        resolvedAt: new Date(),
        resolutionNotes: 'Auto-resolved after 24 hours',
      },
    );
  }

  /**
   * Clean up denial tracker periodically
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  cleanupDenialTracker(): void {
    const cutoff = new Date();
    cutoff.setMinutes(cutoff.getMinutes() - ALERT_CONFIG.REPEATED_DENIAL_WINDOW_MINUTES);

    for (const [key, value] of this.denialTracker.entries()) {
      if (value.firstDenied < cutoff) {
        this.denialTracker.delete(key);
      }
    }
  }

  // ==================== Alert Creation ====================

  /**
   * Create a security alert with full relationship tracking
   */
  async createAlert(params: AlertCreationParams): Promise<SecurityAlert> {
    // Check for duplicate active alerts of same type for same gate
    const existingAlert = await this.alertRepository.findOne({
      where: {
        tenantId: params.tenantId,
        gateId: params.gateId || undefined,
        type: params.type,
        status: SecurityAlertStatus.ACTIVE,
      },
    });

    if (existingAlert) {
      this.logger.debug(`Duplicate alert prevented: ${params.type} for gate ${params.gateId}`);
      return existingAlert;
    }

    // Get gate name if gateId provided
    let gateName = '';
    if (params.gateId) {
      const gate = await this.gateRepository.findOne({ where: { id: params.gateId } });
      gateName = gate?.name || '';
    }

    // Create the alert
    const alert = this.alertRepository.create({
      tenantId: params.tenantId,
      gateId: params.gateId,
      deviceId: params.deviceId,
      type: params.type,
      source: params.source,
      priority: params.priority,
      status: SecurityAlertStatus.ACTIVE,
      title: params.title,
      description: params.description,
      accessEventId: params.accessEventId,
      visitorName: params.visitorName,
      residentId: params.residentId,
      gateName,
      controllerSerial: params.controllerSerial,
      credentialType: params.credentialType,
      credentialValue: params.credentialValue,
      buzzerTriggered: params.triggerHardwareAlarm || false,
      hardwareAlarmSent: false,
      alarmDurationSeconds: params.alarmDuration || ALERT_CONFIG.DEFAULT_ALARM_DURATION,
      metadata: params.metadata,
    });

    const savedAlert = await this.alertRepository.save(alert);

    this.logger.warn(
      `🚨 SECURITY ALERT CREATED: ${params.type} | Gate: ${gateName || 'N/A'} | Priority: ${params.priority}`,
    );

    // Broadcast to frontend via WebSocket
    this.gatewayService.broadcastSecurityAlert(savedAlert);

    // Trigger hardware alarm if requested
    if (params.triggerHardwareAlarm) {
      await this.triggerHardwareAlarm(savedAlert, params.alarmDuration);
    }

    // Send email notifications for high priority alerts
    if (params.priority === SecurityAlertPriority.HIGH || params.priority === SecurityAlertPriority.CRITICAL) {
      this.eventEmitter.emit('security.alert.notify', { alert: savedAlert });
    }

    return savedAlert;
  }

  /**
   * Create alert for unauthorized visitor reported by resident
   */
  async createUnauthorizedVisitorAlert(
    accessEventId: string,
    residentId: string,
    reportedByEmail: string,
  ): Promise<SecurityAlert> {
    const accessEvent = await this.accessEventRepository.findOne({
      where: { id: accessEventId },
      relations: ['gate'],
    });

    if (!accessEvent) {
      throw new Error('Access event not found');
    }

    // Find the device that handled this event
    const device = await this.deviceRepository.findOne({
      where: { gateId: accessEvent.gateId },
    });

    return this.createAlert({
      tenantId: accessEvent.tenantId,
      gateId: accessEvent.gateId,
      deviceId: device?.id,
      type: SecurityAlertType.UNAUTHORIZED_VISITOR,
      priority: SecurityAlertPriority.CRITICAL,
      source: SecurityAlertSource.RESIDENT_REPORT,
      title: `UNAUTHORIZED VISITOR: ${accessEvent.subjectName || 'Unknown'}`,
      description: `Visitor reported as unauthorized by resident at ${accessEvent.gate?.name || 'unknown gate'}`,
      accessEventId,
      visitorName: accessEvent.subjectName,
      residentId,
      controllerSerial: device?.deviceId,
      triggerHardwareAlarm: true,
      alarmDuration: ALERT_CONFIG.CRITICAL_ALARM_DURATION,
      metadata: {
        reportedByEmail,
        reportedAt: new Date().toISOString(),
      },
    });
  }

  // ==================== Hardware Alarm Control ====================

  /**
   * Trigger hardware alarm on the controller(s) associated with an alert
   */
  private async triggerHardwareAlarm(
    alert: SecurityAlert,
    duration: number = ALERT_CONFIG.DEFAULT_ALARM_DURATION,
  ): Promise<void> {
    let success = false;
    let triggeredSerials: string[] = [];

    // Try by specific controller serial first
    if (alert.controllerSerial) {
      const result = await this.tcpService.triggerSecurityAlarm(alert.controllerSerial, duration);
      success = result.success;
      if (success) triggeredSerials.push(result.serial);
    }
    // Otherwise trigger on all controllers for the gate
    else if (alert.gateId) {
      const result = await this.tcpService.triggerGateAlarm(alert.gateId, duration);
      success = result.successCount > 0;
      triggeredSerials = result.serials;
    }

    // Update alert with hardware alarm status
    if (success) {
      await this.alertRepository.update(alert.id, {
        hardwareAlarmSent: true,
        controllerSerial: triggeredSerials[0] || alert.controllerSerial,
      });

      this.logger.warn(`Hardware alarm triggered on: ${triggeredSerials.join(', ')}`);
    } else {
      this.logger.error(`Failed to trigger hardware alarm for alert ${alert.id}`);
    }
  }

  /**
   * Stop hardware alarm when alert is acknowledged
   */
  async stopHardwareAlarm(alertId: string): Promise<void> {
    const alert = await this.alertRepository.findOne({ where: { id: alertId } });

    if (!alert || !alert.hardwareAlarmSent) return;

    let success = false;

    if (alert.controllerSerial) {
      const result = await this.tcpService.stopSecurityAlarm(alert.controllerSerial);
      success = result.success;
    } else if (alert.gateId) {
      const result = await this.tcpService.stopGateAlarm(alert.gateId);
      success = result.successCount > 0;
    }

    if (success) {
      await this.alertRepository.update(alertId, { hardwareAlarmStopped: true });
      
      // Notify frontend to stop buzzer
      this.gatewayService.stopBuzzer(alert.tenantId, alertId);
    }
  }

  // ==================== Pattern Detection ====================

  /**
   * Track denied access attempts for pattern detection
   */
  private async trackDeniedAccess(event: {
    accessEvent: AccessEvent;
    gate: Gate;
    credential: string;
  }): Promise<void> {
    const key = `${event.gate.id}:${event.credential}`;
    const existing = this.denialTracker.get(key);

    const windowStart = new Date();
    windowStart.setMinutes(windowStart.getMinutes() - ALERT_CONFIG.REPEATED_DENIAL_WINDOW_MINUTES);

    if (existing && existing.firstDenied >= windowStart) {
      // Increment count
      this.denialTracker.set(key, {
        count: existing.count + 1,
        firstDenied: existing.firstDenied,
        lastCredential: event.credential,
      });
    } else {
      // Start new tracking
      this.denialTracker.set(key, {
        count: 1,
        firstDenied: new Date(),
        lastCredential: event.credential,
      });
    }
  }

  /**
   * Check for suspicious denial patterns that warrant alerts
   */
  private async checkDenialPatterns(event: {
    accessEvent: AccessEvent;
    gate: Gate;
    device?: DeviceConfig;
    credential: string;
    credentialType: string;
  }): Promise<void> {
    const key = `${event.gate.id}:${event.credential}`;
    const tracker = this.denialTracker.get(key);

    if (tracker && tracker.count >= ALERT_CONFIG.REPEATED_DENIAL_THRESHOLD) {
      // Create repeated denial alert
      await this.createAlert({
        tenantId: event.gate.tenantId,
        gateId: event.gate.id,
        deviceId: event.device?.id,
        type: SecurityAlertType.REPEATED_DENIED_ACCESS,
        priority: SecurityAlertPriority.HIGH,
        source: SecurityAlertSource.CONTROLLER,
        title: `Repeated Access Denied: ${event.credential.substring(0, 8)}...`,
        description: `${tracker.count} failed access attempts at ${event.gate.name} within ${ALERT_CONFIG.REPEATED_DENIAL_WINDOW_MINUTES} minutes`,
        accessEventId: event.accessEvent.id,
        controllerSerial: event.device?.deviceId,
        credentialType: event.credentialType,
        credentialValue: event.credential,
        triggerHardwareAlarm: true,
        metadata: {
          attemptCount: tracker.count,
          firstAttempt: tracker.firstDenied.toISOString(),
        },
      });

      // Reset tracker after alert
      this.denialTracker.delete(key);
    }
  }

  // ==================== Alert Management ====================

  /**
   * Escalate an unacknowledged alert
   */
  private async escalateAlert(alert: SecurityAlert): Promise<void> {
    await this.alertRepository.update(alert.id, {
      escalated: true,
      escalatedAt: new Date(),
      priority: SecurityAlertPriority.CRITICAL,
    });

    this.logger.warn(`Alert escalated: ${alert.id} - ${alert.title}`);

    // Emit escalation event for additional notifications
    this.eventEmitter.emit('security.alert.escalated', { alert });
  }

  /**
   * Get alert statistics for dashboard
   */
  async getAlertStats(tenantId?: string): Promise<{
    active: number;
    acknowledged: number;
    resolvedToday: number;
    totalToday: number;
    byType: Record<string, number>;
    byPriority: Record<string, number>;
  }> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const whereClause = tenantId ? { tenantId } : {};

    const [active, acknowledged, resolvedToday, totalToday] = await Promise.all([
      this.alertRepository.count({ where: { ...whereClause, status: SecurityAlertStatus.ACTIVE } }),
      this.alertRepository.count({ where: { ...whereClause, status: SecurityAlertStatus.ACKNOWLEDGED } }),
      this.alertRepository.count({
        where: { ...whereClause, status: SecurityAlertStatus.RESOLVED, resolvedAt: MoreThan(today) },
      }),
      this.alertRepository.count({ where: { ...whereClause, createdAt: MoreThan(today) } }),
    ]);

    // Get counts by type
    const typeStats = await this.alertRepository
      .createQueryBuilder('alert')
      .select('alert.type', 'type')
      .addSelect('COUNT(*)', 'count')
      .where(tenantId ? 'alert.tenantId = :tenantId' : '1=1', { tenantId })
      .andWhere('alert.createdAt >= :today', { today })
      .groupBy('alert.type')
      .getRawMany();

    const byType = typeStats.reduce((acc, row) => {
      acc[row.type] = parseInt(row.count);
      return acc;
    }, {} as Record<string, number>);

    // Get counts by priority
    const priorityStats = await this.alertRepository
      .createQueryBuilder('alert')
      .select('alert.priority', 'priority')
      .addSelect('COUNT(*)', 'count')
      .where(tenantId ? 'alert.tenantId = :tenantId' : '1=1', { tenantId })
      .andWhere('alert.status = :status', { status: SecurityAlertStatus.ACTIVE })
      .groupBy('alert.priority')
      .getRawMany();

    const byPriority = priorityStats.reduce((acc, row) => {
      acc[row.priority] = parseInt(row.count);
      return acc;
    }, {} as Record<string, number>);

    return { active, acknowledged, resolvedToday, totalToday, byType, byPriority };
  }
}
