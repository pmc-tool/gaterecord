import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { User } from './user.entity';
import { Vehicle } from './vehicle.entity';

export enum RfidCardStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  LOST = 'lost',
}

/**
 * A physical RFID card. It belongs to EITHER a person (user_id) OR a vehicle
 * (vehicle_id) — never both, never neither (enforced by a DB CHECK constraint).
 *
 * This mirrors how people carry credentials: a person has an intrinsic QR code
 * (users.qrCode) plus removable RFID cards; a vehicle has an intrinsic tag
 * (vehicles.rfid_uid) plus removable RFID cards recorded here. The intrinsic
 * vehicles.rfid_uid is deliberately kept separate and untouched — this table only
 * adds extra scannable cards on top of it.
 */
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

  // Holder is a person OR a vehicle. Exactly one of user_id / vehicle_id is set
  // (DB CHECK constraint). Both are typed `string` rather than `string | null` to
  // match the codebase's nullable-FK convention: readers only ever touch the id
  // that is set for that card's kind, so no null-guarding is forced on callers.
  @Column({ name: 'user_id', nullable: true })
  userId: string;

  @ManyToOne(() => User, (user) => user.rfidCards, { nullable: true })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'vehicle_id', nullable: true })
  vehicleId: string;

  @ManyToOne(() => Vehicle, { nullable: true })
  @JoinColumn({ name: 'vehicle_id' })
  vehicle: Vehicle;

  @Column({ name: 'valid_from', type: 'timestamp', nullable: true })
  validFrom: Date;

  @Column({ name: 'valid_until', type: 'timestamp', nullable: true })
  validUntil: Date;
}
