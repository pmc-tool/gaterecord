/**
 * Stripe Module
 *
 * Handles Stripe integration for subscriptions, billing, and webhooks.
 *
 * Webhook Endpoint:
 * - POST /api/v1/webhooks/stripe - Receives Stripe webhook events
 *
 * Billing API (JWT required, Building Admin+):
 * - POST /api/v1/billing/checkout - Create checkout session
 * - POST /api/v1/billing/portal - Create customer portal session
 * - GET  /api/v1/billing/subscription - Get subscription details
 * - POST /api/v1/billing/cancel - Cancel subscription
 * - POST /api/v1/billing/resume - Resume canceled subscription
 *
 * Admin API (Super Admin only):
 * - POST /api/v1/admin/stripe/sync-plan - Sync single plan to Stripe
 * - POST /api/v1/admin/stripe/sync-all - Sync all plans to Stripe
 *
 * Scheduled Jobs:
 * - Daily Stripe sync (3 AM) - Catch missed webhooks
 * - Payment failure reminders (9 AM, 3 PM) - Dunning emails
 * - Trial expiry warnings (10 AM) - 7 days, 3 days, 1 day
 * - Suspend unpaid accounts (4 AM) - After grace period
 *
 * Configuration (.env):
 * - STRIPE_SECRET_KEY: Stripe secret key (sk_test_... or sk_live_...)
 * - STRIPE_WEBHOOK_SECRET: Webhook signing secret (whsec_...)
 * - FRONTEND_URL: For checkout success/cancel URLs
 * - PAYMENT_GRACE_PERIOD_DAYS: Days before suspension (default: 14)
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';

import { StripeService } from './stripe.service';
import { StripeScheduler } from './stripe.scheduler';
import { DefaultPlanExpiryCron } from './default-plan-expiry.cron';
import { StripeController, BillingController, AdminStripeController } from './stripe.controller';

import { SubscriptionPlan } from '@database/entities/subscription-plan.entity';
import { Tenant } from '@database/entities/tenant.entity';
import { User } from '@database/entities/user.entity';
import { SubscriptionAuditLog } from '@database/entities/subscription-audit-log.entity';
import { Payment } from '@database/entities/payment.entity';
import { NotificationModule } from '../notification/notification.module';

@Module({
  imports: [
    ConfigModule,
    ScheduleModule.forRoot(),
    TypeOrmModule.forFeature([SubscriptionPlan, Tenant, User, SubscriptionAuditLog, Payment]),
    NotificationModule,
  ],
  controllers: [StripeController, BillingController, AdminStripeController],
  providers: [StripeService, StripeScheduler, DefaultPlanExpiryCron],
  exports: [StripeService],
})
export class StripeModule {}
