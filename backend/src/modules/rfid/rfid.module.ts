import { Module, Global, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RfidCard } from '@database/entities/rfid-card.entity';
import { User } from '@database/entities/user.entity';
import { Vehicle } from '@database/entities/vehicle.entity';
import { Gate } from '@database/entities/gate.entity';
import { DeviceConfig } from '@database/entities/device-config.entity';
import { RfidRegistrationService } from './rfid-registration.service';
import { RfidRegistrationController } from './rfid-registration.controller';
import { RfidCardsController } from './rfid-cards.controller';
import { GatewayModule } from '../gateway/gateway.module';

@Global()
@Module({
  imports: [
    // Gate + DeviceConfig back the reader-scope validation in startSession;
    // User backs the resident re-check when a card is created.
    TypeOrmModule.forFeature([RfidCard, User, Vehicle, Gate, DeviceConfig]),
    forwardRef(() => GatewayModule),
  ],
  controllers: [RfidRegistrationController, RfidCardsController],
  providers: [RfidRegistrationService],
  exports: [RfidRegistrationService],
})
export class RfidModule {}
