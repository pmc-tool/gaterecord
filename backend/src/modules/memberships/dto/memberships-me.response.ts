import { ApiProperty } from '@nestjs/swagger';
import { UserRole, UserStatus } from '@database/entities/user.entity';
import { TenantStatus } from '@database/entities/tenant.entity';
import type { MembershipRole } from '@database/entities/membership.entity';

/**
 * GET /memberships/me (contract C4): everything the web's role -> building
 * picker needs, in one call. Built only by MembershipsService.getMine.
 *
 * The tenant projection is deliberately exactly {id, name, address, status,
 * isPaused}: a person may see every building they hold a role in, but not that
 * building's billing, contact or settings data.
 */
export class MembershipTenantView {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ nullable: true, type: String })
  address: string | null;

  @ApiProperty({ enum: TenantStatus, description: 'Includes pending_payment' })
  status: TenantStatus;

  @ApiProperty()
  isPaused: boolean;
}

export class MembershipView {
  @ApiProperty({ format: 'uuid', description: 'The value to send as X-Gate-Membership' })
  id: string;

  @ApiProperty({
    enum: [UserRole.BUILDING_ADMIN, UserRole.RESIDENT, UserRole.SECURITY, UserRole.STAFF],
  })
  role: MembershipRole;

  @ApiProperty({
    enum: UserStatus,
    description:
      'Only active rows whose role is selectable can be chosen; others are listed disabled',
  })
  status: UserStatus;

  @ApiProperty({ nullable: true, type: String })
  unit: string | null;

  @ApiProperty({ type: MembershipTenantView })
  tenant: MembershipTenantView;
}

export class PendingJoinRequestTenantView {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;
}

export class PendingJoinRequestView {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: ['pending'] })
  status: 'pending';

  @ApiProperty({ type: PendingJoinRequestTenantView })
  tenant: PendingJoinRequestTenantView;
}

export class MembershipsMeUserView {
  @ApiProperty({
    format: 'uuid',
    description: 'gate_users.id (the person), never the Keycloak sub',
  })
  id: string;

  @ApiProperty()
  email: string;

  @ApiProperty()
  firstName: string;

  @ApiProperty()
  lastName: string;
}

export class MembershipsMeResponse {
  @ApiProperty({ description: "From the person's own gate_users.role (platform role)" })
  isSuperAdmin: boolean;

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      "The membership this request resolved to, 'platform' for the Platform context, or null " +
      '(no header with several or no memberships, or a stale header)',
  })
  activeMembershipId: string | null;

  @ApiProperty({ description: 'Whether a person may hold roles in several buildings' })
  multiMembershipEnabled: boolean;

  @ApiProperty({ type: MembershipsMeUserView })
  user: MembershipsMeUserView;

  @ApiProperty({
    type: [MembershipView],
    description:
      'Every live membership in a live building, any status, sorted by building name then role',
  })
  memberships: MembershipView[];

  @ApiProperty({ type: [PendingJoinRequestView] })
  pendingJoinRequests: PendingJoinRequestView[];
}
