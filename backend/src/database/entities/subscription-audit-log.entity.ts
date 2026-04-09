/**
 * Subscription Audit Log Entity
 *
 * Tracks all subscription-related changes for compliance and debugging.
 * This follows industry best practices used by companies like Stripe, Notion, etc.
 */

import {
  Entity,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Tenant } from './tenant.entity';

export enum AuditEventType {
  // Subscription lifecycle
  SUBSCRIPTION_CREATED = 'subscription_created',
  SUBSCRIPTION_ACTIVATED = 'subscription_activated',
  SUBSCRIPTION_UPDATED = 'subscription_updated',
  SUBSCRIPTION_CANCELED = 'subscription_canceled',
  SUBSCRIPTION_EXPIRED = 'subscription_expired',
  SUBSCRIPTION_RESUMED = 'subscription_resumed',

  // Payment events
  PAYMENT_SUCCEEDED = 'payment_succeeded',
  PAYMENT_FAILED = 'payment_failed',
  PAYMENT_REFUNDED = 'payment_refunded',
  PAYMENT_PARTIAL_REFUND = 'payment_partial_refund',

  // Credit events
  CREDIT_ISSUED = 'credit_issued',
  CREDIT_APPLIED = 'credit_applied',

  // Plan changes
  PLAN_UPGRADED = 'plan_upgraded',
  PLAN_DOWNGRADED = 'plan_downgraded',
  BILLING_CYCLE_CHANGED = 'billing_cycle_changed',

  // Trial events
  TRIAL_STARTED = 'trial_started',
  TRIAL_ENDING_SOON = 'trial_ending_soon',
  TRIAL_ENDED = 'trial_ended',
  TRIAL_CONVERTED = 'trial_converted',

  // Dunning events
  DUNNING_EMAIL_SENT = 'dunning_email_sent',
  ACCOUNT_SUSPENDED = 'account_suspended',
  ACCOUNT_REACTIVATED = 'account_reactivated',

  // Sync events
  STRIPE_SYNC_COMPLETED = 'stripe_sync_completed',
  STRIPE_SYNC_FAILED = 'stripe_sync_failed',
}

@Entity('subscription_audit_logs')
export class SubscriptionAuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', nullable: true })
  tenantId: string;

  @ManyToOne(() => Tenant, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'tenant_id' })
  tenant: Tenant;

  @Column({
    type: 'enum',
    enum: AuditEventType,
    name: 'event_type',
  })
  eventType: AuditEventType;

  @Column({ name: 'stripe_event_id', nullable: true })
  stripeEventId: string;

  @Column({ name: 'stripe_subscription_id', nullable: true })
  stripeSubscriptionId: string;

  @Column({ name: 'previous_status', nullable: true })
  previousStatus: string;

  @Column({ name: 'new_status', nullable: true })
  newStatus: string;

  @Column({ name: 'previous_plan_id', nullable: true })
  previousPlanId: string;

  @Column({ name: 'new_plan_id', nullable: true })
  newPlanId: string;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  amount: number;

  @Column({ nullable: true })
  currency: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown>;

  @Column({ name: 'error_message', nullable: true })
  errorMessage: string;

  @Column({ name: 'ip_address', nullable: true })
  ipAddress: string;

  @Column({ name: 'user_agent', nullable: true })
  userAgent: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
