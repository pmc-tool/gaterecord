/**
 * SubscriptionGuard — enforces tenant.status on write operations, and nothing else.
 *
 * FAIL-OPEN BY DESIGN for the legacy principal. This guard is meant to run on EVERY
 * authenticated request (wired as an APP_GUARD alongside JwtAuthGuard). A false
 * positive here would lock a paying customer out of their own account, so it blocks
 * ONLY when it is certain the tenant is inactive. In every other case — active /
 * trial tenants, a null or unknown status, super admins, users with no tenant yet,
 * unauthenticated requests, @Public() / @SubscriptionExempt() routes, and
 * @ContextOptional() routes for a membership-context principal — it returns true
 * and gets out of the way. When in doubt, allow.
 *
 * The tenant it looks at is the one the request ACTS in: req.user.tenant, which
 * is the active membership's building once GATE_MEMBERSHIP_CONTEXT is on (an
 * admin of suspended Tower A acting as security of active Tower C can write in
 * C; a resident writing in suspended Tower B gets 402), and the gate_users row's
 * tenant in legacy mode, exactly as before. With a membership context the guard
 * fails CLOSED instead of open on a missing building: "no tenant" there can only
 * mean no context was chosen, which is not a reason to let a write through.
 *
 * When a tenant IS inactive (SUSPENDED, PENDING_PAYMENT, or is_paused === true) it
 * applies READ-ONLY GRACE: safe methods (GET / HEAD / OPTIONS) still pass, so the
 * customer can log in, read their data, and reach billing to pay; every other method
 * (POST / PUT / PATCH / DELETE) is rejected with a stable HTTP 402 (Payment Required)
 * body.
 *
 * It never authenticates, authorizes by role, or touches the database: req.user and
 * its `tenant` are populated upstream by JwtAuthGuard (the strategies resolve the
 * context). It logs nothing, so no PII can leak through it.
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
import { CONTEXT_OPTIONAL_KEY } from '../decorators/context-optional.decorator';
import { contextKindOf, isActingUser } from '../context/acting-user';
import { membershipInvalid, membershipRequired } from '../context/membership-context.errors';
import { UserRole } from '@database/entities/user.entity';
import { Tenant, TenantStatus } from '@database/entities/tenant.entity';

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
    if (this.flag(context, IS_PUBLIC_KEY)) {
      return true;
    }

    // (b) @SubscriptionExempt() routes (billing, onboarding) must work even while
    //     suspended, so the customer can recover.
    if (this.flag(context, SUBSCRIPTION_EXEMPT_KEY)) {
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

    // (d) The membership context (GATE_MEMBERSHIP_CONTEXT on). JwtAuthGuard has
    //     already refused 'none' and a tenantless 'membership' on this route;
    //     they are re-checked here so this guard never depends on running second.
    if (isActingUser(user) && contextKindOf(user) !== 'legacy') {
      // @ContextOptional() routes are person-level (profile, settings,
      // notifications, join requests, /memberships/me): with a membership
      // context they do not act in a building, so no building's subscription
      // can gate them. Only here: the legacy principal below keeps today's
      // 402 on those routes (flag off is identical to before, L6).
      if (this.flag(context, CONTEXT_OPTIONAL_KEY)) {
        return true;
      }

      switch (contextKindOf(user)) {
        case 'platform':
          // A super admin acting platform-wide: never subscription-gated.
          return true;
        case 'none':
          if (user.contextProblem === 'MEMBERSHIP_INVALID') {
            throw membershipInvalid();
          }
          throw membershipRequired(user.contextProblemReason ?? 'NO_MEMBERSHIPS');
        default:
          // 'membership': gate on the ACTIVE membership's building, fail closed.
          if (!user.tenantId || !user.tenant) {
            throw membershipInvalid();
          }
          return this.allowForTenant(user.tenant, req);
      }
    }

    // ---- Legacy principal: today's code path, unchanged. ----

    // (e) Super admins are never subscription-gated.
    if (user.role === UserRole.SUPER_ADMIN) {
      return true;
    }

    // (f) No tenant yet (e.g. a freshly provisioned user, pre-onboarding). Gating
    //     that is not subscription's job.
    const tenant = user.tenant;
    if (!tenant) {
      return true;
    }

    return this.allowForTenant(tenant, req);
  }

  private flag(context: ExecutionContext, key: string): boolean {
    return !!this.reflector.getAllAndOverride<boolean>(key, [
      context.getHandler(),
      context.getClass(),
    ]);
  }

  /** (g) + (h): the tenant-status rule, shared by both principals. */
  private allowForTenant(tenant: Pick<Tenant, 'status' | 'isPaused'>, req: { method?: string }) {
    // (g) Only an EXPLICITLY inactive tenant is gated. Anything else — ACTIVE, TRIAL,
    //     or a null / unknown status — falls through and is allowed.
    const isInactive =
      tenant.status === TenantStatus.SUSPENDED ||
      tenant.status === TenantStatus.PENDING_PAYMENT ||
      tenant.isPaused === true;
    if (!isInactive) {
      return true;
    }

    // (h) Inactive tenant: read-only grace for safe methods, 402 for writes.
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
