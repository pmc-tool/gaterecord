import { IsEnum, IsOptional, IsDateString, IsUUID, IsInt, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  AccessMethod,
  AccessResult,
  AccessSubjectType,
} from '@database/entities/access-event.entity';

export class AccessEventQueryDto {
  @ApiPropertyOptional({ description: 'Filter by tenant ID (super admin only)' })
  @IsUUID()
  @IsOptional()
  tenantId?: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  gateId?: string;

  @ApiPropertyOptional({ enum: AccessMethod })
  @IsEnum(AccessMethod)
  @IsOptional()
  method?: AccessMethod;

  @ApiPropertyOptional({ enum: AccessSubjectType })
  @IsEnum(AccessSubjectType)
  @IsOptional()
  subjectType?: AccessSubjectType;

  @ApiPropertyOptional({ enum: AccessResult })
  @IsEnum(AccessResult)
  @IsOptional()
  result?: AccessResult;

  @ApiPropertyOptional()
  @IsDateString()
  @IsOptional()
  startDate?: string;

  @ApiPropertyOptional()
  @IsDateString()
  @IsOptional()
  endDate?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit?: number;
}

export class AccessEventResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  gateId: string;

  @ApiProperty()
  gateName: string;

  @ApiProperty()
  timestamp: Date;

  @ApiProperty({ enum: AccessMethod })
  method: AccessMethod;

  @ApiProperty({ enum: AccessSubjectType })
  subjectType: AccessSubjectType;

  @ApiPropertyOptional()
  subjectId?: string;

  @ApiPropertyOptional()
  subjectIdentifier?: string;

  @ApiPropertyOptional()
  subjectName?: string;

  @ApiProperty({ enum: AccessResult })
  result: AccessResult;

  @ApiPropertyOptional()
  denialReason?: string;

  @ApiPropertyOptional()
  operatorName?: string;
}

export class AccessEventStatsDto {
  @ApiProperty()
  totalEvents: number;

  @ApiProperty()
  allowedCount: number;

  @ApiProperty()
  deniedCount: number;

  @ApiProperty()
  byMethod: Record<string, number>;

  @ApiProperty()
  byGate: Record<string, { name: string; count: number }>;
}
