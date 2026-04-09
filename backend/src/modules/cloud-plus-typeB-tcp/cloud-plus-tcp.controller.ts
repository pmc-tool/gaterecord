/**
 * Cloud Plus TypeB TCP Controller
 * REST API endpoints for gate control via TCP
 */

import { Controller, Post, Get, Body, Param, UseGuards, Request } from '@nestjs/common';
import { JwtAuthGuard } from '@common/guards/jwt-auth.guard';
import { RolesGuard } from '@common/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { UserRole } from '@database/entities/user.entity';
import { CloudPlusTcpService } from './cloud-plus-tcp.service';
import {
  DoorSelectDto,
  GateControlDto,
  OpenGateWithInfoDto,
  SetAlarmDto,
  SetFireDto,
  GateAction,
} from './dto';

@Controller('gates')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CloudPlusTcpController {
  constructor(private tcpService: CloudPlusTcpService) {}

  /**
   * Open gate via TCP
   * POST /api/v1/gates/:gateId/tcp/open
   */
  @Post(':gateId/tcp/open')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN, UserRole.SECURITY)
  async openGate(@Param('gateId') gateId: string, @Body() dto: DoorSelectDto, @Request() req: any) {
    return this.tcpService.openGate(gateId, req.user, dto.door, dto.deviceId);
  }

  /**
   * Close gate via TCP
   * POST /api/v1/gates/:gateId/tcp/close
   */
  @Post(':gateId/tcp/close')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN, UserRole.SECURITY)
  async closeGate(
    @Param('gateId') gateId: string,
    @Body() dto: DoorSelectDto,
    @Request() req: any,
  ) {
    return this.tcpService.closeGate(gateId, req.user, dto.door, dto.deviceId);
  }

  /**
   * Control gate (generic action)
   * POST /api/v1/gates/:gateId/tcp/control
   */
  @Post(':gateId/tcp/control')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN, UserRole.SECURITY)
  async controlGate(
    @Param('gateId') gateId: string,
    @Body() dto: GateControlDto,
    @Request() req: any,
  ) {
    return this.tcpService.controlGate(gateId, dto.action, req.user, dto.door, dto.deviceId);
  }

  /**
   * Open gate with LCD display info
   * POST /api/v1/gates/:gateId/tcp/open-with-info
   */
  @Post(':gateId/tcp/open-with-info')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN, UserRole.SECURITY)
  async openGateWithInfo(
    @Param('gateId') gateId: string,
    @Body() dto: OpenGateWithInfoDto,
    @Request() req: any,
  ) {
    return this.tcpService.openGateWithInfo(gateId, dto, req.user);
  }

  /**
   * Set alarm state
   * POST /api/v1/gates/:gateId/tcp/alarm
   */
  @Post(':gateId/tcp/alarm')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  async setAlarm(@Param('gateId') gateId: string, @Body() dto: SetAlarmDto, @Request() req: any) {
    return this.tcpService.setAlarm(gateId, dto, req.user);
  }

  /**
   * Set fire/emergency mode (opens gate)
   * POST /api/v1/gates/:gateId/tcp/fire
   */
  @Post(':gateId/tcp/fire')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  async setFire(@Param('gateId') gateId: string, @Body() dto: SetFireDto, @Request() req: any) {
    return this.tcpService.setFire(gateId, dto, req.user);
  }

  /**
   * Sync controller time
   * POST /api/v1/gates/:gateId/tcp/sync-time
   */
  @Post(':gateId/tcp/sync-time')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  async syncTime(@Param('gateId') gateId: string, @Request() req: any) {
    return this.tcpService.syncTime(gateId, req.user);
  }

  /**
   * Restart controller
   * POST /api/v1/gates/:gateId/tcp/restart
   */
  @Post(':gateId/tcp/restart')
  @Roles(UserRole.SUPER_ADMIN)
  async restartController(@Param('gateId') gateId: string, @Request() req: any) {
    return this.tcpService.restartController(gateId, req.user);
  }

  /**
   * Check if gate is connected via TCP
   * GET /api/v1/gates/:gateId/tcp/connected
   */
  @Get(':gateId/tcp/connected')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN, UserRole.SECURITY)
  async isGateConnected(@Param('gateId') gateId: string) {
    const connected = await this.tcpService.isGateConnected(gateId);
    return { connected };
  }
}

/**
 * TCP Server Status Controller
 */
@Controller('tcp')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TcpServerController {
  constructor(private tcpService: CloudPlusTcpService) {}

  /**
   * Get TCP server status
   * GET /api/v1/tcp/status
   */
  @Get('status')
  @Roles(UserRole.SUPER_ADMIN)
  getServerStatus() {
    return this.tcpService.getServerStatus();
  }

  /**
   * Get connected controllers for current tenant
   * GET /api/v1/tcp/controllers
   */
  @Get('controllers')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  async getConnectedControllers(@Request() req: any) {
    if (req.user.role === UserRole.SUPER_ADMIN) {
      // Return all connected controllers
      return this.tcpService.getServerStatus().controllers;
    }
    // Return only tenant's controllers
    return this.tcpService.getConnectedControllersForTenant(req.user.tenantId);
  }
}
