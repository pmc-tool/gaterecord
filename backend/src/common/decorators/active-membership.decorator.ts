import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Membership } from '@database/entities/membership.entity';
import { isActingUser } from '../context/acting-user';

/**
 * The membership the request acts as, or null outside the 'membership' context
 * (platform, none, legacy mode, unauthenticated).
 *
 * Prefer the overlaid fields of @CurrentUser() (role, tenantId, unit) and
 * assertBuildingContext() for scoping; use this only when the membership row
 * itself is needed, for example its id.
 */
export const ActiveMembership = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Membership | null => {
    const request = ctx.switchToHttp().getRequest();
    const user = request?.user;

    return isActingUser(user) ? (user.activeMembership ?? null) : null;
  },
);
