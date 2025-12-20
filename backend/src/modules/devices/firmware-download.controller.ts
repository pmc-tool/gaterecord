import {
  Controller,
  Get,
  Param,
  Res,
  StreamableFile,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Response } from 'express';
import { createReadStream } from 'fs';
import { FirmwareService } from './firmware.service';

@ApiTags('Firmware Download')
@Controller('firmware')
export class FirmwareDownloadController {
  private readonly logger = new Logger(FirmwareDownloadController.name);

  constructor(private firmwareService: FirmwareService) {}

  @Get('download/:version')
  @ApiOperation({ summary: 'Download firmware binary by version' })
  @ApiResponse({ status: 200, description: 'Firmware binary file' })
  @ApiResponse({ status: 404, description: 'Firmware not found' })
  async downloadFirmware(
    @Param('version') version: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    this.logger.log(`Firmware download requested for version ${version}`);

    const filePath = await this.firmwareService.getFirmwareFilePath(version);
    const firmware = await this.firmwareService.getFirmwareByVersion(version);

    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="firmware-${version}.bin"`,
      'X-Firmware-Checksum': firmware?.checksum || '',
      'X-Firmware-Version': version,
    });

    const file = createReadStream(filePath);
    return new StreamableFile(file);
  }

  @Get('latest')
  @ApiOperation({ summary: 'Get latest stable firmware info' })
  @ApiResponse({ status: 200, description: 'Latest firmware version info' })
  async getLatestFirmware() {
    const latest = await this.firmwareService.getLatestStable();
    if (!latest) {
      return { available: false };
    }
    return {
      available: true,
      version: latest.version,
      checksum: latest.checksum,
      firmwareUrl: latest.firmwareUrl,
      firmwareSize: latest.firmwareSize,
    };
  }
}
