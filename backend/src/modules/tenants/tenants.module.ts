import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TenantsService } from './tenants.service';
import { TenantsController } from './tenants.controller';
import { Tenant } from '@database/entities/tenant.entity';
import { SubscriptionPlan } from '@database/entities/subscription-plan.entity';
import { User } from '@database/entities/user.entity';
import { Gate } from '@database/entities/gate.entity';
import { AccessEvent } from '@database/entities/access-event.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Tenant, SubscriptionPlan, User, Gate, AccessEvent])],
  controllers: [TenantsController],
  providers: [TenantsService],
  exports: [TenantsService],
})
export class TenantsModule {}
