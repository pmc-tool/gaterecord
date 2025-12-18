import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { Gate } from './gate.entity';

@Entity('access_policies')
@Index(['tenantId', 'gateId', 'name'], { unique: true })
export class AccessPolicy extends BaseEntity {
  @Column()
  name: string;

  @Column({ nullable: true })
  description: string;

  @Column({ name: 'tenant_id' })
  tenantId: string;

  @ManyToOne(() => Tenant, (tenant) => tenant.accessPolicies)
  @JoinColumn({ name: 'tenant_id' })
  tenant: Tenant;

  @Column({ name: 'gate_id', nullable: true })
  gateId: string | null;

  @ManyToOne(() => Gate, (gate) => gate.accessPolicies, { nullable: true })
  @JoinColumn({ name: 'gate_id' })
  gate: Gate | null;

  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  @Column({ name: 'priority', default: 0 })
  priority: number;

  @Column({ name: 'time_restrictions', type: 'jsonb', nullable: true })
  timeRestrictions: {
    days?: number[];
    startTime?: string;
    endTime?: string;
  };

  @Column({ name: 'allowed_methods', type: 'jsonb', nullable: true })
  allowedMethods: string[];

  @Column({ name: 'allowed_roles', type: 'jsonb', nullable: true })
  allowedRoles: string[];

  @Column({ type: 'jsonb', nullable: true })
  rules: Record<string, unknown>;
}
