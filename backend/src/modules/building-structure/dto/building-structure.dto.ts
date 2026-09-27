import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Basements down to B10, up to a 300-storey tower. */
export const MIN_FLOOR_NUMBER = -10;
export const MAX_FLOOR_NUMBER = 300;
export const FLOOR_NAME_MAX_LENGTH = 60;
export const FLAT_NUMBER_MAX_LENGTH = 20;
/** Flats accepted in one "add flats" request. */
export const MAX_FLATS_PER_REQUEST = 50;

export class CreateFloorDto {
  @ApiProperty({ example: 4, description: '0 = ground floor, negative = basement' })
  @IsInt()
  @Min(MIN_FLOOR_NUMBER)
  @Max(MAX_FLOOR_NUMBER)
  floorNumber: number;

  @ApiPropertyOptional({ example: 'Fourth Floor' })
  @IsOptional()
  @IsString()
  @MaxLength(FLOOR_NAME_MAX_LENGTH)
  name?: string;
}

/** Floors created by one range request. */
export const MAX_FLOORS_PER_RANGE = 100;

export class CreateFloorRangeDto {
  @ApiProperty({ example: 1 })
  @IsInt()
  @Min(MIN_FLOOR_NUMBER)
  @Max(MAX_FLOOR_NUMBER)
  fromFloor: number;

  @ApiProperty({ example: 10 })
  @IsInt()
  @Min(MIN_FLOOR_NUMBER)
  @Max(MAX_FLOOR_NUMBER)
  toFloor: number;
}

export class UpdateFloorDto {
  @ApiPropertyOptional({ example: 4 })
  @IsOptional()
  @IsInt()
  @Min(MIN_FLOOR_NUMBER)
  @Max(MAX_FLOOR_NUMBER)
  floorNumber?: number;

  @ApiPropertyOptional({ example: 'Fourth Floor', description: 'Empty string or null clears it' })
  @IsOptional()
  @IsString()
  @MaxLength(FLOOR_NAME_MAX_LENGTH)
  name?: string | null;
}

export class AddFlatsDto {
  @ApiProperty({ example: ['4A', '4B', '4C'] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_FLATS_PER_REQUEST)
  @IsString({ each: true })
  @MaxLength(FLAT_NUMBER_MAX_LENGTH, { each: true })
  flatNumbers: string[];
}

export class UpdateFlatDto {
  @ApiPropertyOptional({ example: '4B' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(FLAT_NUMBER_MAX_LENGTH)
  flatNumber?: string;

  @ApiPropertyOptional({ description: 'Move the flat to another floor of the same building' })
  @IsOptional()
  @IsUUID()
  floorId?: string;
}
