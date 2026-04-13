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
import { CreateGateDto, UpdateGateDto, GateHealthDto, GateQueryDto } from './dto/gate.dto';

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
    // Determine tenant ID
    let tenantId: string;

    if (currentUser.role === UserRole.SUPER_ADMIN) {
      if (!dto.tenantId) {
        throw new ForbiddenException('Super Admin must specify tenantId');
      }
      tenantId = dto.tenantId;
    } else {
      if (!currentUser.tenantId) {
        throw new ForbiddenException('User must belong to a tenant');
      }
      tenantId = currentUser.tenantId;
    }

    // Check tenant gate limit
    const tenant = await this.tenantRepository.findOne({
      where: { id: tenantId },
      relations: ['subscriptionPlan', 'gates'],
    });

    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    if (!tenant.subscriptionPlan) {
      throw new ForbiddenException('No subscription plan found. Please subscribe to a plan first.');
    }

    const gateCount = tenant.gates?.length || 0;
    if (gateCount >= tenant.subscriptionPlan.maxGates) {
      throw new ForbiddenException(
        `Gate limit reached. Your plan allows ${tenant.subscriptionPlan.maxGates} gates. Please upgrade your plan to add more gates.`,
      );
    }

    // Check name uniqueness within tenant
    const existing = await this.gateRepository.findOne({
      where: { tenantId, name: dto.name },
    });
    if (existing) {
      throw new ConflictException('Gate name already exists in this building');
    }

    const gate = this.gateRepository.create({
      ...dto,
      tenantId,
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
    query: GateQueryDto = {},
  ): Promise<
    (Gate & { devices?: { id: string; deviceId: string; deviceName: string; status: string }[] })[]
  > {
    const qb = this.gateRepository.createQueryBuilder('gate');

    // Filter by tenant for non-super-admin users
    if (currentUser.role !== UserRole.SUPER_ADMIN) {
      qb.where('gate.tenant_id = :tenantId', { tenantId: currentUser.tenantId });
    } else if (query.tenantId) {
      // Super admin can filter by tenant
      qb.where('gate.tenant_id = :tenantId', { tenantId: query.tenantId });
    }

    // Apply type filter
    if (query.type) {
      qb.andWhere('gate.type = :type', { type: query.type });
    }

    // Apply state filter
    if (query.state) {
      qb.andWhere('gate.state = :state', { state: query.state });
    }

    const gates = await qb
      .leftJoinAndSelect('gate.controller', 'controller')
      .leftJoinAndSelect('gate.tenant', 'tenant')
      .getMany();

    // Fetch all devices that are assigned to any of these gates
    const gateIds = gates.map((g) => g.id);

    if (gateIds.length > 0) {
      const devices = await this.deviceConfigRepository
        .createQueryBuilder('device')
        .where('device.gate_id IN (:...ids)', { ids: gateIds })
        .getMany();

      // Group devices by gateId
      const devicesByGateId = new Map<
        string,
        { id: string; deviceId: string; deviceName: string; status: string }[]
      >();
      for (const device of devices) {
        if (device.gateId) {
          const existing = devicesByGateId.get(device.gateId) || [];
          existing.push({
            id: device.id,
            deviceId: device.deviceId,
            deviceName: device.deviceName,
            status: device.status,
          });
          devicesByGateId.set(device.gateId, existing);
        }
      }

      return gates.map((gate) => {
        const gateDevices = devicesByGateId.get(gate.id) || [];
        // Gate is online if at least one device is online
        const isReallyOnline = gateDevices.some((d) => d.status === 'online');
        return {
          ...gate,
          isOnline: isReallyOnline,
          devices: gateDevices,
        };
      });
    }

    // Gates without any devices
    return gates.map((gate) => ({
      ...gate,
      isOnline: false,
      devices: [],
    }));
  }

  async findOne(
    id: string,
    currentUser: User,
  ): Promise<
    Gate & { devices: { id: string; deviceId: string; deviceName: string; status: string }[] }
  > {
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

    // Fetch devices for this gate
    const devices = await this.deviceConfigRepository.find({
      where: { gateId: id },
    });

    const gateDevices = devices.map((d) => ({
      id: d.id,
      deviceId: d.deviceId,
      deviceName: d.deviceName,
      status: d.status,
    }));

    // Gate is online if at least one device is online
    const isReallyOnline = gateDevices.some((d) => d.status === 'online');

    return {
      ...gate,
      isOnline: isReallyOnline,
      devices: gateDevices,
    };
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
