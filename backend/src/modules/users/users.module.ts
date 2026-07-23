import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { User } from '@database/entities/user.entity';
import { Tenant } from '@database/entities/tenant.entity';
import { RfidCard } from '@database/entities/rfid-card.entity';
import { Vehicle } from '@database/entities/vehicle.entity';
import { UploadModule } from '../upload/upload.module';
import { AccountIdentityModule } from '../account-identity/account-identity.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, Tenant, RfidCard, Vehicle]),
    UploadModule,
    AccountIdentityModule,
  ],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
