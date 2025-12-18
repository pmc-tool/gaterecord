import { Entity, Column, OneToOne, OneToMany, JoinColumn } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Gate } from './gate.entity';
import { SensorStatus } from './sensor-status.entity';

export enum ControllerStatus {
  ONLINE = 'online',
  OFFLINE = 'offline',
  FAULT = 'fault',
}

@Entity('gate_controllers')
export class GateController extends BaseEntity {
  @Column({ name: 'gate_id', unique: true })
  gateId: string;

  @OneToOne(() => Gate, (gate) => gate.controller)
  @JoinColumn({ name: 'gate_id' })
  gate: Gate;

  @Column({ name: 'mac_address', nullable: true })
  macAddress: string;

  @Column({ name: 'firmware_version', nullable: true })
  firmwareVersion: string;

  @Column({ type: 'enum', enum: ControllerStatus, default: ControllerStatus.OFFLINE })
  status: ControllerStatus;

  @Column({ name: 'wifi_strength', type: 'int', nullable: true })
  wifiStrength: number;

  @Column({ name: 'uptime_seconds', type: 'bigint', nullable: true })
  uptimeSeconds: number;

  @Column({ name: 'last_heartbeat_at', nullable: true })
  lastHeartbeatAt: Date;

  @Column({ type: 'jsonb', nullable: true })
  config: Record<string, unknown>;

  @OneToMany(() => SensorStatus, (sensor) => sensor.controller)
  sensors: SensorStatus[];
}
