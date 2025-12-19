import { IsString, IsEmail, IsEnum, IsOptional, IsUUID, IsDateString, IsNumber, IsBoolean, IsObject } from 'class-validator';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { TenantStatus, BillingCycle } from '@database/entities/tenant.entity';

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
  @ApiProperty({ example: 'Professional' })
  @IsString()
  name: string;

  @ApiPropertyOptional({ example: 'Perfect for medium-sized buildings' })
  @IsString()
  @IsOptional()
  description?: string;

  // Pricing
  @ApiProperty({ example: 49.99 })
  @IsNumber()
  monthlyPrice: number;

  @ApiProperty({ example: 499.99 })
  @IsNumber()
  yearlyPrice: number;

  // Discount
  @ApiPropertyOptional({ example: 15 })
  @IsNumber()
  @IsOptional()
  discountPercent?: number;

  @ApiPropertyOptional({ example: 'Save 15%' })
  @IsString()
  @IsOptional()
  discountLabel?: string;

  @ApiPropertyOptional()
  @IsDateString()
  @IsOptional()
  discountValidUntil?: string;

  // Trial
  @ApiPropertyOptional({ example: 14 })
  @IsNumber()
  @IsOptional()
  trialDays?: number;

  @ApiPropertyOptional({ example: false })
  @IsBoolean()
  @IsOptional()
  trialRequiresCard?: boolean;

  // Limits
  @ApiProperty({ example: 5 })
  @IsNumber()
  maxGates: number;

  @ApiProperty({ example: 100 })
  @IsNumber()
  maxUsers: number;

  @ApiPropertyOptional({ example: 200 })
  @IsNumber()
  @IsOptional()
  maxVehicles?: number;

  @ApiPropertyOptional({ example: 100 })
  @IsNumber()
  @IsOptional()
  maxVisitorPassesPerMonth?: number;

  @ApiProperty({ example: 90 })
  @IsNumber()
  logRetentionDays: number;

  // Features
  @ApiPropertyOptional()
  @IsObject()
  @IsOptional()
  features?: {
    simulator_access?: boolean;
    csv_export?: boolean;
    api_access?: boolean;
    custom_branding?: boolean;
    priority_support?: boolean;
    advanced_analytics?: boolean;
    multi_building?: boolean;
    webhook_notifications?: boolean;
  };

  // Display settings
  @ApiPropertyOptional({ example: 1 })
  @IsNumber()
  @IsOptional()
  displayOrder?: number;

  @ApiPropertyOptional({ example: 'Popular' })
  @IsString()
  @IsOptional()
  badge?: string;

  @ApiPropertyOptional({ example: 'blue' })
  @IsString()
  @IsOptional()
  badgeColor?: string;

  @ApiPropertyOptional({ example: true })
  @IsBoolean()
  @IsOptional()
  isFeatured?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsBoolean()
  @IsOptional()
  isPublic?: boolean;
}

export class UpdateSubscriptionPlanDto extends PartialType(CreateSubscriptionPlanDto) {}

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
