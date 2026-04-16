import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { User } from './user.entity';
import { Tenant } from './tenant.entity';

export enum NotificationType {
  // Security related
  SECURITY_ALERT = 'security_alert',
  UNAUTHORIZED_ACCESS = 'unauthorized_access',
  
  // Visitor related
  VISITOR_ENTRY = 'visitor_entry',
  VISITOR_PASS_CREATED = 'visitor_pass_created',
  VISITOR_PASS_USED = 'visitor_pass_used',
  
  // Access related
  ACCESS_GRANTED = 'access_granted',
  ACCESS_DENIED = 'access_denied',
  
  // System related
  GATE_OFFLINE = 'gate_offline',
  GATE_ONLINE = 'gate_online',
  DEVICE_OFFLINE = 'device_offline',
  DEVICE_ONLINE = 'device_online',
  
  // Account related
  PASSWORD_CHANGED = 'password_changed',
  PROFILE_UPDATED = 'profile_updated',
  
  // Subscription related
  TRIAL_EXPIRING = 'trial_expiring',
  SUBSCRIPTION_RENEWED = 'subscription_renewed',
  PAYMENT_FAILED = 'payment_failed',
  
  // General
  INFO = 'info',
  WARNING = 'warning',
  SUCCESS = 'success',
}

export enum NotificationPriority {
  LOW = 'low',
  NORMAL = 'normal',
  HIGH = 'high',
  CRITICAL = 'critical',
}

@Entity('notifications')
@Index(['userId', 'isRead'])
@Index(['userId', 'createdAt'])
@Index(['tenantId', 'createdAt'])
export class Notification extends BaseEntity {
  @Column({ name: 'user_id' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'tenant_id', nullable: true })
  tenantId: string | null;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'tenant_id' })
  tenant: Tenant | null;

  @Column({ type: 'enum', enum: NotificationType })
  type: NotificationType;

  @Column({ type: 'enum', enum: NotificationPriority, default: NotificationPriority.NORMAL })
  priority: NotificationPriority;

  @Column()
  title: string;

  @Column({ type: 'text' })
  message: string;

  @Column({ name: 'is_read', default: false })
  isRead: boolean;

  @Column({ name: 'read_at', type: 'timestamp', nullable: true })
  readAt: Date | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: {
    eventId?: string;
    gateId?: string;
    gateName?: string;
    visitorName?: string;
    visitorPassId?: string;
    alertId?: string;
    link?: string;
    [key: string]: unknown;
  } | null;

  @Column({ name: 'email_sent', default: false })
  emailSent: boolean;

  @Column({ name: 'email_sent_at', type: 'timestamp', nullable: true })
  emailSentAt: Date | null;
}
