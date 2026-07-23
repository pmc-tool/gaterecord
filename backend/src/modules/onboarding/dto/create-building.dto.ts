import {
  IsNotEmpty,
  IsString,
  IsOptional,
  IsObject,
  IsBoolean,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Payload for the once-only "Get Started" flow.
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
    description: 'True when the caller has no tenant yet and must create a building.',
  })
  needsOnboarding: boolean;

  @ApiProperty({ description: 'The caller\'s current tenant id, null before onboarding.' })
  tenantId: string | null;

  @ApiProperty({ description: 'The caller\'s gaterecord role.' })
  role: string;

  @ApiProperty({ description: 'Active subscription plans, for rendering the plan picker.' })
  plans: unknown[];
}
