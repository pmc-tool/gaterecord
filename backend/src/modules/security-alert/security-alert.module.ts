import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SecurityAlert } from '@database/entities/security-alert.entity';
import { AccessEvent } from '@database/entities/access-event.entity';
import { User } from '@database/entities/user.entity';
import { Gate } from '@database/entities/gate.entity';
import { SecurityAlertService } from './security-alert.service';
import { SecurityAlertController } from './security-alert.controller';
import { GatewayModule } from '../gateway/gateway.module';

@Module({
  imports: [TypeOrmModule.forFeature([SecurityAlert, AccessEvent, User, Gate]), GatewayModule],
  controllers: [SecurityAlertController],
  providers: [SecurityAlertService],
  exports: [SecurityAlertService],
})
export class SecurityAlertModule {}
