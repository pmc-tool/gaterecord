/**
 * Stripe Scheduler
 *
 * Handles scheduled tasks for subscription management:
 * - Daily sync with Stripe (catch any missed webhooks)
 * - Dunning: Notify users about payment failures
 * - Trial expiry warnings
 * - Suspend accounts after grace period
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, MoreThan, In, IsNull, Not } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import Stripe from 'stripe';

import {
  Tenant,
  TenantStatus,
  SubscriptionStatus,
  BillingCycle,
} from '@database/entities/tenant.entity';
import { SubscriptionPlan } from '@database/entities/subscription-plan.entity';
import {
  SubscriptionAuditLog,
  AuditEventType,
} from '@database/entities/subscription-audit-log.entity';
import { EmailService } from '../notification/email.service';

@Injectable()
export class StripeScheduler {
  private readonly logger = new Logger(StripeScheduler.name);
  private stripe: Stripe | null = null;

  constructor(
    private configService: ConfigService,
    private eventEmitter: EventEmitter2,
    private emailService: EmailService,
    @InjectRepository(Tenant)
    private tenantRepository: Repository<Tenant>,
    @InjectRepository(SubscriptionPlan)
    private planRepository: Repository<SubscriptionPlan>,
    @InjectRepository(SubscriptionAuditLog)
    private auditLogRepository: Repository<SubscriptionAuditLog>,
  ) {
    const secretKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    if (secretKey) {
      this.stripe = new Stripe(secretKey);
    }
  }

  // ==================== Daily Sync Job ====================

  /**
   * Daily sync with Stripe - runs at 3 AM
   * Catches any missed webhooks and ensures data consistency
   */
  @Cron('0 3 * * *') // Every day at 3:00 AM
  async syncStripeSubscriptions(): Promise<void> {
    if (!this.stripe) {
      this.logger.warn('Stripe not configured - skipping sync');
      return;
    }

    this.logger.log('Starting daily Stripe subscription sync...');
    let syncedCount = 0;
    let errorCount = 0;

    const tenants = await this.tenantRepository.find({
      where: { stripeSubscriptionId: Not(IsNull()) },
      relations: ['subscriptionPlan'],
    });

    for (const tenant of tenants) {
      try {
        const subscription = await this.stripe.subscriptions.retrieve(tenant.stripeSubscriptionId);

        const previousStatus = tenant.subscriptionStatus;
        const newStatus = this.mapStripeStatus(subscription.status);
        const newPeriodEnd = new Date(subscription.current_period_end * 1000);

        let changed = false;

        // Check if status changed
        if (tenant.subscriptionStatus !== newStatus) {
          tenant.subscriptionStatus = newStatus;
          changed = true;
        }

        // Check if period end changed
        if (
          !tenant.currentPeriodEnd ||
          tenant.currentPeriodEnd.getTime() !== newPeriodEnd.getTime()
        ) {
          tenant.currentPeriodEnd = newPeriodEnd;
          tenant.subscriptionExpiresAt = newPeriodEnd;
          changed = true;
        }

        // Check cancel_at_period_end
        if (tenant.cancelAtPeriodEnd !== subscription.cancel_at_period_end) {
          tenant.cancelAtPeriodEnd = subscription.cancel_at_period_end;
          changed = true;
        }

        if (changed) {
          await this.tenantRepository.save(tenant);
          syncedCount++;

          // Log the sync
          await this.logAuditEvent({
            tenantId: tenant.id,
            eventType: AuditEventType.STRIPE_SYNC_COMPLETED,
            stripeSubscriptionId: tenant.stripeSubscriptionId,
            previousStatus,
            newStatus,
            metadata: {
              currentPeriodEnd: newPeriodEnd.toISOString(),
              cancelAtPeriodEnd: subscription.cancel_at_period_end,
            },
          });

          this.logger.debug(`Synced tenant ${tenant.name}: ${previousStatus} -> ${newStatus}`);
        }
      } catch (error: any) {
        errorCount++;
        this.logger.error(`Failed to sync tenant ${tenant.name}: ${error.message}`);

        // Handle deleted subscriptions
        if (error.code === 'resource_missing') {
          tenant.subscriptionStatus = SubscriptionStatus.CANCELED;
          tenant.stripeSubscriptionId = null as any;
          await this.tenantRepository.save(tenant);

          await this.logAuditEvent({
            tenantId: tenant.id,
            eventType: AuditEventType.STRIPE_SYNC_FAILED,
            errorMessage: 'Subscription no longer exists in Stripe',
          });
        }
      }
    }

    this.logger.log(
      `Daily sync complete: ${syncedCount} updated, ${errorCount} errors, ${tenants.length} total`,
    );
  }

  // ==================== Dunning: Payment Failure Reminders ====================

  /**
   * Check for past due subscriptions and send reminder emails
   * Runs twice daily at 9 AM and 3 PM
   */
  @Cron('0 9,15 * * *') // 9 AM and 3 PM daily
  async sendPaymentFailureReminders(): Promise<void> {
    this.logger.log('Checking for past due subscriptions...');

    const pastDueTenants = await this.tenantRepository.find({
      where: {
        subscriptionStatus: SubscriptionStatus.PAST_DUE,
        status: In([TenantStatus.ACTIVE, TenantStatus.TRIAL]),
      },
      relations: ['subscriptionPlan', 'users'],
    });

    for (const tenant of pastDueTenants) {
      // Find admin users to notify
      const adminUsers =
        tenant.users?.filter((u) => u.role === 'building_admin' || u.role === 'super_admin') || [];

      for (const admin of adminUsers) {
        await this.sendDunningEmail(tenant, admin.email, 'payment_failed');
      }

      await this.logAuditEvent({
        tenantId: tenant.id,
        eventType: AuditEventType.DUNNING_EMAIL_SENT,
        metadata: { reason: 'payment_failed', recipientCount: adminUsers.length },
      });
    }

    this.logger.log(`Sent payment reminders to ${pastDueTenants.length} tenants`);
  }

  // ==================== Trial Expiry Warnings ====================

  /**
   * Send trial ending soon warnings
   * Runs daily at 10 AM
   */
  @Cron('0 10 * * *') // 10 AM daily
  async sendTrialExpiryWarnings(): Promise<void> {
    this.logger.log('Checking for expiring trials...');

    const now = new Date();
    const threeDaysFromNow = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
    const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    // Get trials expiring in 3 days (urgent) or 7 days (early warning)
    const expiringTrials = await this.tenantRepository.find({
      where: [
        {
          status: TenantStatus.TRIAL,
          subscriptionExpiresAt: LessThan(threeDaysFromNow),
        },
        {
          status: TenantStatus.TRIAL,
          subscriptionExpiresAt: LessThan(sevenDaysFromNow),
        },
      ],
      relations: ['subscriptionPlan', 'users'],
    });

    for (const tenant of expiringTrials) {
      if (!tenant.subscriptionExpiresAt) continue;

      const daysLeft = Math.ceil(
        (tenant.subscriptionExpiresAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000),
      );

      // Only send at 7 days and 3 days
      if (daysLeft !== 7 && daysLeft !== 3 && daysLeft !== 1) continue;

      const adminUsers =
        tenant.users?.filter((u) => u.role === 'building_admin' || u.role === 'super_admin') || [];

      for (const admin of adminUsers) {
        await this.sendTrialExpiryEmail(tenant, admin.email, daysLeft);
      }

      await this.logAuditEvent({
        tenantId: tenant.id,
        eventType: AuditEventType.TRIAL_ENDING_SOON,
        metadata: { daysLeft, recipientCount: adminUsers.length },
      });
    }

    this.logger.log(`Sent trial expiry warnings to ${expiringTrials.length} tenants`);
  }

  // ==================== Suspend Unpaid Accounts ====================

  /**
   * Suspend accounts that have been past due for too long
   * Runs daily at 4 AM
   */
  @Cron('0 4 * * *') // 4 AM daily
  async suspendUnpaidAccounts(): Promise<void> {
    this.logger.log('Checking for accounts to suspend...');

    const gracePeriodDays = this.configService.get<number>('PAYMENT_GRACE_PERIOD_DAYS', 14);
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - gracePeriodDays);

    // Find tenants with expired currentPeriodEnd and still active
    const overduetenants = await this.tenantRepository.find({
      where: {
        subscriptionStatus: In([SubscriptionStatus.PAST_DUE, SubscriptionStatus.UNPAID]),
        currentPeriodEnd: LessThan(cutoffDate),
        status: TenantStatus.ACTIVE,
      },
      relations: ['users'],
    });

    for (const tenant of overduetenants) {
      const previousStatus = tenant.status;
      tenant.status = TenantStatus.SUSPENDED;
      await this.tenantRepository.save(tenant);

      // Notify admins
      const adminUsers =
        tenant.users?.filter((u) => u.role === 'building_admin' || u.role === 'super_admin') || [];

      for (const admin of adminUsers) {
        await this.sendSuspensionEmail(tenant, admin.email);
      }

      await this.logAuditEvent({
        tenantId: tenant.id,
        eventType: AuditEventType.ACCOUNT_SUSPENDED,
        previousStatus,
        newStatus: TenantStatus.SUSPENDED,
        metadata: {
          reason: 'payment_overdue',
          gracePeriodDays,
          lastPeriodEnd: tenant.currentPeriodEnd?.toISOString(),
        },
      });

      this.eventEmitter.emit('tenant.suspended', { tenant, reason: 'payment_overdue' });
    }

    this.logger.log(`Suspended ${overduetenants.length} unpaid accounts`);
  }

  // ==================== Paused Subscription Reminders ====================

  /**
   * Send reminders for subscriptions about to auto-resume
   * Runs daily at 11 AM
   */
  @Cron('0 11 * * *') // 11 AM daily
  async sendPauseResumeReminders(): Promise<void> {
    this.logger.log('Checking for paused subscriptions about to resume...');

    const now = new Date();
    const threeDaysFromNow = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

    // Find paused subscriptions resuming in the next 3 days
    const resumingSoon = await this.tenantRepository.find({
      where: {
        isPaused: true,
        pauseResumesAt: LessThan(threeDaysFromNow),
      },
      relations: ['subscriptionPlan', 'users'],
    });

    for (const tenant of resumingSoon) {
      if (!tenant.pauseResumesAt) continue;

      const daysUntilResume = Math.ceil(
        (tenant.pauseResumesAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000),
      );

      // Only send at 3 days and 1 day
      if (daysUntilResume !== 3 && daysUntilResume !== 1) continue;

      const adminUsers =
        tenant.users?.filter((u) => u.role === 'building_admin' || u.role === 'super_admin') || [];

      for (const admin of adminUsers) {
        await this.sendPauseResumeReminderEmail(tenant, admin.email, daysUntilResume);
      }

      await this.logAuditEvent({
        tenantId: tenant.id,
        eventType: AuditEventType.DUNNING_EMAIL_SENT,
        metadata: {
          type: 'pause_resume_reminder',
          daysUntilResume,
          recipientCount: adminUsers.length,
        },
      });
    }

    this.logger.log(`Sent pause resume reminders to ${resumingSoon.length} tenants`);
  }

  // ==================== Refund Event Listeners ====================

  @OnEvent('refund.created')
  async handleRefundCreatedEvent(payload: {
    tenant: Tenant;
    refund: Stripe.Refund;
    amount: number;
    reason: string;
  }): Promise<void> {
    const { tenant, amount, reason } = payload;

    // Get admin users for this tenant
    const adminUsers = await this.tenantRepository
      .createQueryBuilder('tenant')
      .innerJoin('tenant.users', 'user')
      .where('tenant.id = :tenantId', { tenantId: tenant.id })
      .andWhere('user.role IN (:...roles)', { roles: ['super_admin', 'building_admin'] })
      .select(['user.email'])
      .getRawMany();

    for (const admin of adminUsers) {
      await this.sendRefundConfirmationEmail(tenant, admin.user_email, amount, reason);
    }

    this.logger.log(
      `Refund confirmation sent to ${adminUsers.length} admins for tenant ${tenant.name}`,
    );
  }

  @OnEvent('refund.processed')
  async handleRefundProcessedEvent(payload: {
    tenant: Tenant;
    charge: Stripe.Charge;
    amount: number;
    isFullRefund: boolean;
  }): Promise<void> {
    const { tenant, amount } = payload;

    // This event is from webhook - only send if not already sent by admin action
    // Check if we recently sent a refund email (within last 5 minutes)
    const recentLog = await this.auditLogRepository.findOne({
      where: {
        tenantId: tenant.id,
        eventType: In([AuditEventType.PAYMENT_REFUNDED, AuditEventType.PAYMENT_PARTIAL_REFUND]),
        createdAt: MoreThan(new Date(Date.now() - 5 * 60 * 1000)),
      },
      order: { createdAt: 'DESC' },
    });

    // If this was initiated by admin (has metadata), don't duplicate the email
    if (recentLog?.metadata && (recentLog.metadata as any).initiatedBy === 'admin') {
      return;
    }

    // Get admin users
    const adminUsers = await this.tenantRepository
      .createQueryBuilder('tenant')
      .innerJoin('tenant.users', 'user')
      .where('tenant.id = :tenantId', { tenantId: tenant.id })
      .andWhere('user.role IN (:...roles)', { roles: ['super_admin', 'building_admin'] })
      .select(['user.email'])
      .getRawMany();

    for (const admin of adminUsers) {
      await this.sendRefundConfirmationEmail(
        tenant,
        admin.user_email,
        amount,
        'refund_from_stripe',
      );
    }
  }

  @OnEvent('refund.failed')
  async handleRefundFailedEvent(payload: {
    tenant: Tenant;
    refund: Stripe.Refund;
    failureReason: string | null;
  }): Promise<void> {
    const { tenant, failureReason } = payload;

    // Get admin users
    const adminUsers = await this.tenantRepository
      .createQueryBuilder('tenant')
      .innerJoin('tenant.users', 'user')
      .where('tenant.id = :tenantId', { tenantId: tenant.id })
      .andWhere('user.role IN (:...roles)', { roles: ['super_admin', 'building_admin'] })
      .select(['user.email'])
      .getRawMany();

    for (const admin of adminUsers) {
      await this.sendRefundFailedEmail(tenant, admin.user_email, failureReason || 'Unknown error');
    }

    this.logger.warn(`Refund failed notification sent for tenant ${tenant.name}: ${failureReason}`);
  }

  // ==================== Email Templates ====================

  private async sendDunningEmail(tenant: Tenant, email: string, reason: string): Promise<void> {
    const frontendUrl = this.configService.get<string>('FRONTEND_URL', 'https://yaad.global');
    const billingUrl = `${frontendUrl}/billing/settings`;

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #f59e0b, #d97706); padding: 30px; border-radius: 12px 12px 0 0; text-align: center; }
          .header h1 { color: white; margin: 0; font-size: 24px; }
          .content { background: #fff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px; }
          .alert { background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin: 20px 0; border-radius: 4px; }
          .button { display: inline-block; background: #f59e0b; color: white !important; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; margin: 20px 0; }
          .footer { text-align: center; padding: 20px; color: #6b7280; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>⚠️ Payment Required</h1>
          </div>
          <div class="content">
            <p>Hi there,</p>
            <div class="alert">
              <strong>Action Required:</strong> We were unable to process your payment for <strong>${tenant.name}</strong>.
            </div>
            <p>Your subscription is currently past due. To avoid service interruption, please update your payment method as soon as possible.</p>
            <p>If you believe this is an error, please check with your bank or try a different payment method.</p>
            <center>
              <a href="${billingUrl}" class="button">Update Payment Method</a>
            </center>
            <p>If you have any questions, please contact our support team.</p>
          </div>
          <div class="footer">
            <p>Yaad - Smart Gate Management</p>
          </div>
        </div>
      </body>
      </html>
    `;

    await this.emailService.sendEmail({
      to: email,
      subject: `⚠️ Payment Failed - Action Required for ${tenant.name}`,
      html,
    });
  }

  private async sendTrialExpiryEmail(
    tenant: Tenant,
    email: string,
    daysLeft: number,
  ): Promise<void> {
    const frontendUrl = this.configService.get<string>('FRONTEND_URL', 'https://yaad.global');
    const billingUrl = `${frontendUrl}/billing/settings`;

    const urgency = daysLeft <= 3 ? 'urgent' : 'reminder';
    const headerColor = daysLeft <= 3 ? '#ef4444' : '#3b82f6';
    const emoji = daysLeft <= 3 ? '🔴' : '📅';

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: ${headerColor}; padding: 30px; border-radius: 12px 12px 0 0; text-align: center; }
          .header h1 { color: white; margin: 0; font-size: 24px; }
          .content { background: #fff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px; }
          .countdown { font-size: 48px; font-weight: bold; text-align: center; color: ${headerColor}; margin: 20px 0; }
          .button { display: inline-block; background: #10b981; color: white !important; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; margin: 20px 0; }
          .features { background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0; }
          .footer { text-align: center; padding: 20px; color: #6b7280; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>${emoji} Trial Ending Soon</h1>
          </div>
          <div class="content">
            <p>Hi there,</p>
            <p>Your free trial for <strong>${tenant.name}</strong> is ending soon:</p>
            <div class="countdown">${daysLeft} day${daysLeft === 1 ? '' : 's'} left</div>
            <div class="features">
              <strong>Don't lose access to:</strong>
              <ul>
                <li>Gate access control & monitoring</li>
                <li>Visitor pass management</li>
                <li>Real-time access logs</li>
                <li>Mobile access features</li>
              </ul>
            </div>
            <center>
              <a href="${billingUrl}" class="button">Subscribe Now →</a>
            </center>
            <p>Have questions? Reply to this email and we'll help you choose the right plan.</p>
          </div>
          <div class="footer">
            <p>Yaad - Smart Gate Management</p>
          </div>
        </div>
      </body>
      </html>
    `;

    await this.emailService.sendEmail({
      to: email,
      subject: `${emoji} Your trial ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'} - ${tenant.name}`,
      html,
    });
  }

  private async sendSuspensionEmail(tenant: Tenant, email: string): Promise<void> {
    const frontendUrl = this.configService.get<string>('FRONTEND_URL', 'https://yaad.global');
    const billingUrl = `${frontendUrl}/billing/settings`;

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #dc2626; padding: 30px; border-radius: 12px 12px 0 0; text-align: center; }
          .header h1 { color: white; margin: 0; font-size: 24px; }
          .content { background: #fff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px; }
          .alert { background: #fee2e2; border-left: 4px solid #dc2626; padding: 15px; margin: 20px 0; border-radius: 4px; }
          .button { display: inline-block; background: #10b981; color: white !important; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; margin: 20px 0; }
          .footer { text-align: center; padding: 20px; color: #6b7280; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🚫 Account Suspended</h1>
          </div>
          <div class="content">
            <p>Hi there,</p>
            <div class="alert">
              <strong>Your account has been suspended</strong> due to an unpaid balance.
            </div>
            <p>Access to <strong>${tenant.name}</strong> has been temporarily disabled. Your data is safe, but gate access features are currently unavailable.</p>
            <p>To restore your account immediately:</p>
            <center>
              <a href="${billingUrl}" class="button">Reactivate Account →</a>
            </center>
            <p>Once payment is received, your account will be automatically reactivated.</p>
            <p>If you need assistance, please contact our support team.</p>
          </div>
          <div class="footer">
            <p>Yaad - Smart Gate Management</p>
          </div>
        </div>
      </body>
      </html>
    `;

    await this.emailService.sendEmail({
      to: email,
      subject: `🚫 Account Suspended - ${tenant.name}`,
      html,
    });
  }

  private async sendPauseResumeReminderEmail(
    tenant: Tenant,
    email: string,
    daysUntilResume: number,
  ): Promise<void> {
    const frontendUrl = this.configService.get<string>('FRONTEND_URL', 'https://yaad.global');
    const billingUrl = `${frontendUrl}/billing/settings`;

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #8b5cf6, #6366f1); padding: 30px; border-radius: 12px 12px 0 0; text-align: center; }
          .header h1 { color: white; margin: 0; font-size: 24px; }
          .content { background: #fff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px; }
          .info-box { background: #ede9fe; border-left: 4px solid #8b5cf6; padding: 15px; margin: 20px 0; border-radius: 4px; }
          .countdown { font-size: 42px; font-weight: bold; text-align: center; color: #6366f1; margin: 20px 0; }
          .button { display: inline-block; background: #6366f1; color: white !important; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; margin: 10px 5px; }
          .button-secondary { background: #e5e7eb; color: #374151 !important; }
          .footer { text-align: center; padding: 20px; color: #6b7280; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>⏰ Your Subscription Resumes Soon</h1>
          </div>
          <div class="content">
            <p>Hi there,</p>
            <div class="info-box">
              Your paused subscription for <strong>${tenant.name}</strong> will automatically resume.
            </div>
            <div class="countdown">${daysUntilResume} day${daysUntilResume === 1 ? '' : 's'}</div>
            <p style="text-align: center; color: #6b7280;">until billing resumes</p>
            <p>When your subscription resumes:</p>
            <ul>
              <li>✅ Full access to all features will be restored</li>
              <li>✅ Your payment method will be charged</li>
              <li>✅ All gates and access controls will be reactivated</li>
            </ul>
            <center>
              <a href="${billingUrl}" class="button">Manage Subscription →</a>
            </center>
            <p style="margin-top: 20px; font-size: 14px; color: #6b7280;">
              Want to stay paused longer? You can extend your pause period or cancel from your billing settings.
            </p>
          </div>
          <div class="footer">
            <p>Yaad - Smart Gate Management</p>
          </div>
        </div>
      </body>
      </html>
    `;

    await this.emailService.sendEmail({
      to: email,
      subject: `⏰ Your subscription resumes in ${daysUntilResume} day${daysUntilResume === 1 ? '' : 's'} - ${tenant.name}`,
      html,
    });
  }

  // ==================== Helpers ====================

  private mapStripeStatus(status: Stripe.Subscription.Status): SubscriptionStatus {
    const statusMap: Record<string, SubscriptionStatus> = {
      trialing: SubscriptionStatus.TRIALING,
      active: SubscriptionStatus.ACTIVE,
      past_due: SubscriptionStatus.PAST_DUE,
      canceled: SubscriptionStatus.CANCELED,
      incomplete: SubscriptionStatus.INCOMPLETE,
      incomplete_expired: SubscriptionStatus.INCOMPLETE_EXPIRED,
      unpaid: SubscriptionStatus.UNPAID,
      paused: SubscriptionStatus.PAUSED,
    };
    return statusMap[status] || SubscriptionStatus.ACTIVE;
  }

  private async logAuditEvent(data: Partial<SubscriptionAuditLog>): Promise<void> {
    try {
      const log = this.auditLogRepository.create(data);
      await this.auditLogRepository.save(log);
    } catch (error) {
      this.logger.error('Failed to create audit log:', error);
    }
  }

  // ==================== Refund Email Notifications ====================

  /**
   * Send refund confirmation email
   */
  async sendRefundConfirmationEmail(
    tenant: Tenant,
    email: string,
    amount: number,
    reason: string,
  ): Promise<void> {
    const frontendUrl =
      this.configService.get<string>('FRONTEND_URL') || 'https://yaad.global';
    const billingUrl = `${frontendUrl}/billing`;
    const amountFormatted = `$${(amount / 100).toFixed(2)}`;

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background-color: #f3f4f6; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .card { background: white; border-radius: 12px; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
          .header { text-align: center; margin-bottom: 24px; }
          .amount { font-size: 36px; font-weight: bold; color: #10b981; margin: 16px 0; }
          .details { background: #f9fafb; border-radius: 8px; padding: 20px; margin: 20px 0; }
          .detail-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #e5e7eb; }
          .detail-row:last-child { border-bottom: none; }
          .footer { text-align: center; padding: 20px; color: #6b7280; font-size: 12px; }
          .button { display: inline-block; padding: 12px 24px; background: #3b82f6; color: white; text-decoration: none; border-radius: 8px; margin-top: 16px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="card">
            <div class="header">
              <div style="font-size: 48px;">💸</div>
              <h1 style="color: #111827; margin: 8px 0;">Refund Processed</h1>
            </div>
            <center>
              <p style="color: #6b7280; margin: 0;">Your refund has been successfully processed</p>
              <div class="amount">${amountFormatted}</div>
            </center>
            <div class="details">
              <div class="detail-row">
                <span style="color: #6b7280;">Building</span>
                <span style="font-weight: 500;">${tenant.name}</span>
              </div>
              <div class="detail-row">
                <span style="color: #6b7280;">Reason</span>
                <span style="font-weight: 500;">${this.formatRefundReason(reason)}</span>
              </div>
              <div class="detail-row">
                <span style="color: #6b7280;">Processing Time</span>
                <span style="font-weight: 500;">5-10 business days</span>
              </div>
            </div>
            <p style="color: #6b7280; font-size: 14px; text-align: center;">
              The refund will appear on your original payment method. Processing times vary by bank.
            </p>
            <center>
              <a href="${billingUrl}" class="button">View Billing Details →</a>
            </center>
          </div>
          <div class="footer">
            <p>Questions? Reply to this email or contact support.</p>
            <p>Yaad - Smart Gate Management</p>
          </div>
        </div>
      </body>
      </html>
    `;

    await this.emailService.sendEmail({
      to: email,
      subject: `✅ Refund Processed: ${amountFormatted} - ${tenant.name}`,
      html,
    });
  }

  /**
   * Send refund failed notification
   */
  async sendRefundFailedEmail(tenant: Tenant, email: string, failureReason: string): Promise<void> {
    const frontendUrl =
      this.configService.get<string>('FRONTEND_URL') || 'https://yaad.global';

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background-color: #f3f4f6; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .card { background: white; border-radius: 12px; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
          .header { text-align: center; margin-bottom: 24px; }
          .alert { background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 16px; margin: 20px 0; }
          .footer { text-align: center; padding: 20px; color: #6b7280; font-size: 12px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="card">
            <div class="header">
              <div style="font-size: 48px;">⚠️</div>
              <h1 style="color: #111827; margin: 8px 0;">Refund Processing Issue</h1>
            </div>
            <p style="color: #6b7280; text-align: center;">
              There was an issue processing your refund for ${tenant.name}.
            </p>
            <div class="alert">
              <strong style="color: #dc2626;">Reason:</strong>
              <p style="color: #7f1d1d; margin: 8px 0 0 0;">${failureReason || 'Unknown error'}</p>
            </div>
            <p style="color: #6b7280; font-size: 14px; text-align: center;">
              Our team has been notified and will process your refund manually. 
              No action is required from you. We'll send a confirmation once complete.
            </p>
          </div>
          <div class="footer">
            <p>Yaad - Smart Gate Management</p>
          </div>
        </div>
      </body>
      </html>
    `;

    await this.emailService.sendEmail({
      to: email,
      subject: `⚠️ Refund Processing Issue - ${tenant.name}`,
      html,
    });
  }

  private formatRefundReason(reason: string): string {
    const reasonMap: Record<string, string> = {
      duplicate: 'Duplicate charge',
      fraudulent: 'Fraudulent charge',
      requested_by_customer: 'Customer request',
      service_not_rendered: 'Service not rendered',
      downgrade: 'Plan downgrade credit',
      cancellation: 'Subscription cancellation',
      billing_error: 'Billing error correction',
      other: 'Other',
    };
    return reasonMap[reason] || reason;
  }
}
