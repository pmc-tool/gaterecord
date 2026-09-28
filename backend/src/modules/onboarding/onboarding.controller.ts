import { Controller, Get, Post, Patch, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { OnboardingService } from './onboarding.service';
import { CreateBuildingDto, OnboardingStatusDto } from './dto/create-building.dto';
import { UpdateBuildingDto } from './dto/update-building.dto';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { SubscriptionExempt } from '@common/decorators/subscription-exempt.decorator';
import { ContextOptional } from '@common/decorators/context-optional.decorator';
import { ActingUser } from '@common/context/acting-user';

/**
 * The "Get Started" flow.
 *
 * Both routes are authenticated: they rely on the global JwtAuthGuard registered
 * as APP_GUARD in app.module.ts and are deliberately NOT marked @Public(). GET
 * status and POST building are reachable before any building is chosen (and by
 * a person with none at all), which is what makes them the only usable
 * endpoints for a freshly provisioned person. The service receives the acting
 * principal: the person's id for person-level questions, the overlay for the
 * building the request acts in.
 */
@ApiTags('Onboarding')
@ApiBearerAuth()
@Controller('onboarding')
// Creating/fixing the building is part of recovery: a suspended tenant admin
// must be able to POST/PATCH here to correct their setup, so the controller is
// exempt from the SubscriptionGuard. (GET status is a read and would pass anyway.)
@SubscriptionExempt()
export class OnboardingController {
  constructor(private readonly onboardingService: OnboardingService) {}

  @Get('status')
  // Person-level: answers "do I still need a building?" before any is chosen.
  @ContextOptional()
  @ApiOperation({
    summary: 'Check whether the current user still needs to create a building',
  })
  @ApiResponse({
    status: 200,
    description: 'Onboarding state plus the available subscription plans',
    type: OnboardingStatusDto,
  })
  async getStatus(@CurrentUser() user: ActingUser) {
    return this.onboardingService.getStatus(user);
  }

  @Post('building')
  // Creates a building; the caller does not act in one yet. PATCH below stays
  // context-required: it edits the building the request acts in.
  @ContextOptional()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a building and become its building admin',
  })
  @ApiResponse({
    status: 201,
    description: 'Building created; membershipId is the new building_admin membership',
  })
  @ApiResponse({ status: 400, description: 'No subscription plans available' })
  @ApiResponse({
    status: 403,
    description: 'BUILDING_LIMIT_REACHED or BUILDING_CREATION_NOT_ALLOWED (creation policy)',
  })
  @ApiResponse({
    status: 409,
    description: 'Building name taken, or MULTI_MEMBERSHIP_DISABLED (already has a building)',
  })
  async createBuilding(@CurrentUser() user: ActingUser, @Body() dto: CreateBuildingDto) {
    return this.onboardingService.createBuilding(user, dto);
  }

  @Patch('building')
  @ApiOperation({ summary: 'Update the details of the building you act in, as its admin' })
  @ApiResponse({ status: 200, description: 'Building updated' })
  @ApiResponse({ status: 403, description: 'Not a building admin of the building acted in' })
  @ApiResponse({ status: 409, description: 'No building chosen, or building name taken' })
  async updateBuilding(@CurrentUser() user: ActingUser, @Body() dto: UpdateBuildingDto) {
    return this.onboardingService.updateBuilding(user, dto);
  }
}
