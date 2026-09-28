import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BuildingStructureController } from './building-structure.controller';
import { BuildingStructureService } from './building-structure.service';
import { BuildingFloor } from '@database/entities/building-floor.entity';
import { BuildingFlat } from '@database/entities/building-flat.entity';
import { Membership } from '@database/entities/membership.entity';
import { Tenant } from '@database/entities/tenant.entity';
import { User } from '@database/entities/user.entity';

/**
 * Membership is read-only here: resident memberships (and their unit) are
 * counted for flat occupancy, and the join floor plan checks whether the caller
 * already holds a role in the building. User is registered for the person join
 * in that count; Tenant for the join plan's "does this building exist".
 */
@Module({
  imports: [TypeOrmModule.forFeature([BuildingFloor, BuildingFlat, Membership, Tenant, User])],
  controllers: [BuildingStructureController],
  providers: [BuildingStructureService],
  exports: [BuildingStructureService],
})
export class BuildingStructureModule {}
