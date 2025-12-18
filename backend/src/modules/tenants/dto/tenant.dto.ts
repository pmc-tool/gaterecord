import { IsString, IsEmail, IsEnum, IsOptional, IsUUID, IsDateString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { TenantStatus } from '@database/entities/tenant.entity';

export class CreateTenantDto {
  @ApiProperty({ example: 'Sunrise Apartments' })
  @IsString()
  name: string;

  @ApiProperty({ example: 'sunrise-apartments' })
  @IsString()
  slug: string;

  @ApiProperty({ example: 'contact@sunrise.com' })
  @IsEmail()
  contactEmail: string;

  @ApiPropertyOptional({ example: '+1234567890' })
  @IsString()
  @IsOptional()
  contactPhone?: string;

  @ApiPropertyOptional({ example: '123 Main Street' })
  @IsString()
  @IsOptional()
  address?: string;

  @ApiProperty()
  @IsUUID()
  subscriptionPlanId: string;

  @ApiProperty({ example: 'admin@sunrise.com' })
  @IsEmail()
  adminEmail: string;

  @ApiProperty({ example: 'John' })
  @IsString()
  adminFirstName: string;

  @ApiProperty({ example: 'Doe' })
  @IsString()
  adminLastName: string;
}

export class UpdateTenantDto extends PartialType(CreateTenantDto) {
  @ApiPropertyOptional({ enum: TenantStatus })
  @IsEnum(TenantStatus)
  @IsOptional()
  status?: TenantStatus;

  @ApiPropertyOptional()
  @IsDateString()
  @IsOptional()
  subscriptionExpiresAt?: string;
}

export class CreateSubscriptionPlanDto {
  @ApiProperty({ example: 'Basic' })
  @IsString()
  name: string;

  @ApiProperty({ example: 3 })
  maxGates: number;

  @ApiProperty({ example: 50 })
  maxUsers: number;

  @ApiProperty({ example: 30 })
  logRetentionDays: number;

  @ApiPropertyOptional()
  @IsOptional()
  features?: {
    simulator_access?: boolean;
    csv_export?: boolean;
    api_access?: boolean;
    custom_branding?: boolean;
  };
}

export class TenantResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  slug: string;

  @ApiProperty()
  contactEmail: string;

  @ApiPropertyOptional()
  contactPhone?: string;

  @ApiPropertyOptional()
  address?: string;

  @ApiProperty({ enum: TenantStatus })
  status: TenantStatus;

  @ApiProperty()
  subscriptionPlanId: string;

  @ApiPropertyOptional()
  subscriptionExpiresAt?: Date;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
