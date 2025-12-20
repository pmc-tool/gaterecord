import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from './base.entity';

@Entity('firmware_versions')
@Index(['version'], { unique: true })
export class FirmwareVersion extends BaseEntity {
  @Column({ type: 'varchar', unique: true })
  version: string;

  @Column({ name: 'firmware_url', type: 'varchar' })
  firmwareUrl: string;

  @Column({ name: 'firmware_size', type: 'int', nullable: true })
  firmwareSize: number | null;

  @Column({ type: 'varchar' })
  checksum: string; // SHA256

  @Column({ name: 'release_notes', type: 'text', nullable: true })
  releaseNotes: string | null;

  @Column({ name: 'is_stable', type: 'boolean', default: false })
  isStable: boolean;

  @Column({ name: 'is_latest', type: 'boolean', default: false })
  isLatest: boolean;

  @Column({ name: 'min_required_version', type: 'varchar', nullable: true })
  minRequiredVersion: string | null;

  @Column({ name: 'allow_rollback', type: 'boolean', default: true })
  allowRollback: boolean;

  @Column({ name: 'released_at', type: 'timestamp', nullable: true })
  releasedAt: Date | null;
}
