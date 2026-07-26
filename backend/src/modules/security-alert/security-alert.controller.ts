import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  Req,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse, ApiBody } from '@nestjs/swagger';
import { IsString, IsOptional, IsUUID, IsEnum, IsBoolean, IsNumber } from 'class-validator';
import { SecurityAlertService } from './security-alert.service';
import { JwtAuthGuard } from '@common/guards/jwt-auth.guard';
import { RolesGuard } from '@common/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { Public } from '@common/decorators/public.decorator';
import { User, UserRole } from '@database/entities/user.entity';
import { SecurityAlertStatus, SecurityAlertType, SecurityAlertPriority } from '@database/entities/security-alert.entity';

interface RequestWithUser extends Request {
  user: User;
}

class ReportUnauthorizedDto {
  @IsUUID()
  accessEventId: string;

  @IsString()
  token: string;
}

class ResolveAlertDto {
  @IsOptional()
  @IsString()
  notes?: string;
}

class CreateTestAlertDto {
  @IsEnum(SecurityAlertType)
  type: SecurityAlertType;

  @IsString()
  title: string;

  @IsString()
  description: string;

  @IsOptional()
  @IsUUID()
  gateId?: string;

  @IsOptional()
  @IsUUID()
  deviceId?: string;

  @IsOptional()
  @IsEnum(SecurityAlertPriority)
  priority?: SecurityAlertPriority;

  @IsOptional()
  @IsBoolean()
  triggerBuzzer?: boolean;

  @IsOptional()
  @IsNumber()
  alarmDuration?: number;

  @IsOptional()
  @IsString()
  controllerSerial?: string;
}

class SecurityAlertQueryDto {
  @IsOptional()
  @IsEnum(SecurityAlertStatus)
  status?: SecurityAlertStatus;

  @IsOptional()
  @IsUUID()
  tenantId?: string;
}

@ApiTags('Security Alerts')
@Controller('security-alerts')
export class SecurityAlertController {
  private readonly logger = new Logger(SecurityAlertController.name);

  constructor(private readonly securityAlertService: SecurityAlertService) {}

  @Post('report-unauthorized')
  @Public()
  @ApiOperation({ summary: 'Report unauthorized visitor entry (public - called from email link)' })
  @ApiResponse({ status: 201, description: 'Alert created and security notified' })
  async reportUnauthorized(@Body() dto: ReportUnauthorizedDto) {
    this.logger.warn(`Unauthorized visitor reported for event ${dto.accessEventId}`);

    const alert = await this.securityAlertService.reportUnauthorizedVisitor(
      dto.accessEventId,
      dto.token,
    );

    return {
      success: true,
      message: 'Security has been alerted. An alarm has been triggered.',
      alertId: alert.id,
    };
  }

  @Get()
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  // Residents are allowed to READ — the service scopes them to their own alerts.
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN, UserRole.SECURITY, UserRole.RESIDENT)
  @ApiOperation({ summary: 'Get all security alerts' })
  async findAll(@Query() query: SecurityAlertQueryDto, @Req() req: RequestWithUser) {
    return this.securityAlertService.findAll(req.user, query.status, query.tenantId);
  }

  @Get('active')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN, UserRole.SECURITY, UserRole.RESIDENT)
  @ApiOperation({ summary: 'Get active security alerts' })
  async findActive(@Req() req: RequestWithUser) {
    return this.securityAlertService.findActive(req.user);
  }

  @Get('stats')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN, UserRole.SECURITY, UserRole.RESIDENT)
  @ApiOperation({ summary: 'Get security alert statistics' })
  async getStats(@Req() req: RequestWithUser) {
    return this.securityAlertService.getStats(req.user);
  }

  @Patch(':id/acknowledge')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN, UserRole.SECURITY)
  @ApiOperation({ summary: 'Acknowledge security alert (stops buzzer)' })
  async acknowledge(@Param('id') id: string, @Req() req: RequestWithUser) {
    return this.securityAlertService.acknowledge(id, req.user);
  }

  @Patch(':id/resolve')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN, UserRole.SECURITY)
  @ApiOperation({ summary: 'Resolve security alert' })
  async resolve(
    @Param('id') id: string,
    @Body() dto: ResolveAlertDto,
    @Req() req: RequestWithUser,
  ) {
    return this.securityAlertService.resolve(id, req.user, dto.notes);
  }

  @Patch(':id/false-alarm')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  // Residents may cancel their OWN report as a false alarm (ownership enforced in
  // the service). Acknowledge/resolve remain staff-only.
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN, UserRole.SECURITY, UserRole.RESIDENT)
  @ApiOperation({ summary: 'Mark alert as false alarm' })
  async markFalseAlarm(
    @Param('id') id: string,
    @Body() dto: ResolveAlertDto,
    @Req() req: RequestWithUser,
  ) {
    return this.securityAlertService.markFalseAlarm(id, req.user, dto.notes);
  }

  // ==================== Test Endpoints ====================

  @Post('test/create')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  @ApiOperation({ summary: 'Create a test security alert (for testing purposes)' })
  @ApiBody({ type: CreateTestAlertDto })
  @ApiResponse({ status: 201, description: 'Test alert created successfully' })
  async createTestAlert(
    @Body() dto: CreateTestAlertDto,
    @Req() req: RequestWithUser,
  ) {
    if (!req.user.tenantId) {
      throw new BadRequestException('User must belong to a tenant to create alerts');
    }

    this.logger.warn(`Creating test alert of type ${dto.type} by user ${req.user.email}`);

    const alert = await this.securityAlertService.create({
      tenantId: req.user.tenantId,
      type: dto.type,
      title: dto.title,
      description: dto.description,
      gateId: dto.gateId,
      deviceId: dto.deviceId,
      priority: dto.priority || SecurityAlertPriority.HIGH,
      triggerBuzzer: dto.triggerBuzzer || false,
      alarmDuration: dto.alarmDuration || 30,
      controllerSerial: dto.controllerSerial,
    });

    return {
      success: true,
      message: 'Test security alert created',
      alert: {
        id: alert.id,
        type: alert.type,
        title: alert.title,
        status: alert.status,
        priority: alert.priority,
        createdAt: alert.createdAt,
        hardwareAlarmSent: alert.hardwareAlarmSent,
      },
    };
  }

  @Post('test/simulate-denied-access')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  @ApiOperation({ summary: 'Simulate denied access events to trigger repeated denial detection' })
  @ApiResponse({ status: 201, description: 'Denied access simulated' })
  async simulateDeniedAccess(
    @Body() body: { gateId?: string; count?: number },
    @Req() req: RequestWithUser,
  ) {
    if (!req.user.tenantId) {
      throw new BadRequestException('User must belong to a tenant to simulate events');
    }

    const count = body.count || 3;
    
    this.logger.warn(`Simulating ${count} denied access events for tenant ${req.user.tenantId}`);

    // Create test alerts for repeated denied access
    const alert = await this.securityAlertService.create({
      tenantId: req.user.tenantId,
      type: SecurityAlertType.REPEATED_DENIED_ACCESS,
      title: `Simulated Repeated Denied Access (${count} attempts)`,
      description: `Test simulation of ${count} denied access attempts for testing purposes.`,
      gateId: body.gateId,
      priority: SecurityAlertPriority.HIGH,
      triggerBuzzer: true,
      alarmDuration: 10,
    });

    return {
      success: true,
      message: `Simulated ${count} denied access events`,
      alert: {
        id: alert.id,
        type: alert.type,
        status: alert.status,
      },
    };
  }

  @Get('test/types')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get all available security alert types for testing' })
  async getAlertTypes() {
    return {
      types: Object.values(SecurityAlertType),
      priorities: Object.values(SecurityAlertPriority),
      statuses: Object.values(SecurityAlertStatus),
    };
  }
}
