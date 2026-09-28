import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ResidentsController } from './residents.controller';
import { ResidentsService } from './residents.service';
import { ResidentRemovalService } from './resident-removal.service';
import { User } from '@database/entities/user.entity';
import { Tenant } from '@database/entities/tenant.entity';
import { Membership } from '@database/entities/membership.entity';
import { RfidCard } from '@database/entities/rfid-card.entity';
import { Vehicle } from '@database/entities/vehicle.entity';
import { BuildingStructureModule } from '../building-structure/building-structure.module';
import { PeopleModule } from '../people/people.module';

/**
 * Residents are RESIDENT memberships (MembershipsService, from the @Global
 * MembershipsModule). Adding a resident and ResidentRemovalService both
 * delegate to PeopleModule's MembershipLifecycleService, which also provisions
 * platform accounts, so this module needs no AccountIdentityModule of its own.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([User, Tenant, Membership, RfidCard, Vehicle]),
    BuildingStructureModule,
    PeopleModule,
  ],
  controllers: [ResidentsController],
  providers: [ResidentsService, ResidentRemovalService],
  exports: [ResidentsService, ResidentRemovalService],
})
export class ResidentsModule {}
