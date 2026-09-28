import { Entity, Column, ManyToOne, OneToMany, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { Vehicle } from './vehicle.entity';
import { RfidCard } from './rfid-card.entity';
import { VisitorPass } from './visitor-pass.entity';
import { RefreshToken } from './refresh-token.entity';
// Type-only: the relation below names its target as a string, so this file never
// loads membership.entity at runtime. membership.entity reads UserRole while it
// is being evaluated, and a runtime import in this direction would hand it a
// half-initialised module whenever user.entity happened to load first.
import type { Membership } from './membership.entity';

export enum UserRole {
  SUPER_ADMIN = 'super_admin',
  BUILDING_ADMIN = 'building_admin',
  SECURITY = 'security',
  RESIDENT = 'resident',
  STAFF = 'staff',
}

export enum UserStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  PENDING = 'pending',
}

export interface NotificationSettings {
  emailNotifications: boolean; // Receive email notifications
  inAppNotifications: boolean; // Receive in-app (bell) notifications
}

@Entity('gate_users')
@Index(['email'], { unique: true })
@Index(['tenantId', 'role'])
export class User extends BaseEntity {
  @Column({ unique: true })
  email: string;

  /**
   * Never selected by default (select: false), so no find(), relation join or
   * leftJoinAndSelect ever loads it: a building's admin or security member
   * listing vehicles, cards, alerts or passes would otherwise receive the hash
   * of every person joined in, and under multi-building memberships that is a
   * cross-building credential leak. The few code paths that verify a password
   * (local login, the signup resume, change-password) select it explicitly with
   * addSelect('user.passwordHash'). Writes are unaffected.
   */
  @Column({ name: 'password_hash', select: false })
  passwordHash: string;

  @Column({ name: 'first_name' })
  firstName: string;

  @Column({ name: 'last_name' })
  lastName: string;

  @Column({ nullable: true })
  phone: string;

  /**
   * LEGACY for everyone except super admins. For a super admin this is the
   * platform role (A1), written only when super_admin is granted or revoked.
   * For everyone else it is a MIRROR of the person's primary membership
   * (building_admin when they have none), written only by
   * MembershipsService.syncLegacyColumns. Do not scope by it: use the overlaid
   * req.user and assertBuildingContext().
   */
  @Column({ type: 'enum', enum: UserRole })
  role: UserRole;

  /**
   * LEGACY. Until the status split (DB-12, deferred) this is both the
   * platform-wide ban and, for a person with exactly one live membership, a
   * copy of that membership's status (MembershipsService dual-writes it). Any
   * value other than ACTIVE blocks authentication.
   */
  @Column({ type: 'enum', enum: UserStatus, default: UserStatus.PENDING })
  status: UserStatus;

  /**
   * LEGACY mirror of the primary membership's building (NULL when the person
   * has none). Written only by MembershipsService.syncLegacyColumns; scope by
   * the overlaid req.user or by the person's memberships instead.
   */
  @Column({ name: 'tenant_id', nullable: true })
  tenantId: string | null;

  /** LEGACY: the relation over the mirrored tenant_id above. */
  @ManyToOne(() => Tenant, (tenant) => tenant.users)
  @JoinColumn({ name: 'tenant_id' })
  tenant: Tenant | null;

  /** LEGACY mirror of the primary membership's unit. Written only by syncLegacyColumns. */
  @Column({ nullable: true })
  unit: string;

  @Column({ name: 'profile_image_url', nullable: true })
  profileImageUrl: string;

  @Column({ name: 'qr_code', unique: true, nullable: true })
  qrCode: string;

  @Column({ name: 'last_login_at', nullable: true })
  lastLoginAt: Date;

  @Column({ name: 'must_change_password', default: false })
  mustChangePassword: boolean;

  @Column({ name: 'notification_settings', type: 'jsonb', nullable: true })
  notificationSettings: NotificationSettings;

  /**
   * Link to the platform-wide identity in the global `users` mirror table.
   *
   * Nullable and unpopulated during Phase 1; backfilled in Phase 3. Intentionally
   * a plain column: no @ManyToOne relation and no database-level foreign key yet,
   * because the target table is created by a later migration and a hard constraint
   * would break the unpopulated state.
   */
  @Column({ name: 'user_id', type: 'uuid', nullable: true, unique: true })
  userId: string | null;

  @OneToMany(() => Vehicle, (vehicle) => vehicle.owner)
  vehicles: Vehicle[];

  @OneToMany(() => RfidCard, (rfidCard) => rfidCard.user)
  rfidCards: RfidCard[];

  @OneToMany(() => VisitorPass, (pass) => pass.createdBy)
  createdVisitorPasses: VisitorPass[];

  @OneToMany(() => RefreshToken, (token) => token.user)
  refreshTokens: RefreshToken[];

  /**
   * The person's roles in buildings (gate_memberships). Read-only from this
   * side: persistence is off, so saving a User never inserts, updates or
   * detaches membership rows, whatever this array holds. MembershipsService is
   * the only writer.
   */
  @OneToMany('Membership', 'user', { persistence: false })
  memberships: Membership[];

  /**
   * Second line of defence behind select: false. A User built in memory with a
   * hash (a create() before save(), a password change assigned onto a loaded
   * row) still carries passwordHash, and several endpoints return such entities
   * as they are. JSON.stringify, which Express and socket.io both use, calls
   * this, so the hash never reaches a response body or a socket payload. It has
   * no effect on persistence: TypeORM never serialises entities through it.
   */
  toJSON(): Omit<this, 'passwordHash' | 'toJSON'> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { passwordHash, ...rest } = this;
    return rest;
  }
}
