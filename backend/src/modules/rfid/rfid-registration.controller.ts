import {
  Controller,
  Post,
  Get,
  Body,
  HttpCode,
  HttpStatus,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsUUID, IsIn } from 'class-validator';
import { RfidRegistrationService } from './rfid-registration.service';

class StartRegistrationDto {
  @IsIn(['vehicle', 'resident'])
  targetType: 'vehicle' | 'resident';

  @IsUUID()
  targetId: string;

  @IsUUID()
  tenantId: string;
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
}

@ApiTags('RFID')
@ApiBearerAuth()
@Controller('rfid/registration')
export class RfidRegistrationController {
  private readonly logger = new Logger(RfidRegistrationController.name);

  constructor(private rfidRegistrationService: RfidRegistrationService) {}

  @Post('start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start RFID card registration session' })
  startRegistration(@Body() dto: StartRegistrationDto) {
    this.logger.log(`=== START REGISTRATION REQUEST ===`);
    this.logger.log(`Target Type: ${dto.targetType}`);
    this.logger.log(`Target ID: ${dto.targetId}`);
    this.logger.log(`Tenant ID: ${dto.tenantId}`);

    const { sessionId, expiresAt } = this.rfidRegistrationService.startSession(
      dto.targetType,
      dto.targetId,
      dto.tenantId,
    );

    this.logger.log(`Session created: ${sessionId}`);

    return {
      sessionId,
      expiresAt: expiresAt.toISOString(),
      message: 'Registration session started. Please scan the RFID card.',
    };
  }

  @Post('cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel RFID card registration session' })
  cancelRegistration(@Body() dto: CancelRegistrationDto) {
    const success = this.rfidRegistrationService.cancelSession(dto.sessionId);

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
  async submitScan(@Body() dto: SubmitScanDto) {
    this.logger.log(`Manual scan submission for session ${dto.sessionId}: ${dto.uid}`);
    try {
      const result = await this.rfidRegistrationService.submitManualScan(dto.sessionId, dto.uid);
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
  getStatus() {
    return {
      hasActiveSessions: this.rfidRegistrationService.getActiveSessionsDebug(),
    };
  }
}
