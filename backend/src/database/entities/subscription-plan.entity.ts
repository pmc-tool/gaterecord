import { Entity, Column, OneToMany } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';

@Entity('subscription_plans')
export class SubscriptionPlan extends BaseEntity {
  @Column({ unique: true })
  name: string;

  @Column({ nullable: true })
  description: string;

  @Column({ type: 'decimal', precision: 10, scale: 2, name: 'monthly_price', default: 0 })
  monthlyPrice: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, name: 'yearly_price', default: 0 })
  yearlyPrice: number;

  // Discount fields
  @Column({ type: 'decimal', precision: 5, scale: 2, name: 'discount_percent', default: 0 })
  discountPercent: number;

  @Column({ name: 'discount_label', nullable: true })
  discountLabel: string; // e.g., "Save 20%", "Best Value"

  @Column({ name: 'discount_valid_until', nullable: true })
  discountValidUntil: Date;

  // Trial settings
  @Column({ name: 'trial_days', default: 0 })
  trialDays: number;

  @Column({ name: 'trial_requires_card', default: false })
  trialRequiresCard: boolean;

  // Limits
  @Column({ name: 'max_gates' })
  maxGates: number;

  @Column({ name: 'max_users' })
  maxUsers: number;

  @Column({ name: 'max_vehicles', default: 100 })
  maxVehicles: number;

  @Column({ name: 'max_visitor_passes_per_month', default: 50 })
  maxVisitorPassesPerMonth: number;

  @Column({ name: 'log_retention_days' })
  logRetentionDays: number;

  // Features
  @Column({ type: 'jsonb', default: {} })
  features: {
    simulator_access?: boolean;
    csv_export?: boolean;
    api_access?: boolean;
    custom_branding?: boolean;
    priority_support?: boolean;
    advanced_analytics?: boolean;
    multi_building?: boolean;
    webhook_notifications?: boolean;
  };

  // Display settings
  @Column({ name: 'display_order', default: 0 })
  displayOrder: number;

  @Column({ nullable: true })
  badge: string; // e.g., "Popular", "Best Value", "Enterprise"

  @Column({ name: 'badge_color', nullable: true })
  badgeColor: string; // e.g., "gold", "blue", "green"

  @Column({ name: 'is_featured', default: false })
  isFeatured: boolean;

  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  @Column({ name: 'is_public', default: true })
  isPublic: boolean; // Show on pricing page

  // Stripe Integration
  @Column({ name: 'stripe_product_id', nullable: true })
  stripeProductId: string;

  @Column({ name: 'stripe_price_id_monthly', nullable: true })
  stripePriceIdMonthly: string;

  @Column({ name: 'stripe_price_id_yearly', nullable: true })
  stripePriceIdYearly: string;

  @OneToMany(() => Tenant, (tenant) => tenant.subscriptionPlan)
  tenants: Tenant[];
}
