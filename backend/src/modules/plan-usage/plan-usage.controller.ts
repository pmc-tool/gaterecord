import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '@common/guards/jwt-auth.guard';
import { RolesGuard } from '@common/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { SubscriptionExempt } from '@common/decorators/subscription-exempt.decorator';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { User, UserRole } from '@database/entities/user.entity';
import { PlanUsageService } from './plan-usage.service';

/**
 * Live plan usage for the caller's tenant: used vs limit for each metered
 * resource. Drives the billing page's usage meters and the "upgrade to add more"
 * CTAs.
 *
 * @SubscriptionExempt: a SUSPENDED tenant must be able to SEE their usage to
 * decide to upgrade, so this read must survive read-only mode.
 */
@ApiTags('Billing')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
@SubscriptionExempt()
@Controller('billing/usage')
export class PlanUsageController {
  constructor(private readonly planUsageService: PlanUsageService) {}

  @Get()
  @ApiOperation({ summary: "Current plan usage vs limits for the caller's tenant" })
  async getUsage(@CurrentUser() user: User) {
    return this.planUsageService.getUsage(user);
  }
}
