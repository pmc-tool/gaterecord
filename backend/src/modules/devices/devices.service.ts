import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, MoreThan } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { SetupCode, SetupCodeStatus } from '@database/entities/setup-code.entity';
import { DeviceConfig, DeviceStatus } from '@database/entities/device-config.entity';
import { Gate } from '@database/entities/gate.entity';
import { User, UserRole } from '@database/entities/user.entity';
import {
  CreateSetupCodeDto,
  SetupCodeResponseDto,
  ClaimDeviceDto,
  ClaimResponseDto,
} from './dto/setup-code.dto';
import {
  DeviceResponseDto,
  UpdateDeviceDto,
  UpdateCheckResponseDto,
} from './dto/device.dto';
import { FirmwareService } from './firmware.service';
import { GatewayService } from '../gateway/gateway.service';

@Injectable()
export class DevicesService {
  private readonly logger = new Logger(DevicesService.name);

  // Characters for setup code (excluding confusing: 0, O, I, L, 1)
  private readonly CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

  // Normalize device ID by removing colons (MAC address format)
  private normalizeDeviceId(deviceId: string): string {
    return deviceId.replace(/:/g, '');
  }
  private readonly CODE_EXPIRY_MINUTES = 30;

  // Rate limiting storage (in production, use Redis)
  private readonly claimAttempts: Map<string, { count: number; resetAt: Date }> = new Map();

  constructor(
    @InjectRepository(SetupCode)
    private setupCodeRepo: Repository<SetupCode>,
    @InjectRepository(DeviceConfig)
    private deviceConfigRepo: Repository<DeviceConfig>,
    @InjectRepository(Gate)
    private gateRepo: Repository<Gate>,
    private configService: ConfigService,
    private firmwareService: FirmwareService,
    private gatewayService: GatewayService,
  ) {}

  // ==================== Setup Codes ====================

  private generateCode(): string {
    let code = '';
    for (let i = 0; i < 9; i++) {
      if (i === 3 || i === 6) code += '-';
      code += this.CODE_CHARS[Math.floor(Math.random() * this.CODE_CHARS.length)];
    }
    return code;
  }

  async createSetupCode(dto: CreateSetupCodeDto, user: User): Promise<SetupCodeResponseDto> {
    if (!user.tenantId) {
      throw new ForbiddenException('User must belong to a tenant');
    }

    // Validate gate belongs to tenant
    if (dto.gateId) {
      const gate = await this.gateRepo.findOne({
        where: { id: dto.gateId, tenantId: user.tenantId },
      });
      if (!gate) {
        throw new NotFoundException('Gate not found');
      }
    }

    // Generate unique code
    let code: string;
    let attempts = 0;
    do {
      code = this.generateCode();
      const existing = await this.setupCodeRepo.findOne({ where: { code } });
      if (!existing) break;
      attempts++;
    } while (attempts < 10);

    if (attempts >= 10) {
      throw new BadRequestException('Failed to generate unique setup code');
    }

    const expiresAt = new Date(Date.now() + this.CODE_EXPIRY_MINUTES * 60 * 1000);

    const setupCode = await this.setupCodeRepo.save({
      code,
      deviceName: dto.deviceName,
      tenantId: user.tenantId,
      gateId: dto.gateId || null,
      expiresAt,
      status: SetupCodeStatus.PENDING,
      createdById: user.id,
    });

    return this.mapSetupCodeToResponse(setupCode);
  }

  async getSetupCodes(user: User): Promise<SetupCodeResponseDto[]> {
    if (!user.tenantId) {
      throw new ForbiddenException('User must belong to a tenant');
    }

    // Get pending codes that haven't expired
    const codes = await this.setupCodeRepo.find({
      where: {
        tenantId: user.tenantId,
        status: SetupCodeStatus.PENDING,
        expiresAt: MoreThan(new Date()),
      },
      order: { createdAt: 'DESC' },
    });

    return codes.map(this.mapSetupCodeToResponse);
  }

  async deleteSetupCode(id: string, user: User): Promise<void> {
    if (!user.tenantId) {
      throw new ForbiddenException('User must belong to a tenant');
    }

    const code = await this.setupCodeRepo.findOne({
      where: { id, tenantId: user.tenantId },
    });

    if (!code) {
      throw new NotFoundException('Setup code not found');
    }

    await this.setupCodeRepo.delete(id);
  }

  private mapSetupCodeToResponse(code: SetupCode): SetupCodeResponseDto {
    return {
      id: code.id,
      code: code.code,
      deviceName: code.deviceName,
      gateId: code.gateId || undefined,
      expiresAt: code.expiresAt,
      status: code.status,
      createdAt: code.createdAt,
    };
  }

  // ==================== Device Claim ====================

  async claimDevice(dto: ClaimDeviceDto, ip: string): Promise<ClaimResponseDto> {
    // Rate limiting
    await this.checkRateLimit(ip);

    // Find and validate setup code
    const setupCode = await this.setupCodeRepo.findOne({
      where: { code: dto.code.toUpperCase(), status: SetupCodeStatus.PENDING },
      relations: ['tenant'],
    });

    if (!setupCode) {
      this.incrementRateLimit(ip);
      return {
        success: false,
        error: 'INVALID_CODE',
        message: 'Setup code is invalid or has already been used',
      };
    }

    if (new Date() > setupCode.expiresAt) {
      await this.setupCodeRepo.update(setupCode.id, { status: SetupCodeStatus.EXPIRED });
      return {
        success: false,
        error: 'CODE_EXPIRED',
        message: 'Setup code has expired',
      };
    }

    // Check if device already exists
    const existingDevice = await this.deviceConfigRepo.findOne({
      where: { deviceId: dto.deviceId },
    });

    if (existingDevice) {
      // Device exists - check if same tenant
      if (existingDevice.tenantId !== setupCode.tenantId) {
        return {
          success: false,
          error: 'DEVICE_ALREADY_PAIRED',
          message: 'This device is already paired to another building. Factory reset required.',
        };
      }

      // Same tenant - allow re-pairing (WiFi change scenario)
      const mqttCreds = this.generateMqttCredentials(dto.deviceId);

      await this.deviceConfigRepo.update(existingDevice.id, {
        wifiSsid: dto.wifiSsid,
        firmwareVersion: dto.firmwareVersion,
        gateId: setupCode.gateId,
        deviceName: setupCode.deviceName,
        status: DeviceStatus.ONLINE,
        lastSeenAt: new Date(),
        mqttUsername: mqttCreds.username,
        mqttPasswordHash: this.hashPassword(mqttCreds.password),
      });

      // Mark setup code as claimed
      await this.setupCodeRepo.update(setupCode.id, {
        status: SetupCodeStatus.CLAIMED,
        claimedByDeviceId: dto.deviceId,
        claimedAt: new Date(),
      });

      // Update gate hardware ID (normalized - no colons)
      if (setupCode.gateId) {
        await this.gateRepo.update(setupCode.gateId, { hardwareId: this.normalizeDeviceId(dto.deviceId) });
      }

      return this.buildClaimResponse(setupCode, mqttCreds);
    }

    // New device - create config
    const mqttCreds = this.generateMqttCredentials(dto.deviceId);

    await this.deviceConfigRepo.save({
      tenantId: setupCode.tenantId,
      gateId: setupCode.gateId,
      deviceName: setupCode.deviceName,
      deviceId: dto.deviceId,
      wifiSsid: dto.wifiSsid,
      firmwareVersion: dto.firmwareVersion,
      setupCodeId: setupCode.id,
      status: DeviceStatus.ONLINE,
      lastSeenAt: new Date(),
      pairedAt: new Date(),
      mqttUsername: mqttCreds.username,
      mqttPasswordHash: this.hashPassword(mqttCreds.password),
    });

    // Mark setup code as claimed
    await this.setupCodeRepo.update(setupCode.id, {
      status: SetupCodeStatus.CLAIMED,
      claimedByDeviceId: dto.deviceId,
      claimedAt: new Date(),
    });

    // Update gate hardware ID (normalized - no colons)
    if (setupCode.gateId) {
      await this.gateRepo.update(setupCode.gateId, { hardwareId: this.normalizeDeviceId(dto.deviceId) });
    }

    this.logger.log(`Device ${dto.deviceId} claimed with code ${dto.code}`);

    // Emit WebSocket event for device paired
    this.gatewayService.broadcastDevicePaired(
      setupCode.tenantId,
      dto.deviceId,
      setupCode.deviceName,
      setupCode.gateId || undefined,
    );

    return this.buildClaimResponse(setupCode, mqttCreds);
  }

  private generateMqttCredentials(deviceId: string): { username: string; password: string } {
    const sanitizedId = deviceId.replace(/:/g, '').toLowerCase();
    return {
      username: `device_${sanitizedId}`,
      password: crypto.randomBytes(32).toString('base64'),
    };
  }

  private hashPassword(password: string): string {
    return crypto.createHash('sha256').update(password).digest('hex');
  }

  private buildClaimResponse(
    setupCode: SetupCode,
    mqttCreds: { username: string; password: string },
  ): ClaimResponseDto {
    // External MQTT URL for devices (different from internal Docker URL)
    const mqttExternalHost = this.configService.get<string>('MQTT_EXTERNAL_HOST', 'mqtt.gaterecord.com');
    const mqttExternalPort = this.configService.get<number>('MQTT_EXTERNAL_PORT', 18883);
    const apiBaseUrl = this.configService.get<string>('API_BASE_URL', 'https://api.gaterecord.com');

    const brokerHost = mqttExternalHost;
    const brokerPort = mqttExternalPort;

    return {
      success: true,
      config: {
        tenantId: setupCode.tenantId,
        gateId: setupCode.gateId || undefined,
        deviceName: setupCode.deviceName,
        mqttBroker: brokerHost,
        mqttPort: brokerPort,
        mqttUsername: mqttCreds.username,
        mqttPassword: mqttCreds.password,
        apiBaseUrl,
      },
    };
  }

  private async checkRateLimit(ip: string): Promise<void> {
    const now = new Date();
    const record = this.claimAttempts.get(ip);

    if (record && record.resetAt > now && record.count >= 5) {
      throw new BadRequestException('Too many claim attempts. Please try again later.');
    }
  }

  private incrementRateLimit(ip: string): void {
    const now = new Date();
    const resetAt = new Date(now.getTime() + 60 * 1000); // 1 minute window
    const record = this.claimAttempts.get(ip);

    if (!record || record.resetAt <= now) {
      this.claimAttempts.set(ip, { count: 1, resetAt });
    } else {
      record.count++;
    }
  }

  // ==================== Device Management ====================

  async getDevices(user: User): Promise<DeviceResponseDto[]> {
    let devices: DeviceConfig[];

    if (user.role === UserRole.SUPER_ADMIN) {
      devices = await this.deviceConfigRepo.find({
        relations: ['gate'],
        order: { createdAt: 'DESC' },
      });
    } else {
      if (!user.tenantId) {
        throw new ForbiddenException('User must belong to a tenant');
      }
      devices = await this.deviceConfigRepo.find({
        where: { tenantId: user.tenantId },
        relations: ['gate'],
        order: { createdAt: 'DESC' },
      });
    }

    return devices.map(this.mapDeviceToResponse);
  }

  async getDevice(id: string, user: User): Promise<DeviceResponseDto> {
    const device = await this.deviceConfigRepo.findOne({
      where: { id },
      relations: ['gate'],
    });

    if (!device) {
      throw new NotFoundException('Device not found');
    }

    if (user.role !== UserRole.SUPER_ADMIN && device.tenantId !== user.tenantId) {
      throw new ForbiddenException('Access denied');
    }

    return this.mapDeviceToResponse(device);
  }

  async updateDevice(id: string, dto: UpdateDeviceDto, user: User): Promise<DeviceResponseDto> {
    const device = await this.deviceConfigRepo.findOne({
      where: { id },
      relations: ['gate'],
    });

    if (!device) {
      throw new NotFoundException('Device not found');
    }

    if (user.role !== UserRole.SUPER_ADMIN && device.tenantId !== user.tenantId) {
      throw new ForbiddenException('Access denied');
    }

    // Validate gate if provided
    if (dto.gateId) {
      const gate = await this.gateRepo.findOne({
        where: { id: dto.gateId, tenantId: device.tenantId },
      });
      if (!gate) {
        throw new NotFoundException('Gate not found');
      }

      // Update gate hardware ID (normalized - no colons)
      await this.gateRepo.update(dto.gateId, { hardwareId: this.normalizeDeviceId(device.deviceId) });

      // Remove hardware ID from old gate
      if (device.gateId && device.gateId !== dto.gateId) {
        await this.gateRepo.update(device.gateId, { hardwareId: null });
      }
    }

    if (dto.deviceName) {
      device.deviceName = dto.deviceName;
    }
    if (dto.gateId !== undefined) {
      device.gateId = dto.gateId;
    }

    const updated = await this.deviceConfigRepo.save(device);
    return this.mapDeviceToResponse(updated);
  }

  async deleteDevice(id: string, user: User): Promise<void> {
    const device = await this.deviceConfigRepo.findOne({ where: { id } });

    if (!device) {
      throw new NotFoundException('Device not found');
    }

    if (user.role !== UserRole.SUPER_ADMIN && device.tenantId !== user.tenantId) {
      throw new ForbiddenException('Access denied');
    }

    // Remove hardware ID from gate
    if (device.gateId) {
      await this.gateRepo.update(device.gateId, { hardwareId: null });
    }

    await this.deviceConfigRepo.delete(id);

    // Emit WebSocket event for device removed
    this.gatewayService.broadcastDeviceRemoved(device.tenantId, device.deviceId);
  }

  private mapDeviceToResponse(device: DeviceConfig): DeviceResponseDto {
    return {
      id: device.id,
      deviceName: device.deviceName,
      deviceId: device.deviceId,
      tenantId: device.tenantId,
      gateId: device.gateId || undefined,
      gateName: device.gate?.name,
      wifiSsid: device.wifiSsid || undefined,
      firmwareVersion: device.firmwareVersion || undefined,
      status: device.status,
      lastSeenAt: device.lastSeenAt || undefined,
      ipAddress: device.ipAddress || undefined,
      wifiSignalStrength: device.wifiSignalStrength || undefined,
      uptime: device.uptime || undefined,
      pairedAt: device.pairedAt || undefined,
      createdAt: device.createdAt,
    };
  }

  // ==================== Update Check ====================

  async checkUpdate(deviceId: string, currentVersion: string): Promise<UpdateCheckResponseDto> {
    const latestFirmware = await this.firmwareService.getLatestStable();

    if (!latestFirmware) {
      return { updateAvailable: false };
    }

    const updateAvailable = this.isNewerVersion(latestFirmware.version, currentVersion);

    if (!updateAvailable) {
      return { updateAvailable: false };
    }

    // Check minimum version requirement
    if (latestFirmware.minRequiredVersion) {
      if (!this.meetsMinVersion(currentVersion, latestFirmware.minRequiredVersion)) {
        // Need intermediate update - find the minimum required version
        const intermediateVersion = await this.firmwareService.getVersion(
          latestFirmware.minRequiredVersion,
        );
        if (intermediateVersion) {
          return {
            updateAvailable: true,
            latestVersion: intermediateVersion.version,
            downloadUrl: await this.firmwareService.getDownloadUrl(intermediateVersion.id),
            checksum: intermediateVersion.checksum,
            releaseNotes: intermediateVersion.releaseNotes || undefined,
          };
        }
      }
    }

    return {
      updateAvailable: true,
      latestVersion: latestFirmware.version,
      downloadUrl: await this.firmwareService.getDownloadUrl(latestFirmware.id),
      checksum: latestFirmware.checksum,
      releaseNotes: latestFirmware.releaseNotes || undefined,
    };
  }

  private isNewerVersion(newVersion: string, currentVersion: string): boolean {
    const parseVersion = (v: string) => v.split('.').map((n) => parseInt(n, 10) || 0);
    const newParts = parseVersion(newVersion);
    const currentParts = parseVersion(currentVersion);

    for (let i = 0; i < Math.max(newParts.length, currentParts.length); i++) {
      const newPart = newParts[i] || 0;
      const currentPart = currentParts[i] || 0;
      if (newPart > currentPart) return true;
      if (newPart < currentPart) return false;
    }
    return false;
  }

  private meetsMinVersion(currentVersion: string, minVersion: string): boolean {
    return !this.isNewerVersion(minVersion, currentVersion);
  }

  // ==================== Heartbeat ====================

  async handleHeartbeat(
    deviceId: string,
    payload: {
      firmwareVersion: string;
      wifiRSSI: number;
      freeHeap: number;
      uptime: number;
      ip: string;
    },
  ): Promise<void> {
    // Get device to check if it was offline and to get tenantId
    const device = await this.deviceConfigRepo.findOne({ where: { deviceId } });
    if (!device) {
      this.logger.warn(`Heartbeat from unknown device: ${deviceId}`);
      return;
    }

    const wasOffline = device.status === DeviceStatus.OFFLINE;

    await this.deviceConfigRepo.update(
      { deviceId },
      {
        lastSeenAt: new Date(),
        firmwareVersion: payload.firmwareVersion,
        wifiSignalStrength: payload.wifiRSSI,
        freeHeap: payload.freeHeap,
        uptime: payload.uptime,
        ipAddress: payload.ip,
        status: DeviceStatus.ONLINE,
      },
    );

    // Emit device online event if it was offline
    if (wasOffline) {
      this.gatewayService.broadcastDeviceOnline(
        device.tenantId,
        deviceId,
        device.deviceName,
        device.gateId || undefined,
      );
    }

    // Emit heartbeat metrics to WebSocket
    this.gatewayService.broadcastDeviceHeartbeat(device.tenantId, deviceId, {
      firmwareVersion: payload.firmwareVersion,
      wifiSignalStrength: payload.wifiRSSI,
      uptime: payload.uptime,
      freeHeap: payload.freeHeap,
      ipAddress: payload.ip,
    });
  }

  async markOfflineDevices(): Promise<string[]> {
    const threshold = new Date(Date.now() - 2 * 60 * 1000); // 2 minutes

    const offlineDevices = await this.deviceConfigRepo.find({
      where: {
        status: DeviceStatus.ONLINE,
        lastSeenAt: LessThan(threshold),
      },
    });

    const deviceIds: string[] = [];

    for (const device of offlineDevices) {
      await this.deviceConfigRepo.update(device.id, { status: DeviceStatus.OFFLINE });
      deviceIds.push(device.deviceId);
      this.logger.log(`Device ${device.deviceId} marked offline`);

      // Emit device offline event
      this.gatewayService.broadcastDeviceOffline(
        device.tenantId,
        device.deviceId,
        device.deviceName,
        device.gateId || undefined,
      );
    }

    return deviceIds;
  }
}
