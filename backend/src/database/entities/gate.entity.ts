import { Entity, Column, ManyToOne, OneToMany, OneToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { GateController } from './gate-controller.entity';
import { AccessEvent } from './access-event.entity';
import { AccessPolicy } from './access-policy.entity';

export enum GateType {
  VEHICLE = 'vehicle',
  PEDESTRIAN = 'pedestrian',
  MIXED = 'mixed',
}

export enum GateState {
  CLOSED = 'CLOSED',
  OPENING = 'OPENING',
  OPEN = 'OPEN',
  CLOSING = 'CLOSING',
  OBSTACLE_HOLD = 'OBSTACLE_HOLD',
  FAULT = 'FAULT',
  MANUAL_OVERRIDE = 'MANUAL_OVERRIDE',
}

@Entity('gates')
@Index(['tenantId', 'name'], { unique: true })
@Index(['hardwareId'], { unique: true, where: '"hardware_id" IS NOT NULL' })
export class Gate extends BaseEntity {
  @Column()
  name: string;

  @Column({ name: 'hardware_id', nullable: true, unique: true })
  hardwareId: string; // ESP32 device ID (MAC address or custom ID)

  @Column({ type: 'enum', enum: GateType })
  type: GateType;

  @Column({ nullable: true })
  location: string;

  @Column({ nullable: true })
  description: string;

  @Column({ type: 'enum', enum: GateState, default: GateState.CLOSED })
  state: GateState;

  @Column({ name: 'is_online', default: false })
  isOnline: boolean;

  @Column({ name: 'last_heartbeat_at', nullable: true })
  lastHeartbeatAt: Date;

  @Column({ name: 'tenant_id' })
  tenantId: string;

  @ManyToOne(() => Tenant, (tenant) => tenant.gates)
  @JoinColumn({ name: 'tenant_id' })
  tenant: Tenant;

  @OneToOne(() => GateController, (controller) => controller.gate)
  controller: GateController;

  @OneToMany(() => AccessEvent, (event) => event.gate)
  accessEvents: AccessEvent[];

  @OneToMany(() => AccessPolicy, (policy) => policy.gate)
  accessPolicies: AccessPolicy[];
}
