import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Req,
  Res,
  UseGuards,
  Logger,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { CloudPlusService } from './cloud-plus.service';
import {
  SearchCardAcsRequestDto,
  SearchCardAcsResponseDto,
  GetStatusRequestDto,
  GetStatusResponseDto,
  RegisterCloudPlusDeviceDto,
} from './dto/cloud-plus.dto';
import { Public } from '@common/decorators/public.decorator';
import { JwtAuthGuard } from '@common/guards/jwt-auth.guard';
import { CloudPlusDeviceGuard } from './guards/cloud-plus-device.guard';

/**
 * Cloud Plus TypeB Controller
 *
 * Handles HTTP communication with Cloud Plus gate controllers.
 * Routes:
 * - /SearchCardAcs - Card/credential validation (public, called by controller)
 * - /GetStatus     - Heartbeat (public, called by controller)
 * - /cloud-plus/*  - Admin routes for device management (protected)
 */
@Controller()
export class CloudPlusController {
  private readonly logger = new Logger(CloudPlusController.name);

  constructor(private readonly cloudPlusService: CloudPlusService) {}

  // ==================== Public Routes (Called by Cloud Plus Controller) ====================

  /**
   * Card validation endpoint - GET method
   * Called by Cloud Plus controller when a card/credential is scanned
   *
   * URL format: /SearchCardAcs?Reader=0&Card=XXXX&Serial=YYYY&type=12
   */
  @Public()
  @Get('SearchCardAcs')
  async searchCardAcsGet(
    @Query() query: SearchCardAcsRequestDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
     //on live test
    console.log("On live test, get query:");

    this.logger.log(`GET SearchCardAcs gddss from ${req.ip}`);

    const clientIp = this.getClientIp(req);
    const result = await this.cloudPlusService.processSearchCardAcs(query, clientIp);

    this.sendResponse(res, result);
  }

  /**
   * Card validation endpoint - POST method
   * Some Cloud Plus controllers send POST with JSON body
   */
  @Public()
  @Post('SearchCardAcs')
  async searchCardAcsPost(
    @Body() body: SearchCardAcsRequestDto,
    @Query() query: SearchCardAcsRequestDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {

    //on live test
    console.log("On live test, body:", body);


    this.logger.log(`POST SearchCardAcs from ${req.ip}`);

    // Merge query params and body (body takes precedence)
    const data = { ...query, ...body };
    const clientIp = this.getClientIp(req);
    const result = await this.cloudPlusService.processSearchCardAcs(data, clientIp);

    this.sendResponse(res, result);
  }

  /**
   * Heartbeat endpoint - GET method
   * Called periodically by Cloud Plus controller to indicate it's online
   *
   * URL format: /GetStatus?Key=SERIAL_NUMBER
   */
  @Public()
  @Get('GetStatus')
  async getStatusGet(
    @Query() query: GetStatusRequestDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    this.logger.debug(`GET GetStatus from ${req.ip}: Key=${query.Key}`);

    const clientIp = this.getClientIp(req);
    const result = await this.cloudPlusService.processGetStatus(query, clientIp);

    this.sendResponse(res, result);
  }

  /**
   * Heartbeat endpoint - POST method
   */
  @Public()
  @Post('GetStatus')
  async getStatusPost(
    @Body() body: GetStatusRequestDto,
    @Query() query: GetStatusRequestDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    this.logger.debug(`POST GetStatus from ${req.ip}`);

    const data = { ...query, ...body };
    const clientIp = this.getClientIp(req);
    const result = await this.cloudPlusService.processGetStatus(data, clientIp);

    this.sendResponse(res, result);
  }

  // ==================== Protected Admin Routes ====================

  /**
   * Register a new Cloud Plus controller device
   * This endpoint is protected and requires admin authentication
   */
  @UseGuards(JwtAuthGuard)
  @Post('cloud-plus/devices')
  async registerDevice(
    @Body() dto: RegisterCloudPlusDeviceDto,
    @Req() req: Request,
  ): Promise<{ message: string; device: any }> {
    const user = req['user'] as { tenantId?: string } | undefined;

    if (!user?.tenantId) {
      return { message: 'User must belong to a tenant', device: null };
    }

    const device = await this.cloudPlusService.registerDevice(dto, user.tenantId);

    return {
      message: 'Device registered successfully',
      device: {
        id: device.id,
        serial: device.deviceId,
        name: device.deviceName,
        gateId: device.gateId,
        status: device.status,
      },
    };
  }

  /**
   * Get all Cloud Plus devices for the tenant
   */
  @UseGuards(JwtAuthGuard)
  @Get('cloud-plus/devices')
  async getDevices(@Req() req: Request): Promise<{ devices: any[] }> {
    const user = req['user'] as { tenantId?: string } | undefined;

    if (!user?.tenantId) {
      return { devices: [] };
    }

    const devices = await this.cloudPlusService.getDevices(user.tenantId);

    return {
      devices: devices.map((d) => ({
        id: d.id,
        serial: d.deviceId,
        name: d.deviceName,
        gateId: d.gateId,
        gateName: d.gate?.name,
        status: d.status,
        lastSeenAt: d.lastSeenAt,
        ipAddress: d.ipAddress,
      })),
    };
  }

  // ==================== Helper Methods ====================

  /**
   * Send JSON response with proper content type
   */
  private sendResponse(res: Response, data: any): void {
    res.status(HttpStatus.OK).contentType('application/json').send(JSON.stringify(data));
  }

  /**
   * Extract client IP from request (handles proxies)
   */
  private getClientIp(req: Request): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const ips = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0];
      return ips.trim();
    }
    return req.ip || req.socket.remoteAddress || 'unknown';
  }
}
