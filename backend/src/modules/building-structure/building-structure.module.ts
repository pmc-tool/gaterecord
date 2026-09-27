import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BuildingStructureController } from './building-structure.controller';
import { BuildingStructureService } from './building-structure.service';
import { BuildingFloor } from '@database/entities/building-floor.entity';
import { BuildingFlat } from '@database/entities/building-flat.entity';
import { User } from '@database/entities/user.entity';

/**
 * User is read-only here: resident units are counted for flat occupancy.
 */
@Module({
  imports: [TypeOrmModule.forFeature([BuildingFloor, BuildingFlat, User])],
  controllers: [BuildingStructureController],
  providers: [BuildingStructureService],
  exports: [BuildingStructureService],
})
export class BuildingStructureModule {}
