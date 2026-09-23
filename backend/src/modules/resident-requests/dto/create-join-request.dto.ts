import { IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * What a user submits to ask a building's admin to admit them as a resident.
 *
 * Every property carries a class-validator decorator on purpose: the global
 * ValidationPipe runs with whitelist:true, so an undecorated field is silently
 * stripped and would arrive as undefined with no error.
 */
export class CreateJoinRequestDto {
  @ApiProperty({ example: '5f9c1b3e-4a2d-4c8e-9b1a-0d2e3f4a5b6c' })
  @IsUUID()
  @IsNotEmpty()
  tenantId: string;

  @ApiPropertyOptional({ example: '4B', description: 'Apartment / flat number' })
  @IsString()
  @IsOptional()
  @MaxLength(60)
  unit?: string;

  @ApiPropertyOptional({ example: '+8801712345678' })
  @IsString()
  @IsOptional()
  @MaxLength(30)
  phone?: string;

  @ApiPropertyOptional({ example: 'Moved in March, owner is Mr Rahman.' })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  note?: string;
}
