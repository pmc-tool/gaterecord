import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { User } from './user.entity';

export enum VisitorPassStatus {
  PENDING = 'pending',
  ACTIVE = 'active',
  USED = 'used',
  EXPIRED = 'expired',
  CANCELLED = 'cancelled',
}

@Entity('visitor_passes')
@Index(['tenantId', 'qrToken'], { unique: true })
export class VisitorPass extends BaseEntity {
  @Column({ name: 'qr_token', unique: true })
  qrToken: string;

  @Column({ name: 'visitor_name' })
  visitorName: string;

  @Column({ name: 'visitor_phone', nullable: true })
  visitorPhone: string;

  @Column({ name: 'visitor_email', nullable: true })
  visitorEmail: string;

  @Column({ nullable: true })
  purpose: string;

  @Column({ type: 'enum', enum: VisitorPassStatus, default: VisitorPassStatus.PENDING })
  status: VisitorPassStatus;

  @Column({ name: 'valid_from', type: 'timestamp' })
  validFrom: Date;

  @Column({ name: 'valid_until', type: 'timestamp' })
  validUntil: Date;

  @Column({ name: 'max_uses', default: 1 })
  maxUses: number;

  @Column({ name: 'use_count', default: 0 })
  useCount: number;

  @Column({ name: 'tenant_id' })
  tenantId: string;

  @ManyToOne(() => Tenant, (tenant) => tenant.visitorPasses)
  @JoinColumn({ name: 'tenant_id' })
  tenant: Tenant;

  @Column({ name: 'created_by_id' })
  createdById: string;

  @ManyToOne(() => User, (user) => user.createdVisitorPasses)
  @JoinColumn({ name: 'created_by_id' })
  createdBy: User;

  @Column({ name: 'host_unit', nullable: true })
  hostUnit: string;
}
