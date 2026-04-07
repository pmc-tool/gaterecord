import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { DevicesController } from './devices.controller';
import { FirmwareController } from './firmware.controller';
import { FirmwareDownloadController } from './firmware-download.controller';
import { DevicesService } from './devices.service';
import { FirmwareService } from './firmware.service';
import { DeviceScheduler } from './device.scheduler';
import { SetupCode } from '@database/entities/setup-code.entity';
import { DeviceConfig } from '@database/entities/device-config.entity';
import { FirmwareVersion } from '@database/entities/firmware-version.entity';
import { OtaUpdate } from '@database/entities/ota-update.entity';
import { Gate } from '@database/entities/gate.entity';
import { GatewayModule } from '../gateway/gateway.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([SetupCode, DeviceConfig, FirmwareVersion, OtaUpdate, Gate]),
    ScheduleModule.forRoot(),
    GatewayModule,
  ],
  controllers: [DevicesController, FirmwareController, FirmwareDownloadController],
  providers: [DevicesService, FirmwareService, DeviceScheduler],
  exports: [DevicesService, FirmwareService],
})
export class DevicesModule {}
