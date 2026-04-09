import { IsString, IsEnum, IsOptional, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum SimulatorEvent {
  CAR_RFID_DETECTED = 'car_rfid_detected',
  HUMAN_RFID_DETECTED = 'human_rfid_detected',
  QR_VERIFIED = 'qr_verified',
  OBSTACLE_DETECTED = 'obstacle_detected',
  OBSTACLE_CLEARED = 'obstacle_cleared',
  LIMIT_OPEN_REACHED = 'limit_open_reached',
  LIMIT_CLOSE_REACHED = 'limit_close_reached',
  MANUAL_OPEN = 'manual_open',
  MANUAL_CLOSE = 'manual_close',
}

export class TriggerEventDto {
  @ApiProperty({ enum: SimulatorEvent })
  @IsEnum(SimulatorEvent)
  event: SimulatorEvent;

  @ApiPropertyOptional({ example: 'ABCD1234' })
  @IsString()
  @IsOptional()
  rfidUid?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  qrToken?: string;

  @ApiPropertyOptional({ example: 'ABC123456', description: 'Device Serial Number' })
  @IsString()
  @IsOptional()
  Serial?: string;

  @ApiPropertyOptional({ example: '0', description: 'Reader number (0 or 1)' })
  @IsString()
  @IsOptional()
  Reader?: string;

  @ApiPropertyOptional({ example: '12', description: 'Credential type (12=RFID, 16=QR)' })
  @IsString()
  @IsOptional()
  type?: string;
}

export class SimulatorFeedbackDto {
  @ApiProperty()
  gateId: string;

  @ApiProperty()
  action: string;

  @ApiProperty()
  success: boolean;

  @ApiProperty()
  message: string;

  @ApiProperty()
  gateState: string;

  @ApiPropertyOptional()
  eventId?: string;
}

export class SetOnlineDto {
  @ApiProperty()
  isOnline: boolean;
}

export class UpdateSensorDto {
  @ApiProperty()
  @IsString()
  sensorType: string;

  @ApiProperty()
  @IsString()
  status: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  value?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  notes?: string;
}
