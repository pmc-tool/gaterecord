import { IsString, IsOptional, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateSetupCodeDto {
  @ApiProperty({ example: 'Main Entry Controller' })
  @IsString()
  deviceName: string;

  @ApiPropertyOptional({ example: 'uuid' })
  @IsOptional()
  @IsUUID()
  gateId?: string;
}

export class SetupCodeResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'ABC-DEF-GHJ' })
  code: string;

  @ApiProperty()
  deviceName: string;

  @ApiPropertyOptional()
  gateId?: string;

  @ApiProperty()
  expiresAt: Date;

  @ApiProperty({ example: 'pending' })
  status: string;

  @ApiProperty()
  createdAt: Date;
}

export class ClaimDeviceDto {
  @ApiProperty({ example: 'ABC-DEF-GHJ' })
  @IsString()
  code: string;

  @ApiProperty({ example: 'A4:CF:12:XX:XX:XX' })
  @IsString()
  deviceId: string;

  @ApiProperty({ example: 'Home_Network_5G' })
  @IsString()
  wifiSsid: string;

  @ApiProperty({ example: '1.3.0' })
  @IsString()
  firmwareVersion: string;
}

export class ClaimResponseDto {
  @ApiProperty()
  success: boolean;

  @ApiProperty()
  config?: {
    tenantId: string;
    gateId?: string;
    deviceName: string;
    httpServerUrl: string;
    httpServerPort: number;
    apiKey?: string;
    apiBaseUrl: string;
  };

  @ApiPropertyOptional()
  error?: string;

  @ApiPropertyOptional()
  message?: string;
}
