import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DevicesService } from './devices.service';

@Injectable()
export class DeviceScheduler {
  private readonly logger = new Logger(DeviceScheduler.name);

  constructor(private devicesService: DevicesService) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async checkOfflineDevices(): Promise<void> {
    try {
      const offlineDeviceIds = await this.devicesService.markOfflineDevices();

      if (offlineDeviceIds.length > 0) {
        this.logger.log(`Marked ${offlineDeviceIds.length} devices as offline`);

        // TODO: Emit WebSocket events for offline devices
        // for (const deviceId of offlineDeviceIds) {
        //   this.gateway.emitDeviceOffline(deviceId);
        // }
      }
    } catch (error) {
      this.logger.error('Error checking offline devices', error);
    }
  }
}
