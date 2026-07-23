import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { IsString, IsOptional, IsBoolean } from 'class-validator';
import { Transform } from 'class-transformer';
import { FirmwareVersion } from '@database/entities/firmware-version.entity';
import { OtaUpdate, OtaUpdateStatus } from '@database/entities/ota-update.entity';
import { DeviceConfig } from '@database/entities/device-config.entity';

export class UploadFirmwareDto {
  @IsString()
  version: string;

  @IsOptional()
  @IsString()
  releaseNotes?: string;

  @IsOptional()
  @IsString()
  minRequiredVersion?: string;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  isStable?: boolean;
}

export class FirmwareResponseDto {
  id: string;
  version: string;
  firmwareUrl: string;
  firmwareSize?: number;
  checksum: string;
  releaseNotes?: string;
  isStable: boolean;
  isLatest: boolean;
  minRequiredVersion?: string;
  releasedAt?: Date;
  createdAt: Date;
  deviceCount?: number;
}

@Injectable()
export class FirmwareService {
  private readonly logger = new Logger(FirmwareService.name);

  constructor(
    @InjectRepository(FirmwareVersion)
    private firmwareRepo: Repository<FirmwareVersion>,
    @InjectRepository(OtaUpdate)
    private otaUpdateRepo: Repository<OtaUpdate>,
    @InjectRepository(DeviceConfig)
    private deviceConfigRepo: Repository<DeviceConfig>,
    private configService: ConfigService,
  ) {}

  async getLatestStable(): Promise<FirmwareVersion | null> {
    return this.firmwareRepo.findOne({
      where: { isLatest: true, isStable: true },
    });
  }

  async getVersion(version: string): Promise<FirmwareVersion | null> {
    return this.firmwareRepo.findOne({ where: { version } });
  }

  async getById(id: string): Promise<FirmwareVersion | null> {
    return this.firmwareRepo.findOne({ where: { id } });
  }

  async getDownloadUrl(firmwareId: string): Promise<string> {
    const firmware = await this.firmwareRepo.findOne({ where: { id: firmwareId } });
    if (!firmware) {
      throw new NotFoundException('Firmware not found');
    }

    // In production, generate a signed URL from S3/cloud storage
    // For now, return the direct URL
    return firmware.firmwareUrl;
  }

  async getFirmwareFilePath(version: string): Promise<string> {
    const firmware = await this.firmwareRepo.findOne({ where: { version } });
    if (!firmware) {
      throw new NotFoundException(`Firmware version ${version} not found`);
    }

    const firmwarePath = path.join(process.cwd(), 'uploads', 'firmware', version, 'firmware.bin');
    try {
      await fs.access(firmwarePath);
    } catch {
      throw new NotFoundException(`Firmware file for version ${version} not found on disk`);
    }

    return firmwarePath;
  }

  async getFirmwareByVersion(version: string): Promise<FirmwareVersion | null> {
    return this.firmwareRepo.findOne({ where: { version } });
  }

  async getAllVersions(): Promise<FirmwareResponseDto[]> {
    const versions = await this.firmwareRepo.find({
      order: { createdAt: 'DESC' },
    });

    // Get device counts for each version
    const deviceCounts = await this.deviceConfigRepo
      .createQueryBuilder('device')
      .select('device.firmwareVersion', 'version')
      .addSelect('COUNT(*)', 'count')
      .where('device.deletedAt IS NULL')
      .groupBy('device.firmwareVersion')
      .getRawMany();

    const countMap = new Map<string, number>();
    deviceCounts.forEach((row) => {
      countMap.set(row.version, parseInt(row.count, 10));
    });

    return versions.map((v) => ({
      ...this.mapToResponse(v),
      deviceCount: countMap.get(v.version) || 0,
    }));
  }

  async uploadFirmware(
    file: Buffer,
    filename: string,
    dto: UploadFirmwareDto,
  ): Promise<FirmwareResponseDto> {
    // Check version doesn't exist
    const existing = await this.firmwareRepo.findOne({
      where: { version: dto.version },
    });
    if (existing) {
      throw new BadRequestException(`Firmware version ${dto.version} already exists`);
    }

    // Validate version format
    if (!/^\d+\.\d+\.\d+(-\w+)?$/.test(dto.version)) {
      throw new BadRequestException(
        'Invalid version format. Use semver (e.g., 1.2.3 or 1.2.3-beta)',
      );
    }

    // Calculate checksum
    const checksum = crypto.createHash('sha256').update(file).digest('hex');

    // Save firmware file to local storage
    const uploadsDir = path.join(process.cwd(), 'uploads', 'firmware', dto.version);
    await fs.mkdir(uploadsDir, { recursive: true });
    const firmwarePath = path.join(uploadsDir, 'firmware.bin');
    await fs.writeFile(firmwarePath, file);
    this.logger.log(`Firmware file saved to ${firmwarePath}`);

    // Generate download URL
    const baseUrl = this.configService.get<string>('API_BASE_URL', 'https://dev-api.gaterecord.com');
    const firmwareUrl = `${baseUrl}/api/v1/firmware/download/${dto.version}`;

    const firmware = await this.firmwareRepo.save({
      version: dto.version,
      firmwareUrl,
      firmwareSize: file.length,
      checksum,
      releaseNotes: dto.releaseNotes,
      minRequiredVersion: dto.minRequiredVersion,
      isStable: dto.isStable ?? false,
      isLatest: false,
    });

    this.logger.log(`Firmware ${dto.version} uploaded, checksum: ${checksum}`);

    return this.mapToResponse(firmware);
  }

  async releaseFirmware(
    id: string,
    options: { isLatest?: boolean; isStable?: boolean },
  ): Promise<FirmwareResponseDto> {
    const firmware = await this.firmwareRepo.findOne({ where: { id } });
    if (!firmware) {
      throw new NotFoundException('Firmware not found');
    }

    if (options.isLatest) {
      // Unset previous latest
      await this.firmwareRepo.update({}, { isLatest: false });
    }

    await this.firmwareRepo.update(id, {
      releasedAt: new Date(),
      isLatest: options.isLatest ?? firmware.isLatest,
      isStable: options.isStable ?? firmware.isStable,
    });

    const updated = await this.firmwareRepo.findOne({ where: { id } });
    this.logger.log(`Firmware ${firmware.version} released`);

    return this.mapToResponse(updated!);
  }

  async deleteFirmware(id: string): Promise<void> {
    const firmware = await this.firmwareRepo.findOne({ where: { id } });
    if (!firmware) {
      throw new NotFoundException('Firmware not found');
    }

    // Check if any devices are using this version
    const devicesUsingVersion = await this.deviceConfigRepo.count({
      where: { firmwareVersion: firmware.version },
    });

    if (devicesUsingVersion > 0) {
      throw new BadRequestException(
        `Cannot delete firmware ${firmware.version}: ${devicesUsingVersion} devices are using it`,
      );
    }

    await this.firmwareRepo.delete(id);
    this.logger.log(`Firmware ${firmware.version} deleted`);
  }

  private mapToResponse(firmware: FirmwareVersion): FirmwareResponseDto {
    return {
      id: firmware.id,
      version: firmware.version,
      firmwareUrl: firmware.firmwareUrl,
      firmwareSize: firmware.firmwareSize || undefined,
      checksum: firmware.checksum,
      releaseNotes: firmware.releaseNotes || undefined,
      isStable: firmware.isStable,
      isLatest: firmware.isLatest,
      minRequiredVersion: firmware.minRequiredVersion || undefined,
      releasedAt: firmware.releasedAt || undefined,
      createdAt: firmware.createdAt,
    };
  }

  // ==================== OTA Updates ====================

  async createOtaUpdate(
    deviceConfigId: string,
    firmwareVersionId: string,
    fromVersion: string | null,
    toVersion: string,
    initiatedById?: string,
  ): Promise<OtaUpdate> {
    return this.otaUpdateRepo.save({
      deviceConfigId,
      firmwareVersionId,
      fromVersion,
      toVersion,
      status: OtaUpdateStatus.PENDING,
      initiatedById,
      initiatedAt: new Date(),
    });
  }

  async updateOtaStatus(
    updateId: string,
    status: OtaUpdateStatus,
    progress?: number,
    errorMessage?: string,
  ): Promise<void> {
    const update: {
      status: OtaUpdateStatus;
      progress?: number;
      errorMessage?: string;
      startedAt?: Date;
      completedAt?: Date;
    } = { status };

    if (progress !== undefined) {
      update.progress = progress;
    }
    if (errorMessage) {
      update.errorMessage = errorMessage;
    }
    if (status === OtaUpdateStatus.DOWNLOADING) {
      update.startedAt = new Date();
    }
    if (
      status === OtaUpdateStatus.COMPLETED ||
      status === OtaUpdateStatus.FAILED ||
      status === OtaUpdateStatus.ROLLED_BACK
    ) {
      update.completedAt = new Date();
    }

    await this.otaUpdateRepo.update(updateId, update);
  }

  async getOtaUpdates(deviceConfigId: string): Promise<OtaUpdate[]> {
    return this.otaUpdateRepo.find({
      where: { deviceConfigId },
      relations: ['firmwareVersion'],
      order: { createdAt: 'DESC' },
    });
  }
}
