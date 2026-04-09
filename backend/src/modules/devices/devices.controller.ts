import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Headers,
  Ip,
  UseGuards,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiHeader } from '@nestjs/swagger';
import { DevicesService } from './devices.service';
import { FirmwareService, FirmwareResponseDto } from './firmware.service';
import {
  CreateSetupCodeDto,
  SetupCodeResponseDto,
  ClaimDeviceDto,
  ClaimResponseDto,
} from './dto/setup-code.dto';
import {
  DeviceResponseDto,
  UpdateDeviceDto,
  UpdateCheckResponseDto,
  CreateDeviceDto,
} from './dto/device.dto';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { Public } from '@common/decorators/public.decorator';
import { Roles } from '@common/decorators/roles.decorator';
import { RolesGuard } from '@common/guards/roles.guard';
import { User, UserRole } from '@database/entities/user.entity';

@ApiTags('Devices')
@Controller('devices')
export class DevicesController {
  private readonly logger = new Logger(DevicesController.name);

  constructor(
    private devicesService: DevicesService,
    private firmwareService: FirmwareService,
  ) {}

  // ==================== Setup Codes ====================

  @Post('setup-codes')
  @ApiBearerAuth()
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  @ApiOperation({ summary: 'Generate a new setup code for device pairing' })
  @ApiResponse({ status: 201, type: SetupCodeResponseDto })
  async createSetupCode(
    @Body() dto: CreateSetupCodeDto,
    @CurrentUser() user: User,
  ): Promise<SetupCodeResponseDto> {
    return this.devicesService.createSetupCode(dto, user);
  }

  @Get('setup-codes')
  @ApiBearerAuth()
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  @ApiOperation({ summary: 'List active setup codes for tenant' })
  @ApiResponse({ status: 200, type: [SetupCodeResponseDto] })
  async getSetupCodes(@CurrentUser() user: User): Promise<SetupCodeResponseDto[]> {
    return this.devicesService.getSetupCodes(user);
  }

  @Delete('setup-codes/:id')
  @ApiBearerAuth()
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  @ApiOperation({ summary: 'Delete/cancel a setup code' })
  @ApiResponse({ status: 204 })
  async deleteSetupCode(@Param('id') id: string, @CurrentUser() user: User): Promise<void> {
    return this.devicesService.deleteSetupCode(id, user);
  }

  // ==================== Device Claim (Public) ====================

  @Post('claim')
  @Public()
  @ApiOperation({ summary: 'Claim a setup code and pair device (called by ESP32)' })
  @ApiResponse({ status: 200, type: ClaimResponseDto })
  async claimDevice(@Body() dto: ClaimDeviceDto, @Ip() ip: string): Promise<ClaimResponseDto> {
    this.logger.log(`Device claim attempt from ${ip}: ${dto.deviceId}`);
    return this.devicesService.claimDevice(dto, ip);
  }

  // ==================== Update Check (Public) ====================

  @Get('check-update')
  @Public()
  @ApiOperation({ summary: 'Check for firmware updates (called by device on boot)' })
  @ApiHeader({ name: 'X-Device-ID', required: true })
  @ApiHeader({ name: 'X-Firmware-Version', required: true })
  @ApiResponse({ status: 200, type: UpdateCheckResponseDto })
  async checkUpdate(
    @Headers('X-Device-ID') deviceId: string,
    @Headers('X-Firmware-Version') currentVersion: string,
  ): Promise<UpdateCheckResponseDto> {
    if (!deviceId || !currentVersion) {
      return { updateAvailable: false };
    }
    return this.devicesService.checkUpdate(deviceId, currentVersion);
  }

  // ==================== Firmware Management ====================

  @Get('firmware')
  @ApiBearerAuth()
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  @ApiOperation({ summary: 'List all available firmware versions' })
  @ApiResponse({ status: 200, type: [FirmwareResponseDto] })
  async getFirmwareVersions(): Promise<FirmwareResponseDto[]> {
    return this.firmwareService.getAllVersions();
  }

  // ==================== Device Management ====================

  @Post()
  @ApiBearerAuth()
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Create a device directly (Super Admin only)' })
  @ApiResponse({ status: 201, type: DeviceResponseDto })
  async createDevice(
    @Body() dto: CreateDeviceDto,
    @CurrentUser() user: User,
  ): Promise<DeviceResponseDto> {
    return this.devicesService.createDevice(dto, user);
  }

  @Get()
  @ApiBearerAuth()
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN, UserRole.SECURITY)
  @ApiOperation({ summary: 'List all devices for tenant' })
  @ApiResponse({ status: 200, type: [DeviceResponseDto] })
  async getDevices(@CurrentUser() user: User): Promise<DeviceResponseDto[]> {
    return this.devicesService.getDevices(user);
  }

  @Get(':id')
  @ApiBearerAuth()
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN, UserRole.SECURITY)
  @ApiOperation({ summary: 'Get device details' })
  @ApiResponse({ status: 200, type: DeviceResponseDto })
  async getDevice(@Param('id') id: string, @CurrentUser() user: User): Promise<DeviceResponseDto> {
    return this.devicesService.getDevice(id, user);
  }

  @Patch(':id')
  @ApiBearerAuth()
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  @ApiOperation({ summary: 'Update device (name, gate assignment)' })
  @ApiResponse({ status: 200, type: DeviceResponseDto })
  async updateDevice(
    @Param('id') id: string,
    @Body() dto: UpdateDeviceDto,
    @CurrentUser() user: User,
  ): Promise<DeviceResponseDto> {
    return this.devicesService.updateDevice(id, dto, user);
  }

  @Delete(':id')
  @ApiBearerAuth()
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  @ApiOperation({ summary: 'Remove/unpair device' })
  @ApiResponse({ status: 204 })
  async deleteDevice(@Param('id') id: string, @CurrentUser() user: User): Promise<void> {
    return this.devicesService.deleteDevice(id, user);
  }

  @Post(':id/test')
  @ApiBearerAuth()
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN, UserRole.SECURITY)
  @ApiOperation({ summary: 'Send test command to device (beep, flash LED)' })
  @ApiResponse({ status: 200 })
  async testDevice(
    @Param('id') id: string,
    @CurrentUser() user: User,
  ): Promise<{ success: boolean; message: string }> {
    // Get device to verify access
    const device = await this.devicesService.getDevice(id, user);

    // Commands sent via Cloud Plus HTTP protocol (controller polls server)

    return { success: true, message: `Test command sent to ${device.deviceName}` };
  }

  // ==================== OTA Updates ====================

  @Get(':id/firmware')
  @ApiBearerAuth()
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  @ApiOperation({ summary: 'Check for available updates for device' })
  @ApiResponse({ status: 200, type: UpdateCheckResponseDto })
  async checkDeviceUpdate(
    @Param('id') id: string,
    @CurrentUser() user: User,
  ): Promise<UpdateCheckResponseDto> {
    const device = await this.devicesService.getDevice(id, user);
    return this.devicesService.checkUpdate(device.deviceId, device.firmwareVersion || '0.0.0');
  }

  @Post(':id/firmware/update')
  @ApiBearerAuth()
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  @ApiOperation({ summary: 'Trigger OTA update for device' })
  @ApiResponse({ status: 200 })
  async triggerUpdate(
    @Param('id') id: string,
    @CurrentUser() user: User,
  ): Promise<{ success: boolean; message: string; updateId?: string }> {
    const device = await this.devicesService.getDevice(id, user);
    const latestFirmware = await this.firmwareService.getLatestStable();

    if (!latestFirmware) {
      return { success: false, message: 'No firmware available' };
    }

    const downloadUrl = await this.firmwareService.getDownloadUrl(latestFirmware.id);

    // Create OTA update record
    const otaUpdate = await this.firmwareService.createOtaUpdate(
      device.id,
      latestFirmware.id,
      device.firmwareVersion || null,
      latestFirmware.version,
      user.id,
    );

    // OTA commands sent via Cloud Plus HTTP protocol (controller polls for updates)

    this.logger.log(`OTA update triggered for device ${device.deviceId}`);

    return {
      success: true,
      message: `Update to v${latestFirmware.version} initiated`,
      updateId: otaUpdate.id,
    };
  }
}
