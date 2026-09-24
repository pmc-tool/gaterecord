import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';

import { CurrentUser } from '@common/decorators/current-user.decorator';
import { SubscriptionExempt } from '@common/decorators/subscription-exempt.decorator';
import { User } from '@database/entities/user.entity';

import { ResidentRemovalService } from '@modules/residents/resident-removal.service';

import { ResidentRequestsService } from './resident-requests.service';
import { CreateJoinRequestDto } from './dto/create-join-request.dto';
import { SearchBuildingsDto } from './dto/search-buildings.dto';

/**
 * The requester's half of resident self-signup — the counterpart to
 * OnboardingController, for the user who wants to JOIN a building rather than
 * create one.
 *
 * Deliberately carries no @Roles: the caller is a freshly provisioned user with
 * role=building_admin and tenantId=null (that is what identity provisioning
 * gives everyone), and requiring a role here would lock out the only people who
 * need these routes. RolesGuard is not registered globally, so omitting the
 * decorator leaves the endpoints open to any *authenticated* user, which is the
 * intent — hence the deliberately narrow projection in searchBuildings.
 *
 * @SubscriptionExempt mirrors OnboardingController: these callers have no tenant
 * at all, and SubscriptionGuard must not stand between them and the only routes
 * that can give them one.
 */
@ApiTags('Resident Join')
@ApiBearerAuth()
@Controller('resident-join')
@SubscriptionExempt()
export class ResidentJoinController {
  constructor(
    private readonly residentRequestsService: ResidentRequestsService,
    private readonly residentRemovalService: ResidentRemovalService,
  ) {}

  @Get('buildings')
  @ApiOperation({ summary: 'Search buildings to request joining as a resident' })
  @ApiResponse({ status: 200, description: 'Matching buildings (id, name, slug, address only)' })
  @ApiResponse({ status: 403, description: 'Caller already belongs to a building' })
  async searchBuildings(@CurrentUser() user: User, @Query() query: SearchBuildingsDto) {
    return this.residentRequestsService.searchBuildings(user, query);
  }

  @Get('request')
  @ApiOperation({ summary: "Get the caller's own latest join request, or null" })
  @ApiResponse({ status: 200, description: 'The latest request, or null if none was ever made' })
  async getMyRequest(@CurrentUser() user: User) {
    return this.residentRequestsService.getMyRequest(user);
  }

  @Post('request')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Ask a building admin to admit you as a resident' })
  @ApiResponse({ status: 201, description: 'Request submitted and awaiting review' })
  @ApiResponse({ status: 404, description: 'Building not found' })
  @ApiResponse({
    status: 409,
    description: 'Already in a building, or a request is already pending',
  })
  async createRequest(@CurrentUser() user: User, @Body() dto: CreateJoinRequestDto) {
    return this.residentRequestsService.createRequest(user.id, dto);
  }

  @Delete('request')
  @ApiOperation({ summary: 'Withdraw the pending request so another building can be chosen' })
  @ApiResponse({ status: 200, description: 'Request cancelled' })
  @ApiResponse({ status: 404, description: 'No request awaiting review' })
  async cancelMyRequest(@CurrentUser() user: User) {
    return this.residentRequestsService.cancelMyRequest(user.id);
  }

  /**
   * The resident's own way out, and the counterpart to createRequest. Exempt
   * from SubscriptionGuard with the rest of this controller, so a resident can
   * leave even while the building's subscription is suspended.
   */
  @Post('leave')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Leave your building: releases your cards and vehicles, keeps your account',
  })
  @ApiResponse({ status: 204, description: 'You are now a new gate-management user' })
  @ApiResponse({ status: 409, description: 'Not currently a resident of any building' })
  async leaveBuilding(@CurrentUser() user: User) {
    await this.residentRemovalService.removeFromBuilding(user.id);
  }
}
