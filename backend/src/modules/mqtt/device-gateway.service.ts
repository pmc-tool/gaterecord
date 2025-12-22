import { Injectable, OnModuleInit, Logger, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MqttService } from './mqtt.service';
import { Gate, GateState } from '@database/entities/gate.entity';
import { GateController as GateControllerEntity, ControllerStatus } from '@database/entities/gate-controller.entity';
import { Vehicle, VehicleStatus } from '@database/entities/vehicle.entity';
import { RfidCard, RfidCardStatus } from '@database/entities/rfid-card.entity';
import { AccessEvent, AccessMethod, AccessResult, AccessSubjectType } from '@database/entities/access-event.entity';
import { DeviceConfig, DeviceStatus } from '@database/entities/device-config.entity';
import { GatewayService } from '../gateway/gateway.service';
import { RfidRegistrationService } from '../rfid/rfid-registration.service';

interface DeviceStatusPayload {
  deviceId: string;
  macAddress: string;
  firmwareVersion: string;
  wifiStrength: number;
  uptimeSeconds: number;
  gateState: string;
  isOnline: boolean;
}

interface RfidEventPayload {
  deviceId: string;
  rfidUid: string;
  type: 'vehicle' | 'human';
  timestamp: string;
}

interface SensorEventPayload {
  deviceId: string;
  sensor: string;
  value: unknown;
  timestamp: string;
}

interface GateStateEventPayload {
  deviceId: string;
  state: string;
  previousState: string;
  timestamp: string;
}

@Injectable()
export class DeviceGatewayService implements OnModuleInit {
  private readonly logger = new Logger(DeviceGatewayService.name);

  constructor(
    private mqttService: MqttService,
    private gatewayService: GatewayService,
    @Inject(forwardRef(() => RfidRegistrationService))
    private rfidRegistrationService: RfidRegistrationService,
    @InjectRepository(Gate)
    private gateRepository: Repository<Gate>,
    @InjectRepository(GateControllerEntity)
    private controllerRepository: Repository<GateControllerEntity>,
    @InjectRepository(Vehicle)
    private vehicleRepository: Repository<Vehicle>,
    @InjectRepository(RfidCard)
    private rfidCardRepository: Repository<RfidCard>,
    @InjectRepository(AccessEvent)
    private accessEventRepository: Repository<AccessEvent>,
    @InjectRepository(DeviceConfig)
    private deviceConfigRepository: Repository<DeviceConfig>,
  ) {}

  onModuleInit() {
    this.setupMessageHandlers();
  }

  private setupMessageHandlers(): void {
    // Handle device status/heartbeat
    this.mqttService.subscribe('gate/+/status', (topic, payload) => {
      const deviceId = topic.split('/')[1];
      this.handleDeviceStatus(deviceId, payload as unknown as DeviceStatusPayload);
    });

    // Handle RFID events from devices
    this.mqttService.subscribe('gate/+/event', (topic, payload) => {
      const deviceId = topic.split('/')[1];
      this.handleDeviceEvent(deviceId, payload);
    });

    // Handle sensor readings
    this.mqttService.subscribe('gate/+/sensors', (topic, payload) => {
      const deviceId = topic.split('/')[1];
      this.handleSensorData(deviceId, payload as unknown as SensorEventPayload);
    });

    this.logger.log('Device message handlers registered');
  }

  private normalizeDeviceId(deviceId: string): string {
    // Remove colons and uppercase - stored in DB without colons
    return deviceId.replace(/:/g, '').toUpperCase();
  }

  private async handleDeviceStatus(deviceId: string, payload: DeviceStatusPayload): Promise<void> {
    this.logger.debug(`Device status from ${deviceId}: ${JSON.stringify(payload)}`);

    // Normalize device ID (remove colons, uppercase)
    const normalizedId = this.normalizeDeviceId(deviceId);

    // First, update device_configs table (always do this)
    const deviceConfig = await this.deviceConfigRepository.findOne({
      where: [
        { deviceId: normalizedId },
        { deviceId: deviceId }, // Also try with original format (with colons)
      ],
    });

    if (deviceConfig) {
      deviceConfig.status = DeviceStatus.ONLINE;
      deviceConfig.lastSeenAt = new Date();
      deviceConfig.wifiSignalStrength = payload.wifiStrength;
      deviceConfig.uptime = payload.uptimeSeconds;
      deviceConfig.firmwareVersion = payload.firmwareVersion;
      await this.deviceConfigRepository.save(deviceConfig);
      this.logger.debug(`Updated device config for ${deviceId}`);
    }

    // Find gate by device ID (MAC address or custom ID)
    const gate = await this.gateRepository.findOne({
      where: { hardwareId: normalizedId },
      relations: ['controller'],
    });

    if (!gate) {
      // Device is registered but not assigned to a gate - that's okay
      if (deviceConfig) {
        this.logger.debug(`Device ${deviceId} online but not assigned to gate`);
        return;
      }
      this.logger.warn(`Unknown device: ${deviceId}`);
      return;
    }

    // Update gate online status
    gate.isOnline = true;
    gate.lastHeartbeatAt = new Date();
    if (payload.gateState) {
      gate.state = payload.gateState as GateState;
    }
    await this.gateRepository.save(gate);

    // Update controller info
    if (gate.controller) {
      gate.controller.status = ControllerStatus.ONLINE;
      gate.controller.wifiStrength = payload.wifiStrength;
      gate.controller.uptimeSeconds = payload.uptimeSeconds;
      gate.controller.firmwareVersion = payload.firmwareVersion;
      gate.controller.lastHeartbeatAt = new Date();
      await this.controllerRepository.save(gate.controller);
    }

    // Notify frontend via WebSocket
    this.gatewayService.broadcastToTenant(gate.tenantId, 'device:status', {
      gateId: gate.id,
      deviceId: normalizedId,
      isOnline: true,
      state: gate.state,
    });
  }

  private async handleDeviceEvent(deviceId: string, payload: Record<string, unknown>): Promise<void> {
    const eventType = payload.event as string;

    switch (eventType) {
      case 'RFID_SCAN':
        await this.handleRfidScan(deviceId, payload as unknown as RfidEventPayload);
        break;
      case 'STATE_CHANGE':
        await this.handleStateChange(deviceId, payload as unknown as GateStateEventPayload);
        break;
      case 'OBSTACLE_DETECTED':
        await this.handleObstacle(deviceId, true);
        break;
      case 'OBSTACLE_CLEARED':
        await this.handleObstacle(deviceId, false);
        break;
      case 'LIMIT_OPEN':
        await this.handleLimitSwitch(deviceId, 'open');
        break;
      case 'LIMIT_CLOSE':
        await this.handleLimitSwitch(deviceId, 'close');
        break;
      default:
        this.logger.warn(`Unknown event type: ${eventType}`);
    }
  }

  private async handleRfidScan(deviceId: string, payload: RfidEventPayload): Promise<void> {
    this.logger.log(`=== RFID SCAN RECEIVED ===`);
    this.logger.log(`Device ID: ${deviceId}`);
    this.logger.log(`RFID UID: ${payload.rfidUid}`);
    this.logger.log(`Type: ${payload.type}`);

    const gate = await this.gateRepository.findOne({
      where: { hardwareId: deviceId },
      relations: ['tenant'],
    });

    if (!gate) {
      this.logger.warn(`Unknown device: ${deviceId}`);
      return;
    }

    this.logger.log(`Gate found: ${gate.id}, Tenant ID: ${gate.tenantId}`);

    // Check if there's an active RFID registration session for this tenant
    this.logger.log(`Checking for registration session for tenant: ${gate.tenantId}`);
    const isRegistrationMode = await this.rfidRegistrationService.processRegistrationScan(
      gate.tenantId,
      payload.rfidUid,
      payload.type,
    );

    if (isRegistrationMode) {
      // Card was captured for registration, send feedback to device
      this.logger.log(`RFID ${payload.rfidUid} captured for registration - SUCCESS!`);
      await this.mqttService.sendDisplayMessage(deviceId, 'Card Registered', 'Success!');
      await this.mqttService.sendFeedback(deviceId, 'SUCCESS', true);
      return;
    }

    this.logger.log(`No registration session - proceeding with normal access control`);

    // Normal access control flow - check BOTH vehicles and RFID cards
    // First try vehicle RFID
    const vehicleGranted = await this.processVehicleRfid(gate, payload.rfidUid);
    if (vehicleGranted) {
      return;
    }

    // If not a vehicle, try human RFID card
    await this.processHumanRfid(gate, payload.rfidUid);
  }

  private async processVehicleRfid(gate: Gate, rfidUid: string): Promise<boolean> {
    const vehicle = await this.vehicleRepository.findOne({
      where: {
        tenantId: gate.tenantId,
        rfidUid,
        status: VehicleStatus.ACTIVE,
      },
      relations: ['owner'],
    });

    if (!vehicle) {
      // No vehicle found with this RFID - return false to try human RFID
      return false;
    }

    // Check validity
    const now = new Date();
    if (vehicle.validFrom && vehicle.validFrom > now) {
      await this.createAccessEvent(gate, {
        method: AccessMethod.CAR_RFID,
        subjectType: AccessSubjectType.VEHICLE,
        subjectId: vehicle.id,
        subjectIdentifier: rfidUid,
        subjectName: `${vehicle.owner.firstName} ${vehicle.owner.lastName}`,
        result: AccessResult.DENIED,
        denialReason: 'Not yet valid',
      });

      await this.sendAccessDenied(gate, 'Not Yet Valid');
      return true; // Vehicle found, handled
    }

    if (vehicle.validUntil && vehicle.validUntil < now) {
      await this.createAccessEvent(gate, {
        method: AccessMethod.CAR_RFID,
        subjectType: AccessSubjectType.VEHICLE,
        subjectId: vehicle.id,
        subjectIdentifier: rfidUid,
        subjectName: `${vehicle.owner.firstName} ${vehicle.owner.lastName}`,
        result: AccessResult.DENIED,
        denialReason: 'Expired',
      });

      await this.sendAccessDenied(gate, 'Access Expired');
      return true; // Vehicle found, handled
    }

    // Access granted!
    await this.createAccessEvent(gate, {
      method: AccessMethod.CAR_RFID,
      subjectType: AccessSubjectType.VEHICLE,
      subjectId: vehicle.id,
      subjectIdentifier: rfidUid,
      subjectName: `${vehicle.owner.firstName} ${vehicle.owner.lastName} - ${vehicle.licensePlate}`,
      result: AccessResult.ALLOWED,
    });

    await this.sendAccessGranted(
      gate,
      vehicle.owner.firstName,
      vehicle.licensePlate,
    );

    return true; // Vehicle found, access granted
  }

  private async processHumanRfid(gate: Gate, rfidUid: string): Promise<void> {
    const rfidCard = await this.rfidCardRepository.findOne({
      where: {
        tenantId: gate.tenantId,
        uid: rfidUid,
        status: RfidCardStatus.ACTIVE,
      },
      relations: ['user'],
    });

    if (!rfidCard) {
      await this.createAccessEvent(gate, {
        method: AccessMethod.HUMAN_RFID,
        subjectType: AccessSubjectType.UNKNOWN,
        subjectIdentifier: rfidUid,
        result: AccessResult.DENIED,
        denialReason: 'Unknown card',
      });

      await this.sendAccessDenied(gate, 'Unknown Card');
      return;
    }

    // Check validity
    const now = new Date();
    if (rfidCard.validFrom && rfidCard.validFrom > now) {
      await this.createAccessEvent(gate, {
        method: AccessMethod.HUMAN_RFID,
        subjectType: AccessSubjectType.RFID_CARD,
        subjectId: rfidCard.id,
        subjectIdentifier: rfidUid,
        subjectName: `${rfidCard.user.firstName} ${rfidCard.user.lastName}`,
        result: AccessResult.DENIED,
        denialReason: 'Not yet valid',
      });

      await this.sendAccessDenied(gate, 'Not Yet Valid');
      return;
    }

    if (rfidCard.validUntil && rfidCard.validUntil < now) {
      await this.createAccessEvent(gate, {
        method: AccessMethod.HUMAN_RFID,
        subjectType: AccessSubjectType.RFID_CARD,
        subjectId: rfidCard.id,
        subjectIdentifier: rfidUid,
        subjectName: `${rfidCard.user.firstName} ${rfidCard.user.lastName}`,
        result: AccessResult.DENIED,
        denialReason: 'Card expired',
      });

      await this.sendAccessDenied(gate, 'Card Expired');
      return;
    }

    // Access granted!
    await this.createAccessEvent(gate, {
      method: AccessMethod.HUMAN_RFID,
      subjectType: AccessSubjectType.RFID_CARD,
      subjectId: rfidCard.id,
      subjectIdentifier: rfidUid,
      subjectName: `${rfidCard.user.firstName} ${rfidCard.user.lastName}`,
      result: AccessResult.ALLOWED,
    });

    await this.sendAccessGranted(gate, rfidCard.user.firstName, 'Welcome!');
  }

  private async handleStateChange(deviceId: string, payload: GateStateEventPayload): Promise<void> {
    const gate = await this.gateRepository.findOne({
      where: { hardwareId: deviceId },
    });

    if (!gate) return;

    gate.state = payload.state as GateState;
    await this.gateRepository.save(gate);

    // Notify frontend
    this.gatewayService.broadcastToTenant(gate.tenantId, 'gate:state-change', {
      gateId: gate.id,
      newState: gate.state,
      previousState: payload.previousState,
    });
  }

  private async handleObstacle(deviceId: string, detected: boolean): Promise<void> {
    const gate = await this.gateRepository.findOne({
      where: { hardwareId: deviceId },
    });

    if (!gate) return;

    if (detected && gate.state === GateState.CLOSING) {
      gate.state = GateState.OBSTACLE_HOLD;
      await this.gateRepository.save(gate);

      this.gatewayService.broadcastToTenant(gate.tenantId, 'gate:obstacle', {
        gateId: gate.id,
        detected: true,
      });
    } else if (!detected && gate.state === GateState.OBSTACLE_HOLD) {
      // Resume closing
      await this.mqttService.sendGateCommand(deviceId, 'CLOSE');
    }
  }

  private async handleLimitSwitch(deviceId: string, position: 'open' | 'close'): Promise<void> {
    const gate = await this.gateRepository.findOne({
      where: { hardwareId: deviceId },
    });

    if (!gate) return;

    const newState = position === 'open' ? GateState.OPEN : GateState.CLOSED;
    gate.state = newState;
    await this.gateRepository.save(gate);

    this.gatewayService.broadcastToTenant(gate.tenantId, 'gate:state-change', {
      gateId: gate.id,
      newState,
    });
  }

  private async handleSensorData(deviceId: string, payload: SensorEventPayload): Promise<void> {
    // Store sensor readings if needed
    this.logger.debug(`Sensor data from ${deviceId}: ${JSON.stringify(payload)}`);
  }

  private async sendAccessGranted(gate: Gate, name: string, info: string): Promise<void> {
    const deviceId = gate.hardwareId;
    if (!deviceId) {
      this.logger.warn('No hardware ID for gate, cannot send OPEN command');
      return;
    }

    // Send open command
    this.logger.log(`>>> Sending OPEN command to device: ${deviceId}`);
    await this.mqttService.sendGateCommand(deviceId, 'OPEN');
    this.logger.log(`>>> OPEN command sent to ${deviceId}`);

    // Send display message
    await this.mqttService.sendDisplayMessage(deviceId, `Welcome ${name}`, info);

    // Send success feedback (green LED + beep)
    await this.mqttService.sendFeedback(deviceId, 'SUCCESS', true);

    // Notify frontend
    this.gatewayService.broadcastToTenant(gate.tenantId, 'access:granted', {
      gateId: gate.id,
      name,
      info,
    });
  }

  private async sendAccessDenied(gate: Gate, reason: string): Promise<void> {
    const deviceId = gate.hardwareId;
    if (!deviceId) return;

    // Send display message
    await this.mqttService.sendDisplayMessage(deviceId, 'Access Denied', reason);

    // Send error feedback (red LED + beep)
    await this.mqttService.sendFeedback(deviceId, 'ERROR', true);

    // Notify frontend
    this.gatewayService.broadcastToTenant(gate.tenantId, 'access:denied', {
      gateId: gate.id,
      reason,
    });
  }

  private async createAccessEvent(
    gate: Gate,
    data: Partial<AccessEvent>,
  ): Promise<AccessEvent> {
    const event = this.accessEventRepository.create({
      tenantId: gate.tenantId,
      gateId: gate.id,
      timestamp: new Date(),
      ...data,
    });

    const saved = await this.accessEventRepository.save(event);

    // Broadcast to frontend
    this.gatewayService.broadcastToTenant(gate.tenantId, 'access:event', {
      event: saved,
    });

    return saved;
  }

  // Public methods for manual commands from frontend
  async sendOpenCommand(gateId: string): Promise<void> {
    const gate = await this.gateRepository.findOne({ where: { id: gateId } });
    if (gate?.hardwareId) {
      await this.mqttService.sendGateCommand(gate.hardwareId, 'OPEN');
    }
  }

  async sendCloseCommand(gateId: string): Promise<void> {
    const gate = await this.gateRepository.findOne({ where: { id: gateId } });
    if (gate?.hardwareId) {
      await this.mqttService.sendGateCommand(gate.hardwareId, 'CLOSE');
    }
  }

  async sendStopCommand(gateId: string): Promise<void> {
    const gate = await this.gateRepository.findOne({ where: { id: gateId } });
    if (gate?.hardwareId) {
      await this.mqttService.sendGateCommand(gate.hardwareId, 'STOP');
    }
  }
}
