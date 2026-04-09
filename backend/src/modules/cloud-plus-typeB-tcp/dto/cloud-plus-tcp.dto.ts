/**
 * Cloud Plus TypeB TCP Protocol DTOs
 */

import { IsString, IsNumber, IsOptional, IsBoolean, IsEnum } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * Gate control actions
 */
export enum GateAction {
  OPEN = 'open',
  CLOSE = 'close',
  OPEN_LONG = 'open_long',
  LOCK = 'lock',
  UNLOCK = 'unlock',
}

/**
 * Simple door selector for open/close endpoints
 */
export class DoorSelectDto {
  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => (value !== undefined ? parseInt(value, 10) : 0))
  door?: number = 0; // Door/relay index (0 or 1)

  @IsOptional()
  @IsString()
  deviceId?: string; // Target specific device (serial number)
}

/**
 * Request to control gate via TCP (generic action)
 */
export class GateControlDto {
  @IsEnum(GateAction)
  action: GateAction;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => (value !== undefined ? parseInt(value, 10) : 0))
  door?: number = 0; // Door/relay index (0 or 1)

  @IsOptional()
  @IsString()
  deviceId?: string; // Target specific device (serial number)
}

/**
 * Request to open gate with display info
 */
export class OpenGateWithInfoDto {
  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => (value !== undefined ? parseInt(value, 10) : 0))
  door?: number = 0;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => (value !== undefined ? parseInt(value, 10) : 3))
  openTime?: number = 3; // Seconds to keep gate open

  @IsOptional()
  @IsString()
  card?: string = '';

  @IsOptional()
  @IsString()
  name?: string = '';

  @IsOptional()
  @IsString()
  note?: string = '';

  @IsOptional()
  @IsString()
  voice?: string = '';
}

/**
 * Request to set alarm state
 */
export class SetAlarmDto {
  @IsBoolean()
  enable: boolean;

  @IsOptional()
  @IsNumber()
  longtime?: number = 0;
}

/**
 * Request to set fire/emergency state
 */
export class SetFireDto {
  @IsBoolean()
  enable: boolean;
}

/**
 * Connected controller info
 */
export interface ConnectedController {
  serial: string;
  id: string;
  gateId?: string | null;
  gateName?: string;
  tenantId?: string;
  ipAddress: string;
  port: number;
  connectedAt: Date;
  lastHeartbeat: Date;
  doorStatus: number;
  oemCode: number;
  version: number;
  online: boolean;
}

/**
 * Response from gate control command
 */
export interface GateControlResponse {
  success: boolean;
  message: string;
  serial: string;
  action: string;
  timestamp: string;
}

/**
 * TCP server status
 */
export interface TcpServerStatus {
  running: boolean;
  port: number;
  connectedControllers: number;
  controllers: ConnectedController[];
}

/**
 * Event from controller (card swipe, button press)
 * Per SDK: reader byte contains both reader (bit 0) and door ((reader >> 1) & 0x0f)
 */
export interface ControllerEvent {
  serial: string;
  id: string;
  reader: number;
  door: number;
  dataType: number;
  card: string;
  cardInt?: number;
  timestamp: Date;
  datetime?: Date;
}
