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

export enum RegistrationType {
  SELF_SERVICE = 'self_service',    // Resident created pass for their visitor
  ON_PREMISE = 'on_premise',         // Admin/Security registered visitor on-site
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

  @Column({
    type: 'enum',
    enum: RegistrationType,
    name: 'registration_type',
    default: RegistrationType.SELF_SERVICE
  })
  registrationType: RegistrationType;

  @Column({ name: 'resident_confirmed', nullable: true })
  residentConfirmed: boolean;

  @Column({ name: 'confirmation_notes', nullable: true })
  confirmationNotes: string;

  @Column({ name: 'resident_id', nullable: true })
  residentId: string;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'resident_id' })
  resident: User;
}
