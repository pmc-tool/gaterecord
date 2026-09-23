import { IsInt, IsOptional, IsString, MaxLength, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Query for the building picker a would-be resident uses.
 *
 * `limit` is capped rather than free-form: the endpoint is reachable by any
 * authenticated user, so an uncapped page size would turn it into a bulk export
 * of every building on the platform.
 */
export class SearchBuildingsDto {
  @ApiPropertyOptional({ example: 'nasir', description: 'Matches building name or address' })
  @IsString()
  @IsOptional()
  @MaxLength(120)
  q?: string;

  @ApiPropertyOptional({ example: 20, minimum: 1, maximum: 50, default: 20 })
  @IsInt()
  @IsOptional()
  @Min(1)
  @Max(50)
  limit?: number;
}
