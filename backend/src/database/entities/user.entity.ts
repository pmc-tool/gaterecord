import { Entity, Column, ManyToOne, OneToMany, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { Vehicle } from './vehicle.entity';
import { RfidCard } from './rfid-card.entity';
import { VisitorPass } from './visitor-pass.entity';
import { RefreshToken } from './refresh-token.entity';

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

@Entity('users')
@Index(['email'], { unique: true })
@Index(['tenantId', 'role'])
export class User extends BaseEntity {
  @Column({ unique: true })
  email: string;

  @Column({ name: 'password_hash' })
  passwordHash: string;

  @Column({ name: 'first_name' })
  firstName: string;

  @Column({ name: 'last_name' })
  lastName: string;

  @Column({ nullable: true })
  phone: string;

  @Column({ type: 'enum', enum: UserRole })
  role: UserRole;

  @Column({ type: 'enum', enum: UserStatus, default: UserStatus.PENDING })
  status: UserStatus;

  @Column({ name: 'tenant_id', nullable: true })
  tenantId: string | null;

  @ManyToOne(() => Tenant, (tenant) => tenant.users)
  @JoinColumn({ name: 'tenant_id' })
  tenant: Tenant | null;

  @Column({ nullable: true })
  unit: string;

  @Column({ name: 'profile_image_url', nullable: true })
  profileImageUrl: string;

  @Column({ name: 'last_login_at', nullable: true })
  lastLoginAt: Date;

  @Column({ name: 'must_change_password', default: false })
  mustChangePassword: boolean;

  @OneToMany(() => Vehicle, (vehicle) => vehicle.owner)
  vehicles: Vehicle[];

  @OneToMany(() => RfidCard, (rfidCard) => rfidCard.user)
  rfidCards: RfidCard[];

  @OneToMany(() => VisitorPass, (pass) => pass.createdBy)
  createdVisitorPasses: VisitorPass[];

  @OneToMany(() => RefreshToken, (token) => token.user)
  refreshTokens: RefreshToken[];
}
