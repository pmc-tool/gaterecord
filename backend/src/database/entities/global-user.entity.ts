import {
  Entity,
  Column,
  Index,
  PrimaryColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Full upstream profile payload mirrored from the account service.
 * Intentionally loose: the account service owns this shape.
 */
export interface GlobalUserMeta {
  [key: string]: unknown;
}

/**
 * Global user mirror — one row per human across the whole platform.
 *
 * Synced from the upstream "account" service; the primary key is assigned from
 * the Keycloak `sub` / account `users.id` and is therefore NOT generated here.
 *
 * NOTE: this is NOT the gate-management user (see `User` / `gate_users`).
 */
@Entity('users')
@Index('IDX_users_email', ['email'], { unique: true })
export class GlobalUser {
  @PrimaryColumn({ type: 'uuid' })
  id: string;

  @Column({ type: 'varchar' })
  email: string;

  @Column({ name: 'user_meta', type: 'jsonb', nullable: true })
  userMeta: GlobalUserMeta | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @Column({ name: 'synced_at', type: 'timestamp', nullable: true })
  syncedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
