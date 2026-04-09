/**
 * Cloud Plus TypeB TCP Service
 * Provides gate control via TCP protocol
 */

import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OnEvent } from '@nestjs/event-emitter';

import { DeviceConfig, DeviceStatus } from '@database/entities/device-config.entity';
import { Gate, GateState } from '@database/entities/gate.entity';
import { User, UserRole } from '@database/entities/user.entity';
import {
  AccessEvent,
  AccessMethod,
  AccessResult,
  AccessSubjectType,
} from '@database/entities/access-event.entity';

import { CloudPlusTcpServer } from './cloud-plus-tcp.server';
import {
  buildOpenDoorCommand,
  buildOpenDoorLongCommand,
  buildCloseDoorCommand,
  buildLockDoorCommand,
  buildSetAlarmCommand,
  buildSetFireCommand,
  buildSetTimeCommand,
  buildRestartCommand,
  buildOpenWithInfoCommand,
  buildRequestEventAck,
} from './tcp-protocol';
import {
  GateAction,
  GateControlDto,
  OpenGateWithInfoDto,
  SetAlarmDto,
  SetFireDto,
  GateControlResponse,
  TcpServerStatus,
  ConnectedController,
  ControllerEvent,
} from './dto';
import { GatewayService } from '../gateway/gateway.service';
import { CloudPlusService } from '../cloud-plus-typeB/cloud-plus.service';

@Injectable()
export class CloudPlusTcpService {
  private readonly logger = new Logger(CloudPlusTcpService.name);

  constructor(
    private tcpServer: CloudPlusTcpServer,
    private gatewayService: GatewayService,
    private cloudPlusService: CloudPlusService,
    @InjectRepository(DeviceConfig)
    private deviceConfigRepository: Repository<DeviceConfig>,
    @InjectRepository(Gate)
    private gateRepository: Repository<Gate>,
    @InjectRepository(AccessEvent)
    private accessEventRepository: Repository<AccessEvent>,
  ) {}

  /**
   * Open gate via TCP
   */
  async openGate(
    gateId: string,
    currentUser: User,
    door: number = 0,
    deviceId?: string,
  ): Promise<GateControlResponse> {
    return this.controlGate(gateId, GateAction.OPEN, currentUser, door, deviceId);
  }

  /**
   * Close gate via TCP
   */
  async closeGate(
    gateId: string,
    currentUser: User,
    door: number = 0,
    deviceId?: string,
  ): Promise<GateControlResponse> {
    return this.controlGate(gateId, GateAction.CLOSE, currentUser, door, deviceId);
  }

  /**
   * Control gate (open/close/lock/unlock)
   * If deviceId is provided, sends command to that specific device
   * Otherwise sends command to ALL devices assigned to this gate
   */
  async controlGate(
    gateId: string,
    action: GateAction,
    currentUser: User,
    door: number = 0,
    targetDeviceId?: string,
  ): Promise<GateControlResponse> {
    // Get gate with devices
    const gate = await this.gateRepository.findOne({
      where: { id: gateId },
      relations: ['tenant'],
    });

    if (!gate) {
      throw new NotFoundException('Gate not found');
    }

    // Check permissions
    if (currentUser.role !== UserRole.SUPER_ADMIN && gate.tenantId !== currentUser.tenantId) {
      throw new ForbiddenException('Access denied');
    }

    // Find devices for this gate
    let devices: DeviceConfig[];
    if (targetDeviceId) {
      // Target specific device
      const device = await this.deviceConfigRepository.findOne({
        where: { gateId, deviceId: targetDeviceId },
      });
      if (!device) {
        throw new NotFoundException(`Device ${targetDeviceId} not found for this gate`);
      }
      devices = [device];
    } else {
      // Find ALL devices for this gate
      devices = await this.deviceConfigRepository.find({
        where: { gateId },
      });
    }

    if (devices.length === 0) {
      throw new NotFoundException('No device assigned to this gate');
    }

    // Build command
    let command: Buffer;
    let actionName: string;

    switch (action) {
      case GateAction.OPEN:
        command = buildOpenDoorCommand(door);
        actionName = 'Open';
        break;
      case GateAction.OPEN_LONG:
        command = buildOpenDoorLongCommand(door);
        actionName = 'Open Long';
        break;
      case GateAction.CLOSE:
        command = buildCloseDoorCommand(door);
        actionName = 'Close';
        break;
      case GateAction.LOCK:
        command = buildLockDoorCommand(door, true);
        actionName = 'Lock';
        break;
      case GateAction.UNLOCK:
        command = buildLockDoorCommand(door, false);
        actionName = 'Unlock';
        break;
      default:
        throw new BadRequestException(`Unknown action: ${action}`);
    }

    // Send command to ALL connected devices
    const results: { serial: string; success: boolean; connected: boolean }[] = [];

    for (const device of devices) {
      const serial = device.deviceId;
      const connected = this.tcpServer.isConnected(serial);

      if (connected) {
        const success = this.tcpServer.sendCommand(serial, command);
        results.push({ serial, success, connected: true });
      } else {
        results.push({ serial, success: false, connected: false });
      }
    }

    const successCount = results.filter((r) => r.success).length;
    const connectedCount = results.filter((r) => r.connected).length;

    if (connectedCount === 0) {
      throw new BadRequestException(`No controllers connected via TCP for gate ${gate.name}`);
    }

    // Update gate state
    if (action === GateAction.OPEN || action === GateAction.OPEN_LONG) {
      gate.state = GateState.OPENING;
    } else if (action === GateAction.CLOSE) {
      gate.state = GateState.CLOSING;
    }
    await this.gateRepository.save(gate);

    // Log access event
    await this.logManualControl(gate, currentUser, actionName);

    // Notify frontend
    this.gatewayService.broadcastToTenant(gate.tenantId, 'gate:control', {
      gateId: gate.id,
      gateName: gate.name,
      action: actionName,
      operator: `${currentUser.firstName} ${currentUser.lastName}`,
      devicesCount: devices.length,
      successCount,
      timestamp: new Date().toISOString(),
    });

    const serials = results
      .filter((r) => r.success)
      .map((r) => r.serial)
      .join(', ');

    return {
      success: successCount > 0,
      message:
        successCount === devices.length
          ? `Gate ${actionName} command sent to all ${devices.length} device(s)`
          : `Gate ${actionName} command sent to ${successCount}/${devices.length} device(s)`,
      serial: serials,
      action: actionName,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Open gate with LCD display info
   * Sends command to ALL devices assigned to this gate
   */
  async openGateWithInfo(
    gateId: string,
    dto: OpenGateWithInfoDto,
    currentUser: User,
  ): Promise<GateControlResponse> {
    const gate = await this.gateRepository.findOne({
      where: { id: gateId },
    });

    if (!gate) {
      throw new NotFoundException('Gate not found');
    }

    if (currentUser.role !== UserRole.SUPER_ADMIN && gate.tenantId !== currentUser.tenantId) {
      throw new ForbiddenException('Access denied');
    }

    // Find ALL devices for this gate
    const devices = await this.deviceConfigRepository.find({
      where: { gateId },
    });

    if (devices.length === 0) {
      throw new NotFoundException('No device assigned to this gate');
    }

    const now = new Date();
    const timestamp = now.toISOString().replace('T', ' ').substring(0, 19);

    const command = buildOpenWithInfoCommand(
      true,
      dto.door || 0,
      dto.openTime || 3,
      dto.card || '',
      dto.name || `${currentUser.firstName} ${currentUser.lastName}`,
      dto.note || 'Manual Open',
      timestamp,
      dto.voice || 'Welcome',
    );

    // Send command to ALL connected devices
    const results: { serial: string; success: boolean; connected: boolean }[] = [];

    for (const device of devices) {
      const serial = device.deviceId;
      const connected = this.tcpServer.isConnected(serial);

      if (connected) {
        const success = this.tcpServer.sendCommand(serial, command);
        results.push({ serial, success, connected: true });
      } else {
        results.push({ serial, success: false, connected: false });
      }
    }

    const successCount = results.filter((r) => r.success).length;
    const connectedCount = results.filter((r) => r.connected).length;

    if (connectedCount === 0) {
      throw new BadRequestException(`No controllers connected via TCP for gate ${gate.name}`);
    }

    gate.state = GateState.OPENING;
    await this.gateRepository.save(gate);

    await this.logManualControl(gate, currentUser, 'Open with Info');

    const serials = results
      .filter((r) => r.success)
      .map((r) => r.serial)
      .join(', ');

    return {
      success: successCount > 0,
      message:
        successCount === devices.length
          ? `Gate opened with display info on all ${devices.length} device(s)`
          : `Gate opened with display info on ${successCount}/${devices.length} device(s)`,
      serial: serials,
      action: 'OpenWithInfo',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Set alarm state for gate
   * Sends command to ALL devices assigned to this gate
   */
  async setAlarm(
    gateId: string,
    dto: SetAlarmDto,
    currentUser: User,
  ): Promise<GateControlResponse> {
    const { devices, gate } = await this.validateGateAccess(gateId, currentUser);

    const command = buildSetAlarmCommand(dto.enable, dto.longtime);
    const results = this.sendCommandToAllDevices(devices, command);

    const successCount = results.filter((r) => r.success).length;
    const serials = results
      .filter((r) => r.success)
      .map((r) => r.serial)
      .join(', ');

    return {
      success: successCount > 0,
      message: `Alarm ${dto.enable ? 'enabled' : 'disabled'} on ${successCount}/${devices.length} device(s)`,
      serial: serials,
      action: dto.enable ? 'AlarmOn' : 'AlarmOff',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Set fire/emergency mode for gate
   * Sends command to ALL devices assigned to this gate
   */
  async setFire(gateId: string, dto: SetFireDto, currentUser: User): Promise<GateControlResponse> {
    const { devices, gate } = await this.validateGateAccess(gateId, currentUser);

    const command = buildSetFireCommand(dto.enable);
    const results = this.sendCommandToAllDevices(devices, command);

    const successCount = results.filter((r) => r.success).length;
    const serials = results
      .filter((r) => r.success)
      .map((r) => r.serial)
      .join(', ');

    // Fire mode typically opens all gates
    if (dto.enable) {
      gate.state = GateState.OPEN;
      await this.gateRepository.save(gate);
    }

    return {
      success: successCount > 0,
      message: `Fire mode ${dto.enable ? 'enabled' : 'disabled'} on ${successCount}/${devices.length} device(s)`,
      serial: serials,
      action: dto.enable ? 'FireOn' : 'FireOff',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Sync time on controller
   * Sends command to ALL devices assigned to this gate
   */
  async syncTime(gateId: string, currentUser: User): Promise<GateControlResponse> {
    const { devices } = await this.validateGateAccess(gateId, currentUser);

    const command = buildSetTimeCommand(new Date());
    const results = this.sendCommandToAllDevices(devices, command);

    const successCount = results.filter((r) => r.success).length;
    const serials = results
      .filter((r) => r.success)
      .map((r) => r.serial)
      .join(', ');

    return {
      success: successCount > 0,
      message: `Time synchronized on ${successCount}/${devices.length} device(s)`,
      serial: serials,
      action: 'SyncTime',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Restart controller
   * Sends command to ALL devices assigned to this gate
   */
  async restartController(gateId: string, currentUser: User): Promise<GateControlResponse> {
    const { devices } = await this.validateGateAccess(gateId, currentUser);

    const command = buildRestartCommand();
    const results = this.sendCommandToAllDevices(devices, command);

    const successCount = results.filter((r) => r.success).length;
    const serials = results
      .filter((r) => r.success)
      .map((r) => r.serial)
      .join(', ');

    return {
      success: successCount > 0,
      message: `Restart command sent to ${successCount}/${devices.length} device(s)`,
      serial: serials,
      action: 'Restart',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Get TCP server status and connected controllers
   */
  getServerStatus(): TcpServerStatus {
    return this.tcpServer.getStatus();
  }

  /**
   * Get connected controllers for a tenant
   */
  async getConnectedControllersForTenant(tenantId: string): Promise<ConnectedController[]> {
    const allControllers = this.tcpServer.getConnectedControllers();

    // Get devices for this tenant
    const devices = await this.deviceConfigRepository.find({
      where: { tenantId },
      relations: ['gate'],
    });

    const deviceSerials = new Set(devices.map((d) => d.deviceId));

    // Filter and enrich with gate info
    return allControllers
      .filter((c) => deviceSerials.has(c.serial))
      .map((c) => {
        const device = devices.find((d) => d.deviceId === c.serial);
        return {
          ...c,
          gateId: device?.gateId,
          gateName: device?.gate?.name,
          tenantId,
        };
      });
  }

  /**
   * Check if any device for the gate is connected via TCP
   */
  async isGateConnected(gateId: string): Promise<boolean> {
    const devices = await this.deviceConfigRepository.find({
      where: { gateId },
    });

    if (!devices || devices.length === 0) return false;

    // Return true if ANY device for this gate is connected
    return devices.some((device) => this.tcpServer.isConnected(device.deviceId));
  }

  // ==================== Event Handlers ====================

  /**
   * Handle controller connected event
   */
  @OnEvent('tcp.controller.connected')
  async handleControllerConnected(payload: {
    serial: string;
    id: string;
    ipAddress: string;
    oemCode: number;
  }) {
    this.logger.log(`Controller connected: ${payload.serial}`);

    // Update device status
    const device = await this.deviceConfigRepository.findOne({
      where: { deviceId: payload.serial },
      relations: ['gate'],
    });

    if (device) {
      device.status = DeviceStatus.ONLINE;
      device.lastSeenAt = new Date();
      device.ipAddress = payload.ipAddress;
      await this.deviceConfigRepository.save(device);

      // Update associated gate
      if (device.gate) {
        device.gate.isOnline = true;
        device.gate.lastHeartbeatAt = new Date();
        await this.gateRepository.save(device.gate);

        // Set gate association in TCP server
        this.tcpServer.setControllerGate(payload.serial, device.gateId!, device.tenantId);

        // Notify frontend
        this.gatewayService.broadcastToTenant(device.tenantId, 'gate:online', {
          gateId: device.gateId,
          gateName: device.gate.name,
          serial: payload.serial,
          protocol: 'tcp',
        });
      }
    }
  }

  /**
   * Handle controller disconnected event
   */
  @OnEvent('tcp.controller.disconnected')
  async handleControllerDisconnected(payload: { serial: string }) {
    this.logger.log(`Controller disconnected: ${payload.serial}`);

    const device = await this.deviceConfigRepository.findOne({
      where: { deviceId: payload.serial },
      relations: ['gate'],
    });

    if (device) {
      device.status = DeviceStatus.OFFLINE;
      await this.deviceConfigRepository.save(device);

      if (device.gate) {
        device.gate.isOnline = false;
        await this.gateRepository.save(device.gate);

        this.gatewayService.broadcastToTenant(device.tenantId, 'gate:offline', {
          gateId: device.gateId,
          gateName: device.gate.name,
          serial: payload.serial,
        });
      }
    }
  }

  /**
   * Handle controller event (card swipe, button)
   */
  @OnEvent('tcp.controller.event')
  async handleControllerEvent(payload: { socketId: string; event: ControllerEvent }) {
    const { socketId, event } = payload;
    this.logger.log(
      `Processing event from ${event.serial}: Type=${event.dataType}, Card=${event.card}`,
    );

    // Find device and gate
    const device = await this.deviceConfigRepository.findOne({
      where: { deviceId: event.serial },
      relations: ['gate', 'tenant'],
    });

    if (!device || !device.gate) {
      this.logger.warn(`Unknown device or no gate: ${event.serial}`);
      // Send deny response
      const response = buildRequestEventAck(
        false,
        event.reader,
        1,
        event.card,
        'Unknown',
        'Device not registered',
        new Date().toISOString().replace('T', ' ').substring(0, 19),
        'Access Denied',
      );
      this.tcpServer.sendEventResponse(socketId, response);
      return;
    }

    // Use CloudPlusService for validation (reuse HTTP logic)
    const searchCardRequest = {
      Serial: event.serial,
      Card: event.card,
      Reader: event.reader,
      type: event.dataType,
    };

    const result = await this.cloudPlusService.processSearchCardAcs(
      searchCardRequest,
      undefined,
      event.dataType === 12 ? 'vehicle' : 'human',
      device.gate,
    );

    // Build TCP response
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const response = buildRequestEventAck(
      result.AcsRes === '1',
      event.reader,
      1,
      event.card,
      result.Name,
      result.Note,
      timestamp,
      result.Voice,
    );

    this.tcpServer.sendEventResponse(socketId, response);
  }

  // ==================== Private Helpers ====================

  /**
   * Validate gate access and return all devices
   */
  private async validateGateAccess(
    gateId: string,
    currentUser: User,
  ): Promise<{ devices: DeviceConfig[]; gate: Gate }> {
    const gate = await this.gateRepository.findOne({
      where: { id: gateId },
    });

    if (!gate) {
      throw new NotFoundException('Gate not found');
    }

    if (currentUser.role !== UserRole.SUPER_ADMIN && gate.tenantId !== currentUser.tenantId) {
      throw new ForbiddenException('Access denied');
    }

    // Find ALL devices for this gate
    const devices = await this.deviceConfigRepository.find({
      where: { gateId },
    });

    if (devices.length === 0) {
      throw new NotFoundException('No device assigned to this gate');
    }

    // Check if at least one device is connected
    const connectedCount = devices.filter((d) => this.tcpServer.isConnected(d.deviceId)).length;

    if (connectedCount === 0) {
      throw new BadRequestException(`No controllers connected via TCP for gate ${gate.name}`);
    }

    return { devices, gate };
  }

  /**
   * Send command to all connected devices
   */
  private sendCommandToAllDevices(
    devices: DeviceConfig[],
    command: Buffer,
  ): { serial: string; success: boolean; connected: boolean }[] {
    const results: { serial: string; success: boolean; connected: boolean }[] = [];

    for (const device of devices) {
      const serial = device.deviceId;
      const connected = this.tcpServer.isConnected(serial);

      if (connected) {
        const success = this.tcpServer.sendCommand(serial, command);
        results.push({ serial, success, connected: true });
      } else {
        results.push({ serial, success: false, connected: false });
      }
    }

    return results;
  }

  private async logManualControl(gate: Gate, operator: User, action: string): Promise<void> {
    const accessEvent = this.accessEventRepository.create({
      tenantId: gate.tenantId,
      gateId: gate.id,
      timestamp: new Date(),
      method: AccessMethod.MANUAL,
      subjectType: AccessSubjectType.USER,
      subjectId: operator.id,
      subjectName: `${operator.firstName} ${operator.lastName}`,
      result: AccessResult.ALLOWED,
      metadata: {
        source: 'tcp-manual',
        action,
      },
    });

    await this.accessEventRepository.save(accessEvent);
  }
}
