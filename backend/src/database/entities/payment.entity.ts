/**
 * Payment Entity
 *
 * Stores all financial transactions for comprehensive reporting.
 * This includes successful payments, refunds, credits, and failed payments.
 * Enables MRR/ARR calculation, revenue analytics, and financial dashboard.
 */

import {
  Entity,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
  PrimaryGeneratedColumn,
  Index,
} from 'typeorm';
import { Tenant } from './tenant.entity';
import { SubscriptionPlan } from './subscription-plan.entity';

export enum PaymentType {
  SUBSCRIPTION = 'subscription', // Regular subscription payment
  ONE_TIME = 'one_time', // One-time charge
  SETUP_FEE = 'setup_fee', // Initial setup fee
  UPGRADE = 'upgrade', // Plan upgrade proration
  DOWNGRADE_CREDIT = 'downgrade_credit', // Credit from downgrade
}

export enum PaymentStatus {
  SUCCEEDED = 'succeeded',
  PENDING = 'pending',
  FAILED = 'failed',
  REFUNDED = 'refunded', // Fully refunded
  PARTIALLY_REFUNDED = 'partially_refunded',
  CANCELED = 'canceled',
  DISPUTED = 'disputed',
}

export enum TransactionType {
  CHARGE = 'charge', // Money coming in
  REFUND = 'refund', // Money going out
  CREDIT = 'credit', // Credit issued to customer
  CHARGEBACK = 'chargeback', // Dispute/chargeback
  ADJUSTMENT = 'adjustment', // Manual adjustment
}

@Entity('payments')
@Index(['tenantId', 'createdAt'])
@Index(['stripePaymentIntentId'], { unique: true, where: '"stripe_payment_intent_id" IS NOT NULL' })
@Index(['stripeChargeId'])
@Index(['createdAt'])
@Index(['status'])
export class Payment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // ==================== Relationships ====================

  @Column({ name: 'tenant_id' })
  tenantId: string;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id' })
  tenant: Tenant;

  @Column({ name: 'subscription_plan_id', nullable: true })
  subscriptionPlanId: string;

  @ManyToOne(() => SubscriptionPlan, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'subscription_plan_id' })
  subscriptionPlan: SubscriptionPlan;

  // ==================== Stripe References ====================

  @Column({ name: 'stripe_payment_intent_id', nullable: true })
  stripePaymentIntentId: string;

  @Column({ name: 'stripe_charge_id', nullable: true })
  stripeChargeId: string;

  @Column({ name: 'stripe_invoice_id', nullable: true })
  stripeInvoiceId: string;

  @Column({ name: 'stripe_refund_id', nullable: true })
  stripeRefundId: string;

  @Column({ name: 'stripe_subscription_id', nullable: true })
  stripeSubscriptionId: string;

  // ==================== Transaction Details ====================

  @Column({
    type: 'enum',
    enum: TransactionType,
    name: 'transaction_type',
  })
  transactionType: TransactionType;

  @Column({
    type: 'enum',
    enum: PaymentType,
    name: 'payment_type',
  })
  paymentType: PaymentType;

  @Column({
    type: 'enum',
    enum: PaymentStatus,
    default: PaymentStatus.PENDING,
  })
  status: PaymentStatus;

  // ==================== Amounts ====================

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount: number; // Gross amount

  @Column({ type: 'decimal', precision: 10, scale: 2, name: 'net_amount', nullable: true })
  netAmount: number; // After fees

  @Column({ type: 'decimal', precision: 10, scale: 2, name: 'fee_amount', nullable: true })
  feeAmount: number; // Stripe fees

  @Column({ type: 'decimal', precision: 10, scale: 2, name: 'tax_amount', nullable: true })
  taxAmount: number; // Tax collected

  @Column({ type: 'decimal', precision: 10, scale: 2, name: 'refunded_amount', default: 0 })
  refundedAmount: number; // Amount already refunded

  @Column({ length: 3, default: 'usd' })
  currency: string;

  // ==================== Billing Period ====================

  @Column({ name: 'billing_period_start', nullable: true })
  billingPeriodStart: Date;

  @Column({ name: 'billing_period_end', nullable: true })
  billingPeriodEnd: Date;

  @Column({ name: 'billing_cycle', nullable: true })
  billingCycle: string; // 'monthly' or 'yearly'

  // ==================== Payment Method ====================

  @Column({ name: 'payment_method_type', nullable: true })
  paymentMethodType: string; // 'card', 'bank_transfer', etc.

  @Column({ name: 'payment_method_last4', nullable: true })
  paymentMethodLast4: string; // Last 4 digits of card

  @Column({ name: 'payment_method_brand', nullable: true })
  paymentMethodBrand: string; // 'visa', 'mastercard', etc.

  // ==================== Metadata ====================

  @Column({ nullable: true })
  description: string;

  @Column({ name: 'failure_reason', nullable: true })
  failureReason: string;

  @Column({ name: 'refund_reason', nullable: true })
  refundReason: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown>;

  // ==================== Customer Info (snapshot) ====================

  @Column({ name: 'customer_email', nullable: true })
  customerEmail: string;

  @Column({ name: 'customer_name', nullable: true })
  customerName: string;

  // ==================== Timestamps ====================

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @Column({ name: 'paid_at', nullable: true })
  paidAt: Date;

  @Column({ name: 'refunded_at', nullable: true })
  refundedAt: Date;
}
