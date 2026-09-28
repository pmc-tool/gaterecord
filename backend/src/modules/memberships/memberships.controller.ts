import { Controller, Get, NotFoundException } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { ContextOptional } from '@common/decorators/context-optional.decorator';
import { SubscriptionExempt } from '@common/decorators/subscription-exempt.decorator';
import { ActingUser } from '@common/context/acting-user';
import { isMembershipContextEnabled } from '@common/context/membership-flags';
import { MembershipsService } from './memberships.service';
import { MembershipsMeResponse } from './dto/memberships-me.response';

/**
 * The caller's own memberships, for the web's role -> building picker (C4).
 *
 * @ContextOptional: it is how a person with no chosen building (or a stale
 * X-Gate-Membership header) finds out what to choose, so it can never answer
 * 409 / 403 for a missing or invalid context; a stale header just gives
 * activeMembershipId = null. @SubscriptionExempt: a suspended building must
 * still be listed so its admin can reach billing (D6).
 *
 * While GATE_MEMBERSHIP_CONTEXT is off the route answers 404, which is how the
 * web knows to stay in its single-building (legacy) mode.
 */
@ApiTags('Memberships')
@ApiBearerAuth()
@Controller('memberships')
@ContextOptional()
@SubscriptionExempt()
export class MembershipsController {
  constructor(private readonly membershipsService: MembershipsService) {}

  @Get('me')
  @ApiOperation({ summary: 'List the roles and buildings the caller can act as' })
  @ApiResponse({ status: 200, type: MembershipsMeResponse })
  @ApiResponse({ status: 404, description: 'Multi-building memberships are not enabled' })
  async getMine(@CurrentUser() user: ActingUser): Promise<MembershipsMeResponse> {
    if (!isMembershipContextEnabled()) {
      throw new NotFoundException();
    }

    return this.membershipsService.getMine(user);
  }
}
