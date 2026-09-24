import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';

import { Notification } from '@database/entities/notification.entity';
import { RfidCard } from '@database/entities/rfid-card.entity';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import { Vehicle } from '@database/entities/vehicle.entity';
import {
  RegistrationType,
  VisitorPass,
  VisitorPassStatus,
} from '@database/entities/visitor-pass.entity';

/**
 * Takes a resident out of their building and returns them to the state of a
 * brand-new gate-management user. Every way a resident leaves goes through
 * here: removal from the Residents page, deletion from the Users page, and the
 * resident leaving by themselves.
 *
 * Only gate-management data is touched. The person's platform account (the
 * account service / Keycloak identity) is not, so they can still sign in, and
 * the next time they open gate management they are offered the same choice as
 * any new user: set up a building or join one.
 *
 * The gate_users row is kept and reset rather than deleted. Deleting it
 * outright is refused by the database for anyone with vehicles, cards or
 * visitor passes, and soft-deleting it locks the person out of gate management
 * for good (identity provisioning cannot see the row, but its user_id and
 * email still block creating a new one).
 */
@Injectable()
export class ResidentRemovalService {
  private readonly logger = new Logger(ResidentRemovalService.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * @param expectedTenantId the building the caller was authorised against.
   *   Re-checked under the lock, so an admin whose check passed a moment ago
   *   cannot remove someone who has since moved to another building. Omitted
   *   when residents leave by themselves.
   */
  async removeFromBuilding(residentId: string, expectedTenantId?: string | null): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      // Locked so a concurrent removal, or an admin editing the resident, waits
      // for this one instead of writing over half of it.
      const resident = await manager.findOne(User, {
        where: { id: residentId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!resident) {
        throw new NotFoundException('Resident not found');
      }

      if (
        resident.role !== UserRole.RESIDENT ||
        (expectedTenantId !== undefined && resident.tenantId !== expectedTenantId)
      ) {
        throw new ConflictException('Not currently a resident of this building.');
      }

      // A new user is an active one. A resident deactivated by their building
      // would otherwise stay locked out of gate management everywhere, unable
      // even to ask another building to let them in.
      await this.resetToNewUser(manager, resident, { reactivate: true });
    });
  }

  /**
   * Brings back a soft-deleted gate user as a new user. Soft delete is how the
   * Users page removed people before removal went through here, and how it
   * still removes staff and security. Identity provisioning calls this when
   * such a person signs in again; without it every request they make fails,
   * because the hidden row still holds their user_id and email.
   *
   * Whatever they held in their old building is released exactly as on
   * removal, so restoring can never hand them their old access back. Their
   * status is kept: an account that was also deactivated stays blocked.
   */
  async restoreDeletedUser(userId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const user = await manager.findOne(User, {
        where: { id: userId },
        withDeleted: true,
        lock: { mode: 'pessimistic_write' },
      });

      // Gone for good, or restored a moment ago by a concurrent sign-in: the
      // first request of a session fires several at once.
      if (!user || !user.deletedAt) {
        return;
      }

      await manager.restore(User, user.id);
      await this.resetToNewUser(manager, user, { reactivate: false });
    });
  }

  private async resetToNewUser(
    manager: EntityManager,
    user: User,
    options: { reactivate: boolean },
  ): Promise<void> {
    const formerTenantId = user.tenantId;

    // Credentials are deleted, not deactivated: a UID can be registered only
    // once per building, and both the registration check and the unique index
    // on (tenant_id, uid) count inactive rows. Deleting is what lets the same
    // physical card be handed to the next resident.
    const personalCards = await manager.delete(RfidCard, { userId: user.id });

    const vehicles = await manager.find(Vehicle, {
      where: { ownerId: user.id },
      select: ['id'],
    });
    const vehicleIds = vehicles.map((vehicle) => vehicle.id);

    let vehicleCards = 0;
    if (vehicleIds.length > 0) {
      // Cards before vehicles: rfid_cards.vehicle_id references vehicles.
      const deleted = await manager.delete(RfidCard, { vehicleId: In(vehicleIds) });
      vehicleCards = deleted.affected ?? 0;

      // The vehicle row goes too. Its built-in tag (rfid_uid) and its licence
      // plate are unique per building and cannot be cleared on a kept row.
      await manager.delete(Vehicle, { id: In(vehicleIds) });
    }

    // Passes stay as history but can no longer open a gate: the ones this
    // person made for their own visitors, and the ones registered for visiting
    // them. On-premise passes a guard or admin registered belong to the host
    // resident, so a restored staff member's are left alone.
    const openPass = In([VisitorPassStatus.PENDING, VisitorPassStatus.ACTIVE]);
    await manager.update(
      VisitorPass,
      {
        createdById: user.id,
        registrationType: RegistrationType.SELF_SERVICE,
        status: openPass,
      },
      { status: VisitorPassStatus.CANCELLED },
    );
    await manager.update(
      VisitorPass,
      { residentId: user.id, status: openPass },
      { status: VisitorPassStatus.CANCELLED },
    );

    // Notifications are listed by user alone, so without this the old
    // building's alerts would follow the person into whatever they do next.
    if (formerTenantId) {
      await manager.delete(Notification, { userId: user.id, tenantId: formerTenantId });
    }

    // The same state IdentityProvisioningService gives every new user. Access
    // events and security alerts keep pointing at this row, which is what
    // keeps the building's history intact.
    await manager.update(User, user.id, {
      role: UserRole.BUILDING_ADMIN,
      tenantId: null,
      // Nullable column typed as `string`; a raw NULL avoids an `any` cast.
      unit: () => 'NULL',
      ...(options.reactivate ? { status: UserStatus.ACTIVE } : {}),
    });

    this.logger.log(
      `Reset gate user ${user.id} (${user.role} of ${formerTenantId ?? 'no building'}) ` +
        `to a new user: ${personalCards.affected ?? 0} personal card(s), ` +
        `${vehicleIds.length} vehicle(s) and ${vehicleCards} vehicle card(s) released`,
    );
  }
}
