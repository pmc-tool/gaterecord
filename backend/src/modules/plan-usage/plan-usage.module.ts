import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Tenant } from '@database/entities/tenant.entity';
import { User } from '@database/entities/user.entity';
import { Gate } from '@database/entities/gate.entity';
import { Vehicle } from '@database/entities/vehicle.entity';
import { VisitorPass } from '@database/entities/visitor-pass.entity';
import { PlanUsageController } from './plan-usage.controller';
import { PlanUsageService } from './plan-usage.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Tenant, User, Gate, Vehicle, VisitorPass]),
  ],
  controllers: [PlanUsageController],
  providers: [PlanUsageService],
})
export class PlanUsageModule {}
