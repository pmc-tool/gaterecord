import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { AccessEvent } from './access-event.entity';
import { User } from './user.entity';

export enum SecurityAlertType {
  UNAUTHORIZED_VISITOR = 'unauthorized_visitor',
  FORCED_ENTRY = 'forced_entry',
  TAILGATING = 'tailgating',
  SUSPICIOUS_ACTIVITY = 'suspicious_activity',
}

export enum SecurityAlertStatus {
  ACTIVE = 'active',
  ACKNOWLEDGED = 'acknowledged',
  RESOLVED = 'resolved',
  FALSE_ALARM = 'false_alarm',
}

export enum SecurityAlertPriority {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

@Entity('security_alerts')
@Index(['tenantId', 'status'])
@Index(['tenantId', 'createdAt'])
export class SecurityAlert extends BaseEntity {
  @Column({ name: 'tenant_id' })
  tenantId: string;

  @ManyToOne(() => Tenant)
  @JoinColumn({ name: 'tenant_id' })
  tenant: Tenant;

  @Column({ type: 'enum', enum: SecurityAlertType })
  type: SecurityAlertType;

  @Column({ type: 'enum', enum: SecurityAlertStatus, default: SecurityAlertStatus.ACTIVE })
  status: SecurityAlertStatus;

  @Column({ type: 'enum', enum: SecurityAlertPriority, default: SecurityAlertPriority.HIGH })
  priority: SecurityAlertPriority;

  @Column()
  title: string;

  @Column({ type: 'text' })
  description: string;

  @Column({ name: 'access_event_id', nullable: true })
  accessEventId: string;

  @ManyToOne(() => AccessEvent)
  @JoinColumn({ name: 'access_event_id' })
  accessEvent: AccessEvent;

  @Column({ name: 'visitor_name', nullable: true })
  visitorName: string;

  @Column({ name: 'resident_id', nullable: true })
  residentId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'resident_id' })
  resident: User;

  @Column({ name: 'reported_by_email', nullable: true })
  reportedByEmail: string;

  @Column({ name: 'gate_name', nullable: true })
  gateName: string;

  @Column({ name: 'acknowledged_by_id', nullable: true })
  acknowledgedById: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'acknowledged_by_id' })
  acknowledgedBy: User;

  @Column({ name: 'acknowledged_at', type: 'timestamp', nullable: true })
  acknowledgedAt: Date;

  @Column({ name: 'resolved_by_id', nullable: true })
  resolvedById: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'resolved_by_id' })
  resolvedBy: User;

  @Column({ name: 'resolved_at', type: 'timestamp', nullable: true })
  resolvedAt: Date;

  @Column({ name: 'resolution_notes', type: 'text', nullable: true })
  resolutionNotes: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown>;

  @Column({ name: 'buzzer_triggered', default: false })
  buzzerTriggered: boolean;
}
