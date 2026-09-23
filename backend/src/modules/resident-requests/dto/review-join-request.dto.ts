import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * The admin's decision payload. Shared by approve and reject: on approval the
 * note is an optional internal remark, on rejection it is the reason shown back
 * to the requester.
 */
export class ReviewJoinRequestDto {
  @ApiPropertyOptional({ example: 'Not a tenant of this building.' })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  decisionNote?: string;
}
