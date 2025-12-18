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

  @Column({ type: 'jsonb', nullable: true })
  settings: Record<string, unknown>;

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
