import { Module } from '@nestjs/common';
import { GatewayService } from './gateway.service';
import { EventsGateway } from './events.gateway';

@Module({
  providers: [GatewayService, EventsGateway],
  exports: [GatewayService],
})
export class GatewayModule {}
