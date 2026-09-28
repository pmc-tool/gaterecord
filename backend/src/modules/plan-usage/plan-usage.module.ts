import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Membership } from '@database/entities/membership.entity';
import { Tenant } from '@database/entities/tenant.entity';
import { User } from '@database/entities/user.entity';
import { Gate } from '@database/entities/gate.entity';
import { Vehicle } from '@database/entities/vehicle.entity';
import { VisitorPass } from '@database/entities/visitor-pass.entity';
import { PlanUsageController } from './plan-usage.controller';
import { PlanUsageService } from './plan-usage.service';

/**
 * Membership and User are read through the tenant repository's manager by the
 * shared seat count (people/seat-limit.ts); they are registered here so the
 * module does not depend on another module having registered them.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Tenant, Membership, User, Gate, Vehicle, VisitorPass])],
  controllers: [PlanUsageController],
  providers: [PlanUsageService],
})
export class PlanUsageModule {}
