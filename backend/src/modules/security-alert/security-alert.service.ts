import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  SecurityAlert,
  SecurityAlertType,
  SecurityAlertStatus,
  SecurityAlertPriority,
} from '@database/entities/security-alert.entity';
import { AccessEvent } from '@database/entities/access-event.entity';
import { User, UserRole } from '@database/entities/user.entity';
import { Gate } from '@database/entities/gate.entity';
import { GatewayService } from '../gateway/gateway.service';
import { EmailService } from '../notification/email.service';
import { MqttService } from '../mqtt/mqtt.service';

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
  gateName?: string;
  priority?: SecurityAlertPriority;
  triggerBuzzer?: boolean;
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
    private readonly gatewayService: GatewayService,
    private readonly emailService: EmailService,
    private readonly mqttService: MqttService,
  ) {}

  async create(dto: CreateSecurityAlertDto): Promise<SecurityAlert> {
    const alert = this.alertRepository.create({
      tenantId: dto.tenantId,
      type: dto.type,
      title: dto.title,
      description: dto.description,
      accessEventId: dto.accessEventId,
      visitorName: dto.visitorName,
      residentId: dto.residentId,
      reportedByEmail: dto.reportedByEmail,
      gateName: dto.gateName,
      priority: dto.priority || SecurityAlertPriority.HIGH,
      status: SecurityAlertStatus.ACTIVE,
      buzzerTriggered: dto.triggerBuzzer || false,
    });

    const savedAlert = await this.alertRepository.save(alert);

    // Broadcast to all connected clients in the tenant
    this.gatewayService.broadcastSecurityAlert(savedAlert);

    // If buzzer should be triggered, send command to frontend and hardware
    this.logger.warn(`>>> create alert - triggerBuzzer: ${dto.triggerBuzzer}, gateId: ${dto.gateId}`);
    if (dto.triggerBuzzer) {
      this.logger.warn(`>>> Triggering buzzer for tenant ${dto.tenantId}`);
      this.gatewayService.triggerBuzzer(dto.tenantId, savedAlert.id);

      // Also send MQTT command to physical gate controller
      if (dto.gateId) {
        this.logger.warn(`>>> About to call triggerHardwareAlarm with gateId: ${dto.gateId}`);
        await this.triggerHardwareAlarm(dto.gateId, savedAlert.id);
      } else {
        this.logger.warn(`>>> No gateId provided, skipping hardware alarm`);
      }
    }

    return savedAlert;
  }

  private async triggerHardwareAlarm(gateId: string, alertId: string): Promise<void> {
    this.logger.warn(`>>> triggerHardwareAlarm called with gateId: ${gateId}, alertId: ${alertId}`);
    const gate = await this.gateRepository.findOne({ where: { id: gateId } });
    this.logger.warn(`>>> Gate found: ${JSON.stringify(gate ? { id: gate.id, name: gate.name, hardwareId: gate.hardwareId } : null)}`);

    if (gate?.hardwareId) {
      this.logger.warn(`>>> Sending ALARM START to hardware: ${gate.hardwareId}`);
      try {
        await this.mqttService.sendAlarmStart(gate.hardwareId, alertId);
        this.logger.warn(`>>> ALARM START sent successfully`);
      } catch (error) {
        this.logger.error(`>>> ALARM START failed: ${error}`);
      }
    } else {
      this.logger.warn(`Gate ${gateId} has no hardwareId, cannot trigger hardware alarm`);
    }
  }

  private async stopHardwareAlarm(gateId: string, alertId: string): Promise<void> {
    const gate = await this.gateRepository.findOne({ where: { id: gateId } });

    if (gate?.hardwareId) {
      this.logger.log(`>>> Sending ALARM STOP to hardware: ${gate.hardwareId}`);
      await this.mqttService.sendAlarmStop(gate.hardwareId, alertId);
    }
  }

  async reportUnauthorizedVisitor(accessEventId: string, reportToken: string): Promise<SecurityAlert> {
    // The reportToken is base64 encoded combination of accessEventId and timestamp
    // Verify the token matches the access event
    try {
      const decoded = Buffer.from(reportToken, 'base64').toString('utf-8');
      const [tokenEventId] = decoded.split(':');

      if (tokenEventId !== accessEventId) {
        throw new ForbiddenException('Invalid report token');
      }
    } catch {
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

  private async sendSecurityAlerts(alert: SecurityAlert, accessEvent: AccessEvent, reportedBy: string): Promise<void> {
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

  async findAll(user: User, status?: SecurityAlertStatus): Promise<SecurityAlert[]> {
    const query = this.alertRepository.createQueryBuilder('alert')
      .leftJoinAndSelect('alert.tenant', 'tenant')
      .leftJoinAndSelect('alert.accessEvent', 'accessEvent')
      .leftJoinAndSelect('alert.resident', 'resident')
      .leftJoinAndSelect('alert.acknowledgedBy', 'acknowledgedBy')
      .leftJoinAndSelect('alert.resolvedBy', 'resolvedBy')
      .orderBy('alert.createdAt', 'DESC');

    // Filter by tenant unless super admin
    if (user.role !== UserRole.SUPER_ADMIN) {
      query.where('alert.tenantId = :tenantId', { tenantId: user.tenantId });
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
    if (alert.buzzerTriggered) {
      this.gatewayService.stopBuzzer(alert.tenantId, alert.id);

      // Stop hardware alarm via MQTT
      if (alert.accessEvent?.gateId) {
        await this.stopHardwareAlarm(alert.accessEvent.gateId, alert.id);
      }
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
    if (alert.buzzerTriggered) {
      this.gatewayService.stopBuzzer(alert.tenantId, alert.id);

      // Stop hardware alarm via MQTT
      if (alert.accessEvent?.gateId) {
        await this.stopHardwareAlarm(alert.accessEvent.gateId, alert.id);
      }
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
      query.clone().andWhere('alert.status = :status', { status: SecurityAlertStatus.ACTIVE }).getCount(),
      query.clone().andWhere('alert.status = :status', { status: SecurityAlertStatus.ACKNOWLEDGED }).getCount(),
      query.clone().andWhere('alert.status = :status', { status: SecurityAlertStatus.RESOLVED }).getCount(),
      query.clone().andWhere('alert.status = :status', { status: SecurityAlertStatus.FALSE_ALARM }).getCount(),
    ]);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const todayCount = await query.clone()
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
