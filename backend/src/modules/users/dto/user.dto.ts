import { IsEmail, IsString, IsEnum, IsOptional, MinLength, IsUUID, IsIn } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserRole, UserStatus } from '@database/entities/user.entity';

export class CreateUserDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  email: string;

  @ApiPropertyOptional({
    example: 'Password123!',
    description:
      'Used only when the email has no account yet. If not provided, a temporary password will be generated and emailed to user. An existing account keeps its password.',
  })
  @IsString()
  @MinLength(8)
  @IsOptional()
  password?: string;

  @ApiProperty({ example: 'John' })
  @IsString()
  firstName: string;

  @ApiProperty({ example: 'Doe' })
  @IsString()
  lastName: string;

  @ApiPropertyOptional({ example: '+1234567890' })
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiProperty({
    enum: UserRole,
    example: UserRole.RESIDENT,
    description:
      'The role in the building. super_admin is a platform role on the person: it creates no membership.',
  })
  @IsEnum(UserRole)
  role: UserRole;

  @ApiPropertyOptional({
    description:
      'The building. Required for a super admin; a building admin always adds to the building they act in.',
  })
  @IsUUID()
  @IsOptional()
  tenantId?: string;

  @ApiPropertyOptional({ example: 'A-101' })
  @IsString()
  @IsOptional()
  unit?: string;

  @ApiPropertyOptional({
    enum: UserStatus,
    default: UserStatus.ACTIVE,
    description: 'The status of the new role in this building.',
  })
  @IsEnum(UserStatus)
  @IsOptional()
  status?: UserStatus;
}

/**
 * What PATCH /users/:id accepts. Written out rather than PartialType(CreateUserDto):
 * email and password are deliberately absent, so the global whitelist strips
 * them. The email is the person's platform identity and the password belongs
 * to the account service; neither is a building admin's to change.
 *
 * role, status and unit change the membership in the building the request
 * targets. firstName, lastName and phone belong to the person, who may be in
 * other buildings too: only a platform admin may change them here (a building
 * admin gets 403 PERSON_FIELDS_READ_ONLY unless the value is unchanged).
 */
export class UpdateUserDto {
  @ApiPropertyOptional({ example: 'John' })
  @IsString()
  @IsOptional()
  firstName?: string;

  @ApiPropertyOptional({ example: 'Doe' })
  @IsString()
  @IsOptional()
  lastName?: string;

  @ApiPropertyOptional({ example: '+1234567890' })
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiPropertyOptional({ enum: UserRole, description: 'The role in the targeted building.' })
  @IsEnum(UserRole)
  @IsOptional()
  role?: UserRole;

  @ApiPropertyOptional({
    description:
      'Accepted only when it names the building the row already belongs to: people are not moved between buildings.',
  })
  @IsUUID()
  @IsOptional()
  tenantId?: string;

  @ApiPropertyOptional({ example: 'A-101' })
  @IsString()
  @IsOptional()
  unit?: string;

  @ApiPropertyOptional({ enum: UserStatus, description: 'The status in the targeted building.' })
  @IsEnum(UserStatus)
  @IsOptional()
  status?: UserStatus;
}

/**
 * Names the building a GET/PATCH/DELETE /users/:id acts on. A building admin
 * never needs it (the request acts in their building); a platform admin passes
 * tenantId when the person belongs to several buildings.
 */
export class UserTargetQueryDto {
  @ApiPropertyOptional({
    description:
      'Super admin only: the building whose row this is. Optional when the person has exactly one building.',
  })
  @IsUUID()
  @IsOptional()
  tenantId?: string;

  @ApiPropertyOptional({
    enum: ['platform'],
    description:
      'Super admin only: act on the person, not one of their buildings. GET and PATCH read or edit the platform row (names, phone, status as the platform-wide ban); DELETE removes the person from the whole platform.',
  })
  @IsIn(['platform'])
  @IsOptional()
  scope?: 'platform';
}

/** One row of GET /users: a person's role in one building (see people.views.ts). */
export class UserResponseDto {
  @ApiProperty({
    description: 'The person (gate_users.id). Repeats for someone in several buildings.',
  })
  id: string;

  @ApiPropertyOptional({
    description: "This row's membership, or null for a platform admin listed without a building.",
  })
  membershipId?: string | null;

  @ApiProperty()
  email: string;

  @ApiProperty()
  firstName: string;

  @ApiProperty()
  lastName: string;

  @ApiPropertyOptional()
  phone?: string;

  @ApiProperty({ enum: UserRole })
  role: UserRole;

  @ApiProperty({ enum: UserStatus })
  status: UserStatus;

  @ApiPropertyOptional()
  tenantId?: string;

  @ApiPropertyOptional()
  unit?: string;

  @ApiPropertyOptional()
  profileImageUrl?: string;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'John' })
  @IsString()
  @IsOptional()
  firstName?: string;

  @ApiPropertyOptional({ example: 'Doe' })
  @IsString()
  @IsOptional()
  lastName?: string;

  @ApiPropertyOptional({ example: '+1234567890' })
  @IsString()
  @IsOptional()
  phone?: string;
}

export class UserQueryDto {
  @ApiPropertyOptional({ description: 'Search by name or email' })
  @IsString()
  @IsOptional()
  search?: string;

  @ApiPropertyOptional({ enum: UserRole, description: 'Filter by role' })
  @IsEnum(UserRole)
  @IsOptional()
  role?: UserRole;

  @ApiPropertyOptional({ description: 'Filter by tenant ID (super admin only)' })
  @IsUUID()
  @IsOptional()
  tenantId?: string;

  @ApiPropertyOptional({ enum: UserStatus, description: 'Filter by status' })
  @IsEnum(UserStatus)
  @IsOptional()
  status?: UserStatus;
}
