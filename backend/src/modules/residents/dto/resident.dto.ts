import {
  IsString,
  IsEmail,
  IsOptional,
  IsBoolean,
  IsUUID,
  ValidateIf,
  IsNumber,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

/**
 * What POST /residents accepts. There is no password: a NEW account starts with
 * the configured default (GATE_DEFAULT_USER_PASSWORD) and should change it; an
 * existing account keeps its own. A password in the body is stripped by the
 * global whitelist (forbidNonWhitelisted is off, so older clients still work).
 */
export class CreateResidentDto {
  @ApiProperty()
  @IsString()
  firstName: string;

  @ApiProperty()
  @IsString()
  lastName: string;

  @ApiProperty({
    description:
      'A new email gets an account with the default starting password, emailed to them; ' +
      'an email that already has an account keeps its password and is only added here.',
  })
  @IsEmail()
  email: string;

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
