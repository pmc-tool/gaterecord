import {
  IsString,
  IsEmail,
  IsOptional,
  IsBoolean,
  IsUUID,
  ValidateIf,
  IsNumber,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

export class CreateResidentDto {
  @ApiProperty()
  @IsString()
  firstName: string;

  @ApiProperty()
  @IsString()
  lastName: string;

  @ApiProperty()
  @IsEmail()
  email: string;

  @ApiPropertyOptional({
    description:
      'Optional. Forwarded to the account service, which enforces a minimum of 8 characters; ' +
      'omit it and a strong password is generated and emailed to the resident.',
  })
  @IsString()
  @MinLength(8)
  @IsOptional()
  password?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiProperty()
  @IsString()
  unit: string;

  @ApiPropertyOptional({
    description:
      'Required for super_admin; a building admin always adds to the building they act in',
  })
  @ValidateIf((o) => o.tenantId !== undefined && o.tenantId !== null && o.tenantId !== '')
  @IsUUID()
  @IsOptional()
  tenantId?: string;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

/**
 * What PATCH /residents/:id accepts. There is no email: it is the person's
 * platform identity, not a building's to change, so the global whitelist strips
 * it. unit and isActive change the resident membership in the targeted
 * building only; firstName, lastName and phone belong to the person (who may
 * be in other buildings too) and only a platform admin may change them.
 */
export class UpdateResidentDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  firstName?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  lastName?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  unit?: string;

  @ApiPropertyOptional({
    description:
      'Accepted only when it names the building the row already belongs to: residents are not moved between buildings.',
  })
  @ValidateIf((o) => o.tenantId !== undefined && o.tenantId !== null && o.tenantId !== '')
  @IsUUID()
  @IsOptional()
  tenantId?: string;

  @ApiPropertyOptional({ description: 'The status of the resident membership in this building.' })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

/**
 * Names the building a GET/PATCH/DELETE /residents/:id acts on. A building
 * admin never needs it; a platform admin passes it when the person is a
 * resident of several buildings.
 */
export class ResidentTargetQueryDto {
  @ApiPropertyOptional({
    description:
      'Super admin only: the building whose resident row this is. Optional when the person is a resident of exactly one building.',
  })
  @IsOptional()
  @IsUUID()
  tenantId?: string;
}

export class ResidentQueryDto {
  @ApiPropertyOptional({ description: 'Search by name or email' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ description: 'Filter by tenant ID (super admin only)' })
  @IsOptional()
  @IsUUID()
  tenantId?: string;

  @ApiPropertyOptional({ description: 'Filter by status: active or inactive' })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ description: 'Page number', default: 1 })
  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @IsNumber()
  page?: number;

  @ApiPropertyOptional({ description: 'Items per page', default: 10 })
  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @IsNumber()
  limit?: number;
}
