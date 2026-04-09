import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan, LessThan } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Gate, GateState } from '@database/entities/gate.entity';
import {
  GateController as GateControllerEntity,
  ControllerStatus,
} from '@database/entities/gate-controller.entity';
import {
  SensorStatus,
  SensorType,
  SensorHealthStatus,
} from '@database/entities/sensor-status.entity';
import { Vehicle, VehicleStatus } from '@database/entities/vehicle.entity';
import { RfidCard, RfidCardStatus } from '@database/entities/rfid-card.entity';
import { VisitorPass, VisitorPassStatus } from '@database/entities/visitor-pass.entity';
import {
  AccessEvent,
  AccessMethod,
  AccessResult,
  AccessSubjectType,
} from '@database/entities/access-event.entity';
import { User, UserRole } from '@database/entities/user.entity';
import {
  TriggerEventDto,
  SimulatorEvent,
  SimulatorFeedbackDto,
  UpdateSensorDto,
} from './dto/simulator.dto';
import { EmailService } from '../notification/email.service';
import { SecurityAlertService } from '../security-alert/security-alert.service';
import { CloudPlusService } from '../cloud-plus-typeB/cloud-plus.service';

@Injectable()
export class SimulatorService {
  private readonly logger = new Logger(SimulatorService.name);
  private stateTimeouts: Map<string, NodeJS.Timeout> = new Map();

  constructor(
    private emailService: EmailService,
    private securityAlertService: SecurityAlertService,
    private configService: ConfigService,
    @Inject(forwardRef(() => CloudPlusService))
    private cloudPlusService: CloudPlusService,
    @InjectRepository(Gate)
    private gateRepository: Repository<Gate>,
    @InjectRepository(GateControllerEntity)
    private controllerRepository: Repository<GateControllerEntity>,
    @InjectRepository(SensorStatus)
    private sensorRepository: Repository<SensorStatus>,
    @InjectRepository(Vehicle)
    private vehicleRepository: Repository<Vehicle>,
    @InjectRepository(RfidCard)
    private rfidCardRepository: Repository<RfidCard>,
    @InjectRepository(VisitorPass)
    private visitorPassRepository: Repository<VisitorPass>,
    @InjectRepository(AccessEvent)
    private accessEventRepository: Repository<AccessEvent>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
  ) {}

  async triggerEvent(
    gateId: string,
    dto: TriggerEventDto,
    currentUser: User,
  ): Promise<SimulatorFeedbackDto> {
    const gate = await this.gateRepository.findOne({
      where: { id: gateId },
      relations: ['tenant'],
    });

    if (!gate) {
      throw new NotFoundException('Gate not found');
    }

    if (currentUser.role !== UserRole.SUPER_ADMIN && gate.tenantId !== currentUser.tenantId) {
      throw new ForbiddenException('Access denied');
    }

    switch (dto.event) {
      case SimulatorEvent.CAR_RFID_DETECTED:
        return this.handleCloudPlusCarRfid(gate, dto);
      case SimulatorEvent.HUMAN_RFID_DETECTED:
        return this.handleCloudPlusSearchCard(gate, dto);
      case SimulatorEvent.QR_VERIFIED:
        return this.handleQrVerified(gate, dto.qrToken!, currentUser);
      case SimulatorEvent.OBSTACLE_DETECTED:
        return this.handleObstacle(gate, true);
      case SimulatorEvent.OBSTACLE_CLEARED:
        return this.handleObstacle(gate, false);
      case SimulatorEvent.LIMIT_OPEN_REACHED:
        return this.handleLimitSwitch(gate, 'open');
      case SimulatorEvent.LIMIT_CLOSE_REACHED:
        return this.handleLimitSwitch(gate, 'close');
      case SimulatorEvent.MANUAL_OPEN:
        return this.handleManualOverride(gate, 'open', currentUser);
      case SimulatorEvent.MANUAL_CLOSE:
        return this.handleManualOverride(gate, 'close', currentUser);
      default:
        throw new BadRequestException('Unknown event type');
    }
  }

  private async handleCarRfid(
    gate: Gate,
    rfidUid: string,
    currentUser: User,
  ): Promise<SimulatorFeedbackDto> {
    const now = new Date();
    const vehicle = await this.vehicleRepository.findOne({
      where: {
        tenantId: gate.tenantId,
        rfidUid,
        status: VehicleStatus.ACTIVE,
      },
      relations: ['owner'],
    });

    if (!vehicle) {
      const event = await this.createAccessEvent(gate, {
        method: AccessMethod.CAR_RFID,
        subjectType: AccessSubjectType.UNKNOWN,
        subjectIdentifier: rfidUid,
        result: AccessResult.DENIED,
        denialReason: 'Unknown vehicle RFID',
      });

      // Send RED LED feedback to hardware
      await this.sendHardwareFeedback(gate, 'ERROR', 'Access Denied', 'Unknown Vehicle');

      return {
        gateId: gate.id,
        action: SimulatorEvent.CAR_RFID_DETECTED,
        success: false,
        message: 'Access denied - Unknown vehicle',
        gateState: gate.state,
        eventId: event.id,
      };
    }

    // Check validity period
    if (vehicle.validFrom && vehicle.validFrom > now) {
      const event = await this.createAccessEvent(gate, {
        method: AccessMethod.CAR_RFID,
        subjectType: AccessSubjectType.VEHICLE,
        subjectId: vehicle.id,
        subjectIdentifier: rfidUid,
        subjectName: `${vehicle.owner.firstName} ${vehicle.owner.lastName} - ${vehicle.licensePlate}`,
        result: AccessResult.DENIED,
        denialReason: 'Vehicle not yet valid',
      });

      await this.sendHardwareFeedback(gate, 'ERROR', 'Access Denied', 'Not Yet Valid');

      return {
        gateId: gate.id,
        action: SimulatorEvent.CAR_RFID_DETECTED,
        success: false,
        message: 'Access denied - Vehicle not yet valid',
        gateState: gate.state,
        eventId: event.id,
      };
    }

    if (vehicle.validUntil && vehicle.validUntil < now) {
      const event = await this.createAccessEvent(gate, {
        method: AccessMethod.CAR_RFID,
        subjectType: AccessSubjectType.VEHICLE,
        subjectId: vehicle.id,
        subjectIdentifier: rfidUid,
        subjectName: `${vehicle.owner.firstName} ${vehicle.owner.lastName} - ${vehicle.licensePlate}`,
        result: AccessResult.DENIED,
        denialReason: 'Vehicle access expired',
      });

      await this.sendHardwareFeedback(gate, 'ERROR', 'Access Denied', 'Access Expired');

      return {
        gateId: gate.id,
        action: SimulatorEvent.CAR_RFID_DETECTED,
        success: false,
        message: 'Access denied - Vehicle access expired',
        gateState: gate.state,
        eventId: event.id,
      };
    }

    // Grant access
    const event = await this.createAccessEvent(gate, {
      method: AccessMethod.CAR_RFID,
      subjectType: AccessSubjectType.VEHICLE,
      subjectId: vehicle.id,
      subjectIdentifier: rfidUid,
      subjectName: `${vehicle.owner.firstName} ${vehicle.owner.lastName} - ${vehicle.licensePlate}`,
      result: AccessResult.ALLOWED,
    });

    // Send GREEN LED feedback and welcome message
    await this.sendHardwareFeedback(
      gate,
      'SUCCESS',
      `Welcome ${vehicle.owner.firstName}`,
      vehicle.licensePlate,
    );

    await this.transitionState(gate, GateState.OPENING);

    return {
      gateId: gate.id,
      action: SimulatorEvent.CAR_RFID_DETECTED,
      success: true,
      message: `Access granted - ${vehicle.owner.firstName} ${vehicle.owner.lastName}`,
      gateState: GateState.OPENING,
      eventId: event.id,
    };
  }

  /**
   * Handle Car RFID via Cloud Plus TypeB SearchCardAcs
   */
  private async handleCloudPlusCarRfid(
    gate: Gate,
    dto: TriggerEventDto,
  ): Promise<SimulatorFeedbackDto> {
    // Build SearchCardAcs request from simulator DTO
    const searchCardRequest = {
      Serial: dto.Serial || gate.hardwareId || 'SIMULATOR',
      Card: dto.rfidUid || '',
      Reader: dto.Reader ? parseInt(dto.Reader, 10) : 0,
      type: dto.type ? parseInt(dto.type, 10) : 12, // Default to RFID
    };

    try {
      const response = await this.cloudPlusService.processSearchCardAcs(
        searchCardRequest,
        '',
        'vehicle',
        gate,
      );

      // Parse response to determine success/failure
      const isAllowed = response.AcsRes === '1';

      if (isAllowed) {
        await this.transitionState(gate, GateState.OPENING);
      }

      return {
        gateId: gate.id,
        action: SimulatorEvent.CAR_RFID_DETECTED,
        success: isAllowed,
        message: isAllowed
          ? `Access granted - Vehicle ${response.Name || 'Unknown'}`
          : `Access denied - ${response.Note || 'Unknown vehicle'}`,
        gateState: isAllowed ? GateState.OPENING : gate.state,
      };
    } catch (error) {
      this.logger.error('Cloud Plus Car RFID error:', error);
      return {
        gateId: gate.id,
        action: SimulatorEvent.CAR_RFID_DETECTED,
        success: false,
        message: 'Access denied - System error',
        gateState: gate.state,
      };
    }
  }

  /**
   * Handle Human RFID via Cloud Plus TypeB SearchCardAcs
   */
  private async handleCloudPlusSearchCard(
    gate: Gate,
    dto: TriggerEventDto,
  ): Promise<SimulatorFeedbackDto> {
    // Build SearchCardAcs request from simulator DTO
    const searchCardRequest = {
      Serial: dto.Serial || gate.hardwareId || 'SIMULATOR',
      Card: dto.rfidUid || '',
      Reader: dto.Reader ? parseInt(dto.Reader, 10) : 0,
      type: dto.type ? parseInt(dto.type, 10) : 12, // Default to RFID
    };

    try {
      const response = await this.cloudPlusService.processSearchCardAcs(
        searchCardRequest,
        '',
        'human',
        gate,
      );

      // Parse response to determine success/failure
      const isAllowed = response.AcsRes === '1';

      if (isAllowed) {
        await this.transitionState(gate, GateState.OPENING);
      }

      return {
        gateId: gate.id,
        action: SimulatorEvent.HUMAN_RFID_DETECTED,
        success: isAllowed,
        message: isAllowed
          ? `Access granted - ${response.Name || 'User'}`
          : `Access denied - ${response.Note || 'Unknown'}`,
        gateState: isAllowed ? GateState.OPENING : gate.state,
      };
    } catch (error) {
      this.logger.error('Cloud Plus SearchCardAcs error:', error);
      return {
        gateId: gate.id,
        action: SimulatorEvent.HUMAN_RFID_DETECTED,
        success: false,
        message: 'Access denied - System error',
        gateState: gate.state,
      };
    }
  }

  private async handleHumanRfid(
    gate: Gate,
    rfidUid: string,
    currentUser: User,
  ): Promise<SimulatorFeedbackDto> {
    const now = new Date();
    const rfidCard = await this.rfidCardRepository.findOne({
      where: {
        tenantId: gate.tenantId,
        uid: rfidUid,
        status: RfidCardStatus.ACTIVE,
      },
      relations: ['user'],
    });

    if (!rfidCard) {
      const event = await this.createAccessEvent(gate, {
        method: AccessMethod.HUMAN_RFID,
        subjectType: AccessSubjectType.UNKNOWN,
        subjectIdentifier: rfidUid,
        result: AccessResult.DENIED,
        denialReason: 'Unknown RFID card',
      });

      await this.sendHardwareFeedback(gate, 'ERROR', 'Access Denied', 'Unknown Card');

      return {
        gateId: gate.id,
        action: SimulatorEvent.HUMAN_RFID_DETECTED,
        success: false,
        message: 'Access denied - Unknown card',
        gateState: gate.state,
        eventId: event.id,
      };
    }

    // Check validity period
    if (rfidCard.validFrom && rfidCard.validFrom > now) {
      const event = await this.createAccessEvent(gate, {
        method: AccessMethod.HUMAN_RFID,
        subjectType: AccessSubjectType.RFID_CARD,
        subjectId: rfidCard.id,
        subjectIdentifier: rfidUid,
        subjectName: `${rfidCard.user.firstName} ${rfidCard.user.lastName}`,
        result: AccessResult.DENIED,
        denialReason: 'Card not yet valid',
      });

      await this.sendHardwareFeedback(gate, 'ERROR', 'Access Denied', 'Not Yet Valid');

      return {
        gateId: gate.id,
        action: SimulatorEvent.HUMAN_RFID_DETECTED,
        success: false,
        message: 'Access denied - Card not yet valid',
        gateState: gate.state,
        eventId: event.id,
      };
    }

    if (rfidCard.validUntil && rfidCard.validUntil < now) {
      const event = await this.createAccessEvent(gate, {
        method: AccessMethod.HUMAN_RFID,
        subjectType: AccessSubjectType.RFID_CARD,
        subjectId: rfidCard.id,
        subjectIdentifier: rfidUid,
        subjectName: `${rfidCard.user.firstName} ${rfidCard.user.lastName}`,
        result: AccessResult.DENIED,
        denialReason: 'Card expired',
      });

      await this.sendHardwareFeedback(gate, 'ERROR', 'Access Denied', 'Card Expired');

      return {
        gateId: gate.id,
        action: SimulatorEvent.HUMAN_RFID_DETECTED,
        success: false,
        message: 'Access denied - Card expired',
        gateState: gate.state,
        eventId: event.id,
      };
    }

    // Grant access
    const event = await this.createAccessEvent(gate, {
      method: AccessMethod.HUMAN_RFID,
      subjectType: AccessSubjectType.RFID_CARD,
      subjectId: rfidCard.id,
      subjectIdentifier: rfidUid,
      subjectName: `${rfidCard.user.firstName} ${rfidCard.user.lastName}`,
      result: AccessResult.ALLOWED,
    });

    await this.sendHardwareFeedback(
      gate,
      'SUCCESS',
      `Welcome ${rfidCard.user.firstName}`,
      'Access Granted',
    );

    await this.transitionState(gate, GateState.OPENING);

    return {
      gateId: gate.id,
      action: SimulatorEvent.HUMAN_RFID_DETECTED,
      success: true,
      message: `Access granted - ${rfidCard.user.firstName} ${rfidCard.user.lastName}`,
      gateState: GateState.OPENING,
      eventId: event.id,
    };
  }

  private async handleQrVerified(
    gate: Gate,
    qrToken: string,
    currentUser: User,
  ): Promise<SimulatorFeedbackDto> {
    const now = new Date();
    const pass = await this.visitorPassRepository.findOne({
      where: {
        tenantId: gate.tenantId,
        qrToken,
      },
      relations: ['createdBy', 'resident', 'tenant'],
    });

    if (!pass) {
      const event = await this.createAccessEvent(gate, {
        method: AccessMethod.QR,
        subjectType: AccessSubjectType.UNKNOWN,
        subjectIdentifier: qrToken,
        result: AccessResult.DENIED,
        denialReason: 'Invalid QR code',
      });

      return {
        gateId: gate.id,
        action: SimulatorEvent.QR_VERIFIED,
        success: false,
        message: 'Access denied - Invalid QR code',
        gateState: gate.state,
        eventId: event.id,
      };
    }

    // Check status
    if (pass.status !== VisitorPassStatus.ACTIVE && pass.status !== VisitorPassStatus.PENDING) {
      const event = await this.createAccessEvent(gate, {
        method: AccessMethod.QR,
        subjectType: AccessSubjectType.VISITOR_PASS,
        subjectId: pass.id,
        subjectIdentifier: qrToken,
        subjectName: pass.visitorName,
        result: AccessResult.DENIED,
        denialReason: `Pass status: ${pass.status}`,
      });

      return {
        gateId: gate.id,
        action: SimulatorEvent.QR_VERIFIED,
        success: false,
        message: `Access denied - Pass ${pass.status}`,
        gateState: gate.state,
        eventId: event.id,
      };
    }

    // Check validity period
    if (pass.validFrom > now || pass.validUntil < now) {
      const event = await this.createAccessEvent(gate, {
        method: AccessMethod.QR,
        subjectType: AccessSubjectType.VISITOR_PASS,
        subjectId: pass.id,
        subjectIdentifier: qrToken,
        subjectName: pass.visitorName,
        result: AccessResult.DENIED,
        denialReason: 'Pass not valid at this time',
      });

      return {
        gateId: gate.id,
        action: SimulatorEvent.QR_VERIFIED,
        success: false,
        message: 'Access denied - Pass not valid at this time',
        gateState: gate.state,
        eventId: event.id,
      };
    }

    // Check use count
    if (pass.useCount >= pass.maxUses) {
      await this.visitorPassRepository.update(pass.id, { status: VisitorPassStatus.USED });

      const event = await this.createAccessEvent(gate, {
        method: AccessMethod.QR,
        subjectType: AccessSubjectType.VISITOR_PASS,
        subjectId: pass.id,
        subjectIdentifier: qrToken,
        subjectName: pass.visitorName,
        result: AccessResult.DENIED,
        denialReason: 'Pass usage limit reached',
      });

      return {
        gateId: gate.id,
        action: SimulatorEvent.QR_VERIFIED,
        success: false,
        message: 'Access denied - Pass usage limit reached',
        gateState: gate.state,
        eventId: event.id,
      };
    }

    // Grant access and increment use count
    await this.visitorPassRepository.update(pass.id, {
      useCount: pass.useCount + 1,
      status: VisitorPassStatus.ACTIVE,
    });

    // Determine resident info for notification
    const resident = pass.resident || pass.createdBy;
    const residentId = resident?.id;
    const residentName = resident ? `${resident.firstName} ${resident.lastName}` : 'Unknown';
    const residentEmail = resident?.email;

    const event = await this.createAccessEvent(gate, {
      method: AccessMethod.QR,
      subjectType: AccessSubjectType.VISITOR_PASS,
      subjectId: pass.id,
      subjectIdentifier: qrToken,
      subjectName: `${pass.visitorName} (Visitor)`,
      result: AccessResult.ALLOWED,
      metadata: {
        residentId,
        residentName,
        residentEmail,
        visitorName: pass.visitorName,
        visitorPassId: pass.id,
      },
    });

    await this.transitionState(gate, GateState.OPENING);

    // Send visitor entry notification to resident
    if (residentEmail) {
      this.sendVisitorEntryNotification(event, gate, pass, resident).catch((err) => {
        this.logger.error('Failed to send visitor entry notification:', err);
      });
    }

    return {
      gateId: gate.id,
      action: SimulatorEvent.QR_VERIFIED,
      success: true,
      message: `Access granted - Visitor: ${pass.visitorName}`,
      gateState: GateState.OPENING,
      eventId: event.id,
    };
  }

  private async sendVisitorEntryNotification(
    accessEvent: AccessEvent,
    gate: Gate,
    pass: VisitorPass,
    resident: User,
  ): Promise<void> {
    const frontendUrl = this.configService.get<string>('FRONTEND_URL', 'http://localhost:3000');
    const reportToken = this.securityAlertService.generateReportToken(accessEvent.id);
    const reportUrl = `${frontendUrl}/report-unauthorized?eventId=${accessEvent.id}&token=${reportToken}`;

    const buildingName = pass.tenant?.name || gate.tenant?.name || 'the building';

    await this.emailService.sendVisitorEntryNotification(
      resident.email,
      `${resident.firstName} ${resident.lastName}`,
      pass.visitorName,
      buildingName,
      gate.name,
      accessEvent.timestamp,
      accessEvent.id,
      reportUrl,
    );

    this.logger.log(`Visitor entry notification sent to ${resident.email}`);
  }

  private async handleObstacle(gate: Gate, detected: boolean): Promise<SimulatorFeedbackDto> {
    if (detected) {
      if (gate.state === GateState.CLOSING) {
        await this.transitionState(gate, GateState.OBSTACLE_HOLD);
        return {
          gateId: gate.id,
          action: SimulatorEvent.OBSTACLE_DETECTED,
          success: true,
          message: 'Obstacle detected - Gate holding',
          gateState: GateState.OBSTACLE_HOLD,
        };
      }
    } else {
      if (gate.state === GateState.OBSTACLE_HOLD) {
        await this.transitionState(gate, GateState.CLOSING);
        return {
          gateId: gate.id,
          action: SimulatorEvent.OBSTACLE_CLEARED,
          success: true,
          message: 'Obstacle cleared - Resuming close',
          gateState: GateState.CLOSING,
        };
      }
    }

    return {
      gateId: gate.id,
      action: detected ? SimulatorEvent.OBSTACLE_DETECTED : SimulatorEvent.OBSTACLE_CLEARED,
      success: false,
      message: `Obstacle event ignored in state: ${gate.state}`,
      gateState: gate.state,
    };
  }

  private async handleLimitSwitch(
    gate: Gate,
    position: 'open' | 'close',
  ): Promise<SimulatorFeedbackDto> {
    if (position === 'open' && gate.state === GateState.OPENING) {
      await this.transitionState(gate, GateState.OPEN);

      // Auto-close after 5 seconds
      this.scheduleAutoClose(gate.id);

      return {
        gateId: gate.id,
        action: SimulatorEvent.LIMIT_OPEN_REACHED,
        success: true,
        message: 'Gate fully open',
        gateState: GateState.OPEN,
      };
    }

    if (position === 'close' && gate.state === GateState.CLOSING) {
      await this.transitionState(gate, GateState.CLOSED);

      return {
        gateId: gate.id,
        action: SimulatorEvent.LIMIT_CLOSE_REACHED,
        success: true,
        message: 'Gate fully closed',
        gateState: GateState.CLOSED,
      };
    }

    return {
      gateId: gate.id,
      action:
        position === 'open'
          ? SimulatorEvent.LIMIT_OPEN_REACHED
          : SimulatorEvent.LIMIT_CLOSE_REACHED,
      success: false,
      message: `Limit switch event ignored in state: ${gate.state}`,
      gateState: gate.state,
    };
  }

  private async handleManualOverride(
    gate: Gate,
    action: 'open' | 'close',
    currentUser: User,
  ): Promise<SimulatorFeedbackDto> {
    const targetState = action === 'open' ? GateState.MANUAL_OVERRIDE : GateState.CLOSING;

    const event = await this.createAccessEvent(gate, {
      method: AccessMethod.MANUAL,
      subjectType: AccessSubjectType.USER,
      subjectId: currentUser.id,
      subjectName: `${currentUser.firstName} ${currentUser.lastName}`,
      result: AccessResult.ALLOWED,
      operatorId: currentUser.id,
      operatorName: `${currentUser.firstName} ${currentUser.lastName}`,
    });

    if (action === 'open') {
      await this.transitionState(gate, GateState.OPENING);
    } else {
      await this.transitionState(gate, GateState.CLOSING);
    }

    return {
      gateId: gate.id,
      action: action === 'open' ? SimulatorEvent.MANUAL_OPEN : SimulatorEvent.MANUAL_CLOSE,
      success: true,
      message: `Manual ${action} initiated by ${currentUser.firstName}`,
      gateState: action === 'open' ? GateState.OPENING : GateState.CLOSING,
      eventId: event.id,
    };
  }

  private async transitionState(gate: Gate, newState: GateState): Promise<void> {
    gate.state = newState;
    await this.gateRepository.save(gate);

    // Gate commands are sent via Cloud Plus HTTP protocol
    if (gate.hardwareId) {
      this.logger.log(
        `>>> Gate state transition: ${gate.hardwareId}, state: ${newState} (via Cloud Plus HTTP)`,
      );
    }
  }

  // Send LED feedback to hardware
  private async sendHardwareFeedback(
    gate: Gate,
    type: 'SUCCESS' | 'ERROR' | 'WARNING',
    message1?: string,
    _message2?: string,
  ): Promise<void> {
    if (!gate.hardwareId) return;

    // Feedback is sent via Cloud Plus HTTP protocol response
    this.logger.log(`>>> ${type} feedback for hardware: ${gate.hardwareId}, message: ${message1}`);
  }

  private scheduleAutoClose(gateId: string): void {
    // Clear existing timeout if any
    const existingTimeout = this.stateTimeouts.get(gateId);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    // Schedule auto-close after 5 seconds
    const timeout = setTimeout(async () => {
      const gate = await this.gateRepository.findOne({ where: { id: gateId } });
      if (gate && gate.state === GateState.OPEN) {
        await this.transitionState(gate, GateState.CLOSING);
      }
      this.stateTimeouts.delete(gateId);
    }, 5000);

    this.stateTimeouts.set(gateId, timeout);
  }

  private async createAccessEvent(gate: Gate, data: Partial<AccessEvent>): Promise<AccessEvent> {
    const event = this.accessEventRepository.create({
      tenantId: gate.tenantId,
      gateId: gate.id,
      timestamp: new Date(),
      ...data,
    });

    return this.accessEventRepository.save(event);
  }

  async setOnlineStatus(gateId: string, isOnline: boolean, currentUser: User): Promise<Gate> {
    const gate = await this.gateRepository.findOne({ where: { id: gateId } });

    if (!gate) {
      throw new NotFoundException('Gate not found');
    }

    if (currentUser.role !== UserRole.SUPER_ADMIN && gate.tenantId !== currentUser.tenantId) {
      throw new ForbiddenException('Access denied');
    }

    gate.isOnline = isOnline;
    if (isOnline) {
      gate.lastHeartbeatAt = new Date();
    }

    await this.gateRepository.save(gate);

    // Update controller status
    const controller = await this.controllerRepository.findOne({ where: { gateId } });
    if (controller) {
      controller.status = isOnline ? ControllerStatus.ONLINE : ControllerStatus.OFFLINE;
      controller.lastHeartbeatAt = isOnline ? new Date() : controller.lastHeartbeatAt;
      await this.controllerRepository.save(controller);
    }

    return gate;
  }

  async updateSensor(
    gateId: string,
    dto: UpdateSensorDto,
    currentUser: User,
  ): Promise<SensorStatus> {
    const gate = await this.gateRepository.findOne({
      where: { id: gateId },
      relations: ['controller'],
    });

    if (!gate) {
      throw new NotFoundException('Gate not found');
    }

    if (currentUser.role !== UserRole.SUPER_ADMIN && gate.tenantId !== currentUser.tenantId) {
      throw new ForbiddenException('Access denied');
    }

    if (!gate.controller) {
      throw new NotFoundException('Gate controller not found');
    }

    const sensor = await this.sensorRepository.findOne({
      where: {
        controllerId: gate.controller.id,
        sensorType: dto.sensorType as SensorType,
      },
    });

    if (!sensor) {
      throw new NotFoundException('Sensor not found');
    }

    sensor.status = dto.status as SensorHealthStatus;
    if (dto.value) {
      sensor.lastValue = dto.value;
    }
    if (dto.notes) {
      sensor.notes = dto.notes;
    }
    sensor.lastReadingAt = new Date();

    return this.sensorRepository.save(sensor);
  }
}
