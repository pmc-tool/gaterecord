import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TenantsService } from './tenants.service';
import { TenantsController } from './tenants.controller';
import { Tenant } from '@database/entities/tenant.entity';
import { SubscriptionPlan } from '@database/entities/subscription-plan.entity';
import { User } from '@database/entities/user.entity';
import { Gate } from '@database/entities/gate.entity';
import { AccessEvent } from '@database/entities/access-event.entity';
import { Payment } from '@database/entities/payment.entity';
import { Membership } from '@database/entities/membership.entity';
import { BuildingJoinRequest } from '@database/entities/building-join-request.entity';
import { PeopleModule } from '../people/people.module';

/**
 * PeopleModule provides MembershipLifecycleService (the shared person insert
 * and email lookup). MembershipsService and MembershipAccessService come from
 * the @Global MembershipsModule. Membership and BuildingJoinRequest are
 * registered for the member counts and the delete cascade.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Tenant,
      SubscriptionPlan,
      User,
      Gate,
      AccessEvent,
      Payment,
      Membership,
      BuildingJoinRequest,
    ]),
    PeopleModule,
  ],
  controllers: [TenantsController],
  providers: [TenantsService],
  exports: [TenantsService],
})
export class TenantsModule {}
