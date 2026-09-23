import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';

import { JwtAuthGuard } from '@common/guards/jwt-auth.guard';
import { RolesGuard } from '@common/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { User, UserRole } from '@database/entities/user.entity';

import { ResidentRequestsService } from './resident-requests.service';
import { ListJoinRequestsDto } from './dto/list-join-requests.dto';
import { ReviewJoinRequestDto } from './dto/review-join-request.dto';

/**
 * The reviewer's half of resident self-signup: the queue a building admin works
 * through, backing the "Resident Requests" sidebar item.
 *
 * Scoping is enforced in the service, not by a guard — a building admin can only
 * see and decide requests for their own tenant, and an id belonging to another
 * building answers 404 rather than 403 so the queue cannot be probed.
 *
 * Deliberately NOT @SubscriptionExempt: approving seats a new resident, which is
 * the same class of write as creating one through /residents, and that path is
 * already blocked by SubscriptionGuard for a suspended or unpaid tenant. Reads
 * pass regardless, so the queue stays visible.
 */
@ApiTags('Resident Requests')
@ApiBearerAuth()
@Controller('resident-requests')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ResidentRequestsController {
  constructor(private readonly residentRequestsService: ResidentRequestsService) {}

  @Get()
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  @ApiOperation({ summary: "List resident join requests for the reviewer's building" })
  @ApiResponse({ status: 200, description: 'Requests, newest first' })
  async list(@CurrentUser() user: User, @Query() query: ListJoinRequestsDto) {
    return this.residentRequestsService.listForReviewer(user, query.status);
  }

  @Patch(':id/approve')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  @ApiOperation({ summary: 'Approve a request, making the requester a resident of the building' })
  @ApiResponse({ status: 200, description: 'Requester is now a resident' })
  @ApiResponse({ status: 400, description: 'Request is no longer pending' })
  @ApiResponse({ status: 403, description: 'Plan user limit reached' })
  @ApiResponse({ status: 404, description: 'Request not found, or not for this building' })
  @ApiResponse({ status: 409, description: 'Requester already belongs to a building' })
  async approve(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewJoinRequestDto,
  ) {
    return this.residentRequestsService.approve(user, id, dto);
  }

  @Patch(':id/reject')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  @ApiOperation({ summary: 'Decline a request, leaving the requester unchanged' })
  @ApiResponse({ status: 200, description: 'Request declined' })
  @ApiResponse({ status: 400, description: 'Request is no longer pending' })
  @ApiResponse({ status: 404, description: 'Request not found, or not for this building' })
  async reject(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewJoinRequestDto,
  ) {
    return this.residentRequestsService.reject(user, id, dto);
  }
}
