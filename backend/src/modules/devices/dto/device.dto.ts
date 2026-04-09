import { IsString, IsOptional, IsUUID, IsEnum, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DeviceStatus } from '@database/entities/device-config.entity';

export class CreateDeviceDto {
  @ApiProperty({ example: 'Main Gate Controller' })
  @IsString()
  deviceName: string;

  @ApiProperty({ example: '1Y3196', description: 'Device serial number from controller' })
  @IsString()
  deviceId: string;

  @ApiPropertyOptional({ example: '00:04:A3:80:F0:7E', description: 'MAC address' })
  @IsOptional()
  @IsString()
  @Matches(/^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/, {
    message: 'MAC address must be in format XX:XX:XX:XX:XX:XX',
  })
  macAddress?: string;

  @ApiProperty({ description: 'Tenant/Building ID' })
  @IsUUID()
  tenantId: string;

  @ApiPropertyOptional({ description: 'Gate ID to assign' })
  @IsOptional()
  @IsUUID()
  gateId?: string;
}

export class DeviceResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  deviceName: string;

  @ApiProperty()
  deviceId: string;

  @ApiProperty()
  tenantId: string;

  @ApiPropertyOptional()
  gateId?: string;

  @ApiPropertyOptional()
  gateName?: string;

  @ApiPropertyOptional()
  wifiSsid?: string;

  @ApiPropertyOptional()
  firmwareVersion?: string;

  @ApiProperty({ enum: DeviceStatus })
  status: DeviceStatus;

  @ApiPropertyOptional()
  lastSeenAt?: Date;

  @ApiPropertyOptional()
  ipAddress?: string;

  @ApiPropertyOptional()
  wifiSignalStrength?: number;

  @ApiPropertyOptional()
  uptime?: number;

  @ApiPropertyOptional()
  pairedAt?: Date;

  @ApiProperty()
  createdAt: Date;
}

export class UpdateDeviceDto {
  @ApiPropertyOptional({ example: 'Main Entry Controller' })
  @IsOptional()
  @IsString()
  deviceName?: string;

  @ApiPropertyOptional({ description: 'Tenant ID (Super Admin only)' })
  @IsOptional()
  @IsUUID()
  tenantId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  gateId?: string;
}

export class DeviceHeartbeatDto {
  @ApiProperty()
  @IsString()
  type: string;

  @ApiProperty()
  @IsString()
  firmwareVersion: string;

  @ApiProperty()
  wifiRSSI: number;

  @ApiProperty()
  freeHeap: number;

  @ApiProperty()
  uptime: number;

  @ApiProperty()
  @IsString()
  ip: string;
}

export class UpdateCheckResponseDto {
  @ApiProperty()
  updateAvailable: boolean;

  @ApiPropertyOptional()
  latestVersion?: string;

  @ApiPropertyOptional()
  downloadUrl?: string;

  @ApiPropertyOptional()
  checksum?: string;

  @ApiPropertyOptional()
  releaseNotes?: string;
}

export class DeviceDiagnosticsDto {
  @ApiProperty()
  deviceId: string;

  @ApiProperty()
  deviceName: string;

  @ApiProperty({ enum: DeviceStatus })
  status: DeviceStatus;

  @ApiPropertyOptional()
  firmwareVersion?: string;

  @ApiPropertyOptional()
  wifiSsid?: string;

  @ApiPropertyOptional()
  wifiSignalStrength?: number;

  @ApiPropertyOptional()
  ipAddress?: string;

  @ApiPropertyOptional()
  freeHeap?: number;

  @ApiPropertyOptional()
  uptime?: number;

  @ApiPropertyOptional()
  lastSeenAt?: Date;

  @ApiPropertyOptional()
  errorCount?: number;

  @ApiPropertyOptional()
  lastError?: string;

  @ApiPropertyOptional()
  lastRebootReason?: string;
}
