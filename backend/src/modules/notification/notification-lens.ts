/**
 * Which of a person's notifications the bell shows, given the context the
 * request acts in (A5, GATE-10).
 *
 * Notifications are stored per PERSON (notifications.user_id = gate_users.id)
 * and tagged with the building they are about (tenant_id), or untagged
 * (tenant_id NULL) when they are personal: account, join-request and billing
 * messages that belong to no one building. A person with roles in several
 * buildings should see Tower B's gate events only while acting in Tower B, and
 * their personal messages everywhere:
 *
 *   platform  a super admin acting platform-wide: every row of theirs;
 *   building  acting in one building (membership, or legacy mode with a
 *             tenant): that building's rows plus the personal ones;
 *   none      no building chosen yet (the bell works before the picker,
 *             NotificationController is @ContextOptional): personal rows only.
 *
 * Legacy mode (GATE_MEMBERSHIP_CONTEXT off) gives a single-building person the
 * same rows as before: everything of theirs is tagged with their one building
 * or untagged.
 */
import { FindOptionsWhere, IsNull } from 'typeorm';
import { Notification } from '@database/entities/notification.entity';
import { contextKindOf } from '@common/context/acting-user';
import { BuildingContextSubject, isPlatformContext } from '@common/context/assert-building-context';

export interface NotificationLens {
  userId: string;
  /** The building acted in; null for the platform context and for no context. */
  tenantId: string | null;
  platform: boolean;
}

/** The lens for an (overlaid) req.user. */
export function notificationLensFor(
  user: BuildingContextSubject & { id: string },
): NotificationLens {
  const platform = isPlatformContext(user);
  const kind = contextKindOf(user);
  const tenantId =
    !platform && (kind === 'membership' || kind === 'legacy') && user.tenantId
      ? user.tenantId
      : null;

  return { userId: user.id, tenantId, platform };
}

/**
 * The where-clause of a lens, as an OR list of find conditions. `filters`
 * (isRead, type, ...) are applied to every branch.
 */
export function whereForLens(
  lens: NotificationLens,
  filters: FindOptionsWhere<Notification> = {},
): FindOptionsWhere<Notification>[] {
  const own = { ...filters, userId: lens.userId };

  if (lens.platform) {
    return [own];
  }
  if (lens.tenantId) {
    return [
      { ...own, tenantId: lens.tenantId },
      { ...own, tenantId: IsNull() },
    ];
  }
  return [{ ...own, tenantId: IsNull() }];
}
