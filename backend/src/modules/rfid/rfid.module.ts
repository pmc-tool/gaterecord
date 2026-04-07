import { Module, Global, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RfidCard } from '@database/entities/rfid-card.entity';
import { Vehicle } from '@database/entities/vehicle.entity';
import { RfidRegistrationService } from './rfid-registration.service';
import { RfidRegistrationController } from './rfid-registration.controller';
import { RfidCardsController } from './rfid-cards.controller';
import { GatewayModule } from '../gateway/gateway.module';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([RfidCard, Vehicle]), forwardRef(() => GatewayModule)],
  controllers: [RfidRegistrationController, RfidCardsController],
  providers: [RfidRegistrationService],
  exports: [RfidRegistrationService],
})
export class RfidModule {}
