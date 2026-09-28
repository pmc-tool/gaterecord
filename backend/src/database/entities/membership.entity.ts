import {
  Entity,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
} from 'typeorm';
import { User, UserRole, UserStatus } from './user.entity';
import { Tenant } from './tenant.entity';

/**
 * The roles a person can hold IN A BUILDING. super_admin is a platform role that
 * stays on gate_users.role and is never a membership.
 *
 * Typed as a subset of UserRole, not as a new enum, so existing code compares a
 * membership role with the UserRole constants it already uses
 * (`membership.role === UserRole.RESIDENT`). The string values are identical,
 * which is also what lets the backfill copy gate_users.role through ::text.
 */
export type MembershipRole =
  | UserRole.BUILDING_ADMIN
  | UserRole.RESIDENT
  | UserRole.SECURITY
  | UserRole.STAFF;

/** Membership status uses the same three values as gate_users.status. */
export type MembershipStatus = UserStatus;

/** Every role a membership row may carry. */
export const MEMBERSHIP_ROLES: readonly MembershipRole[] = [
  UserRole.BUILDING_ADMIN,
  UserRole.RESIDENT,
  UserRole.SECURITY,
  UserRole.STAFF,
];

/**
 * The roles a person may act as, i.e. pick in the role/building picker and be
 * auto-selected into when they hold exactly one. Staff is included so existing
 * staff rows keep their gate access after the backfill; the web labels it
 * "Staff" and only shows it to people who hold one. The single list used by
 * backend auto-select and by /memberships/me selectability.
 */
export const SELECTABLE_ROLES: readonly MembershipRole[] = [
  UserRole.BUILDING_ADMIN,
  UserRole.RESIDENT,
  UserRole.SECURITY,
  UserRole.STAFF,
];

export function isMembershipRole(role: unknown): role is MembershipRole {
  return (MEMBERSHIP_ROLES as readonly unknown[]).includes(role);
}

/**
 * One person's role in one building: gate_memberships.
 *
 * gate_users stays one row per person (email, Keycloak link, name, QR code,
 * password). What used to be the single tenant_id / role / unit on that row
 * lives here instead, one row per building, so the same person can be the
 * admin of Tower A, a resident of Tower B and security at Tower C. The
 * old gate_users columns are kept as a legacy mirror written only by
 * MembershipsService.syncLegacyColumns.
 *
 * Exactly one live role per building: the partial unique index on
 * (user_id, tenant_id) ignores soft-deleted rows, so leaving a building and
 * being added back later is a new row and the history is kept.
 *
 * Every constraint, index and enum is named explicitly and matches migration
 * 1775740000000-CreateGateMemberships, so a schema built by `synchronize` and
 * one built by the migration converge on the same objects instead of creating
 * hash-named duplicates side by side. That is also why this entity declares its
 * own id and timestamps instead of extending BaseEntity: TypeORM keeps the
 * parent's column definition when a child redeclares it, so the pinned primary
 * key name could not be set through an override.
 *
 * A resident join request is never a membership; it stays in
 * building_join_requests until an admin approves it.
 */
@Entity('gate_memberships')
@Index('UQ_gate_memberships_user_tenant', ['userId', 'tenantId'], {
  unique: true,
  where: '"deleted_at" IS NULL',
})
@Index('IDX_gate_memberships_tenant_role_status', ['tenantId', 'role', 'status'])
@Index('IDX_gate_memberships_user', ['userId'])
export class Membership {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_gate_memberships_id' })
  id: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', nullable: true })
  deletedAt: Date | null;

  /** gate_users.id of the PERSON, never the Keycloak sub (that is gate_users.user_id). */
  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  // onDelete matches the migration's FK so a synchronize-built dev schema and a
  // migration-built one behave the same on a hard delete. orphanedRowAction is
  // disabled so saving a User that happens to carry a partial `memberships`
  // array can never delete or detach membership rows.
  @ManyToOne(() => User, (user) => user.memberships, {
    onDelete: 'CASCADE',
    orphanedRowAction: 'disable',
  })
  @JoinColumn({ name: 'user_id', foreignKeyConstraintName: 'FK_gate_memberships_user' })
  user: User;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @ManyToOne(() => Tenant, (tenant) => tenant.memberships, {
    onDelete: 'CASCADE',
    orphanedRowAction: 'disable',
  })
  @JoinColumn({ name: 'tenant_id', foreignKeyConstraintName: 'FK_gate_memberships_tenant' })
  tenant: Tenant;

  @Column({
    type: 'enum',
    enum: MEMBERSHIP_ROLES as MembershipRole[],
    enumName: 'gate_memberships_role_enum',
  })
  role: MembershipRole;

  @Column({
    type: 'enum',
    enum: UserStatus,
    enumName: 'gate_memberships_status_enum',
    default: UserStatus.ACTIVE,
  })
  status: MembershipStatus;

  /** Apartment / flat for a resident membership, free text as gate_users.unit was. */
  @Column({ type: 'varchar', nullable: true })
  unit: string | null;
}
