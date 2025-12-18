import { Entity, Column, OneToMany } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';

@Entity('subscription_plans')
export class SubscriptionPlan extends BaseEntity {
  @Column({ unique: true })
  name: string;

  @Column({ name: 'max_gates' })
  maxGates: number;

  @Column({ name: 'max_users' })
  maxUsers: number;

  @Column({ name: 'log_retention_days' })
  logRetentionDays: number;

  @Column({ type: 'jsonb', default: {} })
  features: {
    simulator_access?: boolean;
    csv_export?: boolean;
    api_access?: boolean;
    custom_branding?: boolean;
  };

  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  @OneToMany(() => Tenant, (tenant) => tenant.subscriptionPlan)
  tenants: Tenant[];
}
