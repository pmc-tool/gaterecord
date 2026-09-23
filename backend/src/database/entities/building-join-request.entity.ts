import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { User } from './user.entity';
import { Tenant } from './tenant.entity';

export enum JoinRequestStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  CANCELLED = 'cancelled',
}

/**
 * A self-service request from a signed-in user to join an existing building as
 * a resident, pending that building's admin approving it.
 *
 * Deliberately a separate table rather than a state on `gate_users`: a resident
 * IS a gate_users row with role=RESIDENT, so putting the pending state there
 * would mean flipping the role before approval. That cannot be done safely —
 * OnboardingService.updateBuilding rejects any role that is not BUILDING_ADMIN
 * or SUPER_ADMIN, and onboarding is the only surface a tenant-less user can
 * reach, so a premature role change strands them with no way forward. The
 * requester's gate_users row is therefore left completely untouched until an
 * admin approves.
 */
@Entity('building_join_requests')
@Index(['tenantId', 'status'])
@Index(['userId', 'status'])
export class BuildingJoinRequest extends BaseEntity {
  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  // onDelete matches the migration's FK so a synchronize-built dev schema and a
  // migration-built production schema behave identically on a hard delete.
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id' })
  tenant: Tenant;

  @Column({ type: 'enum', enum: JoinRequestStatus, default: JoinRequestStatus.PENDING })
  status: JoinRequestStatus;

  /** Apartment / flat number, copied onto gate_users.unit on approval. */
  @Column({ nullable: true })
  unit: string;

  /** Copied onto gate_users.phone on approval when that column is still empty. */
  @Column({ nullable: true })
  phone: string;

  /** Free-text context from the requester ("flat 4B, moved in March"). */
  @Column({ type: 'text', nullable: true })
  note: string | null;

  @Column({ name: 'reviewed_by', type: 'uuid', nullable: true })
  reviewedBy: string | null;

  @Column({ name: 'reviewed_at', type: 'timestamp', nullable: true })
  reviewedAt: Date | null;

  /** Reason shown to the requester when an admin rejects. */
  @Column({ name: 'decision_note', type: 'text', nullable: true })
  decisionNote: string | null;
}
