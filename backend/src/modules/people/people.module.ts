import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BuildingJoinRequest } from '@database/entities/building-join-request.entity';
import { Membership } from '@database/entities/membership.entity';
import { Notification } from '@database/entities/notification.entity';
import { RfidCard } from '@database/entities/rfid-card.entity';
import { SubscriptionPlan } from '@database/entities/subscription-plan.entity';
import { Tenant } from '@database/entities/tenant.entity';
import { User } from '@database/entities/user.entity';
import { Vehicle } from '@database/entities/vehicle.entity';
import { VisitorPass } from '@database/entities/visitor-pass.entity';
import { AccountIdentityModule } from '../account-identity/account-identity.module';
import { MembershipLifecycleService } from './membership-lifecycle.service';

/**
 * The people lifecycle shared by users, residents, join requests and identity
 * provisioning: adding a person to a building, removing them from one or from
 * the platform, restoring a soft-deleted person. The seat rule and the safe
 * response projections (seat-limit.ts, people.views.ts) are plain functions
 * next to it and need no module.
 *
 * Must NOT import AuthModule: AuthModule reaches this module through
 * ResidentsModule (identity provisioning restores deleted people), so the
 * reverse import would be a cycle.
 *
 * Needs no import for its other dependencies: MembershipsModule and
 * NotificationModule (EmailService) are @Global, ConfigModule is global.
 *
 * The forFeature list registers every entity the service touches through its
 * EntityManager, so autoLoadEntities knows them even if the module that
 * normally registers one is ever dropped.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      Tenant,
      SubscriptionPlan,
      Membership,
      RfidCard,
      Vehicle,
      VisitorPass,
      Notification,
      BuildingJoinRequest,
    ]),
    AccountIdentityModule,
  ],
  providers: [MembershipLifecycleService],
  exports: [MembershipLifecycleService],
})
export class PeopleModule {}
