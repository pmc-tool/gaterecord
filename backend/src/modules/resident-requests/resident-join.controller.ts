import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';

import { CurrentUser } from '@common/decorators/current-user.decorator';
import { SubscriptionExempt } from '@common/decorators/subscription-exempt.decorator';
import { ContextOptional, ContextRequired } from '@common/decorators/context-optional.decorator';
import { User } from '@database/entities/user.entity';

import { BuildingStructureService } from '@modules/building-structure/building-structure.service';

import { ResidentRequestsService } from './resident-requests.service';
import { CreateJoinRequestDto } from './dto/create-join-request.dto';
import { LeaveBuildingDto } from './dto/leave-building.dto';
import { SearchBuildingsDto } from './dto/search-buildings.dto';

/**
 * The requester's half of resident self-signup — the counterpart to
 * OnboardingController, for the person who wants to JOIN a building rather than
 * create one. That may be a brand-new user with no building at all or, with
 * GATE_MEMBERSHIP_CONTEXT on, someone who already holds roles elsewhere: the
 * admin of Tower A may ask to be a resident of Tower B.
 *
 * Deliberately carries no @Roles: a person with no building has no role in any
 * building (the 'none' context, role null), and requiring one here would lock
 * out the only people who need these routes. RolesGuard is not registered
 * globally, so omitting the decorator leaves the endpoints open to any
 * *authenticated* user, which is the intent — hence the deliberately narrow
 * projection in searchBuildings. Who may do what is decided in
 * ResidentRequestsService, from the person's memberships.
 *
 * @SubscriptionExempt mirrors OnboardingController: these callers have no tenant
 * at all, and SubscriptionGuard must not stand between them and the only routes
 * that can give them one.
 */
@ApiTags('Resident Join')
@ApiBearerAuth()
@Controller('resident-join')
@SubscriptionExempt()
// Joining is a person-level flow: every route works before (or without) a
// chosen building, except POST leave below, which is @ContextRequired.
@ContextOptional()
export class ResidentJoinController {
  constructor(
    private readonly residentRequestsService: ResidentRequestsService,
    private readonly buildingStructureService: BuildingStructureService,
  ) {}

  @Get('buildings')
  @ApiOperation({ summary: 'Search buildings to request joining as a resident' })
  @ApiResponse({
    status: 200,
    description:
      'Matching buildings (id, name, slug, address only), except those the caller has a role in',
  })
  @ApiResponse({
    status: 403,
    description: 'Caller already belongs to a building (only while multi-building is off)',
  })
  async searchBuildings(@CurrentUser() user: User, @Query() query: SearchBuildingsDto) {
    return this.residentRequestsService.searchBuildings(user, query);
  }

  @Get('buildings/:tenantId/floors')
  @ApiOperation({ summary: "A building's floors and flats, to pick your flat when requesting" })
  @ApiResponse({ status: 200, description: 'Floor and flat names only (no occupancy)' })
  @ApiResponse({
    status: 403,
    description: 'Caller already belongs to a building (only while multi-building is off)',
  })
  @ApiResponse({ status: 404, description: 'Building not found' })
  @ApiResponse({
    status: 409,
    description: 'MEMBERSHIP_EXISTS: the caller already has a role there',
  })
  async getFloorPlan(
    @CurrentUser() user: User,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
  ) {
    // 404 for an unknown building, 409 MEMBERSHIP_EXISTS when the caller
    // already has a role there, and the legacy 403 with multi-building off.
    return this.buildingStructureService.getJoinFloorPlan(user, tenantId);
  }

  @Get('request')
  @ApiOperation({ summary: "Get the caller's own latest join request, or null" })
  @ApiResponse({ status: 200, description: 'The latest request, or null if none was ever made' })
  async getMyRequest(@CurrentUser() user: User) {
    return this.residentRequestsService.getMyRequest(user);
  }

  @Get('requests')
  @ApiOperation({ summary: "The caller's own join requests, newest first" })
  @ApiResponse({
    status: 200,
    description: 'Pending and declined requests, and approved ones while still a resident there',
  })
  async listMyRequests(@CurrentUser() user: User) {
    return this.residentRequestsService.listMyRequests(user);
  }

  @Post('request')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Ask a building admin to admit you as a resident' })
  @ApiResponse({ status: 201, description: 'Request submitted and awaiting review' })
  @ApiResponse({ status: 404, description: 'Building not found' })
  @ApiResponse({ status: 403, description: 'ACCOUNT_SUSPENDED' })
  @ApiResponse({
    status: 409,
    description:
      'MEMBERSHIP_EXISTS (already a role there), JOIN_REQUEST_PENDING (already waiting for that building), too many requests waiting, or MULTI_MEMBERSHIP_DISABLED',
  })
  async createRequest(@CurrentUser() user: User, @Body() dto: CreateJoinRequestDto) {
    return this.residentRequestsService.createRequest(user.id, dto);
  }

  @Delete('request')
  @ApiOperation({ summary: 'Withdraw the pending request so another building can be chosen' })
  @ApiResponse({ status: 200, description: 'Request cancelled' })
  @ApiResponse({ status: 400, description: 'Several requests are waiting: cancel one by id' })
  @ApiResponse({ status: 404, description: 'No request awaiting review' })
  async cancelMyRequest(@CurrentUser() user: User) {
    return this.residentRequestsService.cancelMyRequest(user.id);
  }

  @Delete('request/:id')
  @ApiOperation({ summary: 'Withdraw one of your pending requests' })
  @ApiResponse({ status: 200, description: 'Request cancelled' })
  @ApiResponse({ status: 404, description: 'No such request of yours awaiting review' })
  async cancelMyRequestById(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.residentRequestsService.cancelMyRequest(user.id, id);
  }

  /**
   * The resident's own way out, and the counterpart to createRequest. Exempt
   * from SubscriptionGuard with the rest of this controller, so a resident can
   * leave even while the building's subscription is suspended.
   */
  @Post('leave')
  // Acts in the chosen building (it ends the resident membership the request
  // acts as), so it needs a context; and stays exempt on its own account.
  @ContextRequired()
  @SubscriptionExempt()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Leave your building: releases your cards and vehicles, keeps your account',
  })
  @ApiResponse({
    status: 204,
    description: 'No longer a resident there; the account and any other buildings are kept',
  })
  @ApiResponse({ status: 400, description: 'The role chosen in that building is not resident' })
  @ApiResponse({ status: 409, description: 'Not currently a resident of that building' })
  async leaveBuilding(@CurrentUser() user: User, @Body() dto: LeaveBuildingDto) {
    // The resident membership the request acts as (the header); dto.tenantId is
    // read only in legacy mode.
    await this.residentRequestsService.leaveBuilding(user, dto ?? {});
  }
}
