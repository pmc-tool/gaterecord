import { Injectable, Logger, NotFoundException, ForbiddenException, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  SecurityAlert,
  SecurityAlertType,
  SecurityAlertStatus,
  SecurityAlertPriority,
  SecurityAlertSource,
} from '@database/entities/security-alert.entity';
import { AccessEvent } from '@database/entities/access-event.entity';
import { User, UserRole } from '@database/entities/user.entity';
import { Gate } from '@database/entities/gate.entity';
import { DeviceConfig } from '@database/entities/device-config.entity';
import { GatewayService } from '../gateway/gateway.service';
import { EmailService } from '../notification/email.service';
import { NotificationService } from '../notification/notification.service';
import { CloudPlusTcpService } from '../cloud-plus-typeB-tcp/cloud-plus-tcp.service';
import { PendingAlarmService } from '../cloud-plus-typeB/pending-alarm.service';

export interface CreateSecurityAlertDto {
  tenantId: string;
  type: SecurityAlertType;
  title: string;
  description: string;
  accessEventId?: string;
  visitorName?: string;
  residentId?: string;
  reportedByEmail?: string;
  gateId?: string;
  deviceId?: string;
  gateName?: string;
  priority?: SecurityAlertPriority;
  source?: SecurityAlertSource;
  controllerSerial?: string;
  triggerBuzzer?: boolean;
  alarmDuration?: number;
}

export interface ReportUnauthorizedDto {
  accessEventId: string;
  reportToken: string;
}

@Injectable()
export class SecurityAlertService {
  private readonly logger = new Logger(SecurityAlertService.name);

  constructor(
    @InjectRepository(SecurityAlert)
    private readonly alertRepository: Repository<SecurityAlert>,
    @InjectRepository(AccessEvent)
    private readonly accessEventRepository: Repository<AccessEvent>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Gate)
    private readonly gateRepository: Repository<Gate>,
    @InjectRepository(DeviceConfig)
    private readonly deviceRepository: Repository<DeviceConfig>,
    private readonly gatewayService: GatewayService,
    private readonly emailService: EmailService,
    private readonly notificationService: NotificationService,
    @Inject(forwardRef(() => CloudPlusTcpService))
    private readonly tcpService: CloudPlusTcpService,
    private readonly pendingAlarmService: PendingAlarmService,
  ) {}

  async create(dto: CreateSecurityAlertDto): Promise<SecurityAlert> {
    const alert = this.alertRepository.create({
      tenantId: dto.tenantId,
      gateId: dto.gateId,
      deviceId: dto.deviceId,
      type: dto.type,
      source: dto.source || SecurityAlertSource.SYSTEM,
      title: dto.title,
      description: dto.description,
      accessEventId: dto.accessEventId,
      visitorName: dto.visitorName,
      residentId: dto.residentId,
      reportedByEmail: dto.reportedByEmail,
      gateName: dto.gateName,
      controllerSerial: dto.controllerSerial,
      priority: dto.priority || SecurityAlertPriority.HIGH,
      status: SecurityAlertStatus.ACTIVE,
      buzzerTriggered: dto.triggerBuzzer || false,
      alarmDurationSeconds: dto.alarmDuration || 30,
    });

    const savedAlert = await this.alertRepository.save(alert);

    // Broadcast to all connected clients in the tenant
    this.gatewayService.broadcastSecurityAlert(savedAlert);

    // Create database notifications for Security, Building Admin, and Super Admins
    this.notificationService.notifySecurityAlert(
      dto.tenantId,
      dto.title,
      dto.description,
      {
        alertId: savedAlert.id,
        gateId: dto.gateId,
        gateName: dto.gateName,
        visitorName: dto.visitorName,
        priority: dto.priority,
        link: `/security-alerts?id=${savedAlert.id}`,
      },
    ).catch((err) => {
      this.logger.error('Failed to create security alert notifications:', err);
    });

    // If buzzer should be triggered, send command to frontend and hardware
    this.logger.warn(
      `>>> create alert - triggerBuzzer: ${dto.triggerBuzzer}, gateId: ${dto.gateId}`,
    );
    if (dto.triggerBuzzer) {
      this.logger.warn(`>>> Triggering buzzer for tenant ${dto.tenantId}`);
      this.gatewayService.triggerBuzzer(dto.tenantId, savedAlert.id);

      // Send command to physical gate controller via Cloud Plus TCP
      await this.triggerHardwareAlarm(savedAlert, dto.alarmDuration || 30);
    }

    return savedAlert;
  }

  /**
   * Trigger hardware alarm on Cloud Plus TypeB controller via TCP
   */
  private async triggerHardwareAlarm(alert: SecurityAlert, duration: number): Promise<void> {
    try {
      let success = false;
      let serials: string[] = [];

      // Try by specific controller serial first
      if (alert.controllerSerial) {
        const result = await this.tcpService.triggerSecurityAlarm(alert.controllerSerial, duration);
        success = result.success;
        if (success) serials.push(result.serial);
      }
      // Otherwise trigger on all controllers for the gate
      else if (alert.gateId) {
        const result = await this.tcpService.triggerGateAlarm(alert.gateId, duration);
        success = result.successCount > 0;
        serials = result.serials;
      }

      if (success) {
        await this.alertRepository.update(alert.id, {
          hardwareAlarmSent: true,
          controllerSerial: serials[0] || alert.controllerSerial,
        });
        this.logger.warn(`Hardware alarm triggered on controllers: ${serials.join(', ')}`);
      } else {
        this.logger.warn(`No TCP-connected controllers found for hardware alarm`);
      }

      // Also arm the HTTP-mode alarm queue. HTTP-client controllers hold no TCP
      // socket, so the TCP path above no-ops for them; this delivers the alarm on
      // the controller's next GetStatus heartbeat instead. Harmless for TCP units.
      await this.armHttpAlarm(alert);
    } catch (error) {
      this.logger.error(`Failed to trigger hardware alarm: ${error}`);
    }
  }

  /**
   * Arm the pending-alarm queue for every controller serial behind this alert,
   * so an HTTP-mode controller sounds its alarm relay on the next heartbeat.
   */
  private async armHttpAlarm(alert: SecurityAlert): Promise<void> {
    const serials = await this.resolveControllerSerials(alert);
    if (serials.length === 0) {
      this.logger.error(
        `[HTTP-ALARM] No controller serials resolved for alert ${alert.id} ` +
          `(gateId=${alert.gateId ?? 'none'}, controllerSerial=${alert.controllerSerial ?? 'none'}). ` +
          `Buzzer will NOT fire — register a DeviceConfig (deviceId=controller serial) for this gate.`,
      );
      return;
    }
    this.logger.warn(`[HTTP-ALARM] Arming buzzer for alert ${alert.id} on serials: ${serials.join(', ')}`);
    for (const serial of serials) {
      this.pendingAlarmService.arm(serial);
    }
  }

  /** Collect controller serials from the alert's controllerSerial or its gate. */
  private async resolveControllerSerials(alert: SecurityAlert): Promise<string[]> {
    if (alert.controllerSerial) {
      return [alert.controllerSerial];
    }
    if (alert.gateId) {
      const devices = await this.deviceRepository.find({ where: { gateId: alert.gateId } });
      const serials = devices.map((d) => d.deviceId).filter((s): s is string => !!s);
      this.logger.debug(
        `[HTTP-ALARM] Gate ${alert.gateId} → ${devices.length} device(s), serials: [${serials.join(', ')}]`,
      );
      return serials;
    }
    return [];
  }

  /**
   * Stop hardware alarm on Cloud Plus TypeB controller via TCP
   */
  private async stopHardwareAlarm(alert: SecurityAlert): Promise<void> {
    try {
      // Always disarm the HTTP alarm queue so the CLOSE command is delivered on
      // the controller's next heartbeat, even if the TCP path was never used.
      const serials = await this.resolveControllerSerials(alert);
      if (serials.length > 0) {
        this.logger.warn(`[HTTP-ALARM] Silencing buzzer for alert ${alert.id} on serials: ${serials.join(', ')}`);
      }
      for (const serial of serials) {
        this.pendingAlarmService.disarm(serial);
      }

      if (!alert.hardwareAlarmSent) return;

      let success = false;

      if (alert.controllerSerial) {
        const result = await this.tcpService.stopSecurityAlarm(alert.controllerSerial);
        success = result.success;
      } else if (alert.gateId) {
        const result = await this.tcpService.stopGateAlarm(alert.gateId);
        success = result.successCount > 0;
      }

      if (success) {
        await this.alertRepository.update(alert.id, { hardwareAlarmStopped: true });
        this.logger.log(`Hardware alarm stopped for alert ${alert.id}`);
      }
    } catch (error) {
      this.logger.error(`Failed to stop hardware alarm: ${error}`);
    }
  }

  async reportUnauthorizedVisitor(
    accessEventId: string,
    reportToken: string,
  ): Promise<SecurityAlert> {
    this.logger.warn(`[REPORT] Unauthorized-visitor report received for accessEvent=${accessEventId}`);

    // The reportToken is base64 encoded combination of accessEventId and timestamp
    // Verify the token matches the access event
    try {
      const decoded = Buffer.from(reportToken, 'base64').toString('utf-8');
      const [tokenEventId] = decoded.split(':');

      if (tokenEventId !== accessEventId) {
        this.logger.error(
          `[REPORT] Token mismatch: token points to ${tokenEventId}, request is ${accessEventId}`,
        );
        throw new ForbiddenException('Invalid report token');
      }
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      this.logger.error(`[REPORT] Malformed report token for accessEvent=${accessEventId}`);
      throw new ForbiddenException('Invalid report token');
    }

    // Find the access event
    const accessEvent = await this.accessEventRepository.findOne({
      where: { id: accessEventId },
      relations: ['gate', 'tenant'],
    });

    if (!accessEvent) {
      throw new NotFoundException('Access event not found');
    }

    // Check if already reported
    const existingAlert = await this.alertRepository.findOne({
      where: {
        accessEventId,
        type: SecurityAlertType.UNAUTHORIZED_VISITOR,
      },
    });

    if (existingAlert) {
      return existingAlert;
    }

    // Get resident info from metadata
    const residentId = accessEvent.metadata?.residentId as string;
    const visitorName = accessEvent.subjectName || 'Unknown Visitor';

    let residentName = 'Unknown Resident';
    let resident: User | null = null;

    if (residentId) {
      resident = await this.userRepository.findOne({ where: { id: residentId } });
      if (resident) {
        residentName = `${resident.firstName} ${resident.lastName}`;
      }
    }

    // Create security alert
    const alert = await this.create({
      tenantId: accessEvent.tenantId,
      type: SecurityAlertType.UNAUTHORIZED_VISITOR,
      title: `UNAUTHORIZED VISITOR: ${visitorName}`,
      description: `Visitor "${visitorName}" was reported as unauthorized by ${residentName} at gate ${accessEvent.gate?.name || 'Unknown'}`,
      accessEventId,
      visitorName,
      residentId,
      reportedByEmail: resident?.email,
      gateId: accessEvent.gateId,
      gateName: accessEvent.gate?.name,
      priority: SecurityAlertPriority.CRITICAL,
      triggerBuzzer: true,
    });

    // Send security alert email to all security staff and admins
    await this.sendSecurityAlerts(alert, accessEvent, residentName);

    return alert;
  }

  private async sendSecurityAlerts(
    alert: SecurityAlert,
    accessEvent: AccessEvent,
    reportedBy: string,
  ): Promise<void> {
    // Find all security staff and admins for this tenant
    const securityUsers = await this.userRepository.find({
      where: [
        { tenantId: accessEvent.tenantId, role: UserRole.SECURITY },
        { tenantId: accessEvent.tenantId, role: UserRole.BUILDING_ADMIN },
      ],
    });

    // Also get super admins
    const superAdmins = await this.userRepository.find({
      where: { role: UserRole.SUPER_ADMIN },
    });

    const allRecipients = [...securityUsers, ...superAdmins];

    for (const user of allRecipients) {
      if (user.email) {
        try {
          await this.emailService.sendSecurityAlertEmail(
            user.email,
            alert.visitorName || 'Unknown',
            reportedBy,
            accessEvent.tenant?.name || 'Unknown Building',
            alert.gateName || 'Unknown Gate',
            accessEvent.timestamp,
            reportedBy,
            accessEvent.id,
          );
        } catch (error) {
          this.logger.error(`Failed to send security alert to ${user.email}:`, error);
        }
      }
    }
  }

  async findAll(user: User, status?: SecurityAlertStatus, tenantId?: string): Promise<SecurityAlert[]> {
    const query = this.alertRepository
      .createQueryBuilder('alert')
      .leftJoinAndSelect('alert.tenant', 'tenant')
      .leftJoinAndSelect('alert.accessEvent', 'accessEvent')
      .leftJoinAndSelect('alert.resident', 'resident')
      .leftJoinAndSelect('alert.acknowledgedBy', 'acknowledgedBy')
      .leftJoinAndSelect('alert.resolvedBy', 'resolvedBy')
      .orderBy('alert.createdAt', 'DESC');

    // Filter by tenant unless super admin
    if (user.role !== UserRole.SUPER_ADMIN) {
      query.where('alert.tenantId = :tenantId', { tenantId: user.tenantId });
    } else if (tenantId) {
      // Super admin can filter by tenant
      query.where('alert.tenantId = :tenantId', { tenantId });
    }

    if (status) {
      query.andWhere('alert.status = :status', { status });
    }

    return query.getMany();
  }

  async findActive(user: User): Promise<SecurityAlert[]> {
    return this.findAll(user, SecurityAlertStatus.ACTIVE);
  }

  async acknowledge(id: string, user: User): Promise<SecurityAlert> {
    const alert = await this.alertRepository.findOne({
      where: { id },
      relations: ['tenant', 'accessEvent'],
    });

    if (!alert) {
      throw new NotFoundException('Security alert not found');
    }

    // Check access
    if (user.role !== UserRole.SUPER_ADMIN && alert.tenantId !== user.tenantId) {
      throw new ForbiddenException('Access denied');
    }

    alert.status = SecurityAlertStatus.ACKNOWLEDGED;
    alert.acknowledgedById = user.id;
    alert.acknowledgedAt = new Date();

    const savedAlert = await this.alertRepository.save(alert);

    // Broadcast update
    this.gatewayService.broadcastSecurityAlertUpdate(savedAlert);

    // Stop buzzer if it was triggered (frontend and hardware)
    if (alert.buzzerTriggered || alert.hardwareAlarmSent) {
      this.gatewayService.stopBuzzer(alert.tenantId, alert.id);

      // Stop hardware alarm via Cloud Plus TCP protocol
      await this.stopHardwareAlarm(alert);
    }

    return savedAlert;
  }

  async resolve(id: string, user: User, notes?: string): Promise<SecurityAlert> {
    const alert = await this.alertRepository.findOne({
      where: { id },
      relations: ['tenant'],
    });

    if (!alert) {
      throw new NotFoundException('Security alert not found');
    }

    // Check access
    if (user.role !== UserRole.SUPER_ADMIN && alert.tenantId !== user.tenantId) {
      throw new ForbiddenException('Access denied');
    }

    alert.status = SecurityAlertStatus.RESOLVED;
    alert.resolvedById = user.id;
    alert.resolvedAt = new Date();
    if (notes) {
      alert.resolutionNotes = notes;
    }

    const savedAlert = await this.alertRepository.save(alert);

    // Broadcast update
    this.gatewayService.broadcastSecurityAlertUpdate(savedAlert);

    return savedAlert;
  }

  async markFalseAlarm(id: string, user: User, notes?: string): Promise<SecurityAlert> {
    const alert = await this.alertRepository.findOne({
      where: { id },
      relations: ['tenant', 'accessEvent'],
    });

    if (!alert) {
      throw new NotFoundException('Security alert not found');
    }

    // Check access
    if (user.role !== UserRole.SUPER_ADMIN && alert.tenantId !== user.tenantId) {
      throw new ForbiddenException('Access denied');
    }

    alert.status = SecurityAlertStatus.FALSE_ALARM;
    alert.resolvedById = user.id;
    alert.resolvedAt = new Date();
    if (notes) {
      alert.resolutionNotes = notes;
    } else {
      alert.resolutionNotes = 'Marked as false alarm';
    }

    const savedAlert = await this.alertRepository.save(alert);

    // Broadcast update
    this.gatewayService.broadcastSecurityAlertUpdate(savedAlert);

    // Stop buzzer (frontend and hardware)
    if (alert.buzzerTriggered || alert.hardwareAlarmSent) {
      this.gatewayService.stopBuzzer(alert.tenantId, alert.id);

      // Stop hardware alarm via Cloud Plus TCP protocol
      await this.stopHardwareAlarm(alert);
    }

    return savedAlert;
  }

  async getStats(user: User): Promise<{
    active: number;
    acknowledged: number;
    resolved: number;
    falseAlarms: number;
    today: number;
  }> {
    const query = this.alertRepository.createQueryBuilder('alert');

    if (user.role !== UserRole.SUPER_ADMIN) {
      query.where('alert.tenantId = :tenantId', { tenantId: user.tenantId });
    }

    const [active, acknowledged, resolved, falseAlarms] = await Promise.all([
      query
        .clone()
        .andWhere('alert.status = :status', { status: SecurityAlertStatus.ACTIVE })
        .getCount(),
      query
        .clone()
        .andWhere('alert.status = :status', { status: SecurityAlertStatus.ACKNOWLEDGED })
        .getCount(),
      query
        .clone()
        .andWhere('alert.status = :status', { status: SecurityAlertStatus.RESOLVED })
        .getCount(),
      query
        .clone()
        .andWhere('alert.status = :status', { status: SecurityAlertStatus.FALSE_ALARM })
        .getCount(),
    ]);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const todayCount = await query
      .clone()
      .andWhere('alert.createdAt >= :today', { today })
      .getCount();

    return {
      active,
      acknowledged,
      resolved,
      falseAlarms,
      today: todayCount,
    };
  }

  generateReportToken(accessEventId: string): string {
    const timestamp = Date.now();
    const data = `${accessEventId}:${timestamp}`;
    return Buffer.from(data).toString('base64');
  }
}
