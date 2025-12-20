import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { Gate } from './gate.entity';
import { User } from './user.entity';

export enum SetupCodeStatus {
  PENDING = 'pending',
  CLAIMED = 'claimed',
  EXPIRED = 'expired',
}

@Entity('setup_codes')
@Index(['code'], { unique: true })
@Index(['tenantId', 'status'])
export class SetupCode extends BaseEntity {
  @Column({ unique: true })
  code: string;

  @Column({ name: 'device_name', type: 'varchar', nullable: true })
  deviceName: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @ManyToOne(() => Tenant)
  @JoinColumn({ name: 'tenant_id' })
  tenant: Tenant;

  @Column({ name: 'gate_id', type: 'uuid', nullable: true })
  gateId: string | null;

  @ManyToOne(() => Gate, { nullable: true })
  @JoinColumn({ name: 'gate_id' })
  gate: Gate | null;

  @Column({ name: 'expires_at', type: 'timestamp' })
  expiresAt: Date;

  @Column({ type: 'enum', enum: SetupCodeStatus, default: SetupCodeStatus.PENDING })
  status: SetupCodeStatus;

  @Column({ name: 'claimed_by_device_id', type: 'varchar', nullable: true })
  claimedByDeviceId: string | null;

  @Column({ name: 'claimed_at', type: 'timestamp', nullable: true })
  claimedAt: Date | null;

  @Column({ name: 'created_by_id', type: 'uuid', nullable: true })
  createdById: string | null;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'created_by_id' })
  createdBy: User | null;
}
