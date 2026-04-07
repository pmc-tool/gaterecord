import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Gate, GateState, GateType } from '@database/entities/gate.entity';
import {
  GateController as GateControllerEntity,
  ControllerStatus,
} from '@database/entities/gate-controller.entity';
import {
  SensorStatus,
  SensorType,
  SensorHealthStatus,
} from '@database/entities/sensor-status.entity';
import { Tenant } from '@database/entities/tenant.entity';
import { User, UserRole } from '@database/entities/user.entity';
import { DeviceConfig } from '@database/entities/device-config.entity';
import { CreateGateDto, UpdateGateDto, GateHealthDto } from './dto/gate.dto';

@Injectable()
export class GatesService {
  constructor(
    @InjectRepository(Gate)
    private gateRepository: Repository<Gate>,
    @InjectRepository(GateControllerEntity)
    private controllerRepository: Repository<GateControllerEntity>,
    @InjectRepository(SensorStatus)
    private sensorRepository: Repository<SensorStatus>,
    @InjectRepository(Tenant)
    private tenantRepository: Repository<Tenant>,
    @InjectRepository(DeviceConfig)
    private deviceConfigRepository: Repository<DeviceConfig>,
  ) {}

  async create(dto: CreateGateDto, currentUser: User): Promise<Gate> {
    if (!currentUser.tenantId) {
      throw new ForbiddenException('User must belong to a tenant');
    }

    // Check tenant gate limit
    const tenant = await this.tenantRepository.findOne({
      where: { id: currentUser.tenantId },
      relations: ['subscriptionPlan', 'gates'],
    });

    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    const gateCount = tenant.gates?.length || 0;
    if (gateCount >= tenant.subscriptionPlan.maxGates) {
      throw new ForbiddenException(
        `Gate limit reached. Your plan allows ${tenant.subscriptionPlan.maxGates} gates.`,
      );
    }

    // Check name uniqueness within tenant
    const existing = await this.gateRepository.findOne({
      where: { tenantId: currentUser.tenantId, name: dto.name },
    });
    if (existing) {
      throw new ConflictException('Gate name already exists in this building');
    }

    const gate = this.gateRepository.create({
      ...dto,
      tenantId: currentUser.tenantId,
      state: GateState.CLOSED,
      isOnline: false,
    });

    const savedGate = await this.gateRepository.save(gate);

    // Create controller entry for simulation
    const controller = this.controllerRepository.create({
      gateId: savedGate.id,
      status: ControllerStatus.OFFLINE,
      firmwareVersion: '1.0.0-sim',
    });
    await this.controllerRepository.save(controller);

    // Create default sensor status entries
    await this.initializeSensors(controller.id, dto.type);

    return savedGate;
  }

  private async initializeSensors(controllerId: string, gateType: GateType): Promise<void> {
    const sensors: Partial<SensorStatus>[] = [
      { controllerId, sensorType: SensorType.ESP32_CONTROLLER, status: SensorHealthStatus.UNKNOWN },
      { controllerId, sensorType: SensorType.SERVO_ACTUATOR, status: SensorHealthStatus.UNKNOWN },
      { controllerId, sensorType: SensorType.IR_OBSTACLE, status: SensorHealthStatus.UNKNOWN },
      {
        controllerId,
        sensorType: SensorType.LIMIT_SWITCH_OPEN,
        status: SensorHealthStatus.UNKNOWN,
      },
      {
        controllerId,
        sensorType: SensorType.LIMIT_SWITCH_CLOSE,
        status: SensorHealthStatus.UNKNOWN,
      },
      { controllerId, sensorType: SensorType.OLED_DISPLAY, status: SensorHealthStatus.UNKNOWN },
      { controllerId, sensorType: SensorType.LED_BUZZER, status: SensorHealthStatus.UNKNOWN },
    ];

    // Add RFID reader for all gate types
    sensors.push({
      controllerId,
      sensorType: SensorType.RFID_READER,
      status: SensorHealthStatus.UNKNOWN,
    });

    // Add ultrasonic for vehicle gates
    if (gateType === GateType.VEHICLE || gateType === GateType.MIXED) {
      sensors.push({
        controllerId,
        sensorType: SensorType.ULTRASONIC,
        status: SensorHealthStatus.UNKNOWN,
      });
    }

    await this.sensorRepository.save(sensors);
  }

  async findAll(
    currentUser: User,
  ): Promise<(Gate & { deviceName?: string; deviceStatus?: string })[]> {
    const query = this.gateRepository.createQueryBuilder('gate');

    if (currentUser.role !== UserRole.SUPER_ADMIN) {
      query.where('gate.tenant_id = :tenantId', { tenantId: currentUser.tenantId });
    }

    const gates = await query.leftJoinAndSelect('gate.controller', 'controller').getMany();

    // Fetch device info for gates with hardware IDs
    const hardwareIds = gates.filter((g) => g.hardwareId).map((g) => g.hardwareId);

    if (hardwareIds.length > 0) {
      const devices = await this.deviceConfigRepository
        .createQueryBuilder('device')
        .where('device.device_id IN (:...ids)', { ids: hardwareIds })
        .getMany();

      const deviceMap = new Map(
        devices.map((d) => [d.deviceId, { name: d.deviceName, status: d.status }]),
      );

      return gates.map((gate) => {
        const deviceInfo = gate.hardwareId ? deviceMap.get(gate.hardwareId) : undefined;
        // Gate is only online if it has a connected device that is online
        const isReallyOnline = deviceInfo?.status === 'online';
        return {
          ...gate,
          isOnline: isReallyOnline,
          deviceName: deviceInfo?.name,
          deviceStatus: deviceInfo?.status,
        };
      });
    }

    // Gates without hardware IDs are offline
    return gates.map((gate) => ({
      ...gate,
      isOnline: false,
      deviceStatus: undefined,
    }));
  }

  async findOne(id: string, currentUser: User): Promise<Gate> {
    const gate = await this.gateRepository.findOne({
      where: { id },
      relations: ['controller', 'controller.sensors', 'tenant'],
    });

    if (!gate) {
      throw new NotFoundException('Gate not found');
    }

    if (currentUser.role !== UserRole.SUPER_ADMIN && gate.tenantId !== currentUser.tenantId) {
      throw new ForbiddenException('Access denied');
    }

    return gate;
  }

  async update(id: string, dto: UpdateGateDto, currentUser: User): Promise<Gate> {
    const gate = await this.findOne(id, currentUser);

    if (dto.name && dto.name !== gate.name) {
      const existing = await this.gateRepository.findOne({
        where: { tenantId: gate.tenantId, name: dto.name },
      });
      if (existing) {
        throw new ConflictException('Gate name already exists');
      }
    }

    Object.assign(gate, dto);
    return this.gateRepository.save(gate);
  }

  async remove(id: string, currentUser: User): Promise<void> {
    const gate = await this.findOne(id, currentUser);
    await this.gateRepository.softDelete(gate.id);
  }

  async getHealth(id: string, currentUser: User): Promise<GateHealthDto> {
    const gate = await this.gateRepository.findOne({
      where: { id },
      relations: ['controller', 'controller.sensors'],
    });

    if (!gate) {
      throw new NotFoundException('Gate not found');
    }

    if (currentUser.role !== UserRole.SUPER_ADMIN && gate.tenantId !== currentUser.tenantId) {
      throw new ForbiddenException('Access denied');
    }

    return {
      gateId: gate.id,
      gateName: gate.name,
      isOnline: gate.isOnline,
      lastHeartbeatAt: gate.lastHeartbeatAt,
      sensors:
        gate.controller?.sensors?.map((s) => ({
          sensorType: s.sensorType,
          status: s.status,
          lastValue: s.lastValue,
          lastReadingAt: s.lastReadingAt,
          notes: s.notes,
        })) || [],
      firmwareVersion: gate.controller?.firmwareVersion,
      wifiStrength: gate.controller?.wifiStrength,
      uptimeSeconds: gate.controller?.uptimeSeconds
        ? Number(gate.controller.uptimeSeconds)
        : undefined,
    };
  }

  async updateState(id: string, state: GateState): Promise<Gate> {
    const gate = await this.gateRepository.findOne({ where: { id } });
    if (!gate) {
      throw new NotFoundException('Gate not found');
    }

    gate.state = state;
    return this.gateRepository.save(gate);
  }

  async setOnlineStatus(id: string, isOnline: boolean): Promise<Gate> {
    const gate = await this.gateRepository.findOne({ where: { id } });
    if (!gate) {
      throw new NotFoundException('Gate not found');
    }

    gate.isOnline = isOnline;
    if (isOnline) {
      gate.lastHeartbeatAt = new Date();
    }
    return this.gateRepository.save(gate);
  }
}
