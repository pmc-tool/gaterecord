import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { User } from './user.entity';

export enum RfidCardStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  LOST = 'lost',
}

@Entity('rfid_cards')
@Index(['tenantId', 'uid'], { unique: true })
export class RfidCard extends BaseEntity {
  @Column()
  uid: string;

  @Column({ nullable: true })
  label: string;

  @Column({ type: 'enum', enum: RfidCardStatus, default: RfidCardStatus.ACTIVE })
  status: RfidCardStatus;

  @Column({ name: 'tenant_id' })
  tenantId: string;

  @ManyToOne(() => Tenant, (tenant) => tenant.rfidCards)
  @JoinColumn({ name: 'tenant_id' })
  tenant: Tenant;

  @Column({ name: 'user_id' })
  userId: string;

  @ManyToOne(() => User, (user) => user.rfidCards)
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'valid_from', type: 'timestamp', nullable: true })
  validFrom: Date;

  @Column({ name: 'valid_until', type: 'timestamp', nullable: true })
  validUntil: Date;
}
