import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Self-service edit of the caller's OWN building.
 *
 * Deliberately narrow: only the details a building admin owns. Plan,
 * subscription state, status and Stripe fields are not editable here — those
 * move through billing or super-admin routes.
 */
export class UpdateBuildingDto {
  @ApiProperty({ example: 'Nasir Tower' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  buildingName: string;

  @ApiPropertyOptional({ example: '123 Main St, City' })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  buildingAddress?: string;
}
