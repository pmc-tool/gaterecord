import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GatesService } from './gates.service';
import { GatesController } from './gates.controller';
import { Gate } from '@database/entities/gate.entity';
import { GateController as GateControllerEntity } from '@database/entities/gate-controller.entity';
import { SensorStatus } from '@database/entities/sensor-status.entity';
import { Tenant } from '@database/entities/tenant.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Gate, GateControllerEntity, SensorStatus, Tenant])],
  controllers: [GatesController],
  providers: [GatesService],
  exports: [GatesService],
})
export class GatesModule {}
