/**
 * Stripe Service
 * Handles all Stripe-related operations: products, prices, subscriptions, webhooks
 */

import {
  Injectable,
  Logger,
  OnModuleInit,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Stripe from 'stripe';
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';

import { EmailService } from '@modules/notification/email.service';

import { SubscriptionPlan } from '@database/entities/subscription-plan.entity';
import {
  Tenant,
  TenantStatus,
  BillingCycle,
  SubscriptionStatus,
} from '@database/entities/tenant.entity';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import { Gate } from '@database/entities/gate.entity';
import { Vehicle } from '@database/entities/vehicle.entity';
import {
  SubscriptionAuditLog,
  AuditEventType,
} from '@database/entities/subscription-audit-log.entity';
import {
  Payment,
  PaymentType,
  PaymentStatus,
  TransactionType,
} from '@database/entities/payment.entity';
import {
  CreateCheckoutSessionDto,
  SignupCheckoutDto,
  CheckoutSessionResponse,
  PortalSessionResponse,
  StripeSubscriptionDetails,
  CreateRefundDto,
  RefundResult,
  RefundCalculation,
  RefundHistory,
  RefundReason,
} from './dto';

/**
 * Tags SetupIntents minted for the in-app Stripe Elements checkout
 * (createSubscriptionIntent). The setup_intent.succeeded webhook acts ONLY on
 * SetupIntents carrying this source, so card saves from any other flow (e.g. the
 * hosted billing portal) are left untouched.
 */
const INAPP_SUBSCRIPTION_SOURCE = 'inapp_subscription_intent';

// Financial Overview interfaces
export interface FinancialOverview {
  mrr: number; // Monthly Recurring Revenue
  arr: number; // Annual Recurring Revenue
  revenueGrowth: number; // Percentage change from last month
  totalRevenue: number; // All-time revenue
  totalRefunds: number; // All-time refunds
  netRevenue: number; // Total - Refunds
  activeSubscriptions: number;
  churnRate: number; // Percentage of cancellations
  averageRevenuePerUser: number; // ARPU
  currency: string;
}

export interface PaymentSummary {
  totalPayments: number;
  successfulPayments: number;
  failedPayments: number;
  totalRefunds: number;
  totalAmount: number;
  refundedAmount: number;
  netAmount: number;
}

export interface RevenueByPeriod {
  period: string; // e.g., "2026-04"
  revenue: number;
  refunds: number;
  net: number;
  transactions: number;
}

// Phase 6 — payment visibility response shapes (shared with the frontend agents).

/** One row of a tenant's Stripe invoice history (building-admin billing page). */
export interface TenantInvoice {
  id: string;
  number: string | null; // Stripe human invoice number, e.g. "A1B2C3-0001"
  status: string | null; // draft | open | paid | uncollectible | void
  amountDue: number; // major units (USD dollars), converted from Stripe cents
  amountPaid: number;
  amountRemaining: number;
  currency: string;
  created: Date;
  periodStart: Date | null;
  periodEnd: Date | null;
  dueDate: Date | null;
  hostedInvoiceUrl: string | null; // Stripe-hosted invoice page
  invoicePdf: string | null; // direct PDF download
  description: string | null;
}

/** A recent payment row in the super-admin revenue snapshot. */
export interface RecentPaymentSummary {
  id: string;
  tenantId: string;
  tenantName: string | null;
  planName: string | null;
  amount: number; // major units (USD dollars) as stored in the payments table
  currency: string;
  status: PaymentStatus;
  transactionType: TransactionType;
  paymentType: PaymentType;
  cardBrand: string | null;
  cardLast4: string | null;
  createdAt: Date;
}

/** Platform-wide billing snapshot for the super-admin revenue endpoint. */
export interface RevenueSnapshot {
  mrr: number;
  arr: number;
  totalRevenue: number;
  totalRefunds: number;
  netRevenue: number;
  revenueGrowth: number; // % vs last month
  churnRate: number; // %
  averageRevenuePerUser: number;
  activeSubscriptions: number;
  currency: string;
  counts: {
    total: number;
    active: number;
    trial: number;
    suspended: number;
    pendingPayment: number;
    pastDue: number;
  };
  recentPayments: RecentPaymentSummary[];
}

@Injectable()
export class StripeService implements OnModuleInit {
  private readonly logger = new Logger(StripeService.name);
  private stripe!: Stripe;

  constructor(
    private configService: ConfigService,
    private eventEmitter: EventEmitter2,
    private emailService: EmailService,
    @InjectRepository(SubscriptionPlan)
    private planRepository: Repository<SubscriptionPlan>,
    @InjectRepository(Tenant)
    private tenantRepository: Repository<Tenant>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(SubscriptionAuditLog)
    private auditLogRepository: Repository<SubscriptionAuditLog>,
    @InjectRepository(Payment)
    private paymentRepository: Repository<Payment>,
  ) {}

  onModuleInit() {
    const secretKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    if (!secretKey) {
      this.logger.warn('STRIPE_SECRET_KEY not configured - Stripe disabled');
      return;
    }

    this.stripe = new Stripe(secretKey);
    this.logger.log('Stripe initialized');
  }

  private ensureStripe() {
    if (!this.stripe) {
      throw new BadRequestException('Stripe is not configured');
    }
  }

  /**
   * Extract subscription ID from session.subscription
   * Can be either a string ID or an expanded Subscription object
   */
  private extractSubscriptionId(subscription: string | Stripe.Subscription | null): string | null {
    if (!subscription) return null;
    if (typeof subscription === 'string') return subscription;
    if (typeof subscription === 'object' && 'id' in subscription) return subscription.id;
    return null;
  }

  // ==================== Product & Price Management ====================

  /**
   * Calculate the effective price after applying discount
   * Checks if discount is valid (not expired) before applying
   */
  private calculateEffectivePrice(basePrice: number, discountPercent: number, discountValidUntil: Date | null): number {
    // Check if discount is valid
    if (discountPercent <= 0) {
      return basePrice;
    }

    // Check if discount has expired
    if (discountValidUntil && new Date(discountValidUntil) < new Date()) {
      return basePrice;
    }

    // Apply discount
    const discountedPrice = basePrice * (1 - discountPercent / 100);
    return Math.round(discountedPrice * 100) / 100; // Round to 2 decimals
  }

  /**
   * Sync a plan to Stripe - creates/updates Product and Prices
   * Applies any active discounts to the Stripe price
   */
  async syncPlanToStripe(planId: string): Promise<SubscriptionPlan> {
    this.ensureStripe();

    const plan = await this.planRepository.findOne({ where: { id: planId } });
    if (!plan) {
      throw new NotFoundException('Plan not found');
    }

    // Create or update Product
    let product: Stripe.Product;
    if (plan.stripeProductId) {
      product = await this.stripe.products.update(plan.stripeProductId, {
        name: plan.name,
        description: plan.description || undefined,
        metadata: {
          planId: plan.id,
          maxGates: String(plan.maxGates),
          maxUsers: String(plan.maxUsers),
        },
      });
    } else {
      product = await this.stripe.products.create({
        name: plan.name,
        description: plan.description || undefined,
        metadata: {
          planId: plan.id,
          maxGates: String(plan.maxGates),
          maxUsers: String(plan.maxUsers),
        },
      });
      plan.stripeProductId = product.id;
    }

    // Calculate effective prices with discount applied
    const effectiveMonthlyPrice = this.calculateEffectivePrice(
      Number(plan.monthlyPrice),
      Number(plan.discountPercent),
      plan.discountValidUntil,
    );
    const effectiveYearlyPrice = this.calculateEffectivePrice(
      Number(plan.yearlyPrice),
      Number(plan.discountPercent),
      plan.discountValidUntil,
    );

    // Create Monthly Price (or update by creating new if changed)
    const monthlyPriceCents = Math.round(effectiveMonthlyPrice * 100);
    if (
      !plan.stripePriceIdMonthly ||
      (await this.priceNeedsUpdate(plan.stripePriceIdMonthly, monthlyPriceCents))
    ) {
      // Archive old price if exists
      if (plan.stripePriceIdMonthly) {
        await this.stripe.prices.update(plan.stripePriceIdMonthly, { active: false });
      }
      const monthlyPrice = await this.stripe.prices.create({
        product: product.id,
        unit_amount: monthlyPriceCents,
        currency: 'usd',
        recurring: { interval: 'month' },
        metadata: {
          planId: plan.id,
          billingCycle: 'monthly',
          originalPrice: String(plan.monthlyPrice),
          discountPercent: String(plan.discountPercent || 0),
        },
      });
      plan.stripePriceIdMonthly = monthlyPrice.id;
    }

    // Create Yearly Price
    const yearlyPriceCents = Math.round(effectiveYearlyPrice * 100);
    if (
      !plan.stripePriceIdYearly ||
      (await this.priceNeedsUpdate(plan.stripePriceIdYearly, yearlyPriceCents))
    ) {
      if (plan.stripePriceIdYearly) {
        await this.stripe.prices.update(plan.stripePriceIdYearly, { active: false });
      }
      const yearlyPrice = await this.stripe.prices.create({
        product: product.id,
        unit_amount: yearlyPriceCents,
        currency: 'usd',
        recurring: { interval: 'year' },
        metadata: {
          planId: plan.id,
          billingCycle: 'yearly',
          originalPrice: String(plan.yearlyPrice),
          discountPercent: String(plan.discountPercent || 0),
        },
      });
      plan.stripePriceIdYearly = yearlyPrice.id;
    }

    await this.planRepository.save(plan);
    this.logger.log(
      `Synced plan ${plan.name} to Stripe: ${product.id} (Monthly: $${effectiveMonthlyPrice}, Yearly: $${effectiveYearlyPrice})`,
    );
    return plan;
  }

  private async priceNeedsUpdate(priceId: string, expectedAmount: number): Promise<boolean> {
    try {
      const price = await this.stripe.prices.retrieve(priceId);
      return price.unit_amount !== expectedAmount;
    } catch {
      return true;
    }
  }

  /**
   * Sync all active plans to Stripe
   */
  async syncAllPlansToStripe(): Promise<void> {
    const plans = await this.planRepository.find({ where: { isActive: true } });
    for (const plan of plans) {
      await this.syncPlanToStripe(plan.id);
    }
    this.logger.log(`Synced ${plans.length} plans to Stripe`);
  }

  // ==================== Customer Management ====================

  /**
   * Create or get Stripe customer for a tenant
   */
  async ensureStripeCustomer(tenant: Tenant): Promise<string> {
    this.ensureStripe();

    if (tenant.stripeCustomerId) {
      return tenant.stripeCustomerId;
    }

    const customer = await this.stripe.customers.create({
      email: tenant.contactEmail,
      name: tenant.name,
      metadata: {
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
      },
    });

    tenant.stripeCustomerId = customer.id;
    await this.tenantRepository.save(tenant);
    this.logger.log(`Created Stripe customer ${customer.id} for tenant ${tenant.name}`);
    return customer.id;
  }

  // ==================== Checkout & Billing Portal ====================

  /**
   * Create Stripe Checkout Session for subscription
   */
  async createCheckoutSession(
    tenantId: string,
    dto: CreateCheckoutSessionDto,
  ): Promise<CheckoutSessionResponse> {
    this.ensureStripe();

    const tenant = await this.tenantRepository.findOne({
      where: { id: tenantId },
      relations: ['subscriptionPlan'],
    });
    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    // Guard: a tenant that already holds a LIVE Stripe subscription must not open a
    // second Checkout Session — that would create a duplicate subscription in Stripe
    // (double-billing) and orphan the first one. Switching plans is a plan CHANGE
    // (POST /billing/plans/change) which prorates and runs the downgrade fit-check.
    // Trial-without-subscription, cancelled and never-subscribed tenants have no live
    // stripeSubscriptionId and fall through to normal checkout so they can (re)subscribe.
    const liveSubscriptionStatuses = [
      SubscriptionStatus.ACTIVE,
      SubscriptionStatus.TRIALING,
      SubscriptionStatus.PAST_DUE,
      SubscriptionStatus.PAUSED,
    ];
    if (
      tenant.stripeSubscriptionId &&
      liveSubscriptionStatuses.includes(tenant.subscriptionStatus)
    ) {
      // Verify the subscription actually still exists in Stripe before blocking.
      // If it was deleted directly in Stripe (without a webhook updating our DB),
      // the tenant is stuck in limbo — clear the stale data and let them re-subscribe.
      let stripeSubGone = false;
      try {
        const stripeSub = await this.stripe.subscriptions.retrieve(tenant.stripeSubscriptionId);
        if (stripeSub.status === 'canceled') {
          stripeSubGone = true;
        }
      } catch {
        stripeSubGone = true;
      }

      if (stripeSubGone) {
        this.logger.warn(
          `Tenant ${tenant.id} has stale stripeSubscriptionId ${tenant.stripeSubscriptionId} that no longer exists in Stripe. Clearing stale data.`,
        );
        tenant.stripeSubscriptionId = null as any;
        tenant.subscriptionStatus = SubscriptionStatus.CANCELED;
        await this.tenantRepository.save(tenant);
      } else {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          code: 'SUBSCRIPTION_ALREADY_ACTIVE',
          message:
            'You already have an active subscription. Use Change Plan to switch — your price is prorated automatically.',
        });
      }
    }

    let plan = await this.planRepository.findOne({ where: { id: dto.planId } });
    if (!plan) {
      throw new NotFoundException('Plan not found');
    }

    // Auto-sync plan to Stripe if not already synced
    if (!plan.stripePriceIdMonthly || !plan.stripePriceIdYearly) {
      this.logger.log(`Auto-syncing plan ${plan.name} to Stripe...`);
      plan = await this.syncPlanToStripe(plan.id);
    }

    const priceId =
      dto.billingCycle === BillingCycle.MONTHLY
        ? plan.stripePriceIdMonthly
        : plan.stripePriceIdYearly;

    if (!priceId) {
      throw new BadRequestException('Plan not synced to Stripe. Please contact support.');
    }

    const customerId = await this.ensureStripeCustomer(tenant);
    const frontendUrl = this.configService.get<string>('FRONTEND_URL') || 'https://yaad.global';

    const session = await this.stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      subscription_data: {
        // No-trial system: paid plans are charged immediately. New users get the
        // free plan, not a trial — this matches the in-app checkout and the
        // pricing/summary UI, so no path silently grants a trial period.
        metadata: {
          tenantId: tenant.id,
          planId: plan.id,
          billingCycle: dto.billingCycle,
        },
      },
      success_url: dto.successUrl || `${frontendUrl}/gate-management/billing/settings?success=true`,
      cancel_url: dto.cancelUrl || `${frontendUrl}/gate-management/billing/settings?canceled=true`,
      metadata: {
        tenantId: tenant.id,
        planId: plan.id,
        billingCycle: dto.billingCycle,
      },
    });

    return {
      sessionId: session.id,
      url: session.url!,
    };
  }

  /**
   * In-app Stripe Elements checkout: mint a SetupIntent so a tenant can enter
   * card details WITHOUT leaving the app, then confirm it with
   * stripe.confirmSetup() on the page.
   *
   * DELIBERATELY creates nothing else — no subscription, no tenant mutation. The
   * subscription is built later, ONLY once the card is actually confirmed, by the
   * setup_intent.succeeded webhook (handleSetupIntentSucceeded). This is the
   * whole safety property: abandoning the card step has zero side effects (an
   * unused SetupIntent simply expires), and — critically — a Free-plan tenant who
   * starts then abandons an upgrade can never be left pointing at an `incomplete`
   * subscription that a later `incomplete_expired` webhook would suspend. Money
   * and tenant state change only on a real, Stripe-verified event, exactly like
   * hosted checkout.
   *
   * The same guards as createCheckoutSession apply: a tenant with a live Stripe
   * subscription must switch via Change Plan (proration), never mint a second one.
   */
  async createSubscriptionIntent(
    tenantId: string,
    dto: CreateCheckoutSessionDto,
  ): Promise<{ clientSecret: string }> {
    this.ensureStripe();

    const tenant = await this.tenantRepository.findOne({
      where: { id: tenantId },
      relations: ['subscriptionPlan'],
    });
    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    // Same live-subscription guard as createCheckoutSession — switching an active
    // subscription is a plan CHANGE (prorated), not a fresh charge.
    const liveSubscriptionStatuses = [
      SubscriptionStatus.ACTIVE,
      SubscriptionStatus.TRIALING,
      SubscriptionStatus.PAST_DUE,
      SubscriptionStatus.PAUSED,
    ];
    if (
      tenant.stripeSubscriptionId &&
      liveSubscriptionStatuses.includes(tenant.subscriptionStatus)
    ) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'SUBSCRIPTION_ALREADY_ACTIVE',
        message:
          'You already have an active subscription. Use Change Plan to switch — your price is prorated automatically.',
      });
    }

    let plan = await this.planRepository.findOne({ where: { id: dto.planId } });
    if (!plan) {
      throw new NotFoundException('Plan not found');
    }

    // The Free/default plan is auto-assigned and has no price — nothing to charge.
    if (plan.isDefault) {
      throw new BadRequestException('The default plan does not require payment.');
    }

    // Auto-sync plan to Stripe if not already synced (mirrors createCheckoutSession)
    if (!plan.stripePriceIdMonthly || !plan.stripePriceIdYearly) {
      this.logger.log(`Auto-syncing plan ${plan.name} to Stripe...`);
      plan = await this.syncPlanToStripe(plan.id);
    }

    const priceId =
      dto.billingCycle === BillingCycle.MONTHLY
        ? plan.stripePriceIdMonthly
        : plan.stripePriceIdYearly;
    if (!priceId) {
      throw new BadRequestException(
        'Plan not synced to Stripe. Please contact support.',
      );
    }

    const customerId = await this.ensureStripeCustomer(tenant);

    // Card-only SetupIntent. This MUST match how the frontend Elements is mounted
    // (paymentMethodTypes: ['card']) or stripe.confirmSetup() rejects with a
    // payment_method_types mismatch. Card-only keeps checkout to a single method
    // and collects no extra data. usage:'off_session' so the saved card can back
    // recurring invoices. Everything the webhook needs to build the exact
    // subscription the user was quoted — including the resolved priceId — travels
    // in metadata, so the webhook never re-resolves and cannot drift.
    const setupIntent = await this.stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ['card'],
      usage: 'off_session',
      metadata: {
        source: INAPP_SUBSCRIPTION_SOURCE,
        tenantId: tenant.id,
        planId: plan.id,
        priceId,
        billingCycle: dto.billingCycle,
      },
    });

    if (!setupIntent.client_secret) {
      throw new BadRequestException(
        'Could not initialize payment. Please try again.',
      );
    }

    this.logger.log(
      `Created in-app SetupIntent ${setupIntent.id} for tenant ${tenant.name} (plan ${plan.name}, ${dto.billingCycle})`,
    );

    return { clientSecret: setupIntent.client_secret };
  }

  /**
   * Create Stripe Checkout Session for NEW SIGNUP (no account created yet)
   * Account will be created when payment succeeds via webhook
   */
  async createSignupCheckoutSession(dto: SignupCheckoutDto): Promise<CheckoutSessionResponse> {
    this.ensureStripe();

    // Validate email doesn't exist
    const existingUser = await this.userRepository.findOne({
      where: { email: dto.email.toLowerCase() },
    });
    if (existingUser) {
      throw new ConflictException('Email already registered');
    }

    // Validate building name doesn't exist
    const existingTenant = await this.tenantRepository.findOne({
      where: { name: dto.buildingName },
    });
    if (existingTenant) {
      throw new ConflictException('Building name already registered');
    }

    // Get the plan
    let plan = await this.planRepository.findOne({ where: { id: dto.planId } });
    if (!plan) {
      throw new NotFoundException('Plan not found');
    }

    // Auto-sync plan to Stripe if not already synced
    if (!plan.stripePriceIdMonthly || !plan.stripePriceIdYearly) {
      this.logger.log(`Auto-syncing plan ${plan.name} to Stripe...`);
      plan = await this.syncPlanToStripe(plan.id);
    }

    const priceId =
      dto.billingCycle === BillingCycle.MONTHLY
        ? plan.stripePriceIdMonthly
        : plan.stripePriceIdYearly;

    if (!priceId) {
      throw new BadRequestException('Plan not synced to Stripe. Please contact support.');
    }

    const frontendUrl = this.configService.get<string>('FRONTEND_URL') || 'https://yaad.global';

    // Hash password before storing in metadata (we'll use this after payment succeeds)
    const passwordHash = await bcrypt.hash(dto.password, 10);

    // Determine if trial should be applied
    // skipTrial = true means "Pay & Subscribe" was clicked (charge immediately)
    // skipTrial = false or undefined means "Free Trial" was clicked (use trial period)
    const useTrialDays = dto.skipTrial !== true && plan.trialDays > 0 ? plan.trialDays : undefined;

    // Store ALL signup data in session metadata
    // This will be used to create the account after successful payment
    const session = await this.stripe.checkout.sessions.create({
      customer_email: dto.email.toLowerCase(),
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      subscription_data: {
        trial_period_days: useTrialDays,
        metadata: {
          type: 'signup', // Identifies this as a signup checkout
          planId: plan.id,
          billingCycle: dto.billingCycle,
          skipTrial: dto.skipTrial ? 'true' : 'false',
        },
      },
      success_url:
        dto.successUrl ||
        `${frontendUrl}/gate-management/billing/settings?success=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: dto.cancelUrl || `${frontendUrl}/gate-management/billing?canceled=true`,
      metadata: {
        type: 'signup', // Important: identifies this as a signup checkout
        firstName: dto.firstName,
        lastName: dto.lastName,
        email: dto.email.toLowerCase(),
        passwordHash: passwordHash,
        phone: dto.phone || '',
        buildingName: dto.buildingName,
        buildingAddress: dto.buildingAddress || '',
        planId: plan.id,
        billingCycle: dto.billingCycle,
      },
    });

    this.logger.log(`Signup checkout session created for ${dto.email}`);

    return {
      sessionId: session.id,
      url: session.url!,
    };
  }

  /**
   * Create Stripe Billing Portal session
   */
  async createPortalSession(tenantId: string, returnUrl?: string): Promise<PortalSessionResponse> {
    this.ensureStripe();

    const tenant = await this.tenantRepository.findOne({ where: { id: tenantId } });
    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    if (!tenant.stripeCustomerId) {
      throw new BadRequestException('No Stripe customer associated with this tenant');
    }

    const frontendUrl = this.configService.get<string>('FRONTEND_URL') || 'https://yaad.global';

    const session = await this.stripe.billingPortal.sessions.create({
      customer: tenant.stripeCustomerId,
      return_url: returnUrl || `${frontendUrl}/gate-management/billing/settings`,
    });

    return { url: session.url };
  }

  // ==================== Subscription Management ====================

  /**
   * Get subscription details for a tenant
   */
  async getSubscriptionDetails(tenantId: string): Promise<StripeSubscriptionDetails | null> {
    this.ensureStripe();

    const tenant = await this.tenantRepository.findOne({
      where: { id: tenantId },
      relations: ['subscriptionPlan'],
    });

    if (!tenant) {
      return null;
    }

    // Handle trial users (no Stripe subscription yet)
    if (!tenant.stripeSubscriptionId) {
      // If tenant is in trialing status, return trial info
      if (tenant.subscriptionStatus === SubscriptionStatus.TRIALING) {
        return {
          subscriptionId: 'trial',
          status: 'trialing',
          currentPeriodEnd: tenant.subscriptionExpiresAt || new Date(),
          cancelAtPeriodEnd: false,
          planName: tenant.subscriptionPlan?.name || 'Basic',
          billingCycle: tenant.billingCycle,
          monthlyAmount: 0,
          nextBillingDate: tenant.subscriptionExpiresAt || new Date(),
          isTrial: true,
          trialEndDate: tenant.subscriptionExpiresAt,
          isPaused: false,
        };
      }
      return null;
    }

    const subscription = await this.stripe.subscriptions.retrieve(tenant.stripeSubscriptionId);

    return {
      subscriptionId: subscription.id,
      status: subscription.status,
      currentPeriodEnd: new Date(subscription.current_period_end * 1000),
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      planName: tenant.subscriptionPlan?.name || 'Unknown',
      billingCycle: tenant.billingCycle,
      monthlyAmount: subscription.items.data[0]?.price?.unit_amount
        ? subscription.items.data[0].price.unit_amount / 100
        : 0,
      nextBillingDate: new Date(subscription.current_period_end * 1000),
      // Pause info
      isPaused: tenant.isPaused,
      pausedAt: tenant.pausedAt || undefined,
      pauseResumesAt: tenant.pauseResumesAt || undefined,
      pauseReason: tenant.pauseReason || undefined,
    };
  }

  /**
   * Cancel subscription
   */
  async cancelSubscription(tenantId: string, immediately: boolean = false): Promise<void> {
    this.ensureStripe();

    const tenant = await this.tenantRepository.findOne({ where: { id: tenantId } });
    if (!tenant?.stripeSubscriptionId) {
      throw new BadRequestException('No active subscription');
    }

    if (immediately) {
      await this.stripe.subscriptions.cancel(tenant.stripeSubscriptionId);
      tenant.subscriptionStatus = SubscriptionStatus.CANCELED;
      // Mirror handleSubscriptionDeleted so "Cancel immediately — lose access now"
      // holds even before the customer.subscription.deleted webhook lands (local
      // dev has no webhook). Idempotent: the webhook sets the same state. Access is
      // restored to ACTIVE on re-subscribe (handleCheckoutCompleted).
      tenant.status = TenantStatus.SUSPENDED;
      tenant.stripeSubscriptionId = null as any;
    } else {
      await this.stripe.subscriptions.update(tenant.stripeSubscriptionId, {
        cancel_at_period_end: true,
      });
      tenant.cancelAtPeriodEnd = true;
    }

    await this.tenantRepository.save(tenant);
    this.logger.log(`Subscription canceled for tenant ${tenant.name} (immediate: ${immediately})`);
  }

  /**
   * Resume a canceled subscription (if cancel_at_period_end was true)
   */
  async resumeSubscription(tenantId: string): Promise<void> {
    this.ensureStripe();

    const tenant = await this.tenantRepository.findOne({ where: { id: tenantId } });
    if (!tenant?.stripeSubscriptionId) {
      throw new BadRequestException('No active subscription');
    }

    await this.stripe.subscriptions.update(tenant.stripeSubscriptionId, {
      cancel_at_period_end: false,
    });

    tenant.cancelAtPeriodEnd = false;
    await this.tenantRepository.save(tenant);
    this.logger.log(`Subscription resumed for tenant ${tenant.name}`);
  }

  // ==================== Subscription Pause (Spotify/Netflix Style) ====================

  /**
   * Pause a subscription
   * - Stops billing but keeps the subscription active
   * - User retains limited access (configurable)
   * - Can auto-resume after a set period (max 1 year)
   */
  async pauseSubscription(
    tenantId: string,
    options: {
      resumesAt?: Date;
      reason?: string;
      behavior?: 'keep_as_draft' | 'mark_uncollectible' | 'void';
    } = {},
  ): Promise<{ success: boolean; pausedUntil?: Date }> {
    this.ensureStripe();

    const tenant = await this.tenantRepository.findOne({
      where: { id: tenantId },
      relations: ['subscriptionPlan'],
    });

    if (!tenant?.stripeSubscriptionId) {
      throw new BadRequestException('No active subscription to pause');
    }

    if (tenant.isPaused) {
      throw new BadRequestException('Subscription is already paused');
    }

    // Validate status - can only pause active subscriptions
    if (tenant.subscriptionStatus !== SubscriptionStatus.ACTIVE) {
      throw new BadRequestException(
        `Cannot pause subscription with status: ${tenant.subscriptionStatus}`,
      );
    }

    // Calculate resume date (default: 1 month, max: 1 year)
    const resumesAt = options.resumesAt;
    if (resumesAt) {
      const maxResumeDate = new Date();
      maxResumeDate.setFullYear(maxResumeDate.getFullYear() + 1);

      if (resumesAt > maxResumeDate) {
        throw new BadRequestException('Pause duration cannot exceed 1 year');
      }

      if (resumesAt <= new Date()) {
        throw new BadRequestException('Resume date must be in the future');
      }
    }

    // Pause in Stripe using pause_collection
    const pauseConfig: Stripe.SubscriptionUpdateParams.PauseCollection = {
      behavior: options.behavior || 'void',
    };

    if (resumesAt) {
      pauseConfig.resumes_at = Math.floor(resumesAt.getTime() / 1000);
    }

    await this.stripe.subscriptions.update(tenant.stripeSubscriptionId, {
      pause_collection: pauseConfig,
      metadata: {
        ...(tenant.settings as Record<string, string>),
        pauseReason: options.reason || 'User requested pause',
        pausedAt: new Date().toISOString(),
      },
    });

    // Update local database
    const previousStatus = tenant.subscriptionStatus;
    tenant.isPaused = true;
    tenant.pausedAt = new Date();
    tenant.pauseResumesAt = resumesAt || (null as any);
    tenant.pauseReason = options.reason || (null as any);
    tenant.subscriptionStatus = SubscriptionStatus.PAUSED;

    await this.tenantRepository.save(tenant);

    // Audit log
    await this.logAuditEvent({
      tenantId: tenant.id,
      eventType: AuditEventType.SUBSCRIPTION_UPDATED,
      stripeSubscriptionId: tenant.stripeSubscriptionId,
      previousStatus,
      newStatus: SubscriptionStatus.PAUSED,
      metadata: {
        action: 'pause',
        reason: options.reason,
        resumesAt: resumesAt?.toISOString(),
      },
    });

    this.logger.log(`Subscription paused for tenant ${tenant.name}`);
    this.eventEmitter.emit('subscription.paused', {
      tenant,
      resumesAt,
      reason: options.reason,
    });

    return {
      success: true,
      pausedUntil: resumesAt,
    };
  }

  /**
   * Resume a paused subscription
   * - Immediately resumes billing
   * - Can optionally reset the billing cycle anchor
   */
  async unpauseSubscription(
    tenantId: string,
    options: { billingCycleAnchor?: boolean } = {},
  ): Promise<{ success: boolean; nextBillingDate: Date }> {
    this.ensureStripe();

    const tenant = await this.tenantRepository.findOne({
      where: { id: tenantId },
      relations: ['subscriptionPlan'],
    });

    if (!tenant?.stripeSubscriptionId) {
      throw new BadRequestException('No subscription found');
    }

    if (!tenant.isPaused) {
      throw new BadRequestException('Subscription is not paused');
    }

    // Resume in Stripe by clearing pause_collection
    const updateParams: Stripe.SubscriptionUpdateParams = {
      pause_collection: '', // Empty string clears the pause
    };

    // Optionally reset billing cycle to start now
    if (options.billingCycleAnchor) {
      updateParams.billing_cycle_anchor = 'now';
      updateParams.proration_behavior = 'none';
    }

    const subscription = await this.stripe.subscriptions.update(
      tenant.stripeSubscriptionId,
      updateParams,
    );

    // Update local database
    const previousStatus = tenant.subscriptionStatus;
    tenant.isPaused = false;
    tenant.pausedAt = null as any;
    tenant.pauseResumesAt = null as any;
    tenant.pauseReason = null as any;
    tenant.subscriptionStatus = SubscriptionStatus.ACTIVE;
    tenant.currentPeriodEnd = new Date(subscription.current_period_end * 1000);

    await this.tenantRepository.save(tenant);

    // Audit log
    await this.logAuditEvent({
      tenantId: tenant.id,
      eventType: AuditEventType.SUBSCRIPTION_UPDATED,
      stripeSubscriptionId: tenant.stripeSubscriptionId,
      previousStatus,
      newStatus: SubscriptionStatus.ACTIVE,
      metadata: {
        action: 'unpause',
        billingCycleReset: options.billingCycleAnchor,
        pauseDuration: tenant.pausedAt
          ? Math.floor((Date.now() - new Date(tenant.pausedAt).getTime()) / (1000 * 60 * 60 * 24))
          : null,
      },
    });

    this.logger.log(`Subscription resumed for tenant ${tenant.name}`);
    this.eventEmitter.emit('subscription.resumed', {
      tenant,
      nextBillingDate: tenant.currentPeriodEnd,
    });

    return {
      success: true,
      nextBillingDate: tenant.currentPeriodEnd,
    };
  }

  /**
   * Get pause status for a subscription
   */
  async getPauseStatus(tenantId: string): Promise<{
    isPaused: boolean;
    pausedAt?: Date;
    resumesAt?: Date;
    reason?: string;
    canPause: boolean;
    remainingPauseDays?: number;
  }> {
    const tenant = await this.tenantRepository.findOne({
      where: { id: tenantId },
    });

    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    // Calculate remaining pause days if paused
    let remainingPauseDays: number | undefined;
    if (tenant.isPaused && tenant.pauseResumesAt) {
      remainingPauseDays = Math.max(
        0,
        Math.ceil((tenant.pauseResumesAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24)),
      );
    }

    return {
      isPaused: tenant.isPaused,
      pausedAt: tenant.pausedAt || undefined,
      resumesAt: tenant.pauseResumesAt || undefined,
      reason: tenant.pauseReason || undefined,
      canPause: tenant.subscriptionStatus === SubscriptionStatus.ACTIVE && !tenant.isPaused,
      remainingPauseDays,
    };
  }

  // ==================== Plan Upgrade/Change ====================

  /**
   * Get available plans for upgrade/downgrade
   * Returns plans the tenant can switch to (excludes current plan)
   */
  async getAvailablePlans(tenantId: string): Promise<{
    currentPlan: {
      id: string;
      name: string;
      monthlyPrice: number;
      yearlyPrice: number;
      maxGates: number;
      maxUsers: number;
      features: string[];
    } | null;
    isOnTrial: boolean;
    /** True once the tenant has ever paid — the free tier is then permanently used. */
    hasUsedPaidPlan: boolean;
    availablePlans: {
      id: string;
      name: string;
      description: string;
      monthlyPrice: number;
      yearlyPrice: number;
      maxGates: number;
      maxUsers: number;
      features: string[];
      isUpgrade: boolean;
      priceDifference: {
        monthly: number;
        yearly: number;
      };
    }[];
  }> {
    const tenant = await this.tenantRepository.findOne({
      where: { id: tenantId },
      relations: ['subscriptionPlan'],
    });

    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    // Check if tenant is on trial
    const isOnTrial = tenant.subscriptionStatus === SubscriptionStatus.TRIALING && !tenant.stripeSubscriptionId;

    // Get all active public plans
    const allPlans = await this.planRepository.find({
      where: { isActive: true, isPublic: true },
      order: { monthlyPrice: 'ASC' },
    });

    // A tenant with no LIVE Stripe subscription that is not on the free-ride trial
    // (e.g. CANCELED / lapsed) has no "current" plan any more. Report it as null so
    // every plan is offered for a clean RE-SUBSCRIBE — otherwise the pricing page
    // shows their old, cancelled plan as "Your plan" and blocks re-selecting it.
    const hasNoLiveSubscription =
      !tenant.stripeSubscriptionId &&
      tenant.subscriptionStatus !== SubscriptionStatus.TRIALING;
    const currentPlan = hasNoLiveSubscription ? null : tenant.subscriptionPlan;
    const currentMonthly = isOnTrial ? 0 : Number(currentPlan?.monthlyPrice) || 0;

    // Convert features object to array for current plan
    const currentPlanFeatures: string[] = [];
    if (currentPlan?.features && typeof currentPlan.features === 'object') {
      Object.entries(currentPlan.features).forEach(([key, value]) => {
        if (value === true) {
          currentPlanFeatures.push(key.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase()));
        }
      });
    }

    return {
      currentPlan: currentPlan
        ? {
            id: currentPlan.id,
            name: currentPlan.name,
            monthlyPrice: Number(currentPlan.monthlyPrice),
            yearlyPrice: Number(currentPlan.yearlyPrice),
            maxGates: currentPlan.maxGates,
            maxUsers: currentPlan.maxUsers,
            features: currentPlanFeatures,
          }
        : null,
      isOnTrial,
      hasUsedPaidPlan: tenant.hasUsedPaidPlan,
      availablePlans: allPlans
        // For trial users, include ALL plans (so they can subscribe to any plan including their current trial plan)
        // For non-trial users, exclude the current plan
        .filter((p) => isOnTrial || p.id !== currentPlan?.id)
        .map((plan) => {
          // Convert features object to array of enabled feature names
          const featuresArray: string[] = [];
          if (plan.features && typeof plan.features === 'object') {
            Object.entries(plan.features).forEach(([key, value]) => {
              if (value === true) {
                // Convert snake_case to Title Case
                featuresArray.push(key.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase()));
              }
            });
          }
          
          return {
            id: plan.id,
            name: plan.name,
            description: plan.description || '',
            monthlyPrice: Number(plan.monthlyPrice),
            yearlyPrice: Number(plan.yearlyPrice),
            maxGates: plan.maxGates,
            maxUsers: plan.maxUsers,
            features: featuresArray,
            isUpgrade: Number(plan.monthlyPrice) > currentMonthly,
            priceDifference: {
              monthly: Number(plan.monthlyPrice) - currentMonthly,
              yearly: Number(plan.yearlyPrice) - (isOnTrial ? 0 : Number(currentPlan?.yearlyPrice || 0)),
            },
          };
        }),
    };
  }

  /**
   * Preview plan change (calculate prorated amounts)
   * Netflix-style proration:
   * - UPGRADES: Charge prorated difference immediately
   * - DOWNGRADES: Change takes effect at billing period end (no immediate charge)
   */
  async previewPlanChange(
    tenantId: string,
    newPlanId: string,
    billingCycle: BillingCycle,
  ): Promise<{
    currentPlan: { name: string; price: number };
    newPlan: { name: string; price: number };
    prorationAmount: number;
    amountDue: number;
    creditAmount: number;
    effectiveDate: Date;
    isUpgrade: boolean;
    daysRemaining: number;
    immediateChange: boolean;
  }> {
    this.ensureStripe();

    const tenant = await this.tenantRepository.findOne({
      where: { id: tenantId },
      relations: ['subscriptionPlan'],
    });

    if (!tenant?.stripeSubscriptionId) {
      throw new BadRequestException('No active subscription found');
    }

    const newPlan = await this.planRepository.findOne({ where: { id: newPlanId } });
    if (!newPlan) {
      throw new NotFoundException('New plan not found');
    }

    // Ensure plan is synced to Stripe
    if (!newPlan.stripePriceIdMonthly || !newPlan.stripePriceIdYearly) {
      await this.syncPlanToStripe(newPlanId);
    }

    const newPriceId =
      billingCycle === BillingCycle.MONTHLY
        ? newPlan.stripePriceIdMonthly
        : newPlan.stripePriceIdYearly;

    // Get current subscription
    const subscription = await this.stripe.subscriptions.retrieve(tenant.stripeSubscriptionId);
    const currentPeriodEnd = new Date(subscription.current_period_end * 1000);
    const currentPeriodStart = new Date(subscription.current_period_start * 1000);
    const now = new Date();

    // Calculate remaining days in current period
    const totalDays = Math.ceil(
      (currentPeriodEnd.getTime() - currentPeriodStart.getTime()) / (1000 * 60 * 60 * 24),
    );
    const daysRemaining = Math.max(
      0,
      Math.ceil((currentPeriodEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)),
    );
    const prorationFactor = daysRemaining / totalDays;

    const currentPrice = Number(
      tenant.billingCycle === BillingCycle.MONTHLY
        ? tenant.subscriptionPlan?.monthlyPrice || 0
        : tenant.subscriptionPlan?.yearlyPrice || 0,
    );

    const newPrice = Number(
      billingCycle === BillingCycle.MONTHLY ? newPlan.monthlyPrice : newPlan.yearlyPrice,
    );

    const isUpgrade = newPrice > currentPrice;

    // Netflix-style proration calculation
    let prorationAmount = 0;
    let amountDue = 0;
    let creditAmount = 0;
    let effectiveDate: Date;
    let immediateChange: boolean;

    if (isUpgrade) {
      // UPGRADE: Charge immediately for prorated difference
      // Credit for unused portion of current plan
      const unusedCredit = currentPrice * prorationFactor;
      // Charge for remaining portion of new plan
      const newPlanCharge = newPrice * prorationFactor;
      // Net proration = what they owe for the upgrade
      prorationAmount = newPlanCharge - unusedCredit;
      amountDue = Math.max(0, prorationAmount);
      creditAmount = 0;
      effectiveDate = now;
      immediateChange = true;

      this.logger.debug(
        `Upgrade proration: ${daysRemaining}/${totalDays} days remaining. ` +
          `Credit: $${unusedCredit.toFixed(2)}, New charge: $${newPlanCharge.toFixed(2)}, ` +
          `Amount due: $${amountDue.toFixed(2)}`,
      );
    } else {
      // DOWNGRADE: No immediate charge, change at period end
      // User keeps current plan features until period ends
      prorationAmount = 0;
      amountDue = 0;
      creditAmount = 0; // No credit, they use full value of current plan
      effectiveDate = currentPeriodEnd;
      immediateChange = false;

      this.logger.debug(
        `Downgrade scheduled for ${currentPeriodEnd.toISOString()}. ` +
          `No immediate charge. New rate: $${newPrice}/period`,
      );
    }

    return {
      currentPlan: {
        name: tenant.subscriptionPlan?.name || 'Unknown',
        price: currentPrice,
      },
      newPlan: {
        name: newPlan.name,
        price: newPrice,
      },
      prorationAmount: Math.round(prorationAmount * 100) / 100, // Round to 2 decimals
      amountDue: Math.round(amountDue * 100) / 100,
      creditAmount: Math.round(creditAmount * 100) / 100,
      effectiveDate,
      isUpgrade,
      daysRemaining,
      immediateChange,
    };
  }

  /**
   * Change subscription plan (upgrade or downgrade)
   * Netflix-style billing:
   * - UPGRADES: Immediate change with proration (pay prorated difference now)
   * - DOWNGRADES: Scheduled for period end (keep current plan, new price on renewal)
   */
  /**
   * Phase 4 — Downgrade fit check.
   *
   * Rejects a plan change whose target limits cannot hold the tenant's current
   * usage. Counts live gates / users / vehicles the same way the create-time
   * limit checks do (all rows for the tenant, soft-deleted excluded) and, if any
   * resource exceeds the target plan, throws a 400 whose body carries a
   * human-readable message plus structured per-resource deltas for the UI.
   *
   * Gate and Vehicle repositories are not injected into StripeModule; they are
   * reached through the shared EntityManager (both entities are registered by
   * their own modules), so no module wiring changes are required.
   */
  private async assertUsageFitsPlan(tenantId: string, targetPlan: SubscriptionPlan): Promise<void> {
    const manager = this.tenantRepository.manager;
    const [gateCount, userCount, vehicleCount] = await Promise.all([
      manager.count(Gate, { where: { tenantId } }),
      this.userRepository.count({ where: { tenantId } }),
      manager.count(Vehicle, { where: { tenantId } }),
    ]);

    const violations: Array<{
      resource: 'gates' | 'users' | 'vehicles';
      label: string;
      limit: number;
      used: number;
      removeCount: number;
    }> = [];

    if (gateCount > targetPlan.maxGates) {
      violations.push({
        resource: 'gates',
        label: 'gate',
        limit: targetPlan.maxGates,
        used: gateCount,
        removeCount: gateCount - targetPlan.maxGates,
      });
    }
    if (userCount > targetPlan.maxUsers) {
      violations.push({
        resource: 'users',
        label: 'user',
        limit: targetPlan.maxUsers,
        used: userCount,
        removeCount: userCount - targetPlan.maxUsers,
      });
    }
    if (vehicleCount > targetPlan.maxVehicles) {
      violations.push({
        resource: 'vehicles',
        label: 'vehicle',
        limit: targetPlan.maxVehicles,
        used: vehicleCount,
        removeCount: vehicleCount - targetPlan.maxVehicles,
      });
    }

    if (violations.length === 0) {
      return; // usage fits — upgrade / same-size / harmless downgrade
    }

    const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
    const joinParts = (parts: string[]) =>
      parts.length <= 1
        ? parts.join('')
        : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;

    const allowsPart = joinParts(violations.map((v) => plural(v.limit, v.label)));
    const havePart = joinParts(violations.map((v) => plural(v.used, v.label)));
    const removePart = joinParts(violations.map((v) => plural(v.removeCount, v.label)));

    const message =
      `${targetPlan.name} allows ${allowsPart}; you have ${havePart}. ` +
      `Remove ${removePart} to downgrade.`;

    throw new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      code: 'DOWNGRADE_BLOCKED_USAGE_EXCEEDS_LIMITS',
      message,
      targetPlan: { id: targetPlan.id, name: targetPlan.name },
      violations: violations.map((v) => ({
        resource: v.resource,
        limit: v.limit,
        used: v.used,
        removeCount: v.removeCount,
      })),
    });
  }

  async changePlan(
    tenantId: string,
    newPlanId: string,
    billingCycle: BillingCycle,
    options: { immediate?: boolean } = { immediate: true },
  ): Promise<{
    success: boolean;
    message: string;
    newPlan: { id: string; name: string };
    amountCharged: number;
    creditApplied: number;
    effectiveDate: Date;
    isUpgrade: boolean;
    isScheduled: boolean;
  }> {
    this.ensureStripe();

    const tenant = await this.tenantRepository.findOne({
      where: { id: tenantId },
      relations: ['subscriptionPlan'],
    });

    if (!tenant?.stripeSubscriptionId) {
      throw new BadRequestException('No active subscription found');
    }

    if (tenant.isPaused) {
      throw new BadRequestException('Cannot change plan while subscription is paused');
    }

    const newPlan = await this.planRepository.findOne({ where: { id: newPlanId } });
    if (!newPlan) {
      throw new NotFoundException('Plan not found');
    }

    // The free/default plan is a one-time starter grant. Once a tenant has a paid
    // subscription it can never switch back to free — cancelling suspends the
    // tenant (read-only) instead. Blocks the path even if a client somehow offers it.
    if (newPlan.isDefault) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'FREE_PLAN_ALREADY_USED',
        message:
          'The free plan has already been used and cannot be selected again. To stop paying, cancel your subscription instead.',
      });
    }

    if (newPlanId === tenant.subscriptionPlanId) {
      throw new BadRequestException('Already subscribed to this plan');
    }

    // Phase 4 — Voluntary downgrade fit check. Block the switch when the TARGET
    // plan's limits are smaller than the tenant's CURRENT usage, listing the exact
    // per-resource deltas the admin must trim first. Upgrades and same-size changes
    // pass untouched (their limits are >= current usage). Runs before any Stripe
    // mutation, and NEVER auto-disables resources — trimming is the admin's choice.
    await this.assertUsageFitsPlan(tenantId, newPlan);

    // Ensure plan is synced to Stripe
    let syncedPlan = newPlan;
    if (!newPlan.stripePriceIdMonthly || !newPlan.stripePriceIdYearly) {
      syncedPlan = await this.syncPlanToStripe(newPlanId);
    }

    const newPriceId =
      billingCycle === BillingCycle.MONTHLY
        ? syncedPlan.stripePriceIdMonthly
        : syncedPlan.stripePriceIdYearly;

    if (!newPriceId) {
      throw new BadRequestException('Plan not synced to Stripe');
    }

    // Get current subscription
    const subscription = await this.stripe.subscriptions.retrieve(tenant.stripeSubscriptionId);
    const currentItemId = subscription.items.data[0].id;
    const currentPeriodEnd = new Date(subscription.current_period_end * 1000);
    const currentPeriodStart = new Date(subscription.current_period_start * 1000);
    const now = new Date();

    const previousPlanId = tenant.subscriptionPlanId;
    const previousPlanName = tenant.subscriptionPlan?.name;
    const previousPrice = Number(
      tenant.billingCycle === BillingCycle.MONTHLY
        ? tenant.subscriptionPlan?.monthlyPrice || 0
        : tenant.subscriptionPlan?.yearlyPrice || 0,
    );
    const newPrice = Number(
      billingCycle === BillingCycle.MONTHLY ? newPlan.monthlyPrice : newPlan.yearlyPrice,
    );
    const isUpgrade = newPrice > previousPrice;

    let amountCharged = 0;
    let creditApplied = 0;
    let effectiveDate: Date;
    let isScheduled = false;

    if (isUpgrade || options.immediate) {
      // UPGRADE: Apply immediately with proration
      // Calculate prorated amounts
      const totalDays = Math.ceil(
        (currentPeriodEnd.getTime() - currentPeriodStart.getTime()) / (1000 * 60 * 60 * 24),
      );
      const daysRemaining = Math.max(
        0,
        Math.ceil((currentPeriodEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)),
      );
      const prorationFactor = daysRemaining / totalDays;

      // Credit for unused current plan + charge for new plan remaining period
      const unusedCredit = previousPrice * prorationFactor;
      const newPlanCharge = newPrice * prorationFactor;
      amountCharged = Math.max(0, Math.round((newPlanCharge - unusedCredit) * 100) / 100);

      // Update subscription in Stripe (immediate with proration)
      await this.stripe.subscriptions.update(tenant.stripeSubscriptionId, {
        items: [{ id: currentItemId, price: newPriceId }],
        proration_behavior: 'create_prorations',
        metadata: {
          ...subscription.metadata,
          planId: newPlanId,
          billingCycle,
          previousPlanId,
          changeType: 'upgrade',
        },
      });

      effectiveDate = now;
      isScheduled = false;

      // Update local database immediately
      tenant.subscriptionPlanId = newPlanId;
      tenant.billingCycle = billingCycle;

      this.logger.log(
        `Upgrade applied immediately: ${previousPlanName} -> ${newPlan.name}. ` +
          `Charged: $${amountCharged.toFixed(2)} (${daysRemaining}/${totalDays} days)`,
      );
    } else {
      // DOWNGRADE: Schedule for period end (Netflix-style)
      // Cancel any existing scheduled update first
      if (subscription.schedule) {
        try {
          await this.stripe.subscriptionSchedules.cancel(subscription.schedule as string);
        } catch (e) {
          this.logger.warn(`Failed to cancel existing schedule: ${e}`);
        }
      }

      // Create a schedule for the downgrade at period end
      const schedule = await this.stripe.subscriptionSchedules.create({
        from_subscription: tenant.stripeSubscriptionId,
      });

      // Update the schedule with new phases
      await this.stripe.subscriptionSchedules.update(schedule.id, {
        phases: [
          {
            // Current phase until period end
            items: [{ price: subscription.items.data[0].price.id, quantity: 1 }],
            start_date: subscription.current_period_start,
            end_date: subscription.current_period_end,
          },
          {
            // New phase with downgraded plan
            items: [{ price: newPriceId, quantity: 1 }],
            start_date: subscription.current_period_end,
            iterations: 1, // Continue indefinitely
          },
        ],
        metadata: {
          tenantId,
          previousPlanId,
          newPlanId,
          billingCycle,
          changeType: 'downgrade',
        },
      });

      effectiveDate = currentPeriodEnd;
      isScheduled = true;
      amountCharged = 0;
      creditApplied = 0;

      // Store scheduled change info in settings (but don't update plan yet)
      tenant.settings = {
        ...((tenant.settings as object) || {}),
        scheduledPlanChange: {
          newPlanId,
          newPlanName: newPlan.name,
          billingCycle,
          effectiveDate: currentPeriodEnd.toISOString(),
          scheduleId: schedule.id,
        },
      };

      this.logger.log(
        `Downgrade scheduled: ${previousPlanName} -> ${newPlan.name} on ${currentPeriodEnd.toISOString()}`,
      );
    }

    const previousStatus = tenant.subscriptionStatus;
    await this.tenantRepository.save(tenant);

    // Audit log
    await this.logAuditEvent({
      tenantId: tenant.id,
      eventType: isUpgrade ? AuditEventType.PLAN_UPGRADED : AuditEventType.PLAN_DOWNGRADED,
      stripeSubscriptionId: tenant.stripeSubscriptionId,
      previousStatus,
      newStatus: tenant.subscriptionStatus,
      metadata: {
        previousPlanId,
        previousPlanName,
        previousPrice,
        newPlanId,
        newPlanName: newPlan.name,
        newPrice,
        billingCycle,
        immediate: !isScheduled,
        amountCharged,
        creditApplied,
        effectiveDate: effectiveDate.toISOString(),
        isScheduled,
      },
    });

    this.logger.log(
      `Plan ${isUpgrade ? 'upgraded' : 'downgrade scheduled'} for tenant ${tenant.name}: ${previousPlanName} -> ${newPlan.name}`,
    );

    // Emit event for any post-change actions
    this.eventEmitter.emit('subscription.planChanged', {
      tenant,
      previousPlanId,
      newPlanId,
      isUpgrade,
      isScheduled,
    });

    return {
      success: true,
      message: isUpgrade
        ? `Successfully upgraded to ${newPlan.name}`
        : isScheduled
          ? `Your plan will change to ${newPlan.name} on ${currentPeriodEnd.toLocaleDateString()}`
          : `You've switched to the ${newPlan.name} plan. A credit for the unused time on your previous plan will be applied to your next invoice.`,
      newPlan: {
        id: newPlan.id,
        name: newPlan.name,
      },
      amountCharged,
      creditApplied,
      effectiveDate,
      isUpgrade,
      isScheduled,
    };
  }

  // ==================== Webhook Handlers ====================

  /**
   * Verify and construct webhook event
   */
  constructWebhookEvent(payload: Buffer, signature: string): Stripe.Event {
    this.ensureStripe();
    const webhookSecret = this.configService.get<string>('STRIPE_WEBHOOK_SECRET');
    if (!webhookSecret) {
      throw new BadRequestException('Webhook secret not configured');
    }

    return this.stripe.webhooks.constructEvent(payload, signature, webhookSecret);
  }

  // ==================== Webhook Idempotency (Phase 6) ====================

  /**
   * Has this Stripe webhook event id already been handled?
   *
   * Backed by the `processed_stripe_events` ledger (created by migration
   * 1775737100000-AddProcessedStripeEvents). Reached via parameterised raw SQL
   * through the EntityManager so no StripeModule wiring is needed.
   *
   * If the table is not present yet (migration not run), we degrade to
   * "not processed" so webhook handling continues exactly as it did before
   * idempotency was added — this can never make behaviour worse than today.
   */
  async isStripeEventProcessed(eventId: string): Promise<boolean> {
    if (!eventId) return false;
    try {
      const rows = await this.paymentRepository.manager.query(
        `SELECT 1 FROM processed_stripe_events WHERE event_id = $1 LIMIT 1`,
        [eventId],
      );
      return Array.isArray(rows) && rows.length > 0;
    } catch (err: any) {
      this.logger.warn(`Idempotency lookup skipped for event ${eventId}: ${err?.message ?? err}`);
      return false;
    }
  }

  /**
   * Record that a Stripe webhook event id has been handled. `ON CONFLICT DO
   * NOTHING` makes concurrent/duplicate deliveries safe. Failures are swallowed
   * (worst case: a later retry re-processes, i.e. today's behaviour).
   */
  async markStripeEventProcessed(eventId: string, type: string): Promise<void> {
    if (!eventId) return;
    try {
      await this.paymentRepository.manager.query(
        `INSERT INTO processed_stripe_events (id, event_id, type, processed_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (event_id) DO NOTHING`,
        [uuidv4(), eventId, type ?? null],
      );
    } catch (err: any) {
      this.logger.warn(`Failed to record processed event ${eventId}: ${err?.message ?? err}`);
    }
  }

  /**
   * Handle checkout.session.completed
   */
  async handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
    const checkoutType = session.metadata?.type;

    // NEW SIGNUP: Create tenant and user from metadata
    if (checkoutType === 'signup') {
      await this.handleSignupCheckoutCompleted(session);
      return;
    }

    // EXISTING TENANT: Update subscription
    const tenantId = session.metadata?.tenantId;
    const planId = session.metadata?.planId;
    const billingCycle = session.metadata?.billingCycle as BillingCycle;

    if (!tenantId || !planId) {
      this.logger.warn('Checkout session missing metadata');
      return;
    }

    const tenant = await this.tenantRepository.findOne({ where: { id: tenantId } });
    const plan = await this.planRepository.findOne({ where: { id: planId } });

    if (!tenant || !plan) {
      this.logger.warn(`Tenant or plan not found: ${tenantId}, ${planId}`);
      return;
    }

    // Update tenant with subscription info
    const previousStatus = tenant.subscriptionStatus;
    const previousPlanId = tenant.subscriptionPlanId;

    tenant.subscriptionPlanId = plan.id;
    tenant.billingCycle = billingCycle || BillingCycle.MONTHLY;
    tenant.stripeSubscriptionId = this.extractSubscriptionId(session.subscription)!;
    tenant.subscriptionStatus = SubscriptionStatus.ACTIVE;
    tenant.status = TenantStatus.ACTIVE;
    tenant.subscriptionStartedAt = new Date();
    tenant.cancelAtPeriodEnd = false;
    // Paid checkout completed — the free tier is now permanently used (one-way).
    tenant.hasUsedPaidPlan = true;

    // Fetch subscription to get period end dates
    const subscriptionId = this.extractSubscriptionId(session.subscription);
    if (subscriptionId) {
      try {
        const subscription = await this.stripe.subscriptions.retrieve(subscriptionId);
        tenant.currentPeriodEnd = new Date(subscription.current_period_end * 1000);
        tenant.subscriptionExpiresAt = tenant.currentPeriodEnd;
      } catch (err) {
        this.logger.warn(`Could not retrieve subscription ${subscriptionId}: ${err}`);
      }
    }

    await this.tenantRepository.save(tenant);
    this.logger.log(`Checkout completed for tenant ${tenant.name} - Plan: ${plan.name}`);

    // Audit log
    await this.logAuditEvent({
      tenantId: tenant.id,
      eventType: AuditEventType.SUBSCRIPTION_ACTIVATED,
      stripeSubscriptionId: subscriptionId!,
      previousStatus,
      newStatus: SubscriptionStatus.ACTIVE,
      previousPlanId,
      newPlanId: plan.id,
      metadata: { billingCycle, sessionId: session.id },
    });

    // Record payment from checkout (upgrade/new subscription)
    if (session.amount_total && session.amount_total > 0) {
      let paymentMethodInfo: { type?: string; last4?: string; brand?: string } = {};
      let netAmount: number | undefined;
      let feeAmount: number | undefined;
      
      if (session.payment_intent) {
        try {
          const paymentIntentId = typeof session.payment_intent === 'string' 
            ? session.payment_intent 
            : session.payment_intent.id;
          const paymentIntent = await this.stripe.paymentIntents.retrieve(paymentIntentId, {
            expand: ['payment_method', 'latest_charge.balance_transaction'],
          });
          if (paymentIntent.payment_method && typeof paymentIntent.payment_method !== 'string') {
            const pm = paymentIntent.payment_method;
            if (pm.card) {
              paymentMethodInfo = {
                type: 'card',
                last4: pm.card.last4 || undefined,
                brand: pm.card.brand || undefined,
              };
            }
          }
          
          // Get net amount and fees from balance transaction
          const latestCharge = paymentIntent.latest_charge as Stripe.Charge | null;
          if (latestCharge && typeof latestCharge === 'object') {
            const balanceTransaction = latestCharge.balance_transaction as Stripe.BalanceTransaction | null;
            if (balanceTransaction && typeof balanceTransaction === 'object') {
              netAmount = balanceTransaction.net; // In cents
              feeAmount = balanceTransaction.fee; // In cents
            }
          }
        } catch (e) {
          this.logger.warn(`Could not fetch payment intent details: ${e}`);
        }
      }

      await this.recordPayment({
        tenantId: tenant.id,
        amount: session.amount_total,
        netAmount,
        feeAmount,
        currency: session.currency || 'usd',
        transactionType: TransactionType.CHARGE,
        paymentType: previousPlanId ? PaymentType.UPGRADE : PaymentType.SUBSCRIPTION,
        stripePaymentIntentId: typeof session.payment_intent === 'string' 
          ? session.payment_intent 
          : session.payment_intent?.id,
        stripeInvoiceId: typeof session.invoice === 'string' 
          ? session.invoice 
          : session.invoice?.id,
        stripeSubscriptionId: subscriptionId || undefined,
        billingPeriodStart: tenant.subscriptionStartedAt,
        billingPeriodEnd: tenant.currentPeriodEnd,
        billingCycle: billingCycle,
        paymentMethodType: paymentMethodInfo.type,
        paymentMethodLast4: paymentMethodInfo.last4,
        paymentMethodBrand: paymentMethodInfo.brand,
        description: `Subscription payment - ${plan.name}`,
        metadata: {
          sessionId: session.id,
          previousPlanId,
        },
      });
    }

    this.eventEmitter.emit('subscription.activated', { tenant, plan });
  }

  /**
   * Handle signup checkout completed - creates tenant and user
   */
  private async handleSignupCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
    const metadata = session.metadata!;

    // Extract signup data from metadata
    const firstName = metadata.firstName;
    const lastName = metadata.lastName;
    const email = metadata.email;
    const passwordHash = metadata.passwordHash;
    const phone = metadata.phone || '';
    const buildingName = metadata.buildingName;
    const buildingAddress = metadata.buildingAddress || '';
    const planId = metadata.planId;
    const billingCycle = metadata.billingCycle as BillingCycle;

    // Get the plan
    const plan = await this.planRepository.findOne({ where: { id: planId } });
    if (!plan) {
      this.logger.error(`Plan not found during signup checkout: ${planId}`);
      return;
    }

    // Double-check email doesn't exist (race condition protection)
    const existingUser = await this.userRepository.findOne({
      where: { email: email.toLowerCase() },
    });
    if (existingUser) {
      this.logger.warn(`Email already exists during signup checkout: ${email}`);
      return;
    }

    // Generate slug from building name
    const slug =
      buildingName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '') +
      '-' +
      Date.now().toString(36);

    // Fetch subscription to get period end dates
    const subscriptionId = this.extractSubscriptionId(session.subscription);
    let currentPeriodEnd: Date | undefined;
    if (subscriptionId) {
      try {
        const subscription = await this.stripe.subscriptions.retrieve(subscriptionId);
        currentPeriodEnd = new Date(subscription.current_period_end * 1000);
      } catch (err) {
        this.logger.warn(`Could not retrieve subscription ${subscriptionId}: ${err}`);
      }
    }

    // Create tenant
    const tenant = this.tenantRepository.create({
      name: buildingName,
      slug,
      contactEmail: email.toLowerCase(),
      contactPhone: phone,
      address: buildingAddress,
      status: TenantStatus.ACTIVE, // Paid - so ACTIVE
      subscriptionPlanId: plan.id,
      billingCycle: billingCycle || BillingCycle.MONTHLY,
      stripeCustomerId: session.customer as string,
      stripeSubscriptionId: subscriptionId!,
      subscriptionStatus: SubscriptionStatus.ACTIVE,
      subscriptionStartedAt: new Date(),
      subscriptionExpiresAt: currentPeriodEnd,
      currentPeriodEnd: currentPeriodEnd,
      cancelAtPeriodEnd: false,
      settings: {
        signupDate: new Date().toISOString(),
        paidOnSignup: true,
      },
    });

    const savedTenant = await this.tenantRepository.save(tenant);

    // Generate QR code for the building admin
    const qrCode = `GR-${uuidv4()}`;

    // Create user (building admin)
    const user = this.userRepository.create({
      email: email.toLowerCase(),
      passwordHash,
      firstName,
      lastName,
      phone,
      role: UserRole.BUILDING_ADMIN,
      status: UserStatus.ACTIVE,
      tenantId: savedTenant.id,
      qrCode,
    });

    const savedUser = await this.userRepository.save(user);

    this.logger.log(
      `Signup completed via Stripe: ${email} - Tenant: ${buildingName} - Plan: ${plan.name}`,
    );

    // Calculate effective price with discount for email display
    const basePrice = billingCycle === BillingCycle.YEARLY
      ? Number(plan.yearlyPrice)
      : Number(plan.monthlyPrice);
    const effectivePrice = this.calculateEffectivePrice(
      basePrice,
      Number(plan.discountPercent),
      plan.discountValidUntil,
    );

    // Send welcome email with subscription info (don't fail signup if email fails)
    const frontendUrl = this.configService.get<string>('FRONTEND_URL', 'https://yaad.global');
    this.emailService
      .sendWelcomeEmail(
        savedUser.email,
        `${savedUser.firstName} ${savedUser.lastName}`,
        savedTenant.name,
        `${frontendUrl}/dashboard`,
        {
          type: 'subscription',
          planName: plan.name,
          price: effectivePrice,
          billingCycle: billingCycle === BillingCycle.YEARLY ? 'yearly' : 'monthly',
        },
      )
      .catch((error) => {
        this.logger.error(`Failed to send welcome email to ${savedUser.email}:`, error);
      });

    // Audit log
    await this.logAuditEvent({
      tenantId: savedTenant.id,
      eventType: AuditEventType.SUBSCRIPTION_CREATED,
      stripeSubscriptionId: subscriptionId!,
      newStatus: SubscriptionStatus.ACTIVE,
      newPlanId: plan.id,
      metadata: {
        email,
        buildingName,
        billingCycle,
        paidOnSignup: true,
      },
    });

    // Record initial payment from checkout
    if (session.amount_total && session.amount_total > 0) {
      // Get payment method details if available
      let paymentMethodInfo: { type?: string; last4?: string; brand?: string } = {};
      let netAmount: number | undefined;
      let feeAmount: number | undefined;
      
      if (session.payment_intent) {
        try {
          const paymentIntentId = typeof session.payment_intent === 'string' 
            ? session.payment_intent 
            : session.payment_intent.id;
          const paymentIntent = await this.stripe.paymentIntents.retrieve(paymentIntentId, {
            expand: ['payment_method', 'latest_charge.balance_transaction'],
          });
          if (paymentIntent.payment_method && typeof paymentIntent.payment_method !== 'string') {
            const pm = paymentIntent.payment_method;
            if (pm.card) {
              paymentMethodInfo = {
                type: 'card',
                last4: pm.card.last4 || undefined,
                brand: pm.card.brand || undefined,
              };
            }
          }
          
          // Get net amount and fees from balance transaction
          const latestCharge = paymentIntent.latest_charge as Stripe.Charge | null;
          if (latestCharge && typeof latestCharge === 'object') {
            const balanceTransaction = latestCharge.balance_transaction as Stripe.BalanceTransaction | null;
            if (balanceTransaction && typeof balanceTransaction === 'object') {
              netAmount = balanceTransaction.net; // In cents
              feeAmount = balanceTransaction.fee; // In cents
            }
          }
        } catch (e) {
          this.logger.warn(`Could not fetch payment intent details: ${e}`);
        }
      }

      await this.recordPayment({
        tenantId: savedTenant.id,
        amount: session.amount_total,
        netAmount,
        feeAmount,
        currency: session.currency || 'usd',
        transactionType: TransactionType.CHARGE,
        paymentType: PaymentType.SUBSCRIPTION,
        stripePaymentIntentId: typeof session.payment_intent === 'string' 
          ? session.payment_intent 
          : session.payment_intent?.id,
        stripeInvoiceId: typeof session.invoice === 'string' 
          ? session.invoice 
          : session.invoice?.id,
        stripeSubscriptionId: subscriptionId || undefined,
        billingPeriodStart: new Date(),
        billingPeriodEnd: currentPeriodEnd,
        billingCycle: billingCycle,
        paymentMethodType: paymentMethodInfo.type,
        paymentMethodLast4: paymentMethodInfo.last4,
        paymentMethodBrand: paymentMethodInfo.brand,
        description: `Initial subscription payment - ${plan.name}`,
        metadata: {
          sessionId: session.id,
          signupPayment: true,
        },
      });
      this.logger.log(`Recorded initial payment of $${session.amount_total / 100} for ${email}`);
    }

    this.eventEmitter.emit('signup.completed', { tenant: savedTenant, user: savedUser, plan });
  }

  /**
   * Handle setup_intent.succeeded — the in-app Elements card was saved.
   *
   * Acts ONLY on SetupIntents this service minted (metadata.source), so card
   * saves from any other flow are ignored. Creates the subscription against the
   * just-saved card; from there the ordinary customer.subscription.created /
   * invoice.paid webhooks activate the tenant, so an in-app subscription travels
   * the EXACT same activation path as a hosted one — a single source of truth for
   * going ACTIVE, never an optimistic flip here.
   *
   * Idempotent twice over: the processed_stripe_events ledger drops duplicate
   * event deliveries, and subscriptions.create carries an idempotency key derived
   * from the SetupIntent id, so even a replay of THIS event cannot create a
   * second subscription.
   */
  async handleSetupIntentSucceeded(
    setupIntent: Stripe.SetupIntent,
  ): Promise<void> {
    if (setupIntent.metadata?.source !== INAPP_SUBSCRIPTION_SOURCE) {
      return; // not one of ours — leave portal/other card saves untouched
    }

    const tenantId = setupIntent.metadata?.tenantId;
    const planId = setupIntent.metadata?.planId;
    const priceId = setupIntent.metadata?.priceId;
    const billingCycle =
      (setupIntent.metadata?.billingCycle as BillingCycle) ||
      BillingCycle.MONTHLY;

    if (!tenantId || !planId || !priceId) {
      this.logger.warn(
        `SetupIntent ${setupIntent.id} missing metadata (tenant/plan/price); skipping`,
      );
      return;
    }

    const tenant = await this.tenantRepository.findOne({
      where: { id: tenantId },
    });
    if (!tenant) {
      this.logger.warn(
        `SetupIntent ${setupIntent.id}: tenant ${tenantId} not found; skipping`,
      );
      return;
    }

    // Never double-subscribe: if a live subscription already exists (another path
    // completed first, or a duplicate event), do nothing.
    const liveSubscriptionStatuses = [
      SubscriptionStatus.ACTIVE,
      SubscriptionStatus.TRIALING,
      SubscriptionStatus.PAST_DUE,
      SubscriptionStatus.PAUSED,
    ];
    if (
      tenant.stripeSubscriptionId &&
      liveSubscriptionStatuses.includes(tenant.subscriptionStatus)
    ) {
      this.logger.log(
        `SetupIntent ${setupIntent.id}: tenant ${tenant.name} already has a live subscription; skipping`,
      );
      return;
    }

    const paymentMethodId =
      typeof setupIntent.payment_method === 'string'
        ? setupIntent.payment_method
        : setupIntent.payment_method?.id;
    const customerId =
      typeof setupIntent.customer === 'string'
        ? setupIntent.customer
        : setupIntent.customer?.id;

    if (!paymentMethodId || !customerId) {
      this.logger.warn(
        `SetupIntent ${setupIntent.id}: missing payment method or customer; skipping`,
      );
      return;
    }

    // Make the saved card the customer's default so Stripe bills the first (and
    // recurring) invoices against it.
    await this.stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });

    // Create the subscription. default_payment_method points at the saved card so
    // Stripe charges the first invoice immediately — same outcome as hosted
    // checkout. The idempotency key keyed on the SetupIntent guarantees
    // at-most-one subscription per confirmed card, even on webhook replay.
    const subscription = await this.stripe.subscriptions.create(
      {
        customer: customerId,
        items: [{ price: priceId }],
        default_payment_method: paymentMethodId,
        metadata: {
          tenantId,
          planId,
          billingCycle,
        },
      },
      { idempotencyKey: `sub_from_si_${setupIntent.id}` },
    );

    // Record the subscription id + cycle now so getSubscriptionDetails reflects
    // it immediately and the invoice/subscription-updated webhooks (which look
    // the tenant up BY stripeSubscriptionId) can find it. tenant.status is
    // deliberately NOT flipped here — activation stays owned by the existing
    // customer.subscription.created / invoice.paid handlers.
    tenant.stripeSubscriptionId = subscription.id;
    tenant.subscriptionPlanId = planId;
    tenant.billingCycle = billingCycle;
    tenant.subscriptionStatus = this.mapStripeStatus(subscription.status);
    await this.tenantRepository.save(tenant);

    this.logger.log(
      `In-app subscription ${subscription.id} created for tenant ${tenant.name} from SetupIntent ${setupIntent.id}`,
    );
  }

  /**
   * Handle customer.subscription.created
   */
  async handleSubscriptionCreated(subscription: Stripe.Subscription): Promise<void> {
    const tenantId = subscription.metadata?.tenantId;
    if (!tenantId) {
      // Try to find by customer
      const customerId = subscription.customer as string;
      const tenant = await this.tenantRepository.findOne({
        where: { stripeCustomerId: customerId },
      });
      if (tenant) {
        tenant.stripeSubscriptionId = subscription.id;
        tenant.subscriptionStatus = this.mapStripeStatus(subscription.status);
        tenant.currentPeriodEnd = new Date(subscription.current_period_end * 1000);
        tenant.subscriptionExpiresAt = tenant.currentPeriodEnd;
        if (!tenant.subscriptionStartedAt) {
          tenant.subscriptionStartedAt = new Date();
        }
        await this.tenantRepository.save(tenant);
        this.logger.log(`Subscription created for tenant ${tenant.name}`);
      }
      return;
    }

    const tenant = await this.tenantRepository.findOne({ where: { id: tenantId } });
    if (!tenant) return;

    tenant.stripeSubscriptionId = subscription.id;
    tenant.subscriptionStatus = this.mapStripeStatus(subscription.status);
    tenant.currentPeriodEnd = new Date(subscription.current_period_end * 1000);
    tenant.subscriptionExpiresAt = tenant.currentPeriodEnd;
    if (!tenant.subscriptionStartedAt) {
      tenant.subscriptionStartedAt = new Date();
    }
    await this.tenantRepository.save(tenant);
    this.logger.log(`Subscription created for tenant ${tenant.name}`);
  }

  /**
   * Handle customer.subscription.updated
   */
  async handleSubscriptionUpdated(subscription: Stripe.Subscription): Promise<void> {
    const tenant = await this.tenantRepository.findOne({
      where: { stripeSubscriptionId: subscription.id },
    });

    if (!tenant) {
      this.logger.warn(`No tenant found for subscription ${subscription.id}`);
      return;
    }

    const previousStatus = tenant.subscriptionStatus;
    tenant.subscriptionStatus = this.mapStripeStatus(subscription.status);
    tenant.currentPeriodEnd = new Date(subscription.current_period_end * 1000);
    tenant.subscriptionExpiresAt = tenant.currentPeriodEnd;
    tenant.cancelAtPeriodEnd = subscription.cancel_at_period_end;

    // Update tenant status based on subscription
    if (subscription.status === 'active' || subscription.status === 'trialing') {
      tenant.status = subscription.status === 'trialing' ? TenantStatus.TRIAL : TenantStatus.ACTIVE;
    } else if (subscription.status === 'past_due' || subscription.status === 'unpaid') {
      // Grace period - keep active but mark subscription status
      tenant.status = TenantStatus.ACTIVE;
    } else if (subscription.status === 'canceled' || subscription.status === 'incomplete_expired') {
      tenant.status = TenantStatus.SUSPENDED;
    }

    await this.tenantRepository.save(tenant);
    this.logger.log(
      `Subscription updated for tenant ${tenant.name}: ${previousStatus} -> ${tenant.subscriptionStatus}`,
    );

    // Audit log
    await this.logAuditEvent({
      tenantId: tenant.id,
      eventType: AuditEventType.SUBSCRIPTION_UPDATED,
      stripeSubscriptionId: subscription.id,
      previousStatus,
      newStatus: tenant.subscriptionStatus,
      metadata: {
        currentPeriodEnd: tenant.currentPeriodEnd?.toISOString(),
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
      },
    });

    // Emit events for status changes
    if (previousStatus !== tenant.subscriptionStatus) {
      this.eventEmitter.emit('subscription.status_changed', {
        tenant,
        previousStatus,
        newStatus: tenant.subscriptionStatus,
      });
    }
  }

  /**
   * Handle customer.subscription.deleted
   */
  async handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
    const tenant = await this.tenantRepository.findOne({
      where: { stripeSubscriptionId: subscription.id },
    });

    if (!tenant) return;

    const previousStatus = tenant.subscriptionStatus;
    tenant.subscriptionStatus = SubscriptionStatus.CANCELED;
    tenant.status = TenantStatus.SUSPENDED;
    tenant.stripeSubscriptionId = null as any;

    await this.tenantRepository.save(tenant);
    this.logger.log(`Subscription canceled for tenant ${tenant.name}`);

    // Audit log
    await this.logAuditEvent({
      tenantId: tenant.id,
      eventType: AuditEventType.SUBSCRIPTION_CANCELED,
      stripeSubscriptionId: subscription.id,
      previousStatus,
      newStatus: SubscriptionStatus.CANCELED,
    });

    this.eventEmitter.emit('subscription.canceled', { tenant });
  }

  /**
   * Extract the subscription id from an invoice ACROSS Stripe API versions.
   * Older versions exposed `invoice.subscription`; 2025+/2026 ("dahlia") removed
   * it and moved it to `invoice.parent.subscription_details.subscription` (and,
   * per line item, `line.parent.subscription_item_details.subscription`). Without
   * this, invoice webhooks on a newer account silently drop the payment — the
   * handler reads `undefined` and returns before recording anything.
   */
  private getInvoiceSubscriptionId(invoice: Stripe.Invoice): string | undefined {
    const inv = invoice as any;
    const legacy =
      typeof inv.subscription === 'string'
        ? inv.subscription
        : inv.subscription?.id;
    return (
      legacy ||
      inv.parent?.subscription_details?.subscription ||
      inv.lines?.data?.[0]?.parent?.subscription_item_details?.subscription ||
      undefined
    );
  }

  /**
   * Handle invoice.paid
   */
  async handleInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
    const subscriptionId = this.getInvoiceSubscriptionId(invoice);
    if (!subscriptionId) return;

    let tenant = await this.tenantRepository.findOne({
      where: { stripeSubscriptionId: subscriptionId },
      relations: ['subscriptionPlan'],
    });

    // Race fallback: the in-app checkout creates the subscription INSIDE the
    // setup_intent.succeeded webhook, so invoice.paid can land before
    // tenant.stripeSubscriptionId has been persisted. Without this, the very
    // first payment would be silently dropped (tenant still gets activated by a
    // later subscription.updated, but no payment row is written). A Stripe
    // customer is 1:1 with a tenant, so resolve by customer and backfill the
    // subscription id so subsequent events match directly.
    if (!tenant && invoice.customer) {
      const customerId =
        typeof invoice.customer === 'string'
          ? invoice.customer
          : invoice.customer.id;
      tenant = await this.tenantRepository.findOne({
        where: { stripeCustomerId: customerId },
        relations: ['subscriptionPlan'],
      });
      if (tenant && !tenant.stripeSubscriptionId) {
        tenant.stripeSubscriptionId = subscriptionId;
      }
    }

    if (!tenant) return;

    tenant.subscriptionStatus = SubscriptionStatus.ACTIVE;
    tenant.status = TenantStatus.ACTIVE;
    // A paid invoice means this tenant has now paid for a real plan — the free
    // tier is permanently consumed. One-way latch; never reset.
    tenant.hasUsedPaidPlan = true;

    // Billing period info
    let billingPeriodStart: Date | undefined;
    let billingPeriodEnd: Date | undefined;

    // Extend subscription period
    if (invoice.lines.data[0]?.period?.end) {
      tenant.currentPeriodEnd = new Date(invoice.lines.data[0].period.end * 1000);
      tenant.subscriptionExpiresAt = tenant.currentPeriodEnd;
      billingPeriodEnd = tenant.currentPeriodEnd;
    }
    if (invoice.lines.data[0]?.period?.start) {
      billingPeriodStart = new Date(invoice.lines.data[0].period.start * 1000);
    }

    await this.tenantRepository.save(tenant);
    this.logger.log(`Invoice paid for tenant ${tenant.name}`);

    // Check if payment already recorded (prevent duplicates from checkout + invoice webhooks)
    const existingPayment = await this.paymentRepository.findOne({
      where: { stripeInvoiceId: invoice.id },
    });
    if (existingPayment) {
      this.logger.log(`Payment already recorded for invoice ${invoice.id}, skipping`);
      // Still update audit log
      await this.logAuditEvent({
        tenantId: tenant.id,
        eventType: AuditEventType.PAYMENT_SUCCEEDED,
        stripeSubscriptionId: subscriptionId,
        amount: invoice.amount_paid ? invoice.amount_paid / 100 : undefined,
        currency: invoice.currency,
        metadata: {
          invoiceId: invoice.id,
          periodEnd: tenant.currentPeriodEnd?.toISOString(),
          duplicate: true,
        },
      });
      this.eventEmitter.emit('invoice.paid', { tenant, invoice });
      return;
    }

    // Record the payment in payments table
    const charge = (invoice as any).charge as string | undefined;
    let paymentMethodInfo: { type?: string; last4?: string; brand?: string } = {};
    let netAmount: number | undefined;
    let feeAmount: number | undefined;
    let taxAmount: number | undefined;

    // Get payment method details and balance transaction from the charge
    // (legacy Stripe API: `invoice.charge` present).
    if (charge && this.stripe) {
      try {
        const chargeObj = await this.stripe.charges.retrieve(charge, {
          expand: ['balance_transaction'],
        });

        if (chargeObj.payment_method_details?.card) {
          paymentMethodInfo = {
            type: 'card',
            last4: chargeObj.payment_method_details.card.last4 || undefined,
            brand: chargeObj.payment_method_details.card.brand || undefined,
          };
        }

        // Get net amount and fees from balance transaction
        const balanceTransaction = chargeObj.balance_transaction as Stripe.BalanceTransaction | null;
        if (balanceTransaction && typeof balanceTransaction === 'object') {
          netAmount = balanceTransaction.net; // In cents
          feeAmount = balanceTransaction.fee; // In cents
        }
      } catch (e) {
        this.logger.warn(`Error fetching charge details for ${charge}: ${e}`);
      }
    } else if (this.stripe) {
      // Newer Stripe API ("dahlia"): the invoice no longer carries `charge`.
      // Read the card off the subscription's default payment method (which the
      // in-app checkout set to the saved card) so the payment still shows a brand
      // and last-4. Net/fee are omitted — they are not needed to display the row.
      try {
        const sub = await this.stripe.subscriptions.retrieve(subscriptionId, {
          expand: ['default_payment_method'],
        });
        const pm = sub.default_payment_method;
        if (pm && typeof pm !== 'string' && pm.card) {
          paymentMethodInfo = {
            type: 'card',
            last4: pm.card.last4 || undefined,
            brand: pm.card.brand || undefined,
          };
        }
      } catch (e) {
        this.logger.warn(
          `Could not read default PM for subscription ${subscriptionId}: ${e}`,
        );
      }
    }

    // Get tax from invoice if available (legacy `tax`; newer `total_taxes[]`).
    const inv = invoice as any;
    if (typeof inv.tax === 'number') {
      taxAmount = inv.tax; // In cents
    } else if (Array.isArray(inv.total_taxes)) {
      taxAmount = inv.total_taxes.reduce(
        (sum: number, t: any) => sum + (t.amount || 0),
        0,
      );
    }

    await this.recordPayment({
      tenantId: tenant.id,
      amount: invoice.amount_paid || 0,
      netAmount,
      feeAmount,
      taxAmount,
      currency: invoice.currency,
      transactionType: TransactionType.CHARGE,
      paymentType: PaymentType.SUBSCRIPTION,
      stripeChargeId: charge || undefined,
      stripeInvoiceId: invoice.id,
      stripeSubscriptionId: subscriptionId,
      billingPeriodStart,
      billingPeriodEnd,
      billingCycle: tenant.billingCycle,
      paymentMethodType: paymentMethodInfo.type,
      paymentMethodLast4: paymentMethodInfo.last4,
      paymentMethodBrand: paymentMethodInfo.brand,
      description: `Subscription payment - ${tenant.subscriptionPlan?.name || 'Plan'}`,
      metadata: {
        invoiceNumber: invoice.number,
      },
    });

    // Audit log
    await this.logAuditEvent({
      tenantId: tenant.id,
      eventType: AuditEventType.PAYMENT_SUCCEEDED,
      stripeSubscriptionId: subscriptionId,
      amount: invoice.amount_paid ? invoice.amount_paid / 100 : undefined,
      currency: invoice.currency,
      metadata: {
        invoiceId: invoice.id,
        periodEnd: tenant.currentPeriodEnd?.toISOString(),
      },
    });

    this.eventEmitter.emit('invoice.paid', { tenant, invoice });
  }

  /**
   * Handle invoice.payment_failed
   */
  async handleInvoicePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
    const subscriptionId = this.getInvoiceSubscriptionId(invoice);
    if (!subscriptionId) return;

    const tenant = await this.tenantRepository.findOne({
      where: { stripeSubscriptionId: subscriptionId },
      relations: ['users'],
    });

    if (!tenant) return;

    const previousStatus = tenant.subscriptionStatus;
    const previousTenantStatus = tenant.status;
    tenant.subscriptionStatus = SubscriptionStatus.PAST_DUE;

    // Phase 4 — Involuntary downgrade -> SUSPENDED (read-only via the Phase-1 guard).
    // Stripe retries a failed subscription invoice (dunning). While more attempts are
    // scheduled, `next_payment_attempt` holds the next retry timestamp and the tenant
    // keeps its current access (grace). When Stripe has exhausted its retries,
    // `next_payment_attempt` is null -> this is the FINAL failure, so we suspend the
    // tenant. We deliberately do NOT drop them to the default plan: all data is
    // preserved and full access returns automatically once payment succeeds
    // (handleInvoicePaid flips status back to ACTIVE).
    const dunningExhausted = !invoice.next_payment_attempt;
    if (dunningExhausted) {
      tenant.status = TenantStatus.SUSPENDED;
    }

    await this.tenantRepository.save(tenant);

    if (dunningExhausted) {
      this.logger.warn(
        `Invoice payment failed (final attempt) for tenant ${tenant.name} - ` +
          `suspended (read-only). Access restores on payment.`,
      );
    } else {
      this.logger.warn(
        `Invoice payment failed for tenant ${tenant.name} - past due, ` +
          `awaiting Stripe retry (grace period).`,
      );
    }

    // Record the failed payment
    await this.recordFailedPayment({
      tenantId: tenant.id,
      amount: invoice.amount_due || 0,
      stripeInvoiceId: invoice.id,
      failureReason: 'Payment declined',
      currency: invoice.currency,
    });

    // Audit log
    await this.logAuditEvent({
      tenantId: tenant.id,
      eventType: AuditEventType.PAYMENT_FAILED,
      stripeSubscriptionId: subscriptionId,
      previousStatus,
      newStatus: SubscriptionStatus.PAST_DUE,
      amount: invoice.amount_due ? invoice.amount_due / 100 : undefined,
      currency: invoice.currency,
      metadata: {
        invoiceId: invoice.id,
        attemptCount: invoice.attempt_count,
        nextPaymentAttempt: invoice.next_payment_attempt,
        finalFailure: dunningExhausted,
        tenantSuspended: dunningExhausted,
        previousTenantStatus,
        newTenantStatus: tenant.status,
      },
    });

    this.eventEmitter.emit('invoice.payment_failed', {
      tenant,
      invoice,
      suspended: dunningExhausted,
    });
  }

  /**
   * Handle customer.subscription.trial_will_end
   */
  async handleTrialWillEnd(subscription: Stripe.Subscription): Promise<void> {
    const tenant = await this.tenantRepository.findOne({
      where: { stripeSubscriptionId: subscription.id },
    });

    if (!tenant) return;

    this.logger.log(`Trial ending soon for tenant ${tenant.name}`);
    this.eventEmitter.emit('subscription.trial_ending', {
      tenant,
      trialEnd: new Date(subscription.trial_end! * 1000),
    });
  }

  /**
   * Handle customer.subscription.paused (Stripe auto-paused or via API)
   */
  async handleSubscriptionPaused(subscription: Stripe.Subscription): Promise<void> {
    const tenant = await this.tenantRepository.findOne({
      where: { stripeSubscriptionId: subscription.id },
    });

    if (!tenant) {
      this.logger.warn(`No tenant found for paused subscription ${subscription.id}`);
      return;
    }

    const previousStatus = tenant.subscriptionStatus;

    // Update tenant status
    tenant.isPaused = true;
    tenant.pausedAt = new Date();
    tenant.subscriptionStatus = SubscriptionStatus.PAUSED;

    // Check if there's a resume date set
    if (subscription.pause_collection?.resumes_at) {
      tenant.pauseResumesAt = new Date(subscription.pause_collection.resumes_at * 1000);
    }

    await this.tenantRepository.save(tenant);

    // Audit log
    await this.logAuditEvent({
      tenantId: tenant.id,
      eventType: AuditEventType.SUBSCRIPTION_UPDATED,
      stripeSubscriptionId: subscription.id,
      previousStatus,
      newStatus: SubscriptionStatus.PAUSED,
      metadata: {
        action: 'paused_via_webhook',
        resumesAt: tenant.pauseResumesAt?.toISOString(),
      },
    });

    this.logger.log(`Subscription paused via webhook for tenant ${tenant.name}`);
    this.eventEmitter.emit('subscription.paused', { tenant });
  }

  /**
   * Handle customer.subscription.resumed (Stripe auto-resumed)
   */
  async handleSubscriptionResumed(subscription: Stripe.Subscription): Promise<void> {
    const tenant = await this.tenantRepository.findOne({
      where: { stripeSubscriptionId: subscription.id },
    });

    if (!tenant) {
      this.logger.warn(`No tenant found for resumed subscription ${subscription.id}`);
      return;
    }

    const previousStatus = tenant.subscriptionStatus;
    const pauseDurationDays = tenant.pausedAt
      ? Math.floor((Date.now() - tenant.pausedAt.getTime()) / (1000 * 60 * 60 * 24))
      : null;

    // Update tenant status
    tenant.isPaused = false;
    tenant.pausedAt = null as any;
    tenant.pauseResumesAt = null as any;
    tenant.pauseReason = null as any;
    tenant.subscriptionStatus = this.mapStripeStatus(subscription.status);
    tenant.currentPeriodEnd = new Date(subscription.current_period_end * 1000);

    await this.tenantRepository.save(tenant);

    // Audit log
    await this.logAuditEvent({
      tenantId: tenant.id,
      eventType: AuditEventType.SUBSCRIPTION_UPDATED,
      stripeSubscriptionId: subscription.id,
      previousStatus,
      newStatus: tenant.subscriptionStatus,
      metadata: {
        action: 'resumed_via_webhook',
        pauseDurationDays,
      },
    });

    this.logger.log(`Subscription resumed via webhook for tenant ${tenant.name}`);
    this.eventEmitter.emit('subscription.resumed', {
      tenant,
      pauseDurationDays,
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

  /**
   * Verify a checkout session and activate the account
   * Used after successful Stripe Checkout redirect
   */
  async verifyCheckoutSession(sessionId: string): Promise<{
    success: boolean;
    tenantId?: string;
    message?: string;
  }> {
    this.ensureStripe();

    try {
      const session = await this.stripe.checkout.sessions.retrieve(sessionId, {
        expand: ['subscription'],
      });

      // Check payment status
      if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
        return { success: false, message: 'Payment not completed' };
      }

      const checkoutType = session.metadata?.type;

      // NEW SIGNUP: Find tenant by email (created by webhook)
      if (checkoutType === 'signup') {
        const email = session.metadata?.email;
        if (!email) {
          return { success: false, message: 'Session missing email metadata' };
        }

        // Find the user created by webhook
        const user = await this.userRepository.findOne({
          where: { email: email.toLowerCase() },
          relations: ['tenant'],
        });

        if (!user || !user.tenant) {
          // Webhook might not have processed yet - wait and retry
          await new Promise((resolve) => setTimeout(resolve, 2000));
          const retryUser = await this.userRepository.findOne({
            where: { email: email.toLowerCase() },
            relations: ['tenant'],
          });

          if (retryUser && retryUser.tenant) {
            return { success: true, tenantId: retryUser.tenant.id };
          }

          // Fallback: Create account directly from session metadata
          // This handles cases where webhook is delayed or failed
          this.logger.log(`Webhook hasn't created account yet, creating from session metadata`);
          
          const metadata = session.metadata!;
          const planId = metadata.planId;
          const plan = await this.planRepository.findOne({ where: { id: planId } });
          
          if (!plan) {
            return { success: false, message: 'Plan not found' };
          }

          const buildingName = metadata.buildingName;
          const slug = buildingName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)/g, '') + '-' + Date.now().toString(36);

          // Get subscription period from Stripe
          const subscriptionId = this.extractSubscriptionId(session.subscription);
          let currentPeriodEnd: Date | undefined;
          if (subscriptionId) {
            try {
              const stripeSubscription = await this.stripe.subscriptions.retrieve(subscriptionId);
              currentPeriodEnd = new Date(stripeSubscription.current_period_end * 1000);
            } catch (err) {
              this.logger.warn(`Could not retrieve subscription: ${err}`);
            }
          }

          // Create tenant
          const tenant = this.tenantRepository.create({
            name: buildingName,
            slug,
            contactEmail: email.toLowerCase(),
            contactPhone: metadata.phone || '',
            address: metadata.buildingAddress || '',
            status: TenantStatus.ACTIVE,
            subscriptionPlanId: plan.id,
            billingCycle: (metadata.billingCycle as BillingCycle) || BillingCycle.MONTHLY,
            stripeCustomerId: session.customer as string,
            stripeSubscriptionId: subscriptionId!,
            subscriptionStatus: SubscriptionStatus.ACTIVE,
            subscriptionStartedAt: new Date(),
            subscriptionExpiresAt: currentPeriodEnd,
            currentPeriodEnd: currentPeriodEnd,
            cancelAtPeriodEnd: false,
            settings: {
              signupDate: new Date().toISOString(),
              paidOnSignup: true,
            },
          });

          const savedTenant = await this.tenantRepository.save(tenant);

          // Generate QR code for the building admin
          const qrCode = `GR-${uuidv4()}`;

          // Create user
          const newUser = this.userRepository.create({
            email: email.toLowerCase(),
            passwordHash: metadata.passwordHash,
            firstName: metadata.firstName,
            lastName: metadata.lastName,
            phone: metadata.phone || '',
            role: UserRole.BUILDING_ADMIN,
            status: UserStatus.ACTIVE,
            tenantId: savedTenant.id,
            qrCode,
          });

          const savedUser = await this.userRepository.save(newUser);
          this.logger.log(`Created account via verify-payment fallback: ${email}`);

          // Calculate effective price with discount for email
          const billingCycle = (metadata.billingCycle as BillingCycle) || BillingCycle.MONTHLY;
          const basePrice = billingCycle === BillingCycle.YEARLY
            ? Number(plan.yearlyPrice)
            : Number(plan.monthlyPrice);
          const effectivePrice = this.calculateEffectivePrice(
            basePrice,
            Number(plan.discountPercent),
            plan.discountValidUntil,
          );

          // Send welcome email with subscription info
          const frontendUrl = this.configService.get<string>('FRONTEND_URL', 'https://yaad.global');
          this.emailService
            .sendWelcomeEmail(
              savedUser.email,
              `${savedUser.firstName} ${savedUser.lastName}`,
              savedTenant.name,
              `${frontendUrl}/dashboard`,
              {
                type: 'subscription',
                planName: plan.name,
                price: effectivePrice,
                billingCycle: billingCycle === BillingCycle.YEARLY ? 'yearly' : 'monthly',
              },
            )
            .catch((error) => {
              this.logger.error(`Failed to send welcome email to ${savedUser.email}:`, error);
            });

          return { success: true, tenantId: savedTenant.id };
        }

        return { success: true, tenantId: user.tenant.id };
      }

      // EXISTING TENANT: Original flow
      const tenantId = session.metadata?.tenantId;
      const planId = session.metadata?.planId;
      const billingCycle = session.metadata?.billingCycle as BillingCycle;

      if (!tenantId || !planId) {
        return { success: false, message: 'Session missing required metadata' };
      }

      const tenant = await this.tenantRepository.findOne({ where: { id: tenantId } });
      const plan = await this.planRepository.findOne({ where: { id: planId } });

      if (!tenant || !plan) {
        return { success: false, message: 'Tenant or plan not found' };
      }

      // Update tenant with subscription info
      const subscriptionId = this.extractSubscriptionId(session.subscription);
      tenant.subscriptionPlanId = plan.id;
      tenant.billingCycle = billingCycle || BillingCycle.MONTHLY;
      tenant.stripeSubscriptionId = subscriptionId!;
      tenant.subscriptionStatus = SubscriptionStatus.ACTIVE;
      tenant.status = TenantStatus.ACTIVE;
      tenant.subscriptionStartedAt = new Date();
      tenant.cancelAtPeriodEnd = false;

      // Set subscription period from the subscription
      if (subscriptionId) {
        try {
          const subscription = await this.stripe.subscriptions.retrieve(subscriptionId);
          tenant.currentPeriodEnd = new Date(subscription.current_period_end * 1000);
          tenant.subscriptionExpiresAt = tenant.currentPeriodEnd;
        } catch (err) {
          this.logger.warn(`Could not retrieve subscription: ${err}`);
        }
      }

      await this.tenantRepository.save(tenant);
      this.logger.log(`Payment verified for tenant ${tenant.name} - Plan: ${plan.name}`);

      this.eventEmitter.emit('subscription.activated', { tenant, plan });

      return { success: true, tenantId: tenant.id };
    } catch (error: any) {
      this.logger.error(`Failed to verify checkout session: ${error.message}`);
      return { success: false, message: error.message || 'Failed to verify payment' };
    }
  }

  // ==================== Refund Management ====================

  /**
   * Create a refund for a tenant's charge
   * Supports full refunds, partial refunds, and prorated refunds
   */
  async createRefund(tenantId: string, dto: CreateRefundDto): Promise<RefundResult> {
    this.ensureStripe();

    const tenant = await this.tenantRepository.findOne({
      where: { id: tenantId },
      relations: ['subscriptionPlan'],
    });

    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    if (!tenant.stripeCustomerId) {
      throw new BadRequestException('Tenant has no Stripe customer');
    }

    // Find the charge to refund
    let chargeId = dto.chargeId;

    if (!chargeId) {
      // Get the latest successful charge for this customer
      const charges = await this.stripe.charges.list({
        customer: tenant.stripeCustomerId,
        limit: 1,
      });

      if (!charges.data.length) {
        throw new BadRequestException('No charges found for this customer');
      }

      chargeId = charges.data[0].id;
    }

    // Verify the charge exists and is refundable
    const charge = await this.stripe.charges.retrieve(chargeId);

    if (charge.refunded) {
      throw new BadRequestException('This charge has already been fully refunded');
    }

    const alreadyRefunded = charge.amount_refunded || 0;
    const refundableAmount = charge.amount - alreadyRefunded;

    if (refundableAmount <= 0) {
      throw new BadRequestException('No remaining amount to refund');
    }

    // Determine refund amount
    let refundAmount = dto.amount;
    if (!refundAmount) {
      refundAmount = refundableAmount; // Full refund
    } else if (refundAmount > refundableAmount) {
      throw new BadRequestException(
        `Refund amount exceeds refundable amount. Max refundable: $${(refundableAmount / 100).toFixed(2)}`,
      );
    }

    // Map our reason to Stripe's reason
    const stripeReason = this.mapRefundReasonToStripe(dto.reason);

    // Create the refund in Stripe
    const refund = await this.stripe.refunds.create({
      charge: chargeId,
      amount: refundAmount,
      reason: stripeReason,
      metadata: {
        tenantId: tenant.id,
        internalNote: dto.internalNote || '',
        reason: dto.reason,
        initiatedBy: 'admin',
      },
    });

    // Determine if this is partial or full
    const isPartialRefund = refundAmount < charge.amount;

    // Log the audit event
    await this.logAuditEvent({
      tenantId: tenant.id,
      eventType: isPartialRefund
        ? AuditEventType.PAYMENT_PARTIAL_REFUND
        : AuditEventType.PAYMENT_REFUNDED,
      stripeSubscriptionId: tenant.stripeSubscriptionId || undefined,
      amount: refundAmount / 100,
      currency: charge.currency,
      metadata: {
        refundId: refund.id,
        chargeId: chargeId,
        reason: dto.reason,
        internalNote: dto.internalNote,
        originalAmount: charge.amount / 100,
        refundedAmount: refundAmount / 100,
        isPartial: isPartialRefund,
      },
    });

    // Emit event for notification
    if (dto.notifyCustomer !== false) {
      this.eventEmitter.emit('refund.created', {
        tenant,
        refund,
        amount: refundAmount,
        reason: dto.reason,
      });
    }

    this.logger.log(
      `Refund created for tenant ${tenant.name}: $${(refundAmount / 100).toFixed(2)} (${dto.reason})`,
    );

    return {
      refundId: refund.id,
      chargeId: chargeId,
      amount: refundAmount,
      amountFormatted: `$${(refundAmount / 100).toFixed(2)}`,
      currency: charge.currency,
      status: refund.status as RefundResult['status'],
      reason: dto.reason,
      createdAt: new Date(refund.created * 1000),
    };
  }

  /**
   * Calculate prorated refund amount for early cancellation or downgrade
   */
  async calculateProratedRefund(tenantId: string): Promise<RefundCalculation> {
    this.ensureStripe();

    const tenant = await this.tenantRepository.findOne({
      where: { id: tenantId },
      relations: ['subscriptionPlan'],
    });

    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    if (!tenant.stripeSubscriptionId) {
      return {
        originalAmount: 0,
        refundableAmount: 0,
        daysUsed: 0,
        daysRemaining: 0,
        proratedAmount: 0,
        currency: 'usd',
        eligibleForRefund: false,
        message: 'No active subscription',
      };
    }

    // Get the subscription from Stripe
    const subscription = await this.stripe.subscriptions.retrieve(tenant.stripeSubscriptionId);

    // Get the latest invoice
    const invoices = await this.stripe.invoices.list({
      subscription: tenant.stripeSubscriptionId,
      limit: 1,
      status: 'paid',
    });

    if (!invoices.data.length) {
      return {
        originalAmount: 0,
        refundableAmount: 0,
        daysUsed: 0,
        daysRemaining: 0,
        proratedAmount: 0,
        currency: 'usd',
        eligibleForRefund: false,
        message: 'No paid invoices found',
      };
    }

    const latestInvoice = invoices.data[0];
    const originalAmount = latestInvoice.amount_paid;

    // Calculate proration
    const periodStart = new Date(subscription.current_period_start * 1000);
    const periodEnd = new Date(subscription.current_period_end * 1000);
    const now = new Date();

    const totalDays = Math.ceil(
      (periodEnd.getTime() - periodStart.getTime()) / (1000 * 60 * 60 * 24),
    );
    const daysUsed = Math.ceil((now.getTime() - periodStart.getTime()) / (1000 * 60 * 60 * 24));
    const daysRemaining = Math.max(0, totalDays - daysUsed);

    // Calculate prorated amount
    const dailyRate = originalAmount / totalDays;
    const proratedAmount = Math.round(dailyRate * daysRemaining);

    // Check if refund is allowed (many companies have a cutoff, e.g., 7+ days remaining)
    const minimumDaysForRefund = 7;
    const eligibleForRefund = daysRemaining >= minimumDaysForRefund && proratedAmount > 0;

    return {
      originalAmount,
      refundableAmount: eligibleForRefund ? proratedAmount : 0,
      daysUsed,
      daysRemaining,
      proratedAmount,
      currency: latestInvoice.currency,
      eligibleForRefund,
      message: eligibleForRefund
        ? `Eligible for prorated refund of $${(proratedAmount / 100).toFixed(2)}`
        : daysRemaining < minimumDaysForRefund
          ? `Refunds require at least ${minimumDaysForRefund} days remaining in the billing period`
          : 'Not eligible for refund',
    };
  }

  /**
   * Issue a credit to customer's Stripe balance (for future invoices)
   */
  async issueCredit(
    tenantId: string,
    amount: number, // In cents
    description: string,
  ): Promise<{ success: boolean; creditId: string; amount: number }> {
    this.ensureStripe();

    const tenant = await this.tenantRepository.findOne({ where: { id: tenantId } });

    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    if (!tenant.stripeCustomerId) {
      throw new BadRequestException('Tenant has no Stripe customer');
    }

    // Create a negative invoice item (credit)
    const creditItem = await this.stripe.invoiceItems.create({
      customer: tenant.stripeCustomerId,
      amount: -amount, // Negative = credit
      currency: 'usd',
      description: description,
    });

    // Log audit event
    await this.logAuditEvent({
      tenantId: tenant.id,
      eventType: AuditEventType.CREDIT_ISSUED,
      amount: amount / 100,
      currency: 'usd',
      metadata: {
        creditId: creditItem.id,
        description,
      },
    });

    this.logger.log(`Credit issued to tenant ${tenant.name}: $${(amount / 100).toFixed(2)}`);

    return {
      success: true,
      creditId: creditItem.id,
      amount,
    };
  }

  /**
   * Get refund history for a tenant
   */
  async getRefundHistory(tenantId: string): Promise<RefundHistory> {
    this.ensureStripe();

    const tenant = await this.tenantRepository.findOne({ where: { id: tenantId } });

    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    if (!tenant.stripeCustomerId) {
      return {
        refunds: [],
        totalRefunded: 0,
        totalRefundedFormatted: '$0.00',
        currency: 'usd',
      };
    }

    // Get all charges for this customer
    const charges = await this.stripe.charges.list({
      customer: tenant.stripeCustomerId,
      limit: 100,
    });

    // Get refunds for each charge
    const refunds: RefundResult[] = [];
    let totalRefunded = 0;

    for (const charge of charges.data) {
      if (charge.amount_refunded > 0) {
        // Fetch the actual refund objects
        const chargeRefunds = await this.stripe.refunds.list({
          charge: charge.id,
        });

        for (const refund of chargeRefunds.data) {
          refunds.push({
            refundId: refund.id,
            chargeId: charge.id,
            amount: refund.amount,
            amountFormatted: `$${(refund.amount / 100).toFixed(2)}`,
            currency: refund.currency,
            status: refund.status as RefundResult['status'],
            reason: (refund.metadata?.reason as string) || refund.reason || 'unknown',
            createdAt: new Date(refund.created * 1000),
          });

          totalRefunded += refund.amount;
        }
      }
    }

    // Sort by date descending
    refunds.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    return {
      refunds,
      totalRefunded,
      totalRefundedFormatted: `$${(totalRefunded / 100).toFixed(2)}`,
      currency: 'usd',
    };
  }

  /**
   * Handle charge.refunded webhook from Stripe
   */
  async handleChargeRefunded(charge: Stripe.Charge): Promise<void> {
    const customerId = charge.customer as string;

    const tenant = await this.tenantRepository.findOne({
      where: { stripeCustomerId: customerId },
    });

    if (!tenant) {
      this.logger.warn(`Refund webhook: no tenant found for customer ${customerId}`);
      return;
    }

    const isFullRefund = charge.refunded;
    const refundedAmount = charge.amount_refunded;

    // Record the refund in payments table
    // Get the latest refund details
    try {
      const refunds = await this.stripe.refunds.list({
        charge: charge.id,
        limit: 1,
      });

      if (refunds.data.length > 0) {
        const latestRefund = refunds.data[0];
        await this.recordRefundPayment({
          tenantId: tenant.id,
          amount: latestRefund.amount,
          stripeRefundId: latestRefund.id,
          stripeChargeId: charge.id,
          reason: (latestRefund.metadata?.reason as string) || latestRefund.reason || 'refund',
          currency: charge.currency,
        });
      }
    } catch (e) {
      this.logger.error('Failed to record refund payment:', e);
    }

    // Log audit event
    await this.logAuditEvent({
      tenantId: tenant.id,
      eventType: isFullRefund
        ? AuditEventType.PAYMENT_REFUNDED
        : AuditEventType.PAYMENT_PARTIAL_REFUND,
      stripeSubscriptionId: tenant.stripeSubscriptionId || undefined,
      amount: refundedAmount / 100,
      currency: charge.currency,
      metadata: {
        chargeId: charge.id,
        originalAmount: charge.amount / 100,
        refundedAmount: refundedAmount / 100,
        isFullRefund,
        refundSource: 'webhook',
      },
    });

    // Emit event for notification
    this.eventEmitter.emit('refund.processed', {
      tenant,
      charge,
      amount: refundedAmount,
      isFullRefund,
    });

    this.logger.log(
      `Refund processed for tenant ${tenant.name}: $${(refundedAmount / 100).toFixed(2)} (${isFullRefund ? 'full' : 'partial'})`,
    );
  }

  /**
   * Handle charge.refund.updated webhook from Stripe
   */
  async handleRefundUpdated(refund: Stripe.Refund): Promise<void> {
    // Get the charge to find the customer
    const charge = await this.stripe.charges.retrieve(refund.charge as string);
    const customerId = charge.customer as string;

    const tenant = await this.tenantRepository.findOne({
      where: { stripeCustomerId: customerId },
    });

    if (!tenant) {
      this.logger.warn(`Refund update webhook: no tenant found for customer ${customerId}`);
      return;
    }

    // Log status change
    this.logger.log(
      `Refund ${refund.id} status updated to ${refund.status} for tenant ${tenant.name}`,
    );

    // Handle failed refunds
    if (refund.status === 'failed') {
      this.eventEmitter.emit('refund.failed', {
        tenant,
        refund,
        failureReason: refund.failure_reason,
      });
    }
  }

  /**
   * Map our RefundReason enum to Stripe's accepted reasons
   */
  private mapRefundReasonToStripe(reason: RefundReason): Stripe.RefundCreateParams.Reason {
    switch (reason) {
      case RefundReason.DUPLICATE:
        return 'duplicate';
      case RefundReason.FRAUDULENT:
        return 'fraudulent';
      case RefundReason.REQUESTED_BY_CUSTOMER:
      case RefundReason.SERVICE_NOT_RENDERED:
      case RefundReason.DOWNGRADE:
      case RefundReason.CANCELLATION:
      case RefundReason.BILLING_ERROR:
      case RefundReason.OTHER:
      default:
        return 'requested_by_customer';
    }
  }

  // ==================== Audit Logging ====================

  /**
   * Log an audit event for subscription changes
   */
  async logAuditEvent(data: {
    tenantId?: string;
    eventType: AuditEventType;
    stripeEventId?: string;
    stripeSubscriptionId?: string;
    previousStatus?: string;
    newStatus?: string;
    previousPlanId?: string;
    newPlanId?: string;
    amount?: number;
    currency?: string;
    metadata?: Record<string, unknown>;
    errorMessage?: string;
  }): Promise<void> {
    try {
      const log = this.auditLogRepository.create(data);
      await this.auditLogRepository.save(log);
      this.logger.debug(`Audit logged: ${data.eventType} for tenant ${data.tenantId}`);
    } catch (error) {
      this.logger.error('Failed to create audit log:', error);
    }
  }

  /**
   * Get audit logs for a tenant
   */
  async getAuditLogs(tenantId: string, limit: number = 50): Promise<SubscriptionAuditLog[]> {
    return this.auditLogRepository.find({
      where: { tenantId },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  // ==================== Payment Recording ====================

  /**
   * Record a successful payment
   * Includes duplicate prevention by stripeInvoiceId or stripePaymentIntentId
   */
  async recordPayment(data: {
    tenantId: string;
    amount: number; // In cents
    netAmount?: number;
    feeAmount?: number;
    taxAmount?: number;
    currency?: string;
    transactionType: TransactionType;
    paymentType: PaymentType;
    stripePaymentIntentId?: string;
    stripeChargeId?: string;
    stripeInvoiceId?: string;
    stripeSubscriptionId?: string;
    billingPeriodStart?: Date;
    billingPeriodEnd?: Date;
    billingCycle?: string;
    paymentMethodType?: string;
    paymentMethodLast4?: string;
    paymentMethodBrand?: string;
    description?: string;
    metadata?: Record<string, unknown>;
  }): Promise<Payment> {
    // Prevent duplicates by checking if payment already exists
    if (data.stripeInvoiceId) {
      const existing = await this.paymentRepository.findOne({
        where: { stripeInvoiceId: data.stripeInvoiceId },
      });
      if (existing) {
        this.logger.log(`Payment already exists for invoice ${data.stripeInvoiceId}`);
        return existing;
      }
    }
    if (data.stripePaymentIntentId) {
      const existing = await this.paymentRepository.findOne({
        where: { stripePaymentIntentId: data.stripePaymentIntentId },
      });
      if (existing) {
        this.logger.log(`Payment already exists for payment intent ${data.stripePaymentIntentId}`);
        return existing;
      }
    }

    const tenant = await this.tenantRepository.findOne({
      where: { id: data.tenantId },
      relations: ['subscriptionPlan'],
    });

    const payment = this.paymentRepository.create({
      tenantId: data.tenantId,
      subscriptionPlanId: tenant?.subscriptionPlanId,
      amount: data.amount / 100, // Convert to dollars
      netAmount: data.netAmount ? data.netAmount / 100 : undefined,
      feeAmount: data.feeAmount ? data.feeAmount / 100 : undefined,
      taxAmount: data.taxAmount ? data.taxAmount / 100 : undefined,
      currency: data.currency || 'usd',
      transactionType: data.transactionType,
      paymentType: data.paymentType,
      status: PaymentStatus.SUCCEEDED,
      stripePaymentIntentId: data.stripePaymentIntentId,
      stripeChargeId: data.stripeChargeId,
      stripeInvoiceId: data.stripeInvoiceId,
      stripeSubscriptionId: data.stripeSubscriptionId,
      billingPeriodStart: data.billingPeriodStart,
      billingPeriodEnd: data.billingPeriodEnd,
      billingCycle: data.billingCycle,
      paymentMethodType: data.paymentMethodType,
      paymentMethodLast4: data.paymentMethodLast4,
      paymentMethodBrand: data.paymentMethodBrand,
      description: data.description,
      metadata: data.metadata,
      customerEmail: tenant?.name,
      customerName: tenant?.name,
      paidAt: new Date(),
    });

    const saved = await this.paymentRepository.save(payment);
    this.logger.log(`Payment recorded: $${payment.amount} for tenant ${data.tenantId}`);
    return saved;
  }

  /**
   * Record a refund transaction
   */
  async recordRefundPayment(data: {
    tenantId: string;
    amount: number; // In cents
    originalPaymentId?: string;
    stripeRefundId: string;
    stripeChargeId: string;
    reason?: string;
    currency?: string;
  }): Promise<Payment> {
    const payment = this.paymentRepository.create({
      tenantId: data.tenantId,
      amount: data.amount / 100,
      currency: data.currency || 'usd',
      transactionType: TransactionType.REFUND,
      paymentType: PaymentType.SUBSCRIPTION,
      status: PaymentStatus.SUCCEEDED,
      stripeRefundId: data.stripeRefundId,
      stripeChargeId: data.stripeChargeId,
      refundReason: data.reason,
      description: `Refund: ${data.reason || 'Customer request'}`,
      refundedAt: new Date(),
      paidAt: new Date(),
    });

    const saved = await this.paymentRepository.save(payment);
    this.logger.log(`Refund recorded: $${payment.amount} for tenant ${data.tenantId}`);
    return saved;
  }

  /**
   * Record a failed payment
   */
  async recordFailedPayment(data: {
    tenantId: string;
    amount: number;
    stripePaymentIntentId?: string;
    stripeInvoiceId?: string;
    failureReason: string;
    currency?: string;
  }): Promise<Payment> {
    const payment = this.paymentRepository.create({
      tenantId: data.tenantId,
      amount: data.amount / 100,
      currency: data.currency || 'usd',
      transactionType: TransactionType.CHARGE,
      paymentType: PaymentType.SUBSCRIPTION,
      status: PaymentStatus.FAILED,
      stripePaymentIntentId: data.stripePaymentIntentId,
      stripeInvoiceId: data.stripeInvoiceId,
      failureReason: data.failureReason,
      description: `Failed payment: ${data.failureReason}`,
    });

    const saved = await this.paymentRepository.save(payment);
    this.logger.log(`Failed payment recorded for tenant ${data.tenantId}`);
    return saved;
  }

  // ==================== Financial Overview (Admin) ====================

  /**
   * Get comprehensive financial overview
   * Used for super admin dashboard
   */
  async getFinancialOverview(): Promise<FinancialOverview> {
    const now = new Date();
    const currentMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    // Get MRR from active subscriptions
    const activeTenantsWithPlans = await this.tenantRepository
      .createQueryBuilder('tenant')
      .innerJoinAndSelect('tenant.subscriptionPlan', 'plan')
      .where('tenant.subscriptionStatus = :status', { status: SubscriptionStatus.ACTIVE })
      .andWhere('tenant.isPaused = false')
      .getMany();

    let mrr = 0;
    for (const tenant of activeTenantsWithPlans) {
      if (tenant.billingCycle === BillingCycle.MONTHLY) {
        mrr += Number(tenant.subscriptionPlan.monthlyPrice);
      } else if (tenant.billingCycle === BillingCycle.YEARLY) {
        // Convert yearly to monthly equivalent
        mrr += Number(tenant.subscriptionPlan.yearlyPrice) / 12;
      }
    }

    // Current month revenue
    const currentMonthRevenue = await this.paymentRepository
      .createQueryBuilder('payment')
      .where('payment.createdAt >= :start', { start: currentMonth })
      .andWhere('payment.transactionType = :type', { type: TransactionType.CHARGE })
      .andWhere('payment.status = :status', { status: PaymentStatus.SUCCEEDED })
      .select('COALESCE(SUM(payment.amount), 0)', 'total')
      .getRawOne();

    // Last month revenue
    const lastMonthRevenue = await this.paymentRepository
      .createQueryBuilder('payment')
      .where('payment.createdAt >= :start', { start: lastMonth })
      .andWhere('payment.createdAt < :end', { end: currentMonth })
      .andWhere('payment.transactionType = :type', { type: TransactionType.CHARGE })
      .andWhere('payment.status = :status', { status: PaymentStatus.SUCCEEDED })
      .select('COALESCE(SUM(payment.amount), 0)', 'total')
      .getRawOne();

    // Calculate revenue growth
    const currentRev = parseFloat(currentMonthRevenue?.total || '0');
    const lastRev = parseFloat(lastMonthRevenue?.total || '0');
    const revenueGrowth = lastRev > 0 ? ((currentRev - lastRev) / lastRev) * 100 : 0;

    // Total revenue (all time)
    const totalRevenue = await this.paymentRepository
      .createQueryBuilder('payment')
      .where('payment.transactionType = :type', { type: TransactionType.CHARGE })
      .andWhere('payment.status = :status', { status: PaymentStatus.SUCCEEDED })
      .select('COALESCE(SUM(payment.amount), 0)', 'total')
      .getRawOne();

    // Total refunds (all time)
    const totalRefunds = await this.paymentRepository
      .createQueryBuilder('payment')
      .where('payment.transactionType = :type', { type: TransactionType.REFUND })
      .select('COALESCE(SUM(payment.amount), 0)', 'total')
      .getRawOne();

    // Active subscriptions count
    const activeSubscriptions = await this.tenantRepository.count({
      where: { subscriptionStatus: SubscriptionStatus.ACTIVE },
    });

    // Churn rate (cancellations this month / active at start of month)
    const cancellationsThisMonth = await this.tenantRepository
      .createQueryBuilder('tenant')
      .where('tenant.subscriptionStatus = :status', { status: SubscriptionStatus.CANCELED })
      .andWhere('tenant.updatedAt >= :start', { start: currentMonth })
      .getCount();

    const activeAtMonthStart = activeSubscriptions + cancellationsThisMonth;
    const churnRate =
      activeAtMonthStart > 0 ? (cancellationsThisMonth / activeAtMonthStart) * 100 : 0;

    // ARPU
    const averageRevenuePerUser = activeSubscriptions > 0 ? mrr / activeSubscriptions : 0;

    const totalRev = parseFloat(totalRevenue?.total || '0');
    const totalRef = parseFloat(totalRefunds?.total || '0');

    return {
      mrr: Math.round(mrr * 100) / 100,
      arr: Math.round(mrr * 12 * 100) / 100,
      revenueGrowth: Math.round(revenueGrowth * 10) / 10,
      totalRevenue: totalRev,
      totalRefunds: totalRef,
      netRevenue: totalRev - totalRef,
      activeSubscriptions,
      churnRate: Math.round(churnRate * 10) / 10,
      averageRevenuePerUser: Math.round(averageRevenuePerUser * 100) / 100,
      currency: 'usd',
    };
  }

  /**
   * Get revenue breakdown by month
   */
  async getRevenueByMonth(months: number = 12): Promise<RevenueByPeriod[]> {
    const results: RevenueByPeriod[] = [];
    const now = new Date();

    for (let i = months - 1; i >= 0; i--) {
      const startDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const endDate = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
      const periodKey = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}`;

      // Revenue for this month
      const revenue = await this.paymentRepository
        .createQueryBuilder('payment')
        .where('payment.createdAt >= :start', { start: startDate })
        .andWhere('payment.createdAt <= :end', { end: endDate })
        .andWhere('payment.transactionType = :type', { type: TransactionType.CHARGE })
        .andWhere('payment.status = :status', { status: PaymentStatus.SUCCEEDED })
        .select('COALESCE(SUM(payment.amount), 0)', 'total')
        .addSelect('COUNT(*)', 'count')
        .getRawOne();

      // Refunds for this month
      const refunds = await this.paymentRepository
        .createQueryBuilder('payment')
        .where('payment.createdAt >= :start', { start: startDate })
        .andWhere('payment.createdAt <= :end', { end: endDate })
        .andWhere('payment.transactionType = :type', { type: TransactionType.REFUND })
        .select('COALESCE(SUM(payment.amount), 0)', 'total')
        .getRawOne();

      const rev = parseFloat(revenue?.total || '0');
      const ref = parseFloat(refunds?.total || '0');

      results.push({
        period: periodKey,
        revenue: rev,
        refunds: ref,
        net: rev - ref,
        transactions: parseInt(revenue?.count || '0'),
      });
    }

    return results;
  }

  /**
   * Get all payments with pagination (Admin)
   */
  async getAllPayments(options: {
    page?: number;
    limit?: number;
    tenantId?: string;
    planId?: string;
    status?: PaymentStatus;
    transactionType?: TransactionType;
    billingCycle?: string;
    startDate?: Date;
    endDate?: Date;
    searchTerm?: string;
  }): Promise<{ payments: Payment[]; total: number; page: number; totalPages: number }> {
    const page = options.page || 1;
    const limit = options.limit || 20;
    const skip = (page - 1) * limit;

    const query = this.paymentRepository
      .createQueryBuilder('payment')
      .leftJoinAndSelect('payment.tenant', 'tenant')
      .leftJoinAndSelect('payment.subscriptionPlan', 'plan')
      .orderBy('payment.createdAt', 'DESC');

    if (options.tenantId) {
      query.andWhere('payment.tenantId = :tenantId', { tenantId: options.tenantId });
    }

    if (options.planId) {
      query.andWhere('payment.subscriptionPlanId = :planId', { planId: options.planId });
    }

    if (options.searchTerm) {
      query.andWhere(
        '(tenant.name ILIKE :search OR payment.customerEmail ILIKE :search OR payment.customerName ILIKE :search OR payment.description ILIKE :search)',
        { search: `%${options.searchTerm}%` }
      );
    }

    if (options.status) {
      query.andWhere('payment.status = :status', { status: options.status });
    }

    if (options.transactionType) {
      query.andWhere('payment.transactionType = :type', { type: options.transactionType });
    }

    if (options.billingCycle) {
      query.andWhere('payment.billingCycle = :billingCycle', { billingCycle: options.billingCycle });
    }

    if (options.startDate) {
      query.andWhere('payment.createdAt >= :startDate', { startDate: options.startDate });
    }

    if (options.endDate) {
      query.andWhere('payment.createdAt <= :endDate', { endDate: options.endDate });
    }

    const [payments, total] = await query.skip(skip).take(limit).getManyAndCount();

    return {
      payments,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Get payment summary stats
   */
  async getPaymentSummary(tenantId?: string): Promise<PaymentSummary> {
    const baseQuery = this.paymentRepository.createQueryBuilder('payment');

    if (tenantId) {
      baseQuery.where('payment.tenantId = :tenantId', { tenantId });
    }

    // Total payments
    const totalPayments = await baseQuery.clone().getCount();

    // Successful payments
    const successfulPayments = await baseQuery
      .clone()
      .andWhere('payment.status = :status', { status: PaymentStatus.SUCCEEDED })
      .andWhere('payment.transactionType = :type', { type: TransactionType.CHARGE })
      .getCount();

    // Failed payments
    const failedPayments = await baseQuery
      .clone()
      .andWhere('payment.status = :status', { status: PaymentStatus.FAILED })
      .getCount();

    // Total refunds count
    const totalRefundsCount = await baseQuery
      .clone()
      .andWhere('payment.transactionType = :type', { type: TransactionType.REFUND })
      .getCount();

    // Total amount
    const totalAmountResult = await baseQuery
      .clone()
      .andWhere('payment.transactionType = :type', { type: TransactionType.CHARGE })
      .andWhere('payment.status = :status', { status: PaymentStatus.SUCCEEDED })
      .select('COALESCE(SUM(payment.amount), 0)', 'total')
      .getRawOne();

    // Refunded amount
    const refundedAmountResult = await baseQuery
      .clone()
      .andWhere('payment.transactionType = :type', { type: TransactionType.REFUND })
      .select('COALESCE(SUM(payment.amount), 0)', 'total')
      .getRawOne();

    const totalAmount = parseFloat(totalAmountResult?.total || '0');
    const refundedAmount = parseFloat(refundedAmountResult?.total || '0');

    return {
      totalPayments,
      successfulPayments,
      failedPayments,
      totalRefunds: totalRefundsCount,
      totalAmount,
      refundedAmount,
      netAmount: totalAmount - refundedAmount,
    };
  }

  /**
   * Get tenant's payment history
   */
  async getTenantPaymentHistory(
    tenantId: string,
    options: { page?: number; limit?: number } = {},
  ): Promise<{ payments: Payment[]; total: number }> {
    const page = options.page || 1;
    const limit = options.limit || 20;
    const skip = (page - 1) * limit;

    const [payments, total] = await this.paymentRepository.findAndCount({
      where: { tenantId },
      relations: ['subscriptionPlan'],
      order: { createdAt: 'DESC' },
      skip,
      take: limit,
    });

    return { payments, total };
  }

  // ==================== Payment Visibility (Phase 6) ====================

  /**
   * Building-admin invoice history — a tenant's Stripe invoices (date, amount,
   * status, hosted page + PDF). Sourced from Stripe by `stripeCustomerId` so it
   * always reflects the authoritative billing record and carries the PDF links
   * the local payments table does not store. Returns an empty list for tenants
   * that never reached Stripe checkout (no customer id).
   */
  async getTenantInvoices(
    tenantId: string,
    options: { limit?: number } = {},
  ): Promise<{ invoices: TenantInvoice[]; hasMore: boolean }> {
    this.ensureStripe();

    const tenant = await this.tenantRepository.findOne({ where: { id: tenantId } });
    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }
    if (!tenant.stripeCustomerId) {
      return { invoices: [], hasMore: false };
    }

    const limit = Math.min(Math.max(options.limit ?? 24, 1), 100);
    const list = await this.stripe.invoices.list({
      customer: tenant.stripeCustomerId,
      limit,
    });

    const invoices: TenantInvoice[] = list.data.map((inv) => ({
      id: inv.id,
      number: inv.number ?? null,
      status: inv.status ?? null,
      amountDue: (inv.amount_due ?? 0) / 100,
      amountPaid: (inv.amount_paid ?? 0) / 100,
      amountRemaining: (inv.amount_remaining ?? 0) / 100,
      currency: inv.currency,
      created: new Date(inv.created * 1000),
      periodStart: inv.period_start ? new Date(inv.period_start * 1000) : null,
      periodEnd: inv.period_end ? new Date(inv.period_end * 1000) : null,
      dueDate: inv.due_date ? new Date(inv.due_date * 1000) : null,
      hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
      invoicePdf: inv.invoice_pdf ?? null,
      description: inv.description ?? inv.lines?.data?.[0]?.description ?? null,
    }));

    return { invoices, hasMore: list.has_more };
  }

  /**
   * Super-admin platform revenue snapshot — MRR/ARR and revenue rollups (reused
   * from getFinancialOverview) plus tenant counts by lifecycle status and the
   * most recent payments. Powers the admin revenue widget.
   */
  async getRevenueSnapshot(options: { recentLimit?: number } = {}): Promise<RevenueSnapshot> {
    const overview = await this.getFinancialOverview();

    const [active, trial, suspended, pendingPayment, pastDue] = await Promise.all([
      this.tenantRepository.count({ where: { status: TenantStatus.ACTIVE } }),
      this.tenantRepository.count({ where: { status: TenantStatus.TRIAL } }),
      this.tenantRepository.count({ where: { status: TenantStatus.SUSPENDED } }),
      this.tenantRepository.count({ where: { status: TenantStatus.PENDING_PAYMENT } }),
      this.tenantRepository.count({
        where: { subscriptionStatus: SubscriptionStatus.PAST_DUE },
      }),
    ]);

    const recentLimit = Math.min(Math.max(options.recentLimit ?? 10, 1), 50);
    const recent = await this.paymentRepository.find({
      relations: ['tenant', 'subscriptionPlan'],
      order: { createdAt: 'DESC' },
      take: recentLimit,
    });

    const recentPayments: RecentPaymentSummary[] = recent.map((p) => ({
      id: p.id,
      tenantId: p.tenantId,
      tenantName: p.tenant?.name ?? null,
      planName: p.subscriptionPlan?.name ?? null,
      amount: Number(p.amount),
      currency: p.currency,
      status: p.status,
      transactionType: p.transactionType,
      paymentType: p.paymentType,
      cardBrand: p.paymentMethodBrand ?? null,
      cardLast4: p.paymentMethodLast4 ?? null,
      createdAt: p.createdAt,
    }));

    return {
      mrr: overview.mrr,
      arr: overview.arr,
      totalRevenue: overview.totalRevenue,
      totalRefunds: overview.totalRefunds,
      netRevenue: overview.netRevenue,
      revenueGrowth: overview.revenueGrowth,
      churnRate: overview.churnRate,
      averageRevenuePerUser: overview.averageRevenuePerUser,
      activeSubscriptions: overview.activeSubscriptions,
      currency: overview.currency,
      counts: {
        total: active + trial + suspended + pendingPayment,
        active,
        trial,
        suspended,
        pendingPayment,
        pastDue,
      },
      recentPayments,
    };
  }

  // ==================== Advanced Payment Analytics ====================

  /**
   * Get revenue breakdown by billing cycle (monthly vs yearly)
   */
  async getRevenueByBillingCycle(options?: {
    startDate?: Date;
    endDate?: Date;
    tenantId?: string;
  }): Promise<{
    monthly: { revenue: number; count: number; refunds: number };
    yearly: { revenue: number; count: number; refunds: number };
    unknown: { revenue: number; count: number; refunds: number };
    total: { revenue: number; count: number; refunds: number };
  }> {
    const baseQuery = this.paymentRepository.createQueryBuilder('payment');

    if (options?.startDate) {
      baseQuery.andWhere('payment.createdAt >= :startDate', { startDate: options.startDate });
    }
    if (options?.endDate) {
      baseQuery.andWhere('payment.createdAt <= :endDate', { endDate: options.endDate });
    }
    if (options?.tenantId) {
      baseQuery.andWhere('payment.tenantId = :tenantId', { tenantId: options.tenantId });
    }

    // Get revenue by billing cycle
    const revenueResult = await baseQuery
      .clone()
      .select('payment.billingCycle', 'billingCycle')
      .addSelect('COALESCE(SUM(payment.amount), 0)', 'revenue')
      .addSelect('COUNT(*)', 'count')
      .where('payment.transactionType = :type', { type: TransactionType.CHARGE })
      .andWhere('payment.status = :status', { status: PaymentStatus.SUCCEEDED })
      .groupBy('payment.billingCycle')
      .getRawMany();

    // Get refunds by billing cycle
    const refundResult = await baseQuery
      .clone()
      .select('payment.billingCycle', 'billingCycle')
      .addSelect('COALESCE(SUM(payment.amount), 0)', 'refunds')
      .where('payment.transactionType = :type', { type: TransactionType.REFUND })
      .groupBy('payment.billingCycle')
      .getRawMany();

    // Map results
    const revenueMap = new Map(revenueResult.map((r) => [r.billingCycle || 'unknown', r]));
    const refundMap = new Map(refundResult.map((r) => [r.billingCycle || 'unknown', r]));

    const monthly = {
      revenue: parseFloat(revenueMap.get('monthly')?.revenue || '0'),
      count: parseInt(revenueMap.get('monthly')?.count || '0'),
      refunds: parseFloat(refundMap.get('monthly')?.refunds || '0'),
    };

    const yearly = {
      revenue: parseFloat(revenueMap.get('yearly')?.revenue || '0'),
      count: parseInt(revenueMap.get('yearly')?.count || '0'),
      refunds: parseFloat(refundMap.get('yearly')?.refunds || '0'),
    };

    const unknown = {
      revenue: parseFloat(revenueMap.get('unknown')?.revenue || '0'),
      count: parseInt(revenueMap.get('unknown')?.count || '0'),
      refunds: parseFloat(refundMap.get('unknown')?.refunds || '0'),
    };

    return {
      monthly,
      yearly,
      unknown,
      total: {
        revenue: monthly.revenue + yearly.revenue + unknown.revenue,
        count: monthly.count + yearly.count + unknown.count,
        refunds: monthly.refunds + yearly.refunds + unknown.refunds,
      },
    };
  }

  /**
   * Get revenue for a specific date range
   */
  async getRevenueByDateRange(
    startDate: Date,
    endDate: Date,
    options?: { tenantId?: string; billingCycle?: string },
  ): Promise<{
    revenue: number;
    refunds: number;
    netRevenue: number;
    transactionCount: number;
    averageTransactionAmount: number;
    dailyBreakdown: { date: string; revenue: number; refunds: number; count: number }[];
  }> {
    const baseQuery = this.paymentRepository
      .createQueryBuilder('payment')
      .where('payment.createdAt >= :startDate', { startDate })
      .andWhere('payment.createdAt <= :endDate', { endDate });

    if (options?.tenantId) {
      baseQuery.andWhere('payment.tenantId = :tenantId', { tenantId: options.tenantId });
    }
    if (options?.billingCycle) {
      baseQuery.andWhere('payment.billingCycle = :billingCycle', { billingCycle: options.billingCycle });
    }

    // Get total revenue
    const revenueResult = await baseQuery
      .clone()
      .andWhere('payment.transactionType = :type', { type: TransactionType.CHARGE })
      .andWhere('payment.status = :status', { status: PaymentStatus.SUCCEEDED })
      .select('COALESCE(SUM(payment.amount), 0)', 'revenue')
      .addSelect('COUNT(*)', 'count')
      .getRawOne();

    // Get total refunds
    const refundResult = await baseQuery
      .clone()
      .andWhere('payment.transactionType = :type', { type: TransactionType.REFUND })
      .select('COALESCE(SUM(payment.amount), 0)', 'refunds')
      .getRawOne();

    // Get daily breakdown
    const dailyQuery = await baseQuery
      .clone()
      .select("TO_CHAR(payment.createdAt, 'YYYY-MM-DD')", 'date')
      .addSelect('payment.transactionType', 'type')
      .addSelect('COALESCE(SUM(payment.amount), 0)', 'amount')
      .addSelect('COUNT(*)', 'count')
      .andWhere('(payment.transactionType = :charge OR payment.transactionType = :refund)', {
        charge: TransactionType.CHARGE,
        refund: TransactionType.REFUND,
      })
      .groupBy("TO_CHAR(payment.createdAt, 'YYYY-MM-DD')")
      .addGroupBy('payment.transactionType')
      .orderBy("TO_CHAR(payment.createdAt, 'YYYY-MM-DD')", 'ASC')
      .getRawMany();

    // Aggregate daily breakdown
    const dailyMap = new Map<string, { revenue: number; refunds: number; count: number }>();
    dailyQuery.forEach((row) => {
      if (!dailyMap.has(row.date)) {
        dailyMap.set(row.date, { revenue: 0, refunds: 0, count: 0 });
      }
      const day = dailyMap.get(row.date)!;
      if (row.type === TransactionType.CHARGE) {
        day.revenue += parseFloat(row.amount);
        day.count += parseInt(row.count);
      } else if (row.type === TransactionType.REFUND) {
        day.refunds += parseFloat(row.amount);
      }
    });

    const dailyBreakdown = Array.from(dailyMap.entries()).map(([date, data]) => ({
      date,
      ...data,
    }));

    const revenue = parseFloat(revenueResult?.revenue || '0');
    const refunds = parseFloat(refundResult?.refunds || '0');
    const count = parseInt(revenueResult?.count || '0');

    return {
      revenue,
      refunds,
      netRevenue: revenue - refunds,
      transactionCount: count,
      averageTransactionAmount: count > 0 ? revenue / count : 0,
      dailyBreakdown,
    };
  }

  /**
   * Get revenue by plan with lifetime stats
   */
  async getRevenueByPlan(options?: {
    startDate?: Date;
    endDate?: Date;
  }): Promise<
    {
      planId: string;
      planName: string;
      monthlyRevenue: number;
      yearlyRevenue: number;
      totalRevenue: number;
      monthlySubscriberCount: number;
      yearlySubscriberCount: number;
      refunds: number;
      netRevenue: number;
    }[]
  > {
    const plans = await this.planRepository.find({ where: { isActive: true } });

    const results = await Promise.all(
      plans.map(async (plan) => {
        const baseQuery = this.paymentRepository
          .createQueryBuilder('payment')
          .where('payment.subscriptionPlanId = :planId', { planId: plan.id });

        if (options?.startDate) {
          baseQuery.andWhere('payment.createdAt >= :startDate', { startDate: options.startDate });
        }
        if (options?.endDate) {
          baseQuery.andWhere('payment.createdAt <= :endDate', { endDate: options.endDate });
        }

        // Monthly revenue
        const monthlyResult = await baseQuery
          .clone()
          .andWhere('payment.billingCycle = :cycle', { cycle: 'monthly' })
          .andWhere('payment.transactionType = :type', { type: TransactionType.CHARGE })
          .andWhere('payment.status = :status', { status: PaymentStatus.SUCCEEDED })
          .select('COALESCE(SUM(payment.amount), 0)', 'revenue')
          .addSelect('COUNT(DISTINCT payment.tenantId)', 'subscribers')
          .getRawOne();

        // Yearly revenue
        const yearlyResult = await baseQuery
          .clone()
          .andWhere('payment.billingCycle = :cycle', { cycle: 'yearly' })
          .andWhere('payment.transactionType = :type', { type: TransactionType.CHARGE })
          .andWhere('payment.status = :status', { status: PaymentStatus.SUCCEEDED })
          .select('COALESCE(SUM(payment.amount), 0)', 'revenue')
          .addSelect('COUNT(DISTINCT payment.tenantId)', 'subscribers')
          .getRawOne();

        // Refunds
        const refundResult = await baseQuery
          .clone()
          .andWhere('payment.transactionType = :type', { type: TransactionType.REFUND })
          .select('COALESCE(SUM(payment.amount), 0)', 'refunds')
          .getRawOne();

        const monthlyRevenue = parseFloat(monthlyResult?.revenue || '0');
        const yearlyRevenue = parseFloat(yearlyResult?.revenue || '0');
        const refunds = parseFloat(refundResult?.refunds || '0');

        return {
          planId: plan.id,
          planName: plan.name,
          monthlyRevenue,
          yearlyRevenue,
          totalRevenue: monthlyRevenue + yearlyRevenue,
          monthlySubscriberCount: parseInt(monthlyResult?.subscribers || '0'),
          yearlySubscriberCount: parseInt(yearlyResult?.subscribers || '0'),
          refunds,
          netRevenue: monthlyRevenue + yearlyRevenue - refunds,
        };
      }),
    );

    return results.sort((a, b) => b.totalRevenue - a.totalRevenue);
  }

  /**
   * Advanced payment search with multiple filters
   */
  async searchPayments(filters: {
    page?: number;
    limit?: number;
    tenantId?: string;
    planId?: string;
    status?: PaymentStatus | PaymentStatus[];
    transactionType?: TransactionType | TransactionType[];
    billingCycle?: string;
    paymentType?: PaymentType;
    minAmount?: number;
    maxAmount?: number;
    startDate?: Date;
    endDate?: Date;
    searchTerm?: string; // Search in customer name/email
    sortBy?: 'createdAt' | 'amount' | 'status';
    sortOrder?: 'ASC' | 'DESC';
  }): Promise<{
    payments: Payment[];
    total: number;
    page: number;
    totalPages: number;
    summary: {
      totalAmount: number;
      refundedAmount: number;
      netAmount: number;
    };
  }> {
    const page = filters.page || 1;
    const limit = filters.limit || 20;
    const skip = (page - 1) * limit;

    const query = this.paymentRepository
      .createQueryBuilder('payment')
      .leftJoinAndSelect('payment.tenant', 'tenant')
      .leftJoinAndSelect('payment.subscriptionPlan', 'plan');

    // Apply filters
    if (filters.tenantId) {
      query.andWhere('payment.tenantId = :tenantId', { tenantId: filters.tenantId });
    }

    if (filters.planId) {
      query.andWhere('payment.subscriptionPlanId = :planId', { planId: filters.planId });
    }

    if (filters.status) {
      if (Array.isArray(filters.status)) {
        query.andWhere('payment.status IN (:...statuses)', { statuses: filters.status });
      } else {
        query.andWhere('payment.status = :status', { status: filters.status });
      }
    }

    if (filters.transactionType) {
      if (Array.isArray(filters.transactionType)) {
        query.andWhere('payment.transactionType IN (:...types)', { types: filters.transactionType });
      } else {
        query.andWhere('payment.transactionType = :type', { type: filters.transactionType });
      }
    }

    if (filters.billingCycle) {
      query.andWhere('payment.billingCycle = :billingCycle', { billingCycle: filters.billingCycle });
    }

    if (filters.paymentType) {
      query.andWhere('payment.paymentType = :paymentType', { paymentType: filters.paymentType });
    }

    if (filters.minAmount !== undefined) {
      query.andWhere('payment.amount >= :minAmount', { minAmount: filters.minAmount });
    }

    if (filters.maxAmount !== undefined) {
      query.andWhere('payment.amount <= :maxAmount', { maxAmount: filters.maxAmount });
    }

    if (filters.startDate) {
      query.andWhere('payment.createdAt >= :startDate', { startDate: filters.startDate });
    }

    if (filters.endDate) {
      query.andWhere('payment.createdAt <= :endDate', { endDate: filters.endDate });
    }

    if (filters.searchTerm) {
      query.andWhere(
        '(payment.customerName ILIKE :search OR payment.customerEmail ILIKE :search OR tenant.name ILIKE :search)',
        { search: `%${filters.searchTerm}%` },
      );
    }

    // Sorting
    const sortBy = filters.sortBy || 'createdAt';
    const sortOrder = filters.sortOrder || 'DESC';
    query.orderBy(`payment.${sortBy}`, sortOrder);

    // Get paginated results
    const [payments, total] = await query.skip(skip).take(limit).getManyAndCount();

    // Calculate summary for filtered results
    const summaryQuery = query.clone();
    const chargeSum = await summaryQuery
      .select('COALESCE(SUM(CASE WHEN payment.transactionType = :charge THEN payment.amount ELSE 0 END), 0)', 'charges')
      .addSelect('COALESCE(SUM(CASE WHEN payment.transactionType = :refund THEN payment.amount ELSE 0 END), 0)', 'refunds')
      .setParameter('charge', TransactionType.CHARGE)
      .setParameter('refund', TransactionType.REFUND)
      .getRawOne();

    const totalAmount = parseFloat(chargeSum?.charges || '0');
    const refundedAmount = parseFloat(chargeSum?.refunds || '0');

    return {
      payments,
      total,
      page,
      totalPages: Math.ceil(total / limit),
      summary: {
        totalAmount,
        refundedAmount,
        netAmount: totalAmount - refundedAmount,
      },
    };
  }

  /**
   * Get transaction status breakdown
   */
  async getTransactionStatusBreakdown(options?: {
    startDate?: Date;
    endDate?: Date;
    tenantId?: string;
  }): Promise<{
    succeeded: { count: number; amount: number };
    pending: { count: number; amount: number };
    failed: { count: number; amount: number };
    refunded: { count: number; amount: number };
    disputed: { count: number; amount: number };
    total: { count: number; amount: number };
  }> {
    const baseQuery = this.paymentRepository.createQueryBuilder('payment');

    if (options?.startDate) {
      baseQuery.andWhere('payment.createdAt >= :startDate', { startDate: options.startDate });
    }
    if (options?.endDate) {
      baseQuery.andWhere('payment.createdAt <= :endDate', { endDate: options.endDate });
    }
    if (options?.tenantId) {
      baseQuery.andWhere('payment.tenantId = :tenantId', { tenantId: options.tenantId });
    }

    const result = await baseQuery
      .select('payment.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .addSelect('COALESCE(SUM(payment.amount), 0)', 'amount')
      .groupBy('payment.status')
      .getRawMany();

    const statusMap = new Map(result.map((r) => [r.status, r]));

    const getStats = (status: PaymentStatus) => ({
      count: parseInt(statusMap.get(status)?.count || '0'),
      amount: parseFloat(statusMap.get(status)?.amount || '0'),
    });

    const succeeded = getStats(PaymentStatus.SUCCEEDED);
    const pending = getStats(PaymentStatus.PENDING);
    const failed = getStats(PaymentStatus.FAILED);
    const refunded = getStats(PaymentStatus.REFUNDED);
    const disputed = getStats(PaymentStatus.DISPUTED);

    return {
      succeeded,
      pending,
      failed,
      refunded,
      disputed,
      total: {
        count: succeeded.count + pending.count + failed.count + refunded.count + disputed.count,
        amount: succeeded.amount + pending.amount + failed.amount + refunded.amount + disputed.amount,
      },
    };
  }
}
