import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BuildingJoinRequest } from '@database/entities/building-join-request.entity';
import { Tenant } from '@database/entities/tenant.entity';
import { User } from '@database/entities/user.entity';
import { ResidentsModule } from '@modules/residents/residents.module';

import { ResidentJoinController } from './resident-join.controller';
import { ResidentRequestsController } from './resident-requests.controller';
import { ResidentRequestsService } from './resident-requests.service';

/**
 * Resident self-signup: a user asks to join an existing building, its admin
 * decides.
 *
 * The forFeature registration is what makes BuildingJoinRequest visible to the
 * running app — app.module.ts uses autoLoadEntities, which only picks up
 * entities reachable through a forFeature, not the entities barrel.
 *
 * NotificationService needs no import here: NotificationModule is @Global().
 */
@Module({
  imports: [TypeOrmModule.forFeature([BuildingJoinRequest, User, Tenant]), ResidentsModule],
  controllers: [ResidentJoinController, ResidentRequestsController],
  providers: [ResidentRequestsService],
  exports: [ResidentRequestsService],
})
export class ResidentRequestsModule {}
