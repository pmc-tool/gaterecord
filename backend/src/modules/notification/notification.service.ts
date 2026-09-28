import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, LessThan, FindOptionsWhere } from 'typeorm';
import {
  Notification,
  NotificationType,
  NotificationPriority,
} from '@database/entities/notification.entity';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import { isMembershipRole } from '@database/entities/membership.entity';
import { isUuid } from '@common/context/acting-user';
import { EmailService } from './email.service';
import {
  CreateNotificationDto,
  NotificationQueryDto,
  NotificationCountDto,
} from './dto/notification.dto';
import { NotificationLens, whereForLens } from './notification-lens';
import { MembershipAccessService } from '../memberships/membership-access.service';
import { ALERT_RECIPIENT_ROLES } from '../memberships/membership-access.constants';

/**
 * In-app (bell) notifications and their optional emails.
 *
 * Recipients are PEOPLE (gate_users.id). Who in a building should hear about
 * something is read from memberships (MembershipAccessService
 * .findActivePersonIds: an ACTIVE role in that building, not banned), never
 * from gate_users.tenant_id, so a person who is security in Tower C hears about
 * C's alerts even though their legacy row names another building, and hears
 * about them once however many rows match. Super admins are found by their
 * platform role (gate_users.role, A1).
 *
 * Reading follows the request's context through a NotificationLens (see
 * notification-lens.ts): a building's items plus personal ones.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    @InjectRepository(Notification)
    private notificationRepository: Repository<Notification>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private emailService: EmailService,
    private membershipAccessService: MembershipAccessService,
  ) {}

  /**
   * Create a notification for a specific user (respects user settings)
   */
  async create(dto: CreateNotificationDto): Promise<Notification | null> {
    const user = await this.userRepository.findOne({ where: { id: dto.userId } });
    if (!user) return null;

    // Check if user has in-app notifications enabled
    const inAppEnabled = user.notificationSettings?.inAppNotifications !== false;
    const emailEnabled = user.notificationSettings?.emailNotifications !== false;

    let savedNotification: Notification | null = null;

    // Create in-app notification if enabled
    if (inAppEnabled) {
      const notification = this.notificationRepository.create({
        userId: dto.userId,
        tenantId: dto.tenantId || null,
        type: dto.type,
        priority: dto.priority || NotificationPriority.NORMAL,
        title: dto.title,
        message: dto.message,
        metadata: dto.metadata || null,
      });
      savedNotification = await this.notificationRepository.save(notification);
    }

    // Send email if requested and user has email notifications enabled
    if (dto.sendEmail && emailEnabled && user.email) {
      await this.sendEmailToUser(
        user,
        dto.title,
        dto.message,
        dto.type,
        dto.priority,
        dto.metadata?.link as string,
      );
      if (savedNotification) {
        await this.notificationRepository.update(savedNotification.id, {
          emailSent: true,
          emailSentAt: new Date(),
        });
      }
    }

    return savedNotification;
  }

  /**
   * Send email directly to user (helper method)
   */
  private async sendEmailToUser(
    user: User,
    title: string,
    message: string,
    type: NotificationType,
    priority?: NotificationPriority,
    link?: string,
  ): Promise<void> {
    try {
      await this.emailService.sendNotificationEmail(
        user.email,
        `${user.firstName} ${user.lastName}`,
        title,
        message,
        type,
        priority || NotificationPriority.NORMAL,
        link,
      );
      this.logger.log(`Email sent to ${user.email}`);
    } catch (error) {
      this.logger.error(`Failed to send email to ${user.email}:`, error);
    }
  }

  /**
   * Create notifications for multiple users (respects each user's settings).
   * Each person is notified once however often their id is listed, and people
   * who are not ACTIVE (banned platform-wide, or deactivated in their only
   * building) are skipped.
   */
  async createForUsers(
    userIds: readonly string[],
    data: Omit<CreateNotificationDto, 'userId'>,
  ): Promise<Notification[]> {
    const ids = [...new Set(userIds.filter((id) => isUuid(id)))];
    if (ids.length === 0) return [];

    const users = await this.userRepository.find({
      where: { id: In(ids), status: UserStatus.ACTIVE },
    });

    const notifications: Notification[] = [];

    for (const user of users) {
      const inAppEnabled = user.notificationSettings?.inAppNotifications !== false;
      const emailEnabled = user.notificationSettings?.emailNotifications !== false;

      // Create in-app notification if enabled
      if (inAppEnabled) {
        const notification = this.notificationRepository.create({
          userId: user.id,
          tenantId: data.tenantId || null,
          type: data.type,
          priority: data.priority || NotificationPriority.NORMAL,
          title: data.title,
          message: data.message,
          metadata: data.metadata || null,
        });
        const saved = await this.notificationRepository.save(notification);
        notifications.push(saved);

        // Send email if requested and enabled
        if (data.sendEmail && emailEnabled) {
          await this.sendEmailToUser(
            user,
            data.title,
            data.message,
            data.type,
            data.priority,
            data.metadata?.link as string,
          );
          await this.notificationRepository.update(saved.id, {
            emailSent: true,
            emailSentAt: new Date(),
          });
        }
      } else if (data.sendEmail && emailEnabled) {
        // User wants email only (no in-app)
        await this.sendEmailToUser(
          user,
          data.title,
          data.message,
          data.type,
          data.priority,
          data.metadata?.link as string,
        );
      }
    }

    return notifications;
  }

  /**
   * Notify everyone with an ACTIVE role in `roles` in the building, tagged with
   * the building. Read from memberships, so the recipients are the people who
   * hold that role THERE (not whoever's legacy gate_users row names it), each
   * once. super_admin is not a building role and is ignored here; use
   * createForSuperAdmins.
   */
  async createForTenantRoles(
    tenantId: string,
    roles: readonly UserRole[],
    data: Omit<CreateNotificationDto, 'userId' | 'tenantId'>,
  ): Promise<Notification[]> {
    const { notifications } = await this.notifyTenantRoles(tenantId, roles, data);
    return notifications;
  }

  /**
   * Create notification for super admins (platform role, A1). `excludeIds` are
   * people already notified about the same thing (for example a super admin who
   * is also a building admin of the alert's building), so nobody gets it twice.
   * Pass `tenantId` in `data` to tag the copies with the building they are
   * about; the platform bell shows every row either way.
   */
  async createForSuperAdmins(
    data: Omit<CreateNotificationDto, 'userId'>,
    excludeIds: readonly string[] = [],
  ): Promise<Notification[]> {
    const superAdmins = await this.userRepository.find({
      where: { role: UserRole.SUPER_ADMIN, status: UserStatus.ACTIVE },
    });

    const excluded = new Set(excludeIds);
    const ids = superAdmins.map((u) => u.id).filter((id) => !excluded.has(id));
    if (ids.length === 0) return [];

    return this.createForUsers(ids, data);
  }

  /**
   * Get notifications for current user, through the context lens
   */
  async findForUser(
    lens: NotificationLens,
    query: NotificationQueryDto,
  ): Promise<{ notifications: Notification[]; total: number }> {
    const page = parseInt(query.page || '1', 10);
    const limit = parseInt(query.limit || '20', 10);
    const skip = (page - 1) * limit;

    const filters: FindOptionsWhere<Notification> = {};

    if (query.isRead !== undefined) {
      filters.isRead = query.isRead;
    }

    if (query.type) {
      filters.type = query.type;
    }

    const [notifications, total] = await this.notificationRepository.findAndCount({
      where: whereForLens(lens, filters),
      order: { createdAt: 'DESC' },
      skip,
      take: limit,
    });

    return { notifications, total };
  }

  /**
   * Get notification counts for current user, through the context lens
   */
  async getCountsForUser(lens: NotificationLens): Promise<NotificationCountDto> {
    const [total, unread] = await Promise.all([
      this.notificationRepository.count({ where: whereForLens(lens) }),
      this.notificationRepository.count({ where: whereForLens(lens, { isRead: false }) }),
    ]);

    return { total, unread };
  }

  /**
   * Mark notifications as read
   */
  async markAsRead(userId: string, notificationIds: string[]): Promise<void> {
    await this.notificationRepository.update(
      { id: In(notificationIds), userId },
      { isRead: true, readAt: new Date() },
    );
  }

  /**
   * Mark all notifications as read for a user: the ones the lens shows, so
   * "mark all read" in Tower B leaves Tower A's unread items alone.
   */
  async markAllAsRead(lens: NotificationLens): Promise<void> {
    await this.notificationRepository.update(whereForLens(lens, { isRead: false }), {
      isRead: true,
      readAt: new Date(),
    });
  }

  /**
   * Delete a notification
   */
  async delete(userId: string, notificationId: string): Promise<void> {
    const notification = await this.notificationRepository.findOne({
      where: { id: notificationId, userId },
    });

    if (!notification) {
      throw new NotFoundException('Notification not found');
    }

    await this.notificationRepository.remove(notification);
  }

  /**
   * Delete all read notifications older than specified days
   */
  async cleanupOldNotifications(daysOld: number = 30): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);

    const result = await this.notificationRepository.delete({
      isRead: true,
      createdAt: LessThan(cutoffDate),
    });

    this.logger.log(`Cleaned up ${result.affected} old notifications`);
    return result.affected || 0;
  }

  /**
   * createForTenantRoles, also returning who was reached. The building must be
   * a uuid: a missing one would otherwise mean "no building filter".
   */
  private async notifyTenantRoles(
    tenantId: string,
    roles: readonly UserRole[],
    data: Omit<CreateNotificationDto, 'userId' | 'tenantId'>,
  ): Promise<{ notifications: Notification[]; personIds: string[] }> {
    const buildingRoles = roles.filter(isMembershipRole);
    if (!isUuid(tenantId) || buildingRoles.length === 0) {
      this.logger.warn(`Notification "${data.title}" has no building or no building role; skipped`);
      return { notifications: [], personIds: [] };
    }

    const personIds = await this.membershipAccessService.findActivePersonIds(
      tenantId,
      buildingRoles,
    );
    if (personIds.length === 0) return { notifications: [], personIds };

    const notifications = await this.createForUsers(personIds, { ...data, tenantId });
    return { notifications, personIds };
  }

  // ============ Helper methods for specific notification types ============

  /**
   * Create security alert notification: the building's active admins and
   * security, then every super admin who was not already reached that way.
   * All copies are tagged with the building, so the alert shows in the bell of
   * whoever acts in that building and in the platform view, and a super admin
   * who is also an admin of the building gets exactly one.
   */
  async notifySecurityAlert(
    tenantId: string,
    alertTitle: string,
    alertMessage: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const alert = {
      type: NotificationType.SECURITY_ALERT,
      priority: NotificationPriority.CRITICAL,
      title: alertTitle,
      message: alertMessage,
      sendEmail: true,
    };

    const { personIds } = await this.notifyTenantRoles(tenantId, ALERT_RECIPIENT_ROLES, {
      ...alert,
      metadata,
    });

    await this.createForSuperAdmins(
      {
        ...alert,
        tenantId: isUuid(tenantId) ? tenantId : undefined,
        metadata: { ...metadata, tenantId },
      },
      personIds,
    );
  }

  /**
   * Create visitor entry notification for resident. `tenantId` is the building
   * the visitor entered (the gate's), passed explicitly: the resident's legacy
   * gate_users.tenant_id may name another of their buildings.
   */
  async notifyVisitorEntry(
    residentId: string,
    tenantId: string,
    visitorName: string,
    gateName: string,
    metadata: Record<string, unknown>,
    sendEmail = true,
  ): Promise<void> {
    await this.create({
      userId: residentId,
      tenantId,
      type: NotificationType.VISITOR_ENTRY,
      priority: NotificationPriority.NORMAL,
      title: 'Visitor Arrived',
      message: `${visitorName} has entered through ${gateName}`,
      metadata,
      sendEmail,
    });
  }

  /**
   * Create access denied notification
   */
  async notifyAccessDenied(
    tenantId: string,
    subjectName: string,
    gateName: string,
    reason: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.createForTenantRoles(tenantId, [UserRole.SECURITY, UserRole.BUILDING_ADMIN], {
      type: NotificationType.ACCESS_DENIED,
      priority: NotificationPriority.HIGH,
      title: 'Access Denied',
      message: `${subjectName} was denied access at ${gateName}: ${reason}`,
      metadata,
      sendEmail: false, // Don't spam email for every denial
    });
  }

  /**
   * Create gate offline notification
   */
  async notifyGateOffline(
    tenantId: string,
    gateName: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.createForTenantRoles(tenantId, [UserRole.BUILDING_ADMIN], {
      type: NotificationType.GATE_OFFLINE,
      priority: NotificationPriority.HIGH,
      title: 'Gate Offline',
      message: `${gateName} is now offline`,
      metadata,
      sendEmail: true,
    });
  }

  /**
   * Create subscription warning notification
   */
  async notifyTrialExpiring(
    tenantId: string,
    daysLeft: number,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.createForTenantRoles(tenantId, [UserRole.BUILDING_ADMIN], {
      type: NotificationType.TRIAL_EXPIRING,
      priority: daysLeft <= 3 ? NotificationPriority.HIGH : NotificationPriority.NORMAL,
      title: 'Trial Expiring Soon',
      message: `Your trial expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}. Subscribe to continue using Yaad.`,
      metadata,
      sendEmail: true,
    });
  }
}
