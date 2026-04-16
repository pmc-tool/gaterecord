import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { Gate } from './gate.entity';
import { SetupCode } from './setup-code.entity';

export enum DeviceStatus {
  SETUP = 'setup',
  ONLINE = 'online',
  OFFLINE = 'offline',
  UPDATING = 'updating',
}

@Entity('device_configs')
@Index(['deviceId'], { unique: true })
@Index(['tenantId', 'status'])
export class DeviceConfig extends BaseEntity {
  @Column({ name: 'device_name', type: 'varchar' })
  deviceName: string;

  @Column({ name: 'device_id', type: 'varchar', unique: true })
  deviceId: string; // Serial number from controller

  @Column({ name: 'mac_address', type: 'varchar', nullable: true })
  macAddress: string | null; // MAC address in XX:XX:XX:XX:XX:XX format

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

  @Column({ name: 'setup_code_id', type: 'uuid', nullable: true })
  setupCodeId: string | null;

  @ManyToOne(() => SetupCode, { nullable: true })
  @JoinColumn({ name: 'setup_code_id' })
  setupCode: SetupCode | null;

  @Column({ name: 'paired_at', type: 'timestamp', nullable: true })
  pairedAt: Date | null;

  @Column({ name: 'wifi_ssid', type: 'varchar', nullable: true })
  wifiSsid: string | null;

  @Column({ name: 'api_key', type: 'varchar', nullable: true })
  apiKey: string | null;

  @Column({ name: 'api_key_hash', type: 'varchar', nullable: true })
  apiKeyHash: string | null;

  @Column({ name: 'firmware_version', type: 'varchar', nullable: true })
  firmwareVersion: string | null;

  @Column({ type: 'enum', enum: DeviceStatus, default: DeviceStatus.SETUP })
  status: DeviceStatus;

  @Column({ name: 'last_seen_at', type: 'timestamp', nullable: true })
  lastSeenAt: Date | null;

  @Column({ name: 'ip_address', type: 'varchar', nullable: true })
  ipAddress: string | null;

  @Column({ name: 'wifi_signal_strength', type: 'int', nullable: true })
  wifiSignalStrength: number | null; // RSSI in dBm

  @Column({ name: 'free_heap', type: 'int', nullable: true })
  freeHeap: number | null;

  @Column({ type: 'int', nullable: true })
  uptime: number | null; // seconds

  @Column({ name: 'error_count', type: 'int', default: 0 })
  errorCount: number;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError: string | null;

  @Column({ name: 'last_reboot_reason', type: 'varchar', nullable: true })
  lastRebootReason: string | null;
}
