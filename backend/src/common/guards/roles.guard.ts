import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { UserRole } from '@database/entities/user.entity';

/**
 * @Roles(...) enforcement (applied per controller / handler, not globally).
 *
 * It compares the required roles with req.user.role, which is the OVERLAID role:
 * the role held in the building the request acts in (the membership chosen with
 * X-Gate-Membership), 'super_admin' in the Platform context, and the gate_users
 * row's role in legacy mode (GATE_MEMBERSHIP_CONTEXT off). So one person is a
 * building admin in Tower A and only a resident in Tower B, and @Roles sees
 * whichever the request acts as.
 *
 * A null role (the 'none' context, reachable only on @ContextOptional routes)
 * matches nothing and is denied. No logic changed with memberships; only what
 * req.user.role means did.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest();

    if (!user) {
      throw new ForbiddenException('Access denied');
    }

    const hasRole = requiredRoles.some((role) => user.role === role);

    if (!hasRole) {
      throw new ForbiddenException('Insufficient permissions');
    }

    return true;
  }
}
