import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Logger,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { Response } from 'express';
import { createReadStream } from 'fs';
import { FirmwareService, FirmwareResponseDto, UploadFirmwareDto } from './firmware.service';
import { Roles } from '@common/decorators/roles.decorator';
import { RolesGuard } from '@common/guards/roles.guard';
import { UserRole } from '@database/entities/user.entity';

@ApiTags('Firmware Management (Admin)')
@Controller('admin/firmware')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class FirmwareController {
  private readonly logger = new Logger(FirmwareController.name);

  constructor(private firmwareService: FirmwareService) {}

  @Get()
  @ApiOperation({ summary: 'List all firmware versions' })
  @ApiResponse({ status: 200, type: [FirmwareResponseDto] })
  async getAllVersions(): Promise<FirmwareResponseDto[]> {
    return this.firmwareService.getAllVersions();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get firmware version details' })
  @ApiResponse({ status: 200, type: FirmwareResponseDto })
  async getVersion(@Param('id') id: string): Promise<FirmwareResponseDto> {
    const firmware = await this.firmwareService.getById(id);
    if (!firmware) {
      throw new Error('Firmware not found');
    }
    return {
      id: firmware.id,
      version: firmware.version,
      firmwareUrl: firmware.firmwareUrl,
      firmwareSize: firmware.firmwareSize || undefined,
      checksum: firmware.checksum,
      releaseNotes: firmware.releaseNotes || undefined,
      isStable: firmware.isStable,
      isLatest: firmware.isLatest,
      minRequiredVersion: firmware.minRequiredVersion || undefined,
      releasedAt: firmware.releasedAt || undefined,
      createdAt: firmware.createdAt,
    };
  }

  @Post()
  @UseInterceptors(FileInterceptor('firmware'))
  @ApiOperation({ summary: 'Upload new firmware version' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        firmware: {
          type: 'string',
          format: 'binary',
        },
        version: {
          type: 'string',
          example: '1.3.0',
        },
        releaseNotes: {
          type: 'string',
          example: 'Bug fixes and improvements',
        },
        minRequiredVersion: {
          type: 'string',
          example: '1.2.0',
        },
        isStable: {
          type: 'boolean',
          example: false,
        },
      },
      required: ['firmware', 'version'],
    },
  })
  @ApiResponse({ status: 201, type: FirmwareResponseDto })
  async uploadFirmware(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadFirmwareDto,
  ): Promise<FirmwareResponseDto> {
    this.logger.log(`Uploading firmware version ${dto.version}`);
    return this.firmwareService.uploadFirmware(file.buffer, file.originalname, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update firmware metadata' })
  @ApiResponse({ status: 200, type: FirmwareResponseDto })
  async updateFirmware(
    @Param('id') id: string,
    @Body() dto: { releaseNotes?: string; minRequiredVersion?: string },
  ): Promise<FirmwareResponseDto> {
    // For now, just return the existing version
    // In production, implement update logic
    const firmware = await this.firmwareService.getById(id);
    if (!firmware) {
      throw new Error('Firmware not found');
    }
    return {
      id: firmware.id,
      version: firmware.version,
      firmwareUrl: firmware.firmwareUrl,
      firmwareSize: firmware.firmwareSize || undefined,
      checksum: firmware.checksum,
      releaseNotes: dto.releaseNotes || firmware.releaseNotes || undefined,
      isStable: firmware.isStable,
      isLatest: firmware.isLatest,
      minRequiredVersion: dto.minRequiredVersion || firmware.minRequiredVersion || undefined,
      releasedAt: firmware.releasedAt || undefined,
      createdAt: firmware.createdAt,
    };
  }

  @Post(':id/release')
  @ApiOperation({ summary: 'Mark firmware as released/stable' })
  @ApiResponse({ status: 200, type: FirmwareResponseDto })
  async releaseFirmware(
    @Param('id') id: string,
    @Body() dto: { isLatest?: boolean; isStable?: boolean },
  ): Promise<FirmwareResponseDto> {
    this.logger.log(`Releasing firmware ${id}`);
    return this.firmwareService.releaseFirmware(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete firmware version (if not in use)' })
  @ApiResponse({ status: 204 })
  async deleteFirmware(@Param('id') id: string): Promise<void> {
    return this.firmwareService.deleteFirmware(id);
  }
}
