/**
 * SubscriptionGuard — enforces tenant.status on write operations, and nothing else.
 *
 * FAIL-OPEN BY DESIGN. This guard is meant to run on EVERY authenticated request
 * (wired as an APP_GUARD alongside JwtAuthGuard). A false positive here would lock a
 * paying customer out of their own account, so it blocks ONLY when it is certain the
 * tenant is inactive. In every other case — active / trial tenants, a null or unknown
 * status, super admins, users with no tenant yet, unauthenticated requests, and
 * @Public() / @SubscriptionExempt() routes — it returns true and gets out of the way.
 * When in doubt, allow.
 *
 * When a tenant IS inactive (SUSPENDED, PENDING_PAYMENT, or is_paused === true) it
 * applies READ-ONLY GRACE: safe methods (GET / HEAD / OPTIONS) still pass, so the
 * customer can log in, read their data, and reach billing to pay; every other method
 * (POST / PUT / PATCH / DELETE) is rejected with a stable HTTP 402 (Payment Required)
 * body.
 *
 * It never authenticates, authorizes by role, or touches the database: req.user and
 * its eagerly-loaded `tenant` relation are populated upstream by JwtAuthGuard. It
 * logs nothing, so no PII can leak through it.
 */
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { SUBSCRIPTION_EXEMPT_KEY } from '../decorators/subscription-exempt.decorator';
import { UserRole } from '@database/entities/user.entity';
import { TenantStatus } from '@database/entities/tenant.entity';

/**
 * Stable, machine-readable code returned in the 402 body. Exported so the frontend
 * and tests can match on it without hard-coding the string in more than one place.
 */
export const SUBSCRIPTION_INACTIVE_CODE = 'SUBSCRIPTION_INACTIVE';

/**
 * Read-only HTTP methods that are always permitted, even for an inactive tenant
 * (the READ-ONLY GRACE). Everything else is treated as a write/operation.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // (a) @Public() routes are exempt — mirrors JwtAuthGuard so the two agree on
    //     which routes are open.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    // (b) @SubscriptionExempt() routes (billing, onboarding) must work even while
    //     suspended, so the customer can recover.
    const isExempt = this.reflector.getAllAndOverride<boolean>(SUBSCRIPTION_EXEMPT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isExempt) {
      return true;
    }

    // `req?.` is deliberate: if this guard is ever reached outside a normal HTTP
    // context, getRequest() may be undefined. Reading through it must ALLOW (fail
    // open), never throw a 500 on a request that would otherwise have succeeded.
    const req = context.switchToHttp().getRequest();
    const user = req?.user;

    // (c) No authenticated user on the request => not this guard's decision.
    //     JwtAuthGuard has already allowed it (public path) or rejected it.
    if (!user) {
      return true;
    }

    // (d) Super admins are never subscription-gated.
    if (user.role === UserRole.SUPER_ADMIN) {
      return true;
    }

    // (e) No tenant yet (e.g. a freshly provisioned user, pre-onboarding). Gating
    //     that is not subscription's job.
    const tenant = user.tenant;
    if (!tenant) {
      return true;
    }

    // (f) Only an EXPLICITLY inactive tenant is gated. Anything else — ACTIVE, TRIAL,
    //     or a null / unknown status — falls through and is allowed.
    const isInactive =
      tenant.status === TenantStatus.SUSPENDED ||
      tenant.status === TenantStatus.PENDING_PAYMENT ||
      tenant.isPaused === true;
    if (!isInactive) {
      return true;
    }

    // (g) Inactive tenant: read-only grace for safe methods, 402 for writes.
    const method = String(req.method || '').toUpperCase();
    if (SAFE_METHODS.has(method)) {
      return true;
    }

    throw new HttpException(
      {
        code: SUBSCRIPTION_INACTIVE_CODE,
        status: tenant.status,
        message:
          'Your subscription is inactive. Read access remains available; please update your billing to restore full access.',
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}
