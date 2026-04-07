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
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { IsString, IsOptional, IsUUID } from 'class-validator';
import { SecurityAlertService } from './security-alert.service';
import { JwtAuthGuard } from '@common/guards/jwt-auth.guard';
import { RolesGuard } from '@common/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { Public } from '@common/decorators/public.decorator';
import { User, UserRole } from '@database/entities/user.entity';
import { SecurityAlertStatus } from '@database/entities/security-alert.entity';

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
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN, UserRole.SECURITY)
  @ApiOperation({ summary: 'Get all security alerts' })
  async findAll(@Query('status') status: SecurityAlertStatus, @Req() req: RequestWithUser) {
    return this.securityAlertService.findAll(req.user, status);
  }

  @Get('active')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN, UserRole.SECURITY)
  @ApiOperation({ summary: 'Get active security alerts' })
  async findActive(@Req() req: RequestWithUser) {
    return this.securityAlertService.findActive(req.user);
  }

  @Get('stats')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN, UserRole.SECURITY)
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
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN, UserRole.SECURITY)
  @ApiOperation({ summary: 'Mark alert as false alarm' })
  async markFalseAlarm(
    @Param('id') id: string,
    @Body() dto: ResolveAlertDto,
    @Req() req: RequestWithUser,
  ) {
    return this.securityAlertService.markFalseAlarm(id, req.user, dto.notes);
  }
}
