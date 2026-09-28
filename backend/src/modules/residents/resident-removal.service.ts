import { Injectable } from '@nestjs/common';

import { MembershipRole } from '@database/entities/membership.entity';
import { tenantRequired } from '@common/context/membership-context.errors';
import {
  MembershipLifecycleService,
  MembershipRemovalReason,
  MembershipRemovalResult,
} from '../people/membership-lifecycle.service';

export interface RemoveFromBuildingOptions {
  /**
   * When given, the person must hold this role in the building (409 otherwise,
   * nothing changes). The Residents page passes RESIDENT; the Users page
   * removes any role.
   */
  expectedRole?: MembershipRole | null;
  /** Logged with the removal. Default 'removed_by_admin'. */
  reason?: MembershipRemovalReason;
  /** 409 LAST_BUILDING_ADMIN instead of leaving the building without an admin. */
  protectLastAdmin?: boolean;
}

/**
 * Takes a person out of ONE building. Every way someone leaves a building goes
 * through here: removal from the Residents page, deletion from the Users page,
 * and a resident leaving by themselves.
 *
 * Only that building's membership ends, and only what the person held in that
 * building is released (cards, vehicles, open passes, its notifications); the
 * work is MembershipLifecycleService.removeMembership. Their roles, cards,
 * vehicles and passes in any other building are untouched, and neither the
 * gate_users row nor the platform account (the account service / Keycloak
 * identity) is: they can still sign in, and with no building left they are
 * offered the same choice as any new user, set up a building or join one.
 */
@Injectable()
export class ResidentRemovalService {
  constructor(private readonly membershipLifecycle: MembershipLifecycleService) {}

  /**
   * @param tenantId the building to remove the person from: the building the
   *   caller acts in (or a super admin named). Required: 400 TENANT_REQUIRED
   *   without it, because "their building" no longer means anything for a
   *   person who can belong to several.
   */
  async removeFromBuilding(
    personId: string,
    tenantId: string | null | undefined,
    options: RemoveFromBuildingOptions = {},
  ): Promise<MembershipRemovalResult> {
    if (!tenantId) {
      throw tenantRequired();
    }

    return this.membershipLifecycle.removeMembership({
      userId: personId,
      tenantId,
      expectedRole: options.expectedRole ?? null,
      reason: options.reason ?? 'removed_by_admin',
      protectLastAdmin: options.protectLastAdmin ?? false,
    });
  }

  /**
   * Brings back a soft-deleted gate user as a new user with no building.
   * Identity provisioning calls this when such a person signs in again; without
   * it every request they make fails, because the hidden row still holds their
   * user_id and email.
   *
   * Restoring never hands back old access: every membership still live is
   * ended (MembershipsService.restorePerson, which also writes the no-building
   * sentinel onto the legacy columns), and whatever the person held in those
   * buildings, or in the building the legacy column still names, is released
   * exactly as on removal. A removed guard therefore cannot regain access by
   * signing in. Their status is kept: an account that was also deactivated
   * stays blocked. A no-op when a concurrent sign-in already restored the row.
   */
  async restoreDeletedUser(userId: string): Promise<void> {
    await this.membershipLifecycle.restoreDeletedPerson(userId);
  }
}
