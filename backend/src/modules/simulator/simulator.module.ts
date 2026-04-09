import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { SimulatorService } from './simulator.service';
import { SimulatorController } from './simulator.controller';
import { SimulatorGateway } from './simulator.gateway';
import { Gate } from '@database/entities/gate.entity';
import { GateController as GateControllerEntity } from '@database/entities/gate-controller.entity';
import { SensorStatus } from '@database/entities/sensor-status.entity';
import { Vehicle } from '@database/entities/vehicle.entity';
import { RfidCard } from '@database/entities/rfid-card.entity';
import { VisitorPass } from '@database/entities/visitor-pass.entity';
import { AccessEvent } from '@database/entities/access-event.entity';
import { AccessPolicy } from '@database/entities/access-policy.entity';
import { User } from '@database/entities/user.entity';
import { Tenant } from '@database/entities/tenant.entity';
import { GatesModule } from '../gates/gates.module';
import { AccessEventsModule } from '../access-events/access-events.module';
import { SecurityAlertModule } from '../security-alert/security-alert.module';
import { CloudPlusModule } from '../cloud-plus-typeB/cloud-plus.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Gate,
      GateControllerEntity,
      SensorStatus,
      Vehicle,
      RfidCard,
      VisitorPass,
      AccessEvent,
      AccessPolicy,
      User,
      Tenant,
    ]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
      }),
      inject: [ConfigService],
    }),
    GatesModule,
    AccessEventsModule,
    SecurityAlertModule,
    forwardRef(() => CloudPlusModule),
  ],
  controllers: [SimulatorController],
  providers: [SimulatorService, SimulatorGateway],
  exports: [SimulatorService, SimulatorGateway],
})
export class SimulatorModule {}
