import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { User } from '@database/entities/user.entity';
import { Tenant } from '@database/entities/tenant.entity';
import { Membership } from '@database/entities/membership.entity';
import { RfidCard } from '@database/entities/rfid-card.entity';
import { Vehicle } from '@database/entities/vehicle.entity';
import { UploadModule } from '../upload/upload.module';
import { AccountIdentityModule } from '../account-identity/account-identity.module';
import { ResidentsModule } from '../residents/residents.module';
import { PeopleModule } from '../people/people.module';

/**
 * The Users page. Rows are memberships (MembershipsService, from the @Global
 * MembershipsModule); adding and removing go through PeopleModule's
 * MembershipLifecycleService and ResidentsModule's ResidentRemovalService.
 * AccountIdentityModule stays for the one add that is not a membership:
 * granting super admin to a brand-new email.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([User, Tenant, Membership, RfidCard, Vehicle]),
    UploadModule,
    AccountIdentityModule,
    ResidentsModule,
    PeopleModule,
  ],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
