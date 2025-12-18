import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MqttService } from './mqtt.service';
import { DeviceGatewayService } from './device-gateway.service';
import { Gate } from '@database/entities/gate.entity';
import { GateController as GateControllerEntity } from '@database/entities/gate-controller.entity';
import { Vehicle } from '@database/entities/vehicle.entity';
import { RfidCard } from '@database/entities/rfid-card.entity';
import { AccessEvent } from '@database/entities/access-event.entity';
import { GatewayModule } from '../gateway/gateway.module';

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Gate,
      GateControllerEntity,
      Vehicle,
      RfidCard,
      AccessEvent,
    ]),
    GatewayModule,
  ],
  providers: [MqttService, DeviceGatewayService],
  exports: [MqttService, DeviceGatewayService],
})
export class MqttModule {}
