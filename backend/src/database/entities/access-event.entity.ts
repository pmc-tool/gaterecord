import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { Exclude } from 'class-transformer';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { Gate } from './gate.entity';
import { User } from './user.entity';

export enum AccessMethod {
  CAR_RFID = 'car_rfid',
  HUMAN_RFID = 'human_rfid',
  QR = 'qr',
  WEB_APP = 'web_app',
  MANUAL = 'manual',
}

export enum AccessResult {
  ALLOWED = 'allowed',
  DENIED = 'denied',
}

export enum AccessSubjectType {
  VEHICLE = 'vehicle',
  RFID_CARD = 'rfid_card',
  VISITOR_PASS = 'visitor_pass',
  USER = 'user',
  UNKNOWN = 'unknown',
}

@Entity('access_events')
@Index(['tenantId', 'timestamp'])
@Index(['gateId', 'timestamp'])
@Index(['residentId', 'timestamp'])
export class AccessEvent extends BaseEntity {
  @Column({ name: 'tenant_id' })
  tenantId: string;

  @Exclude()
  @ManyToOne(() => Tenant, (tenant) => tenant.accessEvents)
  @JoinColumn({ name: 'tenant_id' })
  tenant: Tenant;

  @Column({ name: 'gate_id' })
  gateId: string;

  @ManyToOne(() => Gate, (gate) => gate.accessEvents)
  @JoinColumn({ name: 'gate_id' })
  gate: Gate;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  timestamp: Date;

  @Column({ type: 'enum', enum: AccessMethod })
  method: AccessMethod;

  @Column({ name: 'subject_type', type: 'enum', enum: AccessSubjectType })
  subjectType: AccessSubjectType;

  @Column({ name: 'subject_id', nullable: true })
  subjectId: string;

  @Column({ name: 'subject_identifier', nullable: true })
  subjectIdentifier: string;

  @Column({ name: 'subject_name', nullable: true })
  subjectName: string;

  // Denormalized resident ID for fast RBAC filtering
  // Populated from: Vehicle.ownerId, RfidCard.userId, VisitorPass.createdById, or User.id
  @Column({ name: 'resident_id', nullable: true })
  residentId: string;

  @Exclude()
  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'resident_id' })
  resident: User;

  @Column({ type: 'enum', enum: AccessResult })
  result: AccessResult;

  @Column({ name: 'denial_reason', nullable: true })
  denialReason: string;

  @Column({ name: 'operator_id', nullable: true })
  operatorId: string;

  @Column({ name: 'operator_name', nullable: true })
  operatorName: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown>;
}
