import { IsOptional, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Optional body of POST /resident-join/leave.
 *
 * With the membership context on, the building a resident leaves is the one
 * the request acts in (the X-Gate-Membership header), and this body is
 * ignored: a body naming a building is exactly the kind of second source of
 * truth the header replaces. It is read only in legacy mode
 * (GATE_MEMBERSHIP_CONTEXT off), where it may name the caller's own building;
 * leaving still requires a resident membership there, so it can never act on
 * anyone else's.
 */
export class LeaveBuildingDto {
  @ApiPropertyOptional({
    example: '5f9c1b3e-4a2d-4c8e-9b1a-0d2e3f4a5b6c',
    description: 'Legacy mode only: the building to leave. Ignored when a building is chosen.',
  })
  @IsUUID()
  @IsOptional()
  tenantId?: string;
}
