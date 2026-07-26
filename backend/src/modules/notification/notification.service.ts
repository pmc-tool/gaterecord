import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, LessThan } from 'typeorm';
import { Notification, NotificationType, NotificationPriority } from '@database/entities/notification.entity';
import { User, UserRole } from '@database/entities/user.entity';
import { EmailService } from './email.service';
import {
  CreateNotificationDto,
  NotificationQueryDto,
  NotificationCountDto,
} from './dto/notification.dto';

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    @InjectRepository(Notification)
    private notificationRepository: Repository<Notification>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private emailService: EmailService,
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
      await this.sendEmailToUser(user, dto.title, dto.message, dto.type, dto.priority, dto.metadata?.link as string);
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
   * Create notifications for multiple users (respects each user's settings)
   */
  async createForUsers(
    userIds: string[],
    data: Omit<CreateNotificationDto, 'userId'>,
  ): Promise<Notification[]> {
    const users = await this.userRepository.find({
      where: { id: In(userIds) },
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
          await this.sendEmailToUser(user, data.title, data.message, data.type, data.priority, data.metadata?.link as string);
          await this.notificationRepository.update(saved.id, {
            emailSent: true,
            emailSentAt: new Date(),
          });
        }
      } else if (data.sendEmail && emailEnabled) {
        // User wants email only (no in-app)
        await this.sendEmailToUser(user, data.title, data.message, data.type, data.priority, data.metadata?.link as string);
      }
    }

    return notifications;
  }

  /**
   * Create notification for all users with specific roles in a tenant
   */
  async createForTenantRoles(
    tenantId: string,
    roles: UserRole[],
    data: Omit<CreateNotificationDto, 'userId' | 'tenantId'>,
  ): Promise<Notification[]> {
    const users = await this.userRepository.find({
      where: roles.map((role) => ({ tenantId, role })),
    });

    if (users.length === 0) return [];

    return this.createForUsers(
      users.map((u) => u.id),
      { ...data, tenantId },
    );
  }

  /**
   * Create notification for super admins
   */
  async createForSuperAdmins(
    data: Omit<CreateNotificationDto, 'userId'>,
  ): Promise<Notification[]> {
    const superAdmins = await this.userRepository.find({
      where: { role: UserRole.SUPER_ADMIN },
    });

    if (superAdmins.length === 0) return [];

    return this.createForUsers(
      superAdmins.map((u) => u.id),
      data,
    );
  }

  /**
   * Get notifications for current user
   */
  async findForUser(
    userId: string,
    query: NotificationQueryDto,
  ): Promise<{ notifications: Notification[]; total: number }> {
    const page = parseInt(query.page || '1', 10);
    const limit = parseInt(query.limit || '20', 10);
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = { userId };

    if (query.isRead !== undefined) {
      where.isRead = query.isRead;
    }

    if (query.type) {
      where.type = query.type;
    }

    const [notifications, total] = await this.notificationRepository.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip,
      take: limit,
    });

    return { notifications, total };
  }

  /**
   * Get notification counts for current user
   */
  async getCountsForUser(userId: string): Promise<NotificationCountDto> {
    const [total, unread] = await Promise.all([
      this.notificationRepository.count({ where: { userId } }),
      this.notificationRepository.count({ where: { userId, isRead: false } }),
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
   * Mark all notifications as read for a user
   */
  async markAllAsRead(userId: string): Promise<void> {
    await this.notificationRepository.update(
      { userId, isRead: false },
      { isRead: true, readAt: new Date() },
    );
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

  // ============ Helper methods for specific notification types ============

  /**
   * Create security alert notification
   */
  async notifySecurityAlert(
    tenantId: string,
    alertTitle: string,
    alertMessage: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    // Notify Security, Building Admin, and Super Admins
    await this.createForTenantRoles(tenantId, [UserRole.SECURITY, UserRole.BUILDING_ADMIN], {
      type: NotificationType.SECURITY_ALERT,
      priority: NotificationPriority.CRITICAL,
      title: alertTitle,
      message: alertMessage,
      metadata,
      sendEmail: true,
    });

    await this.createForSuperAdmins({
      type: NotificationType.SECURITY_ALERT,
      priority: NotificationPriority.CRITICAL,
      title: alertTitle,
      message: alertMessage,
      metadata: { ...metadata, tenantId },
      sendEmail: true,
    });
  }

  /**
   * Create visitor entry notification for resident
   */
  async notifyVisitorEntry(
    residentId: string,
    visitorName: string,
    gateName: string,
    metadata: Record<string, unknown>,
    sendEmail = true,
  ): Promise<void> {
    const user = await this.userRepository.findOne({ where: { id: residentId } });
    if (!user) return;

    await this.create({
      userId: residentId,
      tenantId: user.tenantId || undefined,
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
