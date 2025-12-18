import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { UserRole } from '@database/entities/user.entity';

@Injectable()
export class TenantGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    const tenantId = request.params.tenantId || request.body.tenantId;

    if (!user) {
      throw new ForbiddenException('Access denied');
    }

    // Super admin can access any tenant
    if (user.role === UserRole.SUPER_ADMIN) {
      return true;
    }

    // For other roles, check if they belong to the requested tenant
    if (tenantId && user.tenantId !== tenantId) {
      throw new ForbiddenException('Access denied to this tenant');
    }

    return true;
  }
}
