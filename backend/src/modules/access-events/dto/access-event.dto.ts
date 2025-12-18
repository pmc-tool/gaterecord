import { IsEnum, IsOptional, IsDateString, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AccessMethod, AccessResult, AccessSubjectType } from '@database/entities/access-event.entity';

export class AccessEventQueryDto {
  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  gateId?: string;

  @ApiPropertyOptional({ enum: AccessMethod })
  @IsEnum(AccessMethod)
  @IsOptional()
  method?: AccessMethod;

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

  @ApiPropertyOptional({ default: 1 })
  page?: number;

  @ApiPropertyOptional({ default: 20 })
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
