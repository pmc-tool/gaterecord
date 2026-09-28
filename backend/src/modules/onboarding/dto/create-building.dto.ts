import { IsNotEmpty, IsString, IsOptional, IsObject, IsBoolean } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Payload for the "Get Started" flow (a first building, or another one for a
 * person who already has a role somewhere, within the creation policy).
 *
 * Field names are deliberately identical to the corresponding fields on SignupDto
 * (src/modules/auth/dto/login.dto.ts) so the frontend can reuse the same form model
 * for both the legacy self-signup path and the Keycloak onboarding path.
 *
 * The identity fields of SignupDto (firstName/lastName/email/password) are absent
 * on purpose: the caller is already authenticated and already has a gate_users row,
 * so this endpoint neither creates a user nor touches credentials.
 */
export class CreateBuildingDto {
  @ApiProperty({ example: 'Sunrise Apartments' })
  @IsString()
  @IsNotEmpty()
  buildingName: string;

  @ApiPropertyOptional({ example: '123 Main St, City, State 12345' })
  @IsString()
  @IsOptional()
  buildingAddress?: string;

  @ApiProperty({
    example: 'starter',
    description: 'Plan name: starter, professional, or enterprise',
  })
  @IsString()
  @IsNotEmpty()
  planName: string;

  @ApiPropertyOptional({
    description: 'Whether this onboarding requires payment (for paid plans)',
  })
  @IsBoolean()
  @IsOptional()
  requiresPayment?: boolean;

  @ApiPropertyOptional({
    description: 'Start a free trial without payment (for plans with trial days)',
  })
  @IsBoolean()
  @IsOptional()
  startTrial?: boolean;

  @ApiPropertyOptional({ description: 'Dummy payment info for now' })
  @IsObject()
  @IsOptional()
  paymentInfo?: {
    cardLast4?: string;
    cardBrand?: string;
    cardholderName?: string;
  };
}

export class OnboardingStatusDto {
  @ApiProperty({
    description:
      'True when the caller holds no membership in any live building (any status) and is ' +
      'not a super admin, so must create or join a building.',
  })
  needsOnboarding: boolean;

  @ApiProperty({ description: 'True for a platform super admin.' })
  isSuperAdmin: boolean;

  @ApiProperty({
    description: 'The building this request acts in, null when none is chosen.',
    nullable: true,
    type: String,
  })
  tenantId: string | null;

  @ApiProperty({
    description:
      'The role held in the building this request acts in (super_admin in the ' +
      'Platform context), null when none is chosen.',
    nullable: true,
    type: String,
  })
  role: string | null;

  @ApiPropertyOptional({
    description: 'Status of the latest join request while the caller has no building.',
    nullable: true,
    type: String,
  })
  joinRequestStatus: string | null;

  @ApiPropertyOptional({
    description: 'The building acted in: { id, name, slug, status }, or null.',
    nullable: true,
  })
  tenant: { id: string; name: string; slug: string; status: string } | null;

  @ApiProperty({ description: 'Active subscription plans, for rendering the plan picker.' })
  plans: unknown[];
}
