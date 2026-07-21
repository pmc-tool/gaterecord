import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { OnboardingService } from './onboarding.service';
import { CreateBuildingDto } from './dto/create-building.dto';
import { UpdateBuildingDto } from './dto/update-building.dto';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { SubscriptionExempt } from '@common/decorators/subscription-exempt.decorator';
import { User } from '@database/entities/user.entity';

/**
 * The "Get Started" flow.
 *
 * Both routes are authenticated: they rely on the global JwtAuthGuard registered
 * as APP_GUARD in app.module.ts and are deliberately NOT marked @Public(). They
 * are, however, reachable by a user with tenantId=null, which is what makes them
 * the only usable endpoints for a freshly provisioned building admin.
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
  @ApiOperation({
    summary: 'Check whether the current user still needs to create a building',
  })
  @ApiResponse({
    status: 200,
    description: 'Onboarding state plus the available subscription plans',
  })
  async getStatus(@CurrentUser() user: User) {
    return this.onboardingService.getStatus(user.id);
  }

  @Post('building')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create the current user\'s building (once-only)' })
  @ApiResponse({ status: 201, description: 'Building created and linked to the user' })
  @ApiResponse({ status: 400, description: 'No subscription plans available' })
  @ApiResponse({ status: 409, description: 'Already onboarded, or building name taken' })
  async createBuilding(@CurrentUser() user: User, @Body() dto: CreateBuildingDto) {
    return this.onboardingService.createBuilding(user.id, dto);
  }

  @Patch('building')
  @ApiOperation({ summary: "Update the current user's own building details" })
  @ApiResponse({ status: 200, description: 'Building updated' })
  @ApiResponse({ status: 403, description: 'Not a building admin' })
  @ApiResponse({ status: 409, description: 'Not onboarded, or building name taken' })
  async updateBuilding(@CurrentUser() user: User, @Body() dto: UpdateBuildingDto) {
    return this.onboardingService.updateBuilding(user.id, dto);
  }
}
