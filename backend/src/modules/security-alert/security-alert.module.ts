import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { SecurityAlert } from '@database/entities/security-alert.entity';
import { AccessEvent } from '@database/entities/access-event.entity';
import { User } from '@database/entities/user.entity';
import { Gate } from '@database/entities/gate.entity';
import { DeviceConfig } from '@database/entities/device-config.entity';
import { SecurityAlertService } from './security-alert.service';
import { SecurityAlertTriggerService } from './security-alert-trigger.service';
import { SecurityAlertController } from './security-alert.controller';
import { GatewayModule } from '../gateway/gateway.module';
import { CloudPlusTcpModule } from '../cloud-plus-typeB-tcp/cloud-plus-tcp.module';
import { NotificationModule } from '../notification/notification.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([SecurityAlert, AccessEvent, User, Gate, DeviceConfig]),
    GatewayModule,
    forwardRef(() => CloudPlusTcpModule),
    NotificationModule,
    ScheduleModule.forRoot(),
  ],
  controllers: [SecurityAlertController],
  providers: [SecurityAlertService, SecurityAlertTriggerService],
  exports: [SecurityAlertService, SecurityAlertTriggerService],
})
export class SecurityAlertModule {}
