import { Global, Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Membership } from '@database/entities/membership.entity';
import { User } from '@database/entities/user.entity';
import { Tenant } from '@database/entities/tenant.entity';
import { BuildingJoinRequest } from '@database/entities/building-join-request.entity';
import { MembershipsService } from './memberships.service';
import { MembershipAccessService } from './membership-access.service';
import { MembershipContextService } from './membership-context.service';
import { MembershipsController } from './memberships.controller';
import { ActingUserWriteGuardSubscriber } from './acting-user-write-guard.subscriber';
import { MembershipChangePublisher } from './membership-change.events';
import { recordMembershipTablePresence } from './membership-table';

/**
 * The ONE module for multi-building memberships (gate_memberships).
 *
 * Global so every module (auth strategies, people, gates, notifications, the
 * socket gateway) can inject MembershipsService and MembershipAccessService
 * without importing it, and without the import cycles an AuthModule <->
 * PeopleModule dependency would create. Later work adds its providers here
 * rather than creating a second module.
 *
 *   MembershipsService              the only writer of gate_memberships and of
 *                                   the legacy gate_users mirror columns, plus
 *                                   the membership reads (and GET /memberships/me);
 *   MembershipContextService        resolves the acting principal (req.user) for
 *                                   both passport strategies;
 *   MembershipAccessService         holder decisions for gate credentials and
 *                                   recipient queries;
 *   ActingUserWriteGuardSubscriber  refuses to persist the overlaid req.user;
 *   MembershipChangePublisher       publishes 'membership.changed' after the
 *                                   transaction of a membership write commits
 *                                   (the socket gateway re-checks rooms on it);
 *   MembershipsController           GET /memberships/me.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Membership, User, Tenant, BuildingJoinRequest])],
  controllers: [MembershipsController],
  providers: [
    MembershipsService,
    MembershipAccessService,
    MembershipContextService,
    ActingUserWriteGuardSubscriber,
    MembershipChangePublisher,
  ],
  exports: [MembershipsService, MembershipAccessService, MembershipContextService],
})
export class MembershipsModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(MembershipsModule.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Loud, non-fatal boot check. synchronize is off against shared databases, so
   * code that reads gate_memberships can be deployed before migration
   * 1775740000000-CreateGateMemberships has run there. Say so at boot rather
   * than as a stream of 500s later. Never fails the boot: with
   * GATE_MEMBERSHIP_CONTEXT off, authentication and the gate holder check read
   * the table only once this check has seen it (membership-table.ts).
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const rows: Array<{ table: string | null }> = await this.dataSource.query(
        'SELECT to_regclass(\'public.gate_memberships\')::text AS "table"',
      );
      recordMembershipTablePresence(!!rows?.[0]?.table);
      if (!rows?.[0]?.table) {
        this.logger.error(
          'Table gate_memberships does not exist. Run the pending migrations ' +
            '(1775740000000-CreateGateMemberships, 1775740100000-JoinRequestsPendingPerBuilding) ' +
            'before using signup, onboarding, people management or GATE_MEMBERSHIP_CONTEXT=on.',
        );
      }
    } catch (error) {
      this.logger.warn(
        `Could not check for the gate_memberships table: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }
}
