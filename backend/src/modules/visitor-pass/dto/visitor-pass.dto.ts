import { IsString, IsOptional, IsEnum, IsDateString, IsBoolean, IsNumber, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VisitorPassStatus } from '@database/entities/visitor-pass.entity';

export enum ValidityType {
  SINGLE_USE = 'single_use',
  TWENTY_FOUR_HOURS = '24_hours',
  ONE_WEEK = '1_week',
  CUSTOM = 'custom',
}

export class CreateVisitorPassDto {
  @ApiProperty({ description: 'Visitor name' })
  @IsString()
  visitorName: string;

  @ApiPropertyOptional({ description: 'Visitor phone number (required for WhatsApp)' })
  @IsString()
  @IsOptional()
  visitorPhone?: string;

  @ApiPropertyOptional({ description: 'Visitor email (required for email notification)' })
  @IsString()
  @IsOptional()
  visitorEmail?: string;

  @ApiPropertyOptional({ description: 'Purpose of visit' })
  @IsString()
  @IsOptional()
  purpose?: string;

  @ApiPropertyOptional({ description: 'Host unit number' })
  @IsString()
  @IsOptional()
  hostUnit?: string;

  @ApiProperty({ enum: ValidityType, description: 'Type of validity period' })
  @IsEnum(ValidityType)
  validityType: ValidityType;

  @ApiPropertyOptional({ description: 'Custom validity start date (required for CUSTOM type)' })
  @IsDateString()
  @IsOptional()
  customValidFrom?: string;

  @ApiPropertyOptional({ description: 'Custom validity end date (required for CUSTOM type)' })
  @IsDateString()
  @IsOptional()
  customValidUntil?: string;

  @ApiPropertyOptional({ description: 'Maximum number of uses (for CUSTOM type)', default: 1 })
  @IsNumber()
  @IsOptional()
  @Min(1)
  @Max(100)
  customMaxUses?: number;

  @ApiPropertyOptional({ description: 'Send notification via email', default: false })
  @IsBoolean()
  @IsOptional()
  sendEmail?: boolean;

  @ApiPropertyOptional({ description: 'Send notification via WhatsApp', default: false })
  @IsBoolean()
  @IsOptional()
  sendWhatsApp?: boolean;
}

export class UpdateVisitorPassDto {
  @ApiPropertyOptional({ enum: VisitorPassStatus, description: 'Pass status' })
  @IsEnum(VisitorPassStatus)
  @IsOptional()
  status?: VisitorPassStatus;

  @ApiPropertyOptional({ description: 'Visitor name' })
  @IsString()
  @IsOptional()
  visitorName?: string;

  @ApiPropertyOptional({ description: 'Visitor phone number' })
  @IsString()
  @IsOptional()
  visitorPhone?: string;

  @ApiPropertyOptional({ description: 'Visitor email' })
  @IsString()
  @IsOptional()
  visitorEmail?: string;

  @ApiPropertyOptional({ description: 'Purpose of visit' })
  @IsString()
  @IsOptional()
  purpose?: string;
}

export class VisitorPassQueryDto {
  @ApiPropertyOptional({ description: 'Filter by status' })
  @IsEnum(VisitorPassStatus)
  @IsOptional()
  status?: VisitorPassStatus;

  @ApiPropertyOptional({ description: 'Start date filter' })
  @IsDateString()
  @IsOptional()
  startDate?: string;

  @ApiPropertyOptional({ description: 'End date filter' })
  @IsDateString()
  @IsOptional()
  endDate?: string;
}
