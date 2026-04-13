import { IsString, IsEnum, IsOptional, IsUUID, IsBoolean } from 'class-validator';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { GateType, GateState } from '@database/entities/gate.entity';
import { SensorType, SensorHealthStatus } from '@database/entities/sensor-status.entity';

export class CreateGateDto {
  @ApiProperty({ example: 'Main Entry' })
  @IsString()
  name: string;

  @ApiProperty({ enum: GateType, example: GateType.VEHICLE })
  @IsEnum(GateType)
  type: GateType;

  @ApiPropertyOptional({ example: 'Front entrance' })
  @IsString()
  @IsOptional()
  location?: string;

  @ApiPropertyOptional({ example: 'Main vehicle entry point' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ example: 'AABBCCDDEEFF', description: 'ESP32 device MAC address' })
  @IsString()
  @IsOptional()
  hardwareId?: string;

  @ApiPropertyOptional({ description: 'Required for Super Admin' })
  @IsUUID()
  @IsOptional()
  tenantId?: string;
}

export class UpdateGateDto extends PartialType(CreateGateDto) {
  @ApiPropertyOptional({ enum: GateState })
  @IsEnum(GateState)
  @IsOptional()
  state?: GateState;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  isOnline?: boolean;

  @ApiPropertyOptional({ example: 'AABBCCDDEEFF', description: 'ESP32 device MAC address' })
  @IsString()
  @IsOptional()
  hardwareId?: string;
}

export class GateResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ enum: GateType })
  type: GateType;

  @ApiPropertyOptional()
  location?: string;

  @ApiPropertyOptional()
  description?: string;

  @ApiPropertyOptional({ description: 'ESP32 device MAC address' })
  hardwareId?: string;

  @ApiProperty({ enum: GateState })
  state: GateState;

  @ApiProperty()
  isOnline: boolean;

  @ApiPropertyOptional()
  lastHeartbeatAt?: Date;

  @ApiProperty()
  tenantId: string;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

export class SensorStatusDto {
  @ApiProperty({ enum: SensorType })
  sensorType: SensorType;

  @ApiProperty({ enum: SensorHealthStatus })
  status: SensorHealthStatus;

  @ApiPropertyOptional()
  lastValue?: string;

  @ApiPropertyOptional()
  lastReadingAt?: Date;

  @ApiPropertyOptional()
  notes?: string;
}

export class GateHealthDto {
  @ApiProperty()
  gateId: string;

  @ApiProperty()
  gateName: string;

  @ApiProperty()
  isOnline: boolean;

  @ApiPropertyOptional()
  lastHeartbeatAt?: Date;

  @ApiProperty({ type: [SensorStatusDto] })
  sensors: SensorStatusDto[];

  @ApiPropertyOptional()
  firmwareVersion?: string;

  @ApiPropertyOptional()
  wifiStrength?: number;

  @ApiPropertyOptional()
  uptimeSeconds?: number;
}

export class GateQueryDto {
  @ApiPropertyOptional({ description: 'Filter by tenant ID (super admin only)' })
  @IsUUID()
  @IsOptional()
  tenantId?: string;

  @ApiPropertyOptional({ enum: GateType, description: 'Filter by gate type' })
  @IsEnum(GateType)
  @IsOptional()
  type?: GateType;

  @ApiPropertyOptional({ enum: GateState, description: 'Filter by gate state' })
  @IsEnum(GateState)
  @IsOptional()
  state?: GateState;
}
