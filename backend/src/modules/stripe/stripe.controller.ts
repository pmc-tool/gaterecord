/**
 * Stripe Controller
 * Handles Stripe webhooks and billing-related API endpoints
 */

import {
  Controller,
  Post,
  Get,
  Body,
  Req,
  Res,
  Headers,
  UseGuards,
  HttpCode,
  HttpStatus,
  RawBodyRequest,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

import { JwtAuthGuard } from '@common/guards/jwt-auth.guard';
import { RolesGuard } from '@common/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { Public } from '@common/decorators/public.decorator';
import { SubscriptionExempt } from '@common/decorators/subscription-exempt.decorator';
import { UserRole } from '@database/entities/user.entity';
import { StripeService } from './stripe.service';
import {
  CreateCheckoutSessionDto,
  CreatePortalSessionDto,
  SyncPlanToStripeDto,
  CancelSubscriptionDto,
  PauseSubscriptionDto,
  ResumeSubscriptionDto,
  CreateRefundDto,
  CalculateRefundDto,
  UpdateSubscriptionDto,
} from './dto';

@Controller('webhooks/stripe')
export class StripeController {
  private readonly logger = new Logger(StripeController.name);

  constructor(private stripeService: StripeService) {}

  // ==================== Webhook Endpoint ====================

  /**
   * Stripe Webhook Handler
   * POST /api/v1/webhooks/stripe
   *
   * IMPORTANT: This endpoint must receive raw body for signature verification
   */
  @Post()
  @Public()
  @HttpCode(HttpStatus.OK)
  async handleWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
    @Res() res: Response,
  ) {
    if (!signature) {
      this.logger.warn('No stripe-signature header');
      return res.status(400).json({ error: 'Missing signature' });
    }

    const rawBody = req.rawBody;
    if (!rawBody) {
      this.logger.warn('No raw body - ensure raw body parser is configured');
      return res.status(400).json({ error: 'Missing raw body' });
    }

    let event;
    try {
      event = this.stripeService.constructWebhookEvent(rawBody, signature);
    } catch (err: any) {
      this.logger.error(`Webhook signature verification failed: ${err.message}`);
      return res.status(400).json({ error: `Webhook Error: ${err.message}` });
    }

    this.logger.log(`Received webhook: ${event.type}`);

    // Idempotency (Phase 6): Stripe retries any delivery that did not get a 2xx
    // and can re-send events. If we have already handled this event.id, ack it
    // immediately without re-processing so retries are safe.
    if (await this.stripeService.isStripeEventProcessed(event.id)) {
      this.logger.log(`Duplicate webhook ${event.id} (${event.type}) already processed - skipping`);
      return res.json({ received: true, duplicate: true });
    }

    try {
      switch (event.type) {
        case 'checkout.session.completed':
          await this.stripeService.handleCheckoutCompleted(event.data.object as any);
          break;

        // In-app Elements checkout: the card was saved. handleSetupIntentSucceeded
        // creates the subscription (only for SetupIntents this app minted), after
        // which the subscription/invoice webhooks below activate the tenant.
        case 'setup_intent.succeeded':
          await this.stripeService.handleSetupIntentSucceeded(event.data.object as any);
          break;

        case 'customer.subscription.created':
          await this.stripeService.handleSubscriptionCreated(event.data.object as any);
          break;

        case 'customer.subscription.updated':
          await this.stripeService.handleSubscriptionUpdated(event.data.object as any);
          break;

        case 'customer.subscription.deleted':
          await this.stripeService.handleSubscriptionDeleted(event.data.object as any);
          break;

        case 'invoice.paid':
          await this.stripeService.handleInvoicePaid(event.data.object as any);
          break;

        case 'invoice.payment_failed':
          await this.stripeService.handleInvoicePaymentFailed(event.data.object as any);
          break;

        case 'customer.subscription.trial_will_end':
          await this.stripeService.handleTrialWillEnd(event.data.object as any);
          break;

        case 'customer.subscription.paused':
          await this.stripeService.handleSubscriptionPaused(event.data.object as any);
          break;

        case 'customer.subscription.resumed':
          await this.stripeService.handleSubscriptionResumed(event.data.object as any);
          break;

        // Refund webhooks
        case 'charge.refunded':
          await this.stripeService.handleChargeRefunded(event.data.object as any);
          break;

        case 'charge.refund.updated':
          await this.stripeService.handleRefundUpdated(event.data.object as any);
          break;

        default:
          this.logger.debug(`Unhandled event type: ${event.type}`);
      }

      // Record only after the handler succeeded, so a failed event is NOT marked
      // processed and can be retried/reconciled. (We still return 200 below to
      // preserve the existing no-retry-on-handled-error behaviour.)
      await this.stripeService.markStripeEventProcessed(event.id, event.type);
    } catch (err: any) {
      this.logger.error(`Error handling webhook ${event.type}: ${err.message}`);
      // Still return 200 to prevent Stripe retries for handled errors
    }

    return res.json({ received: true });
  }
}

/**
 * Billing Controller (for authenticated users)
 * Endpoints for managing subscriptions, checkout, etc.
 */
@Controller('billing')
@UseGuards(JwtAuthGuard, RolesGuard)
// The pay/recover path. A SUSPENDED / PENDING_PAYMENT / paused tenant must be
// able to reach checkout, portal and plan-change to restore access, so the whole
// controller is exempt from the SubscriptionGuard (JWT auth + roles still apply).
@SubscriptionExempt()
export class BillingController {
  constructor(private stripeService: StripeService) {}

  /**
   * Create checkout session for subscription
   * POST /api/v1/billing/checkout
   */
  @Post('checkout')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  async createCheckoutSession(@Req() req: any, @Body() dto: CreateCheckoutSessionDto) {
    const tenantId = req.user.tenantId;
    return this.stripeService.createCheckoutSession(tenantId, dto);
  }

  /**
   * Mint a SetupIntent for the in-app Stripe Elements checkout.
   * POST /api/v1/billing/subscription/intent
   *
   * The page confirms the returned client secret with stripe.confirmSetup(); the
   * subscription itself is created server-side by the setup_intent.succeeded
   * webhook, so nothing is charged or mutated until the card is confirmed. The
   * whole controller is @SubscriptionExempt, so a suspended / pending tenant can
   * still reach this to pay and recover.
   */
  @Post('subscription/intent')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  async createSubscriptionIntent(
    @Req() req: any,
    @Body() dto: CreateCheckoutSessionDto,
  ) {
    const tenantId = req.user.tenantId;
    return this.stripeService.createSubscriptionIntent(tenantId, dto);
  }

  /**
   * Activate a subscription synchronously after the frontend confirms the card.
   * POST /api/v1/billing/subscription/activate
   *
   * The in-app Elements form calls stripe.confirmCardSetup() client-side, then
   * immediately calls this endpoint with the SetupIntent ID. The backend verifies
   * the SetupIntent succeeded in Stripe, creates the subscription and persists it
   * to the DB — all before the frontend navigates to ?success=true, so the
   * subscription is visible as soon as the settings page loads.
   */
  @Post('subscription/activate')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  async activateSubscription(
    @Req() req: any,
    @Body() body: { setupIntentId: string },
  ) {
    const tenantId = req.user.tenantId;
    return this.stripeService.activateSubscriptionFromSetupIntent(tenantId, body.setupIntentId);
  }

  /**
   * Create billing portal session
   * POST /api/v1/billing/portal
   */
  @Post('portal')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  async createPortalSession(@Req() req: any, @Body() dto: CreatePortalSessionDto) {
    const tenantId = req.user.tenantId;
    return this.stripeService.createPortalSession(tenantId, dto.returnUrl);
  }

  /**
   * Get current subscription details
   * GET /api/v1/billing/subscription
   */
  @Get('subscription')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  async getSubscription(@Req() req: any) {
    const tenantId = req.user.tenantId;
    return this.stripeService.getSubscriptionDetails(tenantId);
  }

  /**
   * Cancel subscription
   * POST /api/v1/billing/cancel
   */
  @Post('cancel')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  async cancelSubscription(@Req() req: any, @Body() dto: CancelSubscriptionDto) {
    const tenantId = req.user.tenantId;
    await this.stripeService.cancelSubscription(tenantId, dto.immediately);
    return { success: true, message: 'Subscription cancellation scheduled' };
  }

  /**
   * Resume canceled subscription
   * POST /api/v1/billing/resume
   */
  @Post('resume')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  async resumeSubscription(@Req() req: any) {
    const tenantId = req.user.tenantId;
    await this.stripeService.resumeSubscription(tenantId);
    return { success: true, message: 'Subscription resumed' };
  }

  /**
   * Pause subscription (Spotify/Netflix style)
   * POST /api/v1/billing/pause
   *
   * Pauses billing while keeping account active with limited access.
   * Can set auto-resume date (max 1 year).
   */
  @Post('pause')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  async pauseSubscription(@Req() req: any, @Body() dto: PauseSubscriptionDto) {
    const tenantId = req.user.tenantId;

    // Parse resume date if provided
    const resumesAt = dto.resumesAt ? new Date(dto.resumesAt) : undefined;

    const result = await this.stripeService.pauseSubscription(tenantId, {
      resumesAt,
      reason: dto.reason,
      behavior: dto.behavior as any,
    });

    return {
      success: true,
      message: result.pausedUntil
        ? `Subscription paused until ${result.pausedUntil.toLocaleDateString()}`
        : 'Subscription paused indefinitely',
      pausedUntil: result.pausedUntil,
    };
  }

  /**
   * Unpause/Resume a paused subscription
   * POST /api/v1/billing/unpause
   *
   * Immediately resumes billing for a paused subscription.
   */
  @Post('unpause')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  async unpauseSubscription(@Req() req: any, @Body() dto: ResumeSubscriptionDto) {
    const tenantId = req.user.tenantId;

    const result = await this.stripeService.unpauseSubscription(tenantId, {
      billingCycleAnchor: dto.billingCycleAnchor,
    });

    return {
      success: true,
      message: 'Subscription resumed',
      nextBillingDate: result.nextBillingDate,
    };
  }

  /**
   * Get pause status
   * GET /api/v1/billing/pause-status
   */
  @Get('pause-status')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  async getPauseStatus(@Req() req: any) {
    const tenantId = req.user.tenantId;
    return this.stripeService.getPauseStatus(tenantId);
  }

  // ==================== Refund Endpoints ====================

  /**
   * Calculate prorated refund amount
   * GET /api/v1/billing/refund/calculate
   *
   * Shows how much the customer would get back if they cancel now.
   */
  @Get('refund/calculate')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  async calculateRefund(@Req() req: any) {
    const tenantId = req.user.tenantId;
    return this.stripeService.calculateProratedRefund(tenantId);
  }

  /**
   * Get refund history
   * GET /api/v1/billing/refunds
   *
   * Returns all refunds issued to this tenant.
   */
  @Get('refunds')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  async getRefundHistory(@Req() req: any) {
    const tenantId = req.user.tenantId;
    return this.stripeService.getRefundHistory(tenantId);
  }

  /**
   * Request a prorated refund
   * POST /api/v1/billing/refund/request
   *
   * Building admin can request a prorated refund when cancelling immediately.
   */
  @Post('refund/request')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  async requestRefund(@Req() req: any, @Body() body: { reason?: string }) {
    const tenantId = req.user.tenantId;
    
    // Create refund with prorated amount
    const result = await this.stripeService.createRefund(tenantId, {
      reason: 'requested_by_customer' as any,
      internalNote: body.reason || 'Customer requested refund via billing settings',
      notifyCustomer: true,
    });
    
    return {
      success: true,
      message: `Refund of ${result.amountFormatted} processed successfully`,
      refund: result,
    };
  }

  /**
   * Get payment/transaction history
   * GET /api/v1/billing/payments
   *
   * Returns all payments for this tenant.
   */
  @Get('payments')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  async getPaymentHistory(@Req() req: any) {
    const tenantId = req.user.tenantId;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    return this.stripeService.getTenantPaymentHistory(tenantId, { page, limit });
  }

  /**
   * Get invoice history (Stripe invoices with hosted page + PDF)
   * GET /api/v1/billing/invoices?limit=24
   *
   * The whole BillingController is @SubscriptionExempt, so a SUSPENDED tenant can
   * still view their invoices (and pay). Returns { invoices, hasMore }.
   */
  @Get('invoices')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  async getInvoices(@Req() req: any) {
    const tenantId = req.user.tenantId;
    const limit = parseInt(req.query.limit) || 24;
    return this.stripeService.getTenantInvoices(tenantId, { limit });
  }

  // ==================== Plan Change Endpoints ====================

  /**
   * Get available plans for upgrade/downgrade
   * GET /api/v1/billing/plans
   *
   * Returns all plans the tenant can switch to.
   */
  @Get('plans')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  async getAvailablePlans(@Req() req: any) {
    const tenantId = req.user.tenantId;
    return this.stripeService.getAvailablePlans(tenantId);
  }

  /**
   * Preview plan change (calculate proration)
   * POST /api/v1/billing/plans/preview
   *
   * Shows what the customer would pay/receive as credit.
   */
  @Post('plans/preview')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  async previewPlanChange(@Req() req: any, @Body() dto: UpdateSubscriptionDto) {
    const tenantId = req.user.tenantId;
    return this.stripeService.previewPlanChange(tenantId, dto.newPlanId, dto.billingCycle);
  }

  /**
   * Change subscription plan (upgrade/downgrade)
   * POST /api/v1/billing/plans/change
   *
   * Changes the subscription to a new plan with proration.
   */
  @Post('plans/change')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  async changePlan(@Req() req: any, @Body() dto: UpdateSubscriptionDto) {
    const tenantId = req.user.tenantId;
    return this.stripeService.changePlan(tenantId, dto.newPlanId, dto.billingCycle, {
      immediate: dto.immediate ?? true,
    });
  }
}

/**
 * Admin Stripe Controller (for Super Admin)
 * Endpoints for syncing plans to Stripe
 */
@Controller('admin/stripe')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
// Super-admin-only billing administration. Already covered by the guard's
// SUPER_ADMIN allow-rule; marked exempt too so the pay/admin surface is explicit
// and stays open regardless of any tenant the super admin may be attached to.
@SubscriptionExempt()
export class AdminStripeController {
  constructor(private stripeService: StripeService) {}

  /**
   * Sync a plan to Stripe
   * POST /api/v1/admin/stripe/sync-plan
   */
  @Post('sync-plan')
  async syncPlanToStripe(@Body() dto: SyncPlanToStripeDto) {
    const plan = await this.stripeService.syncPlanToStripe(dto.planId);
    return {
      success: true,
      plan: {
        id: plan.id,
        name: plan.name,
        stripeProductId: plan.stripeProductId,
        stripePriceIdMonthly: plan.stripePriceIdMonthly,
        stripePriceIdYearly: plan.stripePriceIdYearly,
      },
    };
  }

  /**
   * Sync all plans to Stripe
   * POST /api/v1/admin/stripe/sync-all
   */
  @Post('sync-all')
  async syncAllPlans() {
    await this.stripeService.syncAllPlansToStripe();
    return { success: true, message: 'All plans synced to Stripe' };
  }

  // ==================== Admin Refund Management ====================

  /**
   * Create a refund for a tenant
   * POST /api/v1/admin/stripe/refund/:tenantId
   *
   * Super admin can issue refunds with full control.
   */
  @Post('refund/:tenantId')
  async createRefund(@Req() req: any, @Body() dto: CreateRefundDto) {
    const tenantId = req.params.tenantId;
    const result = await this.stripeService.createRefund(tenantId, dto);
    return {
      success: true,
      message: `Refund of ${result.amountFormatted} processed successfully`,
      refund: result,
    };
  }

  /**
   * Calculate prorated refund for a tenant
   * GET /api/v1/admin/stripe/refund/:tenantId/calculate
   */
  @Get('refund/:tenantId/calculate')
  async calculateRefundAdmin(@Req() req: any) {
    const tenantId = req.params.tenantId;
    return this.stripeService.calculateProratedRefund(tenantId);
  }

  /**
   * Get refund history for a tenant
   * GET /api/v1/admin/stripe/refunds/:tenantId
   */
  @Get('refunds/:tenantId')
  async getRefundHistoryAdmin(@Req() req: any) {
    const tenantId = req.params.tenantId;
    return this.stripeService.getRefundHistory(tenantId);
  }

  /**
   * Issue a credit to tenant's Stripe balance
   * POST /api/v1/admin/stripe/credit/:tenantId
   *
   * Creates a credit that will be applied to the next invoice.
   */
  @Post('credit/:tenantId')
  async issueCredit(@Req() req: any, @Body() body: { amount: number; description: string }) {
    const tenantId = req.params.tenantId;
    const result = await this.stripeService.issueCredit(tenantId, body.amount, body.description);
    return {
      success: true,
      message: `Credit of $${(body.amount / 100).toFixed(2)} issued successfully`,
      credit: result,
    };
  }

  // ==================== Financial Overview ====================

  /**
   * Get financial overview (MRR, ARR, Revenue Growth, etc.)
   * GET /api/v1/admin/stripe/financial-overview
   */
  @Get('financial-overview')
  async getFinancialOverview() {
    const overview = await this.stripeService.getFinancialOverview();
    return {
      success: true,
      data: overview,
    };
  }

  /**
   * Get platform revenue snapshot (Phase 6)
   * GET /api/v1/admin/stripe/revenue?recentLimit=10
   *
   * MRR/ARR + revenue rollups, tenant counts by status
   * (active/trial/suspended/pendingPayment/pastDue), and recent payments.
   * Super-admin only (controller is @Roles(SUPER_ADMIN) + @SubscriptionExempt).
   */
  @Get('revenue')
  async getRevenue(@Req() req: any) {
    const recentLimit = parseInt(req.query.recentLimit) || 10;
    const data = await this.stripeService.getRevenueSnapshot({ recentLimit });
    return {
      success: true,
      data,
    };
  }

  /**
   * Get revenue breakdown by month
   * GET /api/v1/admin/stripe/revenue-by-month
   */
  @Get('revenue-by-month')
  async getRevenueByMonth(@Req() req: any) {
    const months = parseInt(req.query.months) || 12;
    const data = await this.stripeService.getRevenueByMonth(months);
    return {
      success: true,
      data,
    };
  }

  /**
   * Get all payments with pagination
   * GET /api/v1/admin/stripe/payments
   */
  @Get('payments')
  async getAllPayments(@Req() req: any) {
    const { page, limit, tenantId, planId, status, type, billingCycle, startDate, endDate, search } = req.query;

    const result = await this.stripeService.getAllPayments({
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 20,
      tenantId,
      planId,
      status,
      transactionType: type,
      billingCycle,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      searchTerm: search,
    });

    return {
      success: true,
      ...result,
    };
  }

  /**
   * Get payment summary stats
   * GET /api/v1/admin/stripe/payment-summary
   */
  @Get('payment-summary')
  async getPaymentSummary(@Req() req: any) {
    const tenantId = req.query.tenantId;
    const summary = await this.stripeService.getPaymentSummary(tenantId);
    return {
      success: true,
      data: summary,
    };
  }

  /**
   * Get tenant's payment history
   * GET /api/v1/admin/stripe/payments/:tenantId
   */
  @Get('payments/:tenantId')
  async getTenantPayments(@Req() req: any) {
    const tenantId = req.params.tenantId;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;

    const result = await this.stripeService.getTenantPaymentHistory(tenantId, { page, limit });
    return {
      success: true,
      ...result,
    };
  }

  // ==================== Advanced Payment Analytics ====================

  /**
   * Get revenue breakdown by billing cycle (monthly vs yearly)
   * GET /api/v1/admin/stripe/revenue-by-billing-cycle
   *
   * Query params: startDate, endDate, tenantId
   */
  @Get('revenue-by-billing-cycle')
  async getRevenueByBillingCycle(@Req() req: any) {
    const { startDate, endDate, tenantId } = req.query;

    const data = await this.stripeService.getRevenueByBillingCycle({
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      tenantId,
    });

    return {
      success: true,
      data,
    };
  }

  /**
   * Get revenue for a specific date range with daily breakdown
   * GET /api/v1/admin/stripe/revenue-by-date-range
   *
   * Query params: startDate (required), endDate (required), tenantId, billingCycle
   */
  @Get('revenue-by-date-range')
  async getRevenueByDateRange(@Req() req: any) {
    const { startDate, endDate, tenantId, billingCycle } = req.query;

    if (!startDate || !endDate) {
      return {
        success: false,
        error: 'startDate and endDate are required',
      };
    }

    const data = await this.stripeService.getRevenueByDateRange(
      new Date(startDate),
      new Date(endDate),
      { tenantId, billingCycle },
    );

    return {
      success: true,
      data,
    };
  }

  /**
   * Get revenue breakdown by plan
   * GET /api/v1/admin/stripe/revenue-by-plan
   *
   * Query params: startDate, endDate
   */
  @Get('revenue-by-plan')
  async getRevenueByPlan(@Req() req: any) {
    const { startDate, endDate } = req.query;

    const data = await this.stripeService.getRevenueByPlan({
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
    });

    return {
      success: true,
      data,
    };
  }

  /**
   * Advanced payment search with multiple filters
   * GET /api/v1/admin/stripe/payments/search
   *
   * Query params: page, limit, tenantId, planId, status, type, billingCycle,
   *               paymentType, minAmount, maxAmount, startDate, endDate,
   *               searchTerm, sortBy, sortOrder
   */
  @Get('payments/search')
  async searchPayments(@Req() req: any) {
    const {
      page,
      limit,
      tenantId,
      planId,
      status,
      type,
      billingCycle,
      paymentType,
      minAmount,
      maxAmount,
      startDate,
      endDate,
      searchTerm,
      sortBy,
      sortOrder,
    } = req.query;

    const result = await this.stripeService.searchPayments({
      page: page ? parseInt(page) : undefined,
      limit: limit ? parseInt(limit) : undefined,
      tenantId,
      planId,
      status: status ? (status.includes(',') ? status.split(',') : status) : undefined,
      transactionType: type ? (type.includes(',') ? type.split(',') : type) : undefined,
      billingCycle,
      paymentType,
      minAmount: minAmount ? parseFloat(minAmount) : undefined,
      maxAmount: maxAmount ? parseFloat(maxAmount) : undefined,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      searchTerm,
      sortBy,
      sortOrder,
    });

    return {
      success: true,
      ...result,
    };
  }

  /**
   * Get transaction status breakdown
   * GET /api/v1/admin/stripe/transaction-status-breakdown
   *
   * Query params: startDate, endDate, tenantId
   */
  @Get('transaction-status-breakdown')
  async getTransactionStatusBreakdown(@Req() req: any) {
    const { startDate, endDate, tenantId } = req.query;

    const data = await this.stripeService.getTransactionStatusBreakdown({
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      tenantId,
    });

    return {
      success: true,
      data,
    };
  }
}
