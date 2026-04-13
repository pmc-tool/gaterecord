import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { AccessEvent } from './access-event.entity';
import { User } from './user.entity';
import { Gate } from './gate.entity';
import { DeviceConfig } from './device-config.entity';

export enum SecurityAlertType {
  UNAUTHORIZED_VISITOR = 'unauthorized_visitor',
  FORCED_ENTRY = 'forced_entry',
  TAILGATING = 'tailgating',
  SUSPICIOUS_ACTIVITY = 'suspicious_activity',
  DOOR_HELD_OPEN = 'door_held_open',
  INVALID_CREDENTIAL = 'invalid_credential',
  REPEATED_DENIED_ACCESS = 'repeated_denied_access',
  AFTER_HOURS_ACCESS = 'after_hours_access',
  DEVICE_TAMPER = 'device_tamper',
  CONTROLLER_OFFLINE = 'controller_offline',
}

export enum SecurityAlertSource {
  CONTROLLER = 'controller', // From Cloud Plus TypeB hardware
  SYSTEM = 'system', // System-generated (e.g., offline detection)
  RESIDENT_REPORT = 'resident_report', // Resident reported unauthorized
  MANUAL = 'manual', // Manually created by security staff
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
@Index(['gateId', 'status'])
@Index(['deviceId', 'createdAt'])
export class SecurityAlert extends BaseEntity {
  @Column({ name: 'tenant_id' })
  tenantId: string;

  @ManyToOne(() => Tenant)
  @JoinColumn({ name: 'tenant_id' })
  tenant: Tenant;

  // Gate relationship - proper FK to gates table
  @Column({ name: 'gate_id', nullable: true })
  gateId: string;

  @ManyToOne(() => Gate)
  @JoinColumn({ name: 'gate_id' })
  gate: Gate;

  // Device relationship - proper FK to device_configs table
  @Column({ name: 'device_id', nullable: true })
  deviceId: string;

  @ManyToOne(() => DeviceConfig)
  @JoinColumn({ name: 'device_id' })
  device: DeviceConfig;

  @Column({ type: 'enum', enum: SecurityAlertType })
  type: SecurityAlertType;

  @Column({
    type: 'enum',
    enum: SecurityAlertSource,
    default: SecurityAlertSource.SYSTEM,
  })
  source: SecurityAlertSource;

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

  // Hardware alarm state tracking
  @Column({ name: 'buzzer_triggered', default: false })
  buzzerTriggered: boolean;

  @Column({ name: 'hardware_alarm_sent', default: false })
  hardwareAlarmSent: boolean;

  @Column({ name: 'hardware_alarm_stopped', default: false })
  hardwareAlarmStopped: boolean;

  @Column({ name: 'alarm_duration_seconds', type: 'int', nullable: true })
  alarmDurationSeconds: number;

  // Controller serial number that triggered the alert
  @Column({ name: 'controller_serial', nullable: true })
  controllerSerial: string;

  // Raw credential data for audit
  @Column({ name: 'credential_type', nullable: true })
  credentialType: string;

  @Column({ name: 'credential_value', nullable: true })
  credentialValue: string;

  // Escalation tracking
  @Column({ name: 'escalated', default: false })
  escalated: boolean;

  @Column({ name: 'escalated_at', type: 'timestamp', nullable: true })
  escalatedAt: Date;

  // Auto-resolve timeout
  @Column({ name: 'auto_resolve_at', type: 'timestamp', nullable: true })
  autoResolveAt: Date;
}
