import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';

import { DeviceConfig, DeviceStatus } from '@database/entities/device-config.entity';
import { Gate, GateState } from '@database/entities/gate.entity';
import { Vehicle, VehicleStatus } from '@database/entities/vehicle.entity';
import { RfidCard, RfidCardStatus } from '@database/entities/rfid-card.entity';
import { VisitorPass, VisitorPassStatus } from '@database/entities/visitor-pass.entity';
import { User, UserStatus } from '@database/entities/user.entity';
import {
  AccessEvent,
  AccessMethod,
  AccessResult,
  AccessSubjectType,
} from '@database/entities/access-event.entity';
import { GatewayService } from '../gateway/gateway.service';
import { RfidRegistrationService } from '../rfid/rfid-registration.service';
import { PendingAlarmService } from './pending-alarm.service';

import {
  SearchCardAcsRequestDto,
  SearchCardAcsResponseDto,
  GetStatusRequestDto,
  GetStatusResponseDto,
  CloudPlusCredentialType,
  CloudPlusAuthResult,
  ValidationResult,
  RegisterCloudPlusDeviceDto,
} from './dto/cloud-plus.dto';

@Injectable()
export class CloudPlusService {
  private readonly logger = new Logger(CloudPlusService.name);

  constructor(
    @InjectRepository(DeviceConfig)
    private deviceConfigRepository: Repository<DeviceConfig>,
    @InjectRepository(Gate)
    private gateRepository: Repository<Gate>,
    @InjectRepository(Vehicle)
    private vehicleRepository: Repository<Vehicle>,
    @InjectRepository(RfidCard)
    private rfidCardRepository: Repository<RfidCard>,
    @InjectRepository(VisitorPass)
    private visitorPassRepository: Repository<VisitorPass>,
    @InjectRepository(AccessEvent)
    private accessEventRepository: Repository<AccessEvent>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private gatewayService: GatewayService,
    private rfidRegistrationService: RfidRegistrationService,
    private pendingAlarmService: PendingAlarmService,
  ) {}

  /**
   * Process card/credential validation request from Cloud Plus controller
   */
  async processSearchCardAcs(
    request: SearchCardAcsRequestDto,
    clientIp?: string,
    handleType?: string,
    gate?: Gate,
  ): Promise<SearchCardAcsResponseDto> {
    // Normalize request with defaults
    const serial = request.Serial || '';
    const card = request.Card || '';
    const credType = request.type ?? 12;
    const reader = request.Reader ?? 0;
    const timestamp = this.formatTimestamp(new Date());

    try {
      // Step 1: Find device by serial number.
      const device = await this.findDeviceBySerial(serial);

      // Resolve the gate and tenant to evaluate against.
      //
      // Real hardware (HTTP or TCP Cloud B4 controller) is ALWAYS a registered
      // device, so `device` is found and the existing device→gate resolution runs
      // unchanged. The ONLY new case is the Gate Simulator driving a gate that has
      // NO attached device: it passes the target `gate` explicitly with an
      // unknown/blank serial, so we evaluate the credential against that gate
      // directly instead of rejecting with "Unregistered device". A real
      // controller never reaches this branch (its serial is registered).
      let activeGate: Gate;
      let tenantId: string;

      if (device) {
        // Update device last seen
        await this.updateDeviceStatus(device, clientIp, request.MAC);

        // Step 2: Find associated gate from device
        const deviceGate = device.gate;
        if (!deviceGate) {
          this.logger.warn(`Device ${serial} not assigned to any gate`);
          return this.buildDenyResponse(
            card,
            reader,
            credType,
            'No Gate',
            'Device not assigned to gate',
            timestamp,
          );
        }

        // Validate gate ID matches if gate is provided
        if (gate && gate.id !== deviceGate.id) {
          this.logger.warn(
            `Gate mismatch: provided gate ${gate.id} does not match device gate ${deviceGate.id}`,
          );
          return this.buildDenyResponse(
            card,
            reader,
            credType,
            'Gate Mismatch',
            'Device not assigned to this gate',
            timestamp,
          );
        }

        activeGate = gate || deviceGate;
        tenantId = device.tenantId;
      } else if (gate) {
        // Simulator driving a device-less gate — evaluate against the gate itself.
        activeGate = gate;
        tenantId = gate.tenantId;
        this.logger.log(
          `No device for serial "${serial}"; simulating against gate ${gate.name} (${gate.id})`,
        );
      } else {
        // Real hardware with an unregistered serial and no gate context — reject.
        this.logger.warn(`Unknown device: ${serial}`);
        return this.buildDenyResponse(
          card,
          reader,
          credType,
          'Unknown Device',
          'Unregistered device',
          timestamp,
        );
      }

      console.log(`Processing credential for gate: ${activeGate.name} (ID: ${activeGate.id})`);

      // Step 3: Process credential based on type
      const credentialType = credType & 0xff;
      let validationResult: ValidationResult;

      // Intercept CARD/RFID_TAG scans when a registration session is active
      // for this tenant — save the card to the resident/vehicle and notify the
      // frontend instead of running normal access validation.
      if (
        credentialType === CloudPlusCredentialType.CARD ||
        credentialType === CloudPlusCredentialType.RFID_TAG
      ) {
        if (this.rfidRegistrationService.hasActiveSession(tenantId)) {
          const normalizedUid = card.toUpperCase().replace(/:/g, '');
          const scanType = handleType === 'vehicle' ? 'vehicle' : 'human';
          const handled = await this.rfidRegistrationService.processRegistrationScan(
            tenantId,
            normalizedUid,
            scanType,
          );
          if (handled) {
            const registrationResult: ValidationResult = {
              allowed: true,
              name: 'Card Registered',
              info: 'Registration successful',
              subjectType: scanType === 'vehicle' ? 'vehicle' : 'rfid_card',
              subjectIdentifier: normalizedUid,
            };
            return this.buildAllowDenyResponse(
              registrationResult,
              card,
              reader,
              credType,
              timestamp,
            );
          }
        }
      }

      switch (credentialType) {
        case CloudPlusCredentialType.CARD:
        case CloudPlusCredentialType.RFID_TAG:
          validationResult = await this.validateRfidCredential(
            tenantId,
            card,
            activeGate,
            handleType,
          );
          break;

        case CloudPlusCredentialType.QR_BASE64:
        case CloudPlusCredentialType.RS232:
          const decodedQr = this.decodeBase64Qr(card);
          validationResult = await this.validateQrCode(tenantId, decodedQr, activeGate);
          break;

        case CloudPlusCredentialType.BUTTON:
          // Exit button - always allow (or check exit policy)
          console.log(`Exit button pressed at gate ${activeGate.name}`);
          validationResult = {
            allowed: true,
            name: 'Exit Request',
            info: 'Button pressed',
            subjectType: 'unknown',
            subjectIdentifier: 'BUTTON',
          };
          break;

        case CloudPlusCredentialType.PASSWORD:
          validationResult = await this.validatePassword(tenantId, card, activeGate);
          break;

        case CloudPlusCredentialType.FACE:
        case CloudPlusCredentialType.FACE_ALT:
          // Face recognition - Card field contains face ID
          validationResult = await this.validateFaceId(tenantId, card, activeGate);
          break;

        default:
          this.logger.warn(`Unsupported credential type: ${credentialType}`);
          validationResult = {
            allowed: false,
            name: 'Unknown',
            info: 'Unsupported credential type',
            subjectType: 'unknown',
            subjectIdentifier: card,
            denialReason: `Unsupported type: ${credentialType}`,
          };
      }

      // Step 4: Log access event
      const savedEvent = await this.logAccessEvent(
        activeGate,
        validationResult,
        this.getAccessMethod(credentialType),
      );

      // Step 5: Notify frontend via WebSocket
      this.notifyFrontend(activeGate, validationResult, savedEvent);

      // Step 6: Build and return response
      return this.buildAllowDenyResponse(validationResult, card, reader, credType, timestamp);
    } catch (error) {
      const err = error as Error;
      this.logger.error(`Error processing SearchCardAcs: ${err.message}`, err.stack);
      return this.buildDenyResponse(
        card,
        reader,
        credType,
        'Error',
        'Internal system error',
        timestamp,
      );
    }
  }

  /**
   * Process heartbeat/status request from Cloud Plus controller
   *
   * Cloud Plus controllers send GetStatus with `Key=<incrementing counter>`,
   * not their serial number. So we identify the device by the request IP
   * (saved during the last SearchCardAcs that included Serial+MAC).
   */
  async processGetStatus(
    request: GetStatusRequestDto,
    clientIp?: string,
  ): Promise<GetStatusResponseDto> {
    const key = request.Key || '';
    this.logger.debug(`Heartbeat from: ${key} (ip=${clientIp ?? 'unknown'})`);

    let device = await this.findDeviceBySerial(key);

    if (!device && clientIp) {
      device = await this.findDeviceByIp(clientIp);
    }

    if (device) {
      await this.updateDeviceStatus(device, clientIp);

      // Deliver any pending buzzer/alarm command for this controller. In HTTP
      // mode this heartbeat response is the only channel to command the device,
      // so a security alert armed for this serial fires the alarm relay here.
      const alarmCommand = this.pendingAlarmService.consume(device.deviceId);
      if (alarmCommand) {
        this.logger.warn(
          `[HTTP-ALARM] Delivering command to ${device.deviceId} on heartbeat: ${JSON.stringify(alarmCommand)}`,
        );
        return { Key: key, ...alarmCommand };
      }
    } else {
      // Heartbeat arrived but we could not map it to a registered DeviceConfig
      // (unknown serial AND unknown IP). Any armed alarm for this controller can
      // never be delivered until it is registered — surface it loudly.
      this.logger.warn(
        `[HTTP-ALARM] Heartbeat from unresolved controller (Key=${key}, ip=${clientIp ?? 'unknown'}). ` +
          `No matching DeviceConfig by serial or IP — a buzzer command could not be delivered.`,
      );
    }

    return { Key: key };
  }

  /**
   * Register a new Cloud Plus controller device
   */
  async registerDevice(dto: RegisterCloudPlusDeviceDto, tenantId: string): Promise<DeviceConfig> {
    // Check if device already exists
    const existing = await this.deviceConfigRepository.findOne({
      where: { deviceId: dto.serial },
    });

    if (existing) {
      throw new BadRequestException('Device already registered');
    }

    // Validate gate if provided
    let gate: Gate | null = null;
    if (dto.gateId) {
      gate = await this.gateRepository.findOne({
        where: { id: dto.gateId, tenantId },
      });
      if (!gate) {
        throw new NotFoundException('Gate not found');
      }
    }

    // Generate API key hash if provided
    let apiKeyHash: string | null = null;
    if (dto.apiKey) {
      apiKeyHash = crypto.createHash('sha256').update(dto.apiKey).digest('hex');
    }

    // Create device config
    const deviceConfig = this.deviceConfigRepository.create({
      deviceId: dto.serial,
      deviceName: dto.deviceName,
      tenantId,
      gateId: dto.gateId,
      status: DeviceStatus.ONLINE,
      apiKeyHash,
      pairedAt: new Date(),
    });

    const saved = await this.deviceConfigRepository.save(deviceConfig);

    // Update gate hardware ID if gate is assigned
    if (gate) {
      gate.hardwareId = dto.serial;
      await this.gateRepository.save(gate);
    }

    this.logger.log(`Registered Cloud Plus device: ${dto.serial} for tenant ${tenantId}`);
    return saved;
  }

  /**
   * Get all Cloud Plus devices for a tenant
   */
  async getDevices(tenantId: string): Promise<DeviceConfig[]> {
    return this.deviceConfigRepository.find({
      where: { tenantId },
      relations: ['gate'],
      order: { createdAt: 'DESC' },
    });
  }

  // ===================== Private Helper Methods =====================

  private async findDeviceBySerial(serial: string): Promise<DeviceConfig | null> {
    if (!serial) return null;
    return this.deviceConfigRepository.findOne({
      where: { deviceId: serial },
      relations: ['gate', 'tenant'],
    });
  }

  private async findDeviceByIp(ip: string): Promise<DeviceConfig | null> {
    if (!ip) return null;
    return this.deviceConfigRepository.findOne({
      where: { ipAddress: ip },
      relations: ['gate', 'tenant'],
      order: { lastSeenAt: 'DESC' },
    });
  }

  private async updateDeviceStatus(
    device: DeviceConfig,
    clientIp?: string,
    macAddress?: string,
  ): Promise<void> {
    device.status = DeviceStatus.ONLINE;
    device.lastSeenAt = new Date();
    if (clientIp) {
      device.ipAddress = clientIp;
    }
    if (macAddress && !device.macAddress) {
      device.macAddress = macAddress;
    }
    await this.deviceConfigRepository.save(device);

    // Update gate online status if assigned
    if (device.gate) {
      device.gate.isOnline = true;
      device.gate.lastHeartbeatAt = new Date();
      await this.gateRepository.save(device.gate);
    }
  }

  /**
   * Validate RFID credential against vehicles and RFID cards
   */
  private async validateRfidCredential(
    tenantId: string,
    rfidUid: string,
    gate: Gate,
    handleType?: string,
  ): Promise<ValidationResult> {
    const normalizedUid = rfidUid.toUpperCase().replace(/:/g, '');

    // A UID can identify a vehicle (via the intrinsic vehicles.rfid_uid tag OR an
    // rfid_cards row linked to a vehicle) or a person (an rfid_cards row linked to
    // a user). `handleType` is the button hint from the simulator; a real reader
    // passes neither, so we then search everything. Card UIDs are unique per
    // tenant and registration forbids a card UID colliding with a vehicle tag, so
    // the resolution below is unambiguous.
    const wantVehicle = handleType === 'vehicle';
    const wantHuman = handleType === 'human';
    const searchAll = !wantVehicle && !wantHuman;

    // 1. Intrinsic vehicle tag (the manual "Car Verify" / rfid_uid path).
    if (wantVehicle || searchAll) {
      const vehicle = await this.vehicleRepository.findOne({
        where: {
          tenantId,
          rfidUid: normalizedUid,
          status: VehicleStatus.ACTIVE,
        },
        relations: ['owner'],
      });

      if (vehicle) {
        return this.validateVehicleAccess(vehicle, normalizedUid);
      }
    }

    // 2. A scannable RFID card — belongs to a vehicle OR a person.
    const rfidCard = await this.rfidCardRepository.findOne({
      where: {
        tenantId,
        uid: normalizedUid,
        status: RfidCardStatus.ACTIVE,
      },
      relations: ['user', 'vehicle', 'vehicle.owner'],
    });

    if (rfidCard) {
      if (rfidCard.vehicleId && rfidCard.vehicle && (wantVehicle || searchAll)) {
        return this.validateVehicleCardAccess(rfidCard, normalizedUid);
      }
      if (rfidCard.userId && rfidCard.user && (wantHuman || searchAll)) {
        return this.validateRfidCardAccess(rfidCard, normalizedUid);
      }
    }

    // No matching credential found
    return {
      allowed: false,
      name: 'Unknown',
      info: 'Card not registered',
      subjectType: 'unknown',
      subjectIdentifier: normalizedUid,
      denialReason: 'Unregistered card',
    };
  }

  private validateVehicleAccess(vehicle: Vehicle, rfidUid: string): ValidationResult {
    const now = new Date();
    const ownerName = `${vehicle.owner.firstName} ${vehicle.owner.lastName}`;

    // Check validity period
    if (vehicle.validFrom && vehicle.validFrom > now) {
      return {
        allowed: false,
        name: ownerName,
        info: vehicle.licensePlate,
        subjectType: 'vehicle',
        subjectId: vehicle.id,
        subjectIdentifier: rfidUid,
        residentId: vehicle.ownerId,
        denialReason: 'Not yet valid',
      };
    }

    if (vehicle.validUntil && vehicle.validUntil < now) {
      return {
        allowed: false,
        name: ownerName,
        info: vehicle.licensePlate,
        subjectType: 'vehicle',
        subjectId: vehicle.id,
        subjectIdentifier: rfidUid,
        residentId: vehicle.ownerId,
        denialReason: 'Access expired',
      };
    }

    // Access granted
    return {
      allowed: true,
      name: ownerName,
      info: vehicle.licensePlate,
      subjectType: 'vehicle',
      subjectId: vehicle.id,
      subjectIdentifier: rfidUid,
      residentId: vehicle.ownerId,
    };
  }

  /**
   * A card linked to a vehicle grants VEHICLE access. The credential is the card,
   * so its own validity window is checked; the subject reported is the vehicle
   * (and its owner), identical to an intrinsic-tag scan so downstream logging and
   * UI treat both the same way.
   */
  private validateVehicleCardAccess(rfidCard: RfidCard, rfidUid: string): ValidationResult {
    const now = new Date();
    const vehicle = rfidCard.vehicle;
    const ownerName = vehicle.owner
      ? `${vehicle.owner.firstName} ${vehicle.owner.lastName}`
      : 'Vehicle';

    const base = {
      name: ownerName,
      info: vehicle.licensePlate,
      subjectType: 'vehicle' as const,
      subjectId: vehicle.id,
      subjectIdentifier: rfidUid,
      residentId: vehicle.ownerId,
    };

    if (vehicle.status !== VehicleStatus.ACTIVE) {
      return { ...base, allowed: false, denialReason: 'Vehicle inactive' };
    }
    if (rfidCard.validFrom && rfidCard.validFrom > now) {
      return { ...base, allowed: false, denialReason: 'Not yet valid' };
    }
    if (rfidCard.validUntil && rfidCard.validUntil < now) {
      return { ...base, allowed: false, denialReason: 'Card expired' };
    }
    return { ...base, allowed: true };
  }

  private validateRfidCardAccess(rfidCard: RfidCard, rfidUid: string): ValidationResult {
    const now = new Date();
    const userName = `${rfidCard.user.firstName} ${rfidCard.user.lastName}`;

    // Check validity period
    if (rfidCard.validFrom && rfidCard.validFrom > now) {
      return {
        allowed: false,
        name: userName,
        info: 'Access Card',
        subjectType: 'rfid_card',
        subjectId: rfidCard.id,
        subjectIdentifier: rfidUid,
        residentId: rfidCard.userId,
        denialReason: 'Not yet valid',
      };
    }

    if (rfidCard.validUntil && rfidCard.validUntil < now) {
      return {
        allowed: false,
        name: userName,
        info: 'Access Card',
        subjectType: 'rfid_card',
        subjectId: rfidCard.id,
        subjectIdentifier: rfidUid,
        residentId: rfidCard.userId,
        denialReason: 'Card expired',
      };
    }

    // Access granted
    return {
      allowed: true,
      name: userName,
      info: 'Welcome',
      subjectType: 'rfid_card',
      subjectId: rfidCard.id,
      subjectIdentifier: rfidUid,
      residentId: rfidCard.userId,
    };
  }

  /**
   * Validate QR code against user QR codes and visitor passes
   */
  private async validateQrCode(
    tenantId: string,
    qrToken: string,
    gate: Gate,
  ): Promise<ValidationResult> {
    // Check if it's a user QR code (starts with "GR-")
    if (qrToken.startsWith('GR-')) {
      const user = await this.userRepository.findOne({
        where: { qrCode: qrToken },
      });

      if (!user) {
        return {
          allowed: false,
          name: 'Unknown',
          info: 'Invalid user QR code',
          subjectType: 'user',
          subjectIdentifier: qrToken,
          denialReason: 'Invalid user QR code',
        };
      }

      // Check if user belongs to the same tenant as the gate
      if (user.tenantId !== tenantId) {
        return {
          allowed: false,
          name: `${user.firstName} ${user.lastName}`,
          info: 'Access denied - wrong building',
          subjectType: 'user',
          subjectId: user.id,
          subjectIdentifier: qrToken,
          residentId: user.id,
          denialReason: 'User does not belong to this building',
        };
      }

      // Check user status
      if (user.status !== UserStatus.ACTIVE) {
        return {
          allowed: false,
          name: `${user.firstName} ${user.lastName}`,
          info: `Account ${user.status}`,
          subjectType: 'user',
          subjectId: user.id,
          subjectIdentifier: qrToken,
          residentId: user.id,
          denialReason: `User account is ${user.status}`,
        };
      }

      // User QR code is valid
      return {
        allowed: true,
        name: `${user.firstName} ${user.lastName}`,
        info: user.unit ? `Unit ${user.unit}` : 'Welcome',
        subjectType: 'user',
        subjectId: user.id,
        subjectIdentifier: qrToken,
        residentId: user.id,
      };
    }

    // Not a user QR code - check visitor passes
    const visitorPass = await this.visitorPassRepository.findOne({
      where: {
        tenantId,
        qrToken,
      },
      relations: ['createdBy'],
    });

    if (!visitorPass) {
      return {
        allowed: false,
        name: 'Unknown',
        info: 'Invalid QR code',
        subjectType: 'visitor_pass',
        subjectIdentifier: qrToken,
        denialReason: 'Invalid QR code',
      };
    }

    const now = new Date();

    // Check status
    if (visitorPass.status === VisitorPassStatus.CANCELLED) {
      return {
        allowed: false,
        name: visitorPass.visitorName,
        info: 'Pass cancelled',
        subjectType: 'visitor_pass',
        subjectId: visitorPass.id,
        subjectIdentifier: qrToken,
        residentId: visitorPass.createdById,
        denialReason: 'Pass cancelled',
      };
    }

    if (visitorPass.status === VisitorPassStatus.EXPIRED) {
      return {
        allowed: false,
        name: visitorPass.visitorName,
        info: 'Pass expired',
        subjectType: 'visitor_pass',
        subjectId: visitorPass.id,
        subjectIdentifier: qrToken,
        residentId: visitorPass.createdById,
        denialReason: 'Pass expired',
      };
    }

    // Check validity period
    if (visitorPass.validFrom > now) {
      return {
        allowed: false,
        name: visitorPass.visitorName,
        info: 'Not yet valid',
        subjectType: 'visitor_pass',
        subjectId: visitorPass.id,
        subjectIdentifier: qrToken,
        residentId: visitorPass.createdById,
        denialReason: 'Pass not yet valid',
      };
    }

    if (visitorPass.validUntil < now) {
      // Mark as expired
      visitorPass.status = VisitorPassStatus.EXPIRED;
      await this.visitorPassRepository.save(visitorPass);

      return {
        allowed: false,
        name: visitorPass.visitorName,
        info: 'Pass expired',
        subjectType: 'visitor_pass',
        subjectId: visitorPass.id,
        subjectIdentifier: qrToken,
        residentId: visitorPass.createdById,
        denialReason: 'Pass expired',
      };
    }

    // Check max uses
    if (visitorPass.useCount >= visitorPass.maxUses) {
      visitorPass.status = VisitorPassStatus.USED;
      await this.visitorPassRepository.save(visitorPass);

      return {
        allowed: false,
        name: visitorPass.visitorName,
        info: 'Max uses reached',
        subjectType: 'visitor_pass',
        subjectId: visitorPass.id,
        subjectIdentifier: qrToken,
        residentId: visitorPass.createdById,
        denialReason: 'Pass already used',
      };
    }

    // Access granted - increment use count
    visitorPass.useCount += 1;
    if (visitorPass.useCount >= visitorPass.maxUses) {
      visitorPass.status = VisitorPassStatus.USED;
    } else {
      visitorPass.status = VisitorPassStatus.ACTIVE;
    }
    await this.visitorPassRepository.save(visitorPass);

    return {
      allowed: true,
      name: visitorPass.visitorName,
      info: `Visitor - ${visitorPass.purpose || 'Welcome'}`,
      subjectType: 'visitor_pass',
      subjectId: visitorPass.id,
      subjectIdentifier: qrToken,
      residentId: visitorPass.createdById,
    };
  }

  /**
   * Validate password/PIN (placeholder - implement based on requirements)
   */
  private async validatePassword(
    tenantId: string,
    password: string,
    gate: Gate,
  ): Promise<ValidationResult> {
    // TODO: Implement password/PIN validation logic
    // Could check against resident PINs, master codes, etc.
    return {
      allowed: false,
      name: 'Unknown',
      info: 'PIN access not configured',
      subjectType: 'unknown',
      subjectIdentifier: '***',
      denialReason: 'PIN access not enabled',
    };
  }

  /**
   * Validate face ID (placeholder - implement based on requirements)
   */
  private async validateFaceId(
    tenantId: string,
    faceId: string,
    gate: Gate,
  ): Promise<ValidationResult> {
    // TODO: Implement face ID validation logic
    // Could map face IDs to residents
    return {
      allowed: false,
      name: 'Unknown',
      info: 'Face recognition not configured',
      subjectType: 'unknown',
      subjectIdentifier: faceId,
      denialReason: 'Face recognition not enabled',
    };
  }

  /**
   * Decode Base64 QR code data
   */
  private decodeBase64Qr(encodedData: string): string {
    try {
      // Handle URL-safe base64 variants
      let normalized = encodedData.replace(/ /g, '+').replace(/-/g, '+').replace(/_/g, '/');

      // Add padding if needed
      const remainder = normalized.length % 4;
      if (remainder === 2) normalized += '==';
      if (remainder === 3) normalized += '=';

      return Buffer.from(normalized, 'base64').toString('utf-8');
    } catch (error) {
      const err = error as Error;
      this.logger.warn(`Failed to decode Base64 QR: ${err.message}`);
      return encodedData; // Return as-is if decoding fails
    }
  }

  /**
   * Map credential type to access method
   */
  private getAccessMethod(credentialType: number): AccessMethod {
    switch (credentialType) {
      case CloudPlusCredentialType.CARD:
      case CloudPlusCredentialType.RFID_TAG:
        return AccessMethod.CAR_RFID; // Will be differentiated by subject type
      case CloudPlusCredentialType.QR_BASE64:
      case CloudPlusCredentialType.RS232:
        return AccessMethod.QR;
      case CloudPlusCredentialType.BUTTON:
        return AccessMethod.MANUAL;
      default:
        return AccessMethod.MANUAL;
    }
  }

  /**
   * Log access event to database
   */
  private async logAccessEvent(
    gate: Gate,
    result: ValidationResult,
    method: AccessMethod,
  ): Promise<AccessEvent> {
    const subjectTypeMap: Record<string, AccessSubjectType> = {
      vehicle: AccessSubjectType.VEHICLE,
      rfid_card: AccessSubjectType.RFID_CARD,
      visitor_pass: AccessSubjectType.VISITOR_PASS,
      user: AccessSubjectType.USER,
      unknown: AccessSubjectType.UNKNOWN,
    };

    const accessEvent = this.accessEventRepository.create({
      tenantId: gate.tenantId,
      gateId: gate.id,
      timestamp: new Date(),
      method:
        result.subjectType === 'vehicle'
          ? AccessMethod.CAR_RFID
          : result.subjectType === 'rfid_card'
            ? AccessMethod.HUMAN_RFID
            : method,
      subjectType: subjectTypeMap[result.subjectType] || AccessSubjectType.UNKNOWN,
      subjectId: result.subjectId,
      subjectIdentifier: result.subjectIdentifier,
      subjectName: result.name,
      residentId: result.residentId,
      result: result.allowed ? AccessResult.ALLOWED : AccessResult.DENIED,
      denialReason: result.denialReason,
      metadata: {
        source: 'cloud-plus-typeB',
        info: result.info,
      },
    });

    return this.accessEventRepository.save(accessEvent);
  }

  /**
   * Notify frontend via WebSocket
   *
   * Emits `access:event` (matching the simulator/frontend contract) so the
   * live feed updates. Also emits the legacy `access:granted`/`access:denied`
   * for any older clients still listening to those names.
   */
  private notifyFrontend(
    gate: Gate,
    result: ValidationResult,
    event: AccessEvent,
  ): void {
    const payload = {
      eventId: event.id,
      gateId: gate.id,
      gateName: gate.name,
      timestamp: event.timestamp.toISOString(),
      method: event.method,
      subjectType: event.subjectType,
      subjectName: result.name,
      result: result.allowed ? 'granted' : 'denied',
      denialReason: result.denialReason,
      info: result.info,
      source: 'cloud-plus',
    };

    this.gatewayService.broadcastToTenant(gate.tenantId, 'access:event', payload);
  }

  /**
   * Build deny response DTO
   */
  private buildDenyResponse(
    card: string,
    reader: number,
    credType: number,
    name: string,
    reason: string,
    timestamp: string,
  ): SearchCardAcsResponseDto {
    const typeName = this.getCredentialTypeName(credType);

    return {
      AcsRes: CloudPlusAuthResult.DENY,
      ActIndex: String(reader & 0x01),
      Time: '1',
      Card: card,
      Name: name,
      Note: `${typeName} - ${reason}`,
      Systime: timestamp,
      Voice: 'Access Denied',
      LCD: '7', // LCD page 7 = deny/invalid
      LCDTime: '5', // Show for 5 seconds
    };
  }

  /**
   * Build allow/deny response DTO based on validation result
   */
  private buildAllowDenyResponse(
    result: ValidationResult,
    card: string,
    reader: number,
    credType: number,
    timestamp: string,
  ): SearchCardAcsResponseDto {
    const typeName = this.getCredentialTypeName(credType);

    return {
      AcsRes: result.allowed ? CloudPlusAuthResult.ALLOW : CloudPlusAuthResult.DENY,
      ActIndex: String(reader & 0x01),
      Time: '1',
      Card: card,
      Name: result.name,
      Note: `${typeName} - ${result.allowed ? 'Access Granted' : result.denialReason || 'Access Denied'}`,
      Systime: timestamp,
      Voice: result.allowed ? `Welcome ${result.name}` : 'Access Denied',
      LCD: result.allowed ? '6' : '7', // LCD page 6 = pass, 7 = deny
      LCDTime: '5', // Show for 5 seconds
    };
  }

  /**
   * Get credential type name
   */
  private getCredentialTypeName(credType: number): string {
    const credentialTypeNames: Record<number, string> = {
      [CloudPlusCredentialType.CARD]: 'Card',
      [CloudPlusCredentialType.RS232]: 'Barcode',
      [CloudPlusCredentialType.PASSWORD]: 'PIN',
      [CloudPlusCredentialType.BUTTON]: 'Button',
      [CloudPlusCredentialType.QR_BASE64]: 'QR Code',
      [CloudPlusCredentialType.RFID_TAG]: 'RFID',
      [CloudPlusCredentialType.FACE]: 'Face',
      [CloudPlusCredentialType.FINGERPRINT]: 'Fingerprint',
    };
    return credentialTypeNames[credType & 0xff] || 'Unknown';
  }

  /**
   * Format timestamp for response
   */
  private formatTimestamp(date: Date): string {
    return date.toISOString().replace('T', ' ').substring(0, 19);
  }

  /**
   * Verify device API key (for authenticated requests)
   */
  async verifyDeviceApiKey(serial: string, apiKey: string): Promise<boolean> {
    const device = await this.findDeviceBySerial(serial);
    if (!device || !device.apiKeyHash) {
      return false;
    }

    const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
    return device.apiKeyHash === apiKeyHash;
  }
}
