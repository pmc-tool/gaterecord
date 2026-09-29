import {
  Injectable,
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User, NotificationSettings } from '@database/entities/user.entity';
import { LoginHistory, LoginStatus } from '@database/entities/login-history.entity';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UpdateNotificationSettingsDto } from './dto/notification-settings.dto';

@Injectable()
export class SettingsService {
  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(LoginHistory)
    private loginHistoryRepository: Repository<LoginHistory>,
  ) {}

  // ==================== Password Management ====================

  async changePassword(userId: string, dto: ChangePasswordDto): Promise<{ message: string }> {
    // passwordHash is select: false on the entity; this is one of the few reads
    // that needs it, so it is selected explicitly.
    const user = await this.userRepository
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.id = :userId', { userId })
      .getOne();
    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Verify current password
    const isPasswordValid = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!isPasswordValid) {
      throw new UnauthorizedException(
        user.userId
          ? 'Current password is incorrect. If you sign in with your YAAD account, change the password there.'
          : 'Current password is incorrect',
      );
    }

    // Check if new passwords match
    if (dto.newPassword !== dto.confirmPassword) {
      throw new BadRequestException('New passwords do not match');
    }

    // Check if new password is same as current
    const isSamePassword = await bcrypt.compare(dto.newPassword, user.passwordHash);
    if (isSamePassword) {
      throw new BadRequestException('New password must be different from current password');
    }

    // Hash and save new password
    const newPasswordHash = await bcrypt.hash(dto.newPassword, 10);
    await this.userRepository.update(userId, {
      passwordHash: newPasswordHash,
      mustChangePassword: false,
    });

    return { message: 'Password changed successfully' };
  }

  /**
   * The web calls this when Keycloak reports the password changed (its
   * UPDATE_PASSWORD action returned kc_action_status=success). The password
   * itself lives in Keycloak; this only clears the starting-password reminder,
   * a UX flag (specs/002-account-identity-integration/design.md §6.2).
   */
  async acknowledgePasswordUpdated(userId: string): Promise<{ message: string }> {
    await this.userRepository.update(userId, { mustChangePassword: false });
    return { message: 'Password reminder cleared' };
  }

  // ==================== Notification Settings ====================

  async getNotificationSettings(userId: string): Promise<NotificationSettings> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Return default settings if none exist
    return (
      user.notificationSettings || {
        emailNotifications: true,
        inAppNotifications: true,
      }
    );
  }

  async updateNotificationSettings(
    userId: string,
    dto: UpdateNotificationSettingsDto,
  ): Promise<NotificationSettings> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const currentSettings = user.notificationSettings || {
      emailNotifications: true,
      inAppNotifications: true,
    };

    const updatedSettings: NotificationSettings = {
      emailNotifications: dto.emailNotifications ?? currentSettings.emailNotifications,
      inAppNotifications: dto.inAppNotifications ?? currentSettings.inAppNotifications,
    };

    await this.userRepository.update(userId, { notificationSettings: updatedSettings });

    return updatedSettings;
  }

  // ==================== Login Activity ====================

  async recordLoginActivity(
    userId: string,
    status: LoginStatus,
    ipAddress?: string,
    userAgent?: string,
    failureReason?: string,
  ): Promise<LoginHistory> {
    const { browser, os, device } = this.parseUserAgent(userAgent || '');

    const loginHistory = this.loginHistoryRepository.create({
      userId,
      status,
      ipAddress,
      userAgent,
      browser,
      os,
      device,
      failureReason,
    });

    return this.loginHistoryRepository.save(loginHistory);
  }

  async getLoginHistory(userId: string, limit: number = 20): Promise<LoginHistory[]> {
    return this.loginHistoryRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  private parseUserAgent(userAgent: string): { browser: string; os: string; device: string } {
    let browser = 'Unknown';
    let os = 'Unknown';
    let device = 'Desktop';

    // Parse browser
    if (userAgent.includes('Chrome') && !userAgent.includes('Edg')) {
      browser = 'Chrome';
    } else if (userAgent.includes('Firefox')) {
      browser = 'Firefox';
    } else if (userAgent.includes('Safari') && !userAgent.includes('Chrome')) {
      browser = 'Safari';
    } else if (userAgent.includes('Edg')) {
      browser = 'Edge';
    } else if (userAgent.includes('Opera') || userAgent.includes('OPR')) {
      browser = 'Opera';
    }

    // Parse OS
    if (userAgent.includes('Windows')) {
      os = 'Windows';
    } else if (userAgent.includes('Mac OS')) {
      os = 'macOS';
    } else if (userAgent.includes('Linux')) {
      os = 'Linux';
    } else if (userAgent.includes('Android')) {
      os = 'Android';
    } else if (userAgent.includes('iOS') || userAgent.includes('iPhone') || userAgent.includes('iPad')) {
      os = 'iOS';
    }

    // Parse device
    if (userAgent.includes('Mobile') || userAgent.includes('Android') || userAgent.includes('iPhone')) {
      device = 'Mobile';
    } else if (userAgent.includes('Tablet') || userAgent.includes('iPad')) {
      device = 'Tablet';
    }

    return { browser, os, device };
  }
}
