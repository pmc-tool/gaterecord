import { Entity, Column, ManyToOne, OneToMany, JoinColumn } from 'typeorm';
import { BaseEntity } from './base.entity';
import { SubscriptionPlan } from './subscription-plan.entity';
import { User } from './user.entity';
import { Gate } from './gate.entity';
import { Vehicle } from './vehicle.entity';
import { RfidCard } from './rfid-card.entity';
import { VisitorPass } from './visitor-pass.entity';
import { AccessEvent } from './access-event.entity';
import { AccessPolicy } from './access-policy.entity';

export enum TenantStatus {
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
  TRIAL = 'trial',
  PENDING_PAYMENT = 'pending_payment', // Account created but waiting for Stripe payment
}

export enum BillingCycle {
  MONTHLY = 'monthly',
  YEARLY = 'yearly',
}

export enum SubscriptionStatus {
  TRIALING = 'trialing',
  ACTIVE = 'active',
  PAST_DUE = 'past_due',
  CANCELED = 'canceled',
  INCOMPLETE = 'incomplete',
  INCOMPLETE_EXPIRED = 'incomplete_expired',
  UNPAID = 'unpaid',
  PAUSED = 'paused',
}

@Entity('tenants')
export class Tenant extends BaseEntity {
  @Column({ unique: true })
  name: string;

  @Column({ unique: true })
  slug: string;

  @Column({ name: 'contact_email' })
  contactEmail: string;

  @Column({ name: 'contact_phone', nullable: true })
  contactPhone: string;

  @Column({ nullable: true })
  address: string;

  @Column({ type: 'enum', enum: TenantStatus, default: TenantStatus.TRIAL })
  status: TenantStatus;

  @Column({ name: 'subscription_plan_id' })
  subscriptionPlanId: string;

  @ManyToOne(() => SubscriptionPlan, (plan) => plan.tenants)
  @JoinColumn({ name: 'subscription_plan_id' })
  subscriptionPlan: SubscriptionPlan;

  @Column({ name: 'subscription_expires_at', nullable: true })
  subscriptionExpiresAt: Date;

  @Column({ name: 'subscription_started_at', nullable: true })
  subscriptionStartedAt: Date;

  @Column({
    type: 'enum',
    enum: BillingCycle,
    name: 'billing_cycle',
    default: BillingCycle.MONTHLY,
  })
  billingCycle: BillingCycle;

  @Column({ type: 'jsonb', nullable: true })
  settings: Record<string, unknown>;

  // Stripe Integration
  @Column({ name: 'stripe_customer_id', nullable: true })
  stripeCustomerId: string;

  @Column({ name: 'stripe_subscription_id', nullable: true })
  stripeSubscriptionId: string;

  @Column({
    type: 'enum',
    enum: SubscriptionStatus,
    name: 'subscription_status',
    default: SubscriptionStatus.TRIALING,
  })
  subscriptionStatus: SubscriptionStatus;

  @Column({ name: 'current_period_end', nullable: true })
  currentPeriodEnd: Date;

  @Column({ name: 'cancel_at_period_end', default: false })
  cancelAtPeriodEnd: boolean;

  /**
   * Latches TRUE the first time this tenant successfully pays for a plan and
   * NEVER resets. The free/default plan is a one-time starter grant: once a
   * building has been on a paid plan, the free plan is permanently "used" and can
   * no longer be selected. Set on every paid activation (handleInvoicePaid /
   * handleCheckoutCompleted); surfaced to the pricing page so the free tier shows
   * as "Free plan used". Durable on purpose — derived from a column, not from
   * payment history, which the retention policy may purge.
   */
  @Column({ name: 'has_used_paid_plan', default: false })
  hasUsedPaidPlan: boolean;

  // Subscription Pause
  @Column({ name: 'is_paused', default: false })
  isPaused: boolean;

  @Column({ name: 'paused_at', nullable: true })
  pausedAt: Date;

  @Column({ name: 'pause_resumes_at', nullable: true })
  pauseResumesAt: Date;

  @Column({ name: 'pause_reason', nullable: true })
  pauseReason: string;

  @OneToMany(() => User, (user) => user.tenant)
  users: User[];

  @OneToMany(() => Gate, (gate) => gate.tenant)
  gates: Gate[];

  @OneToMany(() => Vehicle, (vehicle) => vehicle.tenant)
  vehicles: Vehicle[];

  @OneToMany(() => RfidCard, (rfidCard) => rfidCard.tenant)
  rfidCards: RfidCard[];

  @OneToMany(() => VisitorPass, (pass) => pass.tenant)
  visitorPasses: VisitorPass[];

  @OneToMany(() => AccessEvent, (event) => event.tenant)
  accessEvents: AccessEvent[];

  @OneToMany(() => AccessPolicy, (policy) => policy.tenant)
  accessPolicies: AccessPolicy[];
}
