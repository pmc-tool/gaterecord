import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { DeviceConfig } from './device-config.entity';
import { FirmwareVersion } from './firmware-version.entity';
import { User } from './user.entity';

export enum OtaUpdateStatus {
  PENDING = 'pending',
  DOWNLOADING = 'downloading',
  INSTALLING = 'installing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  ROLLED_BACK = 'rolled_back',
}

@Entity('ota_updates')
@Index(['deviceConfigId', 'status'])
export class OtaUpdate extends BaseEntity {
  @Column({ name: 'device_config_id', type: 'uuid' })
  deviceConfigId: string;

  @ManyToOne(() => DeviceConfig)
  @JoinColumn({ name: 'device_config_id' })
  deviceConfig: DeviceConfig;

  @Column({ name: 'firmware_version_id', type: 'uuid' })
  firmwareVersionId: string;

  @ManyToOne(() => FirmwareVersion)
  @JoinColumn({ name: 'firmware_version_id' })
  firmwareVersion: FirmwareVersion;

  @Column({ name: 'from_version', type: 'varchar', nullable: true })
  fromVersion: string | null;

  @Column({ name: 'to_version', type: 'varchar' })
  toVersion: string;

  @Column({ type: 'enum', enum: OtaUpdateStatus, default: OtaUpdateStatus.PENDING })
  status: OtaUpdateStatus;

  @Column({ type: 'int', default: 0 })
  progress: number;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage: string | null;

  @Column({ name: 'initiated_by_id', type: 'uuid', nullable: true })
  initiatedById: string | null;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'initiated_by_id' })
  initiatedBy: User | null;

  @Column({ name: 'initiated_at', type: 'timestamp', nullable: true })
  initiatedAt: Date | null;

  @Column({ name: 'started_at', type: 'timestamp', nullable: true })
  startedAt: Date | null;

  @Column({ name: 'completed_at', type: 'timestamp', nullable: true })
  completedAt: Date | null;
}
