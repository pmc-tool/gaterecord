import {
  Controller,
  Post,
  Get,
  Body,
  HttpCode,
  HttpStatus,
  BadRequestException,
  Logger,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsUUID, IsIn, IsOptional, IsBoolean, IsInt } from 'class-validator';
import { RegistrationActor, RfidRegistrationService } from './rfid-registration.service';
import { JwtAuthGuard } from '@common/guards/jwt-auth.guard';
import { RolesGuard } from '@common/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { assertBuildingContext, isPlatformContext } from '@common/context/assert-building-context';
import { MembershipErrorCode } from '@common/context/membership-context.errors';
import { User, UserRole } from '@database/entities/user.entity';

class StartRegistrationDto {
  // 'vehicle' sets the vehicle's primary tag; 'vehicle-card' adds an extra
  // scannable card to a vehicle; 'resident' adds a card to a person.
  @IsIn(['vehicle', 'vehicle-card', 'resident'])
  targetType: 'vehicle' | 'vehicle-card' | 'resident';

  @IsUUID()
  targetId: string;

  // Required for a super admin in the Platform context and ignored for everyone
  // else, who registers in the building they act in (see startRegistration).
  @IsOptional()
  @IsUUID()
  tenantId?: string;

  // ── Optional reader scope ────────────────────────────────────────────────
  // Pins the session to one physical reader so ONLY a tap there completes it.
  // Omitted by the phone-NFC and typed-UID flows, which stay tenant-wide.
  @IsOptional()
  @IsUUID()
  gateId?: string;

  /** DeviceConfig.id (uuid PK), not the controller serial. */
  @IsOptional()
  @IsUUID()
  deviceId?: string;

  /** Cloud Plus reader channel: 0 = Reader A, 1 = Reader B. */
  @IsOptional()
  @IsInt()
  @IsIn([0, 1])
  readerChannel?: number;
}

class CancelRegistrationDto {
  @IsString()
  sessionId: string;
}

class SubmitScanDto {
  @IsString()
  sessionId: string;

  @IsString()
  uid: string;

  // true = a UID typed by an admin — store verbatim (no phone byte-reversal).
  @IsOptional()
  @IsBoolean()
  raw?: boolean;
}

/**
 * The actor of a registration request: the building the request acts in
 * (assertBuildingContext: 409 MEMBERSHIP_REQUIRED without one), or null for a
 * super admin in the Platform context.
 */
function registrationActorOf(user: User): RegistrationActor {
  return {
    userId: user.id,
    tenantId: isPlatformContext(user) ? null : assertBuildingContext(user),
  };
}

/**
 * RFID registration binds a physical card UID to a resident or vehicle, so it is
 * tenant-scoped and admin-only. Previously it had no guard and trusted the
 * tenantId in the request body — any authenticated user could register a card
 * for any target in any building.
 *
 * GATE-5: every route is bound to the building the request ACTS in (its
 * membership context). A session is started in that building (a super admin in
 * the Platform context must name one with tenantId), and cancel / scan / status
 * only see sessions of that building: a session started while acting in
 * Tower C cannot be scanned or cancelled from a Tower B context. Hardware taps
 * are unaffected; they complete the session of the device's building.
 */
@ApiTags('RFID')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
@Controller('rfid/registration')
export class RfidRegistrationController {
  private readonly logger = new Logger(RfidRegistrationController.name);

  constructor(private rfidRegistrationService: RfidRegistrationService) {}

  @Post('start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start RFID card registration session' })
  async startRegistration(@CurrentUser() user: User, @Body() dto: StartRegistrationDto) {
    // The building comes from the caller's context, never the body — except for
    // a platform super admin, who has no building and must name one.
    const actor = registrationActorOf(user);
    const tenantId = actor.tenantId ?? dto.tenantId;
    if (!tenantId) {
      throw new BadRequestException({
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'Bad Request',
        code: MembershipErrorCode.TENANT_REQUIRED,
        message: 'Choose the building (tenantId) to register the card in.',
      });
    }

    this.logger.log(`=== START REGISTRATION REQUEST ===`);
    this.logger.log(`Target Type: ${dto.targetType}`);
    this.logger.log(`Target ID: ${dto.targetId}`);

    let session: { sessionId: string; expiresAt: Date };
    try {
      session = await this.rfidRegistrationService.startSession(
        dto.targetType,
        dto.targetId,
        tenantId,
        { gateId: dto.gateId, deviceId: dto.deviceId, readerChannel: dto.readerChannel },
        user.id,
      );
    } catch (error) {
      // A bad reader scope is a client mistake, not a server fault.
      const msg = error instanceof Error ? error.message : 'Failed to start registration';
      throw new BadRequestException(msg);
    }

    this.logger.log(`Session created: ${session.sessionId}`);

    return {
      sessionId: session.sessionId,
      expiresAt: session.expiresAt.toISOString(),
      message: 'Registration session started. Please scan the RFID card.',
    };
  }

  @Post('cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel RFID card registration session' })
  cancelRegistration(@CurrentUser() user: User, @Body() dto: CancelRegistrationDto) {
    const success = this.rfidRegistrationService.cancelSession(
      dto.sessionId,
      registrationActorOf(user),
    );

    if (!success) {
      throw new BadRequestException('Registration session not found or already expired');
    }

    return {
      message: 'Registration session cancelled',
    };
  }

  @Post('scan')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Submit an RFID UID scanned via phone NFC' })
  async submitScan(@CurrentUser() user: User, @Body() dto: SubmitScanDto) {
    // Resolved outside the try below: a missing context is a 409, not a 400.
    const actor = registrationActorOf(user);
    this.logger.log(`Manual scan submission for session ${dto.sessionId}: ${dto.uid}`);
    try {
      const result = await this.rfidRegistrationService.submitManualScan(
        dto.sessionId,
        dto.uid,
        dto.raw ?? false,
        actor,
      );
      return {
        message: 'Card registered successfully',
        targetType: result.targetType,
        uid: result.uid,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Failed to register card';
      throw new BadRequestException(msg);
    }
  }

  @Get('status')
  @ApiOperation({ summary: 'Get registration session status (debug)' })
  getStatus(@CurrentUser() user: User) {
    return {
      hasActiveSessions: this.rfidRegistrationService.getActiveSessionsDebug(
        registrationActorOf(user),
      ),
    };
  }
}
