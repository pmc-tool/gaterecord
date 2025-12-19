import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SecurityAlert } from '@database/entities/security-alert.entity';
import { AccessEvent } from '@database/entities/access-event.entity';
import { User } from '@database/entities/user.entity';
import { Gate } from '@database/entities/gate.entity';
import { SecurityAlertService } from './security-alert.service';
import { SecurityAlertController } from './security-alert.controller';
import { GatewayModule } from '../gateway/gateway.module';
import { MqttModule } from '../mqtt/mqtt.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([SecurityAlert, AccessEvent, User, Gate]),
    GatewayModule,
    MqttModule,
  ],
  controllers: [SecurityAlertController],
  providers: [SecurityAlertService],
  exports: [SecurityAlertService],
})
export class SecurityAlertModule {}
