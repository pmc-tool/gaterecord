import { IsEnum, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { JoinRequestStatus } from '@database/entities/building-join-request.entity';

/** Filter for the admin review queue. Omitting `status` returns every request. */
export class ListJoinRequestsDto {
  @ApiPropertyOptional({ enum: JoinRequestStatus, example: JoinRequestStatus.PENDING })
  @IsEnum(JoinRequestStatus)
  @IsOptional()
  status?: JoinRequestStatus;
}
