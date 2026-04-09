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

import { SubscriptionPlan } from '@database/entities/subscription-plan.entity';
import {
  Tenant,
  TenantStatus,
  BillingCycle,
  SubscriptionStatus,
} from '@database/entities/tenant.entity';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
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

@Injectable()
export class StripeService implements OnModuleInit {
  private readonly logger = new Logger(StripeService.name);
  private stripe!: Stripe;

  constructor(
    private configService: ConfigService,
    private eventEmitter: EventEmitter2,
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

  // ==================== Product & Price Management ====================

  /**
   * Sync a plan to Stripe - creates/updates Product and Prices
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

    // Create Monthly Price (or update by creating new if changed)
    const monthlyPriceCents = Math.round(Number(plan.monthlyPrice) * 100);
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
        metadata: { planId: plan.id, billingCycle: 'monthly' },
      });
      plan.stripePriceIdMonthly = monthlyPrice.id;
    }

    // Create Yearly Price
    const yearlyPriceCents = Math.round(Number(plan.yearlyPrice) * 100);
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
        metadata: { planId: plan.id, billingCycle: 'yearly' },
      });
      plan.stripePriceIdYearly = yearlyPrice.id;
    }

    await this.planRepository.save(plan);
    this.logger.log(`Synced plan ${plan.name} to Stripe: ${product.id}`);
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
    const frontendUrl = this.configService.get<string>('FRONTEND_URL') || 'http://localhost:5173';

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
        trial_period_days: plan.trialDays > 0 ? plan.trialDays : undefined,
        metadata: {
          tenantId: tenant.id,
          planId: plan.id,
          billingCycle: dto.billingCycle,
        },
      },
      success_url: dto.successUrl || `${frontendUrl}/settings/billing?success=true`,
      cancel_url: dto.cancelUrl || `${frontendUrl}/settings/billing?canceled=true`,
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

    const frontendUrl = this.configService.get<string>('FRONTEND_URL') || 'http://localhost:5173';

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
        dto.successUrl || `${frontendUrl}/signup/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: dto.cancelUrl || `${frontendUrl}/signup?step=3`,
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

    const frontendUrl = this.configService.get<string>('FRONTEND_URL') || 'http://localhost:5173';

    const session = await this.stripe.billingPortal.sessions.create({
      customer: tenant.stripeCustomerId,
      return_url: returnUrl || `${frontendUrl}/settings/billing`,
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

    if (!tenant?.stripeSubscriptionId) {
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

    // Get all active public plans
    const allPlans = await this.planRepository.find({
      where: { isActive: true, isPublic: true },
      order: { monthlyPrice: 'ASC' },
    });

    const currentPlan = tenant.subscriptionPlan;
    const currentMonthly = Number(currentPlan?.monthlyPrice) || 0;

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
      availablePlans: allPlans
        .filter((p) => p.id !== currentPlan?.id)
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
              yearly: Number(plan.yearlyPrice) - Number(currentPlan?.yearlyPrice || 0),
            },
          };
        }),
    };
  }

  /**
   * Preview plan change (calculate prorated amounts)
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

    // Create invoice preview using upcoming invoice with subscription changes
    const preview = await this.stripe.invoices.retrieveUpcoming({
      customer: tenant.stripeCustomerId!,
      subscription: tenant.stripeSubscriptionId,
      subscription_items: [
        {
          id: subscription.items.data[0].id,
          price: newPriceId,
        },
      ],
      subscription_proration_behavior: 'create_prorations',
    });

    const currentPrice =
      tenant.billingCycle === BillingCycle.MONTHLY
        ? tenant.subscriptionPlan?.monthlyPrice || 0
        : tenant.subscriptionPlan?.yearlyPrice || 0;

    const newPrice =
      billingCycle === BillingCycle.MONTHLY ? newPlan.monthlyPrice : newPlan.yearlyPrice;

    return {
      currentPlan: {
        name: tenant.subscriptionPlan?.name || 'Unknown',
        price: currentPrice,
      },
      newPlan: {
        name: newPlan.name,
        price: newPrice,
      },
      prorationAmount: (preview.total - (preview.subtotal || 0)) / 100,
      amountDue: preview.total / 100,
      creditAmount: preview.total < 0 ? Math.abs(preview.total) / 100 : 0,
      effectiveDate: new Date(),
      isUpgrade: newPrice > currentPrice,
    };
  }

  /**
   * Change subscription plan (upgrade or downgrade)
   * - Handles proration automatically
   * - Updates Stripe subscription
   * - Updates local database
   */
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

    if (newPlanId === tenant.subscriptionPlanId) {
      throw new BadRequestException('Already subscribed to this plan');
    }

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
    const previousPlanId = tenant.subscriptionPlanId;
    const previousPlanName = tenant.subscriptionPlan?.name;
    const previousPrice =
      tenant.billingCycle === BillingCycle.MONTHLY
        ? tenant.subscriptionPlan?.monthlyPrice || 0
        : tenant.subscriptionPlan?.yearlyPrice || 0;
    const newPrice =
      billingCycle === BillingCycle.MONTHLY ? newPlan.monthlyPrice : newPlan.yearlyPrice;
    const isUpgrade = newPrice > previousPrice;

    // Update subscription in Stripe
    const updatedSubscription = await this.stripe.subscriptions.update(
      tenant.stripeSubscriptionId,
      {
        items: [
          {
            id: currentItemId,
            price: newPriceId,
          },
        ],
        proration_behavior: options.immediate ? 'create_prorations' : 'none',
        metadata: {
          ...subscription.metadata,
          planId: newPlanId,
          billingCycle,
          previousPlanId,
        },
      },
    );

    // Calculate amounts from the latest invoice
    let amountCharged = 0;
    let creditApplied = 0;

    if (options.immediate) {
      try {
        const upcomingInvoice = await this.stripe.invoices.retrieveUpcoming({
          customer: tenant.stripeCustomerId!,
        });
        amountCharged = Math.max(0, upcomingInvoice.total / 100);
        creditApplied = upcomingInvoice.total < 0 ? Math.abs(upcomingInvoice.total) / 100 : 0;
      } catch {
        // No upcoming invoice
      }
    }

    // Update local database
    const previousStatus = tenant.subscriptionStatus;
    tenant.subscriptionPlanId = newPlanId;
    tenant.billingCycle = billingCycle;
    tenant.currentPeriodEnd = new Date(updatedSubscription.current_period_end * 1000);
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
        immediate: options.immediate,
        amountCharged,
        creditApplied,
      },
    });

    this.logger.log(
      `Plan ${isUpgrade ? 'upgraded' : 'downgraded'} for tenant ${tenant.name}: ${previousPlanName} -> ${newPlan.name}`,
    );

    // Emit event for any post-upgrade actions
    this.eventEmitter.emit('subscription.planChanged', {
      tenant,
      previousPlanId,
      newPlanId,
      isUpgrade,
    });

    return {
      success: true,
      message: isUpgrade
        ? `Successfully upgraded to ${newPlan.name}`
        : `Successfully changed to ${newPlan.name}`,
      newPlan: {
        id: newPlan.id,
        name: newPlan.name,
      },
      amountCharged,
      creditApplied,
      effectiveDate: new Date(),
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
    tenant.stripeSubscriptionId = session.subscription as string;
    tenant.subscriptionStatus = SubscriptionStatus.ACTIVE;
    tenant.status = TenantStatus.ACTIVE;
    tenant.subscriptionStartedAt = new Date();
    tenant.cancelAtPeriodEnd = false;

    await this.tenantRepository.save(tenant);
    this.logger.log(`Checkout completed for tenant ${tenant.name} - Plan: ${plan.name}`);

    // Audit log
    await this.logAuditEvent({
      tenantId: tenant.id,
      eventType: AuditEventType.SUBSCRIPTION_ACTIVATED,
      stripeSubscriptionId: session.subscription as string,
      previousStatus,
      newStatus: SubscriptionStatus.ACTIVE,
      previousPlanId,
      newPlanId: plan.id,
      metadata: { billingCycle, sessionId: session.id },
    });

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
      stripeSubscriptionId: session.subscription as string,
      subscriptionStatus: SubscriptionStatus.ACTIVE,
      subscriptionStartedAt: new Date(),
      cancelAtPeriodEnd: false,
      settings: {
        signupDate: new Date().toISOString(),
        paidOnSignup: true,
      },
    });

    const savedTenant = await this.tenantRepository.save(tenant);

    // Create user
    const user = this.userRepository.create({
      email: email.toLowerCase(),
      passwordHash,
      firstName,
      lastName,
      phone,
      role: UserRole.BUILDING_ADMIN,
      status: UserStatus.ACTIVE,
      tenantId: savedTenant.id,
    });

    await this.userRepository.save(user);

    this.logger.log(
      `Signup completed via Stripe: ${email} - Tenant: ${buildingName} - Plan: ${plan.name}`,
    );

    // Audit log
    await this.logAuditEvent({
      tenantId: savedTenant.id,
      eventType: AuditEventType.SUBSCRIPTION_CREATED,
      stripeSubscriptionId: session.subscription as string,
      newStatus: SubscriptionStatus.ACTIVE,
      newPlanId: plan.id,
      metadata: {
        email,
        buildingName,
        billingCycle,
        paidOnSignup: true,
      },
    });

    this.eventEmitter.emit('signup.completed', { tenant: savedTenant, user, plan });
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
   * Handle invoice.paid
   */
  async handleInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
    const subscriptionId = invoice.subscription as string;
    if (!subscriptionId) return;

    const tenant = await this.tenantRepository.findOne({
      where: { stripeSubscriptionId: subscriptionId },
      relations: ['subscriptionPlan'],
    });

    if (!tenant) return;

    tenant.subscriptionStatus = SubscriptionStatus.ACTIVE;
    tenant.status = TenantStatus.ACTIVE;

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

    // Record the payment in payments table
    const charge = invoice.charge as string;
    let paymentMethodInfo: { type?: string; last4?: string; brand?: string } = {};

    // Get payment method details from the charge
    if (charge && this.stripe) {
      try {
        const chargeObj = await this.stripe.charges.retrieve(charge);
        if (chargeObj.payment_method_details?.card) {
          paymentMethodInfo = {
            type: 'card',
            last4: chargeObj.payment_method_details.card.last4 || undefined,
            brand: chargeObj.payment_method_details.card.brand || undefined,
          };
        }
      } catch (e) {
        // Ignore errors fetching charge details
      }
    }

    await this.recordPayment({
      tenantId: tenant.id,
      amount: invoice.amount_paid || 0,
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
    const subscriptionId = invoice.subscription as string;
    if (!subscriptionId) return;

    const tenant = await this.tenantRepository.findOne({
      where: { stripeSubscriptionId: subscriptionId },
      relations: ['users'],
    });

    if (!tenant) return;

    const previousStatus = tenant.subscriptionStatus;
    tenant.subscriptionStatus = SubscriptionStatus.PAST_DUE;
    await this.tenantRepository.save(tenant);

    this.logger.warn(`Invoice payment failed for tenant ${tenant.name}`);

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
      },
    });

    this.eventEmitter.emit('invoice.payment_failed', { tenant, invoice });
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

          if (!retryUser || !retryUser.tenant) {
            return {
              success: false,
              message: 'Account not yet created. Please wait a moment and try again.',
            };
          }

          return { success: true, tenantId: retryUser.tenant.id };
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
      tenant.subscriptionPlanId = plan.id;
      tenant.billingCycle = billingCycle || BillingCycle.MONTHLY;
      tenant.stripeSubscriptionId = session.subscription as string;
      tenant.subscriptionStatus = SubscriptionStatus.ACTIVE;
      tenant.status = TenantStatus.ACTIVE;
      tenant.subscriptionStartedAt = new Date();
      tenant.cancelAtPeriodEnd = false;

      // Set subscription period from the subscription
      if (session.subscription && typeof session.subscription !== 'string') {
        const subscription = session.subscription as Stripe.Subscription;
        tenant.currentPeriodEnd = new Date(subscription.current_period_end * 1000);
        tenant.subscriptionExpiresAt = tenant.currentPeriodEnd;
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
    status?: PaymentStatus;
    transactionType?: TransactionType;
    startDate?: Date;
    endDate?: Date;
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

    if (options.status) {
      query.andWhere('payment.status = :status', { status: options.status });
    }

    if (options.transactionType) {
      query.andWhere('payment.transactionType = :type', { type: options.transactionType });
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
}
