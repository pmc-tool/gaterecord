import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { VehiclesController } from './vehicles.controller';
import { VehiclesService } from './vehicles.service';
import { Vehicle } from '@database/entities/vehicle.entity';
import { Tenant } from '@database/entities/tenant.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Vehicle, Tenant])],
  controllers: [VehiclesController],
  providers: [VehiclesService],
  exports: [VehiclesService],
})
export class VehiclesModule {}
