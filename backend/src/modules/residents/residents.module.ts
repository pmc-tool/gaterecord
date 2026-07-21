import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ResidentsController } from './residents.controller';
import { ResidentsService } from './residents.service';
import { User } from '@database/entities/user.entity';
import { Tenant } from '@database/entities/tenant.entity';
import { AccountIdentityModule } from '../account-identity/account-identity.module';

@Module({
  imports: [TypeOrmModule.forFeature([User, Tenant]), AccountIdentityModule],
  controllers: [ResidentsController],
  providers: [ResidentsService],
  exports: [ResidentsService],
})
export class ResidentsModule {}
