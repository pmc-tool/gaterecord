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
 * Deliberately a separate table rather than a state on `gate_users` or a
 * membership: a request is never a membership (gate_memberships holds only
 * roles a person actually has), so nothing about the requester changes until an
 * admin approves. Approval is what gives them the RESIDENT role in that building.
 *
 * At most one PENDING request per person PER BUILDING. A person may have
 * requests in flight to several buildings at once (they can hold roles in
 * several), but not two to the same one. Enforced in the database as well as
 * the service by the partial unique index below, because two concurrent submits
 * would otherwise both pass the service's existence check. Partial, so resolved
 * requests stay as history and a rejected person can apply again. Declared here
 * with the same name as migration 1775740100000-JoinRequestsPendingPerBuilding
 * so `synchronize` keeps the index instead of dropping it as unknown.
 */
@Entity('building_join_requests')
@Index(['tenantId', 'status'])
@Index(['userId', 'status'])
@Index('UQ_building_join_requests_one_pending_per_user_tenant', ['userId', 'tenantId'], {
  unique: true,
  where: `"status" = 'pending' AND "deleted_at" IS NULL`,
})
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

  /** Apartment / flat number, copied onto the resident's unit on approval. */
  @Column({ nullable: true })
  unit: string;

  /** Copied onto the person's gate_users.phone on approval when that column is still empty. */
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
