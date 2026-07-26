/**
 * Cloud Plus TypeB Controller DTOs
 * Request/Response formats for HTTP protocol communication
 */

import { IsString, IsNumber, IsOptional, IsEnum } from 'class-validator';
import { Transform } from 'class-transformer';

// Credential types from Cloud Plus protocol
export enum CloudPlusCredentialType {
  CARD = 0, // RFID Card
  RS232 = 1, // Serial string (barcode, QR)
  PASSWORD = 2, // PIN/Password
  BUTTON = 3, // Button request (exit button)
  CHINA_ID = 6, // Chinese ID Card (二代证)
  QR_BASE64 = 9, // Base64 encoded QR code
  FINGERPRINT = 10, // Fingerprint
  VEIN = 11, // Finger vein
  RFID_TAG = 12, // RFID Tag
  FACE = 13, // Face recognition
  CHINA_ID_ALT = 26, // Chinese ID Card (alternative)
  FACE_ALT = 23, // Face (alternative)
}

// Authorization result codes
export enum CloudPlusAuthResult {
  ALLOW = '1', // Allow passage
  DENY = '0', // Deny passage
  ALARM = '2', // Trigger alarm
  LOCK = '3', // Lock/close gate
}

/**
 * SearchCardAcs Request - Card validation request from controller
 */
export class SearchCardAcsRequestDto {
  @IsOptional()
  @Transform(({ value }) => (value !== undefined ? parseInt(value, 10) : 0))
  Reader?: number; // Reader channel (0 = entrance, 1 = exit)

  @IsOptional()
  @Transform(({ value }) => String(value || ''))
  Card?: string; // Credential data (RFID UID, QR code, etc.)

  @IsOptional()
  @Transform(({ value }) => String(value || ''))
  Serial?: string; // Controller serial number (device identifier)

  @IsOptional()
  @Transform(({ value }) => (value !== undefined ? parseInt(value, 10) : 12))
  type?: number; // Credential type (see CloudPlusCredentialType)

  @IsOptional()
  @IsString()
  MAC?: string; // Controller MAC address (optional)

  // Chinese ID card fields (type = 6 or 26)
  @IsOptional()
  @IsString()
  Name?: string; // Name in Unicode hex (for ID cards)

  @IsOptional()
  @IsString()
  Sex?: string; // Gender (1 = Male, 0 = Female)

  @IsOptional()
  @IsString()
  Bthday?: string; // Birthday

  @IsOptional()
  @IsString()
  Nation?: string; // Nationality code

  @IsOptional()
  @IsString()
  Addr?: string; // Address in Unicode hex

  @IsOptional()
  @IsString()
  DateFrm?: string; // ID valid from

  @IsOptional()
  @IsString()
  DateTo?: string; // ID valid until

  @IsOptional()
  @IsString()
  Dept?: string; // Issuing department

  @IsOptional()
  @IsString()
  Photo?: string; // Photo data (base64)
}

/**
 * SearchCardAcs Response - Authorization result to controller
 * All string values should be within specified byte limits for LCD display
 */
export class SearchCardAcsResponseDto {
  AcsRes: string; // Authorization result (1=Allow, 0=Deny, 2=Alarm, 3=Lock, 4=Ignore)
  ActIndex: string; // Reader channel to control (0-2)
  Time: string; // Gate hold time (use "1" for gate control)
  Card: string; // Echo back the credential (max 16 bytes)
  Name: string; // Cardholder name (displayed on LCD, max 16 bytes)
  Note: string; // Log note (displayed on LCD, max 32 bytes)
  Systime: string; // Server timestamp (max 20 bytes)
  Voice: string; // Voice prompt text (TTS, max 40 bytes)
  LCD?: string; // LCD display page: 6=pass, 7=deny, 0=standby (optional)
  LCDTime?: string; // LCD display duration in seconds (optional)
}

/**
 * GetStatus Request - Heartbeat from controller
 */
export class GetStatusRequestDto {
  @IsOptional()
  @Transform(({ value }) => String(value || ''))
  Key?: string; // Controller identifier key
}

/**
 * GetStatus Response - Heartbeat acknowledgment
 *
 * Optionally carries an alarm command back to an HTTP-mode controller:
 *   AcsRes '2' + ActIndex '2' + Time N = fire the ALARM relay for N seconds
 *   AcsRes '3' + ActIndex '2'          = close (silence) the ALARM relay
 */
export class GetStatusResponseDto {
  Key: string; // Echo back the key
  AcsRes?: string; // Optional command result (2=alarm, 3=close)
  ActIndex?: string; // Optional relay position (2=alarm relay)
  Time?: string; // Optional relay hold time in seconds
}

/**
 * Device registration request (for admin to register Cloud Plus controllers)
 */
export class RegisterCloudPlusDeviceDto {
  @IsString()
  serial: string; // Controller serial number

  @IsString()
  deviceName: string; // Human-readable name

  @IsOptional()
  @IsString()
  gateId?: string; // Associate with a gate

  @IsOptional()
  @IsString()
  apiKey?: string; // Optional API key for authentication
}

/**
 * Internal validation result
 */
export interface ValidationResult {
  allowed: boolean;
  name: string;
  info: string;
  denialReason?: string;
  subjectType: 'vehicle' | 'rfid_card' | 'visitor_pass' | 'user' | 'unknown';
  subjectId?: string;
  subjectIdentifier: string;
  residentId?: string; // Owner/user ID for RBAC filtering
}
