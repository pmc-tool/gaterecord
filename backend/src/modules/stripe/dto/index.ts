import {
  IsString,
  IsOptional,
  IsEnum,
  IsNumber,
  Min,
  IsBoolean,
  IsEmail,
  MinLength,
  Matches,
} from 'class-validator';
import { BillingCycle } from '@database/entities/tenant.entity';

export class CreateCheckoutSessionDto {
  @IsString()
  planId: string;

  @IsEnum(BillingCycle)
  billingCycle: BillingCycle;

  @IsOptional()
  @IsString()
  successUrl?: string;

  @IsOptional()
  @IsString()
  cancelUrl?: string;
}

// New: Create checkout session for signup (no account created yet)
export class SignupCheckoutDto {
  // Signup data
  @IsString()
  firstName: string;

  @IsString()
  lastName: string;

  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @Matches(/[A-Z]/, { message: 'Password must contain at least one uppercase letter' })
  @Matches(/[a-z]/, { message: 'Password must contain at least one lowercase letter' })
  @Matches(/[0-9]/, { message: 'Password must contain at least one number' })
  @Matches(/[@$!%*?&]/, { message: 'Password must contain at least one special character (@$!%*?&)' })
  password: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsString()
  buildingName: string;

  @IsOptional()
  @IsString()
  buildingAddress?: string;

  // Plan data
  @IsString()
  planId: string;

  @IsEnum(BillingCycle)
  billingCycle: BillingCycle;

  @IsOptional()
  @IsString()
  successUrl?: string;

  @IsOptional()
  @IsString()
  cancelUrl?: string;

  @IsOptional()
  @IsBoolean()
  skipTrial?: boolean; // If true, charge immediately without trial period
}

export class CreatePortalSessionDto {
  @IsOptional()
  @IsString()
  returnUrl?: string;
}

export class SyncPlanToStripeDto {
  @IsString()
  planId: string;
}

export class UpdateSubscriptionDto {
  @IsString()
  newPlanId: string;

  @IsEnum(BillingCycle)
  billingCycle: BillingCycle;

  @IsOptional()
  @IsBoolean()
  immediate?: boolean; // Prorate immediately or at period end
}

export class CancelSubscriptionDto {
  @IsOptional()
  @IsBoolean()
  immediately?: boolean; // Cancel now or at period end
}

export enum PauseBehavior {
  KEEP_AS_DRAFT = 'keep_as_draft', // Don't charge, keep invoice as draft
  MARK_UNCOLLECTIBLE = 'mark_uncollectible', // Mark as uncollectible
  VOID = 'void', // Void the invoice
}

export class PauseSubscriptionDto {
  @IsOptional()
  @IsString()
  resumesAt?: string; // ISO date string when to auto-resume (max 1 year)

  @IsOptional()
  @IsString()
  reason?: string; // Optional reason for pausing

  @IsOptional()
  @IsEnum(PauseBehavior)
  behavior?: PauseBehavior; // What to do with pending invoices
}

export class ResumeSubscriptionDto {
  @IsOptional()
  @IsBoolean()
  billingCycleAnchor?: boolean; // Reset billing cycle to now
}

export interface CheckoutSessionResponse {
  sessionId: string;
  url: string;
}

export interface PortalSessionResponse {
  url: string;
}

export interface StripeSubscriptionDetails {
  subscriptionId: string;
  status: string;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  planName: string;
  billingCycle: BillingCycle;
  monthlyAmount: number;
  nextBillingDate: Date;
  // Pause info
  isPaused?: boolean;
  pausedAt?: Date;
  pauseResumesAt?: Date;
  pauseReason?: string;
}

// ==================== Refund DTOs ====================

export enum RefundReason {
  DUPLICATE = 'duplicate',
  FRAUDULENT = 'fraudulent',
  REQUESTED_BY_CUSTOMER = 'requested_by_customer',
  SERVICE_NOT_RENDERED = 'service_not_rendered',
  DOWNGRADE = 'downgrade', // Prorated refund for downgrade
  CANCELLATION = 'cancellation', // Prorated refund for early cancellation
  BILLING_ERROR = 'billing_error',
  OTHER = 'other',
}

export class CreateRefundDto {
  @IsString()
  chargeId?: string; // Stripe charge ID (optional - will find latest if not provided)

  @IsOptional()
  @IsNumber()
  @Min(1)
  amount?: number; // Amount in cents (optional - full refund if not provided)

  @IsEnum(RefundReason)
  reason: RefundReason;

  @IsOptional()
  @IsString()
  internalNote?: string; // Internal note for admin reference

  @IsOptional()
  @IsBoolean()
  notifyCustomer?: boolean; // Send email notification (default: true)
}

export class CalculateRefundDto {
  @IsOptional()
  @IsString()
  chargeId?: string;

  @IsOptional()
  @IsBoolean()
  prorated?: boolean; // Calculate prorated amount based on remaining days
}

export interface RefundResult {
  refundId: string;
  chargeId: string;
  amount: number; // Amount in cents
  amountFormatted: string; // e.g., "$15.00"
  currency: string;
  status: 'succeeded' | 'pending' | 'failed' | 'canceled';
  reason: string;
  createdAt: Date;
}

export interface RefundCalculation {
  originalAmount: number;
  refundableAmount: number;
  daysUsed: number;
  daysRemaining: number;
  proratedAmount: number;
  currency: string;
  eligibleForRefund: boolean;
  message?: string;
}

export interface RefundHistory {
  refunds: RefundResult[];
  totalRefunded: number;
  totalRefundedFormatted: string;
  currency: string;
}
