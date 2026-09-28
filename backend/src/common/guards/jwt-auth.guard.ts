/**
 * The application-wide authentication guard (registered as APP_GUARD in
 * app.module.ts, opt out per-route with @Public()).
 *
 * DUAL-ACCEPT PHASE. It accepts BOTH strategies at once:
 *   - 'jwt'      — the existing locally-issued HS256 tokens (JWT_SECRET).
 *   - 'keycloak' — RS256 tokens minted by the upstream account service's realm.
 *
 * Passport tries them in the order listed and succeeds as soon as one succeeds,
 * so live HS256 sessions keep working unchanged while clients migrate. 'jwt' is
 * listed first purely so the incumbent, cheaper, no-network path is attempted
 * before the JWKS-backed one; the two can never both match a given token anyway
 * (different algorithms, and the Keycloak strategy additionally pins the issuer).
 *
 * MEMBERSHIP CONTEXT. Both strategies end by resolving the acting principal
 * (MembershipContextService.resolve, which never throws), so req.user is always
 * the person overlaid with the membership chosen by the X-Gate-Membership header
 * (contract C5). This guard is where a context PROBLEM becomes an HTTP answer
 * (contract C6), in handleRequest below:
 *
 *   - 403 MEMBERSHIP_INVALID  the header names a membership that is not the
 *                             caller's usable one (or is malformed);
 *   - 409 MEMBERSHIP_REQUIRED no header and zero or several usable memberships;
 *
 * except on @ContextOptional routes, which accept any context. In legacy mode
 * (GATE_MEMBERSHIP_CONTEXT off) the principal is the gate_users row as before
 * and nothing here ever throws for it.
 *
 * PER-REQUEST MEMO. 34 controllers / handlers also declare
 * @UseGuards(JwtAuthGuard), so the guard runs a second time on the same request
 * after the global run. That second run used to re-authenticate from scratch:
 * reassign req.user and, on the Keycloak path, repeat the provisioning writes.
 * The first successful run now records the principal under GATE_AUTHENTICATED
 * and every later run on the same request returns early, so req.user (and the
 * context resolved into it) stays the same object for the rest of the request.
 */
import {
  Injectable,
  ExecutionContext,
  UnauthorizedException,
  HttpException,
  Logger,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { CONTEXT_OPTIONAL_KEY } from '../decorators/context-optional.decorator';
import { GATE_AUTHENTICATED, contextKindOf, isActingUser } from '../context/acting-user';
import { membershipInvalid, membershipRequired } from '../context/membership-context.errors';

/**
 * Order is significant: first match wins. See the note above.
 *
 * These are passport registration names, not classes. 'keycloak' is spelled out
 * rather than imported from KEYCLOAK_STRATEGY_NAME on purpose: nothing else under
 * common/ imports from modules/, and pulling a module-layer file into the guard
 * that fronts every route would invert that layering and put the guard one future
 * edit away from an import cycle — for a constant string that passport freezes
 * anyway. Keep this in sync with KEYCLOAK_STRATEGY_NAME in
 * src/modules/auth/strategies/keycloak.strategy.ts.
 */
export const ACCEPTED_STRATEGIES = ['jwt', 'keycloak'];

/** The request fields this guard reads and writes. */
interface AuthenticatedRequest {
  user?: unknown;
  [GATE_AUTHENTICATED]?: unknown;
}

@Injectable()
export class JwtAuthGuard extends AuthGuard(ACCEPTED_STRATEGIES) {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(private reflector: Reflector) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    // A controller-level re-run on a request the global run already
    // authenticated: same handler, same metadata, same answer. Keep req.user.
    const request = this.requestOf(context);
    if (request && request.user && request[GATE_AUTHENTICATED] === request.user) {
      return true;
    }

    try {
      const allowed = (await super.canActivate(context)) as boolean;
      if (allowed && request?.user) {
        request[GATE_AUTHENTICATED] = request.user;
      }
      return allowed;
    } catch (error) {
      // Anything already shaped as an HTTP response — including the 401s thrown
      // by the strategies' validate() and the 401 / 409 / 403 thrown by
      // handleRequest below — passes through untouched.
      if (error instanceof HttpException) {
        throw error;
      }

      // The one non-HTTP error passport can raise from an array of strategies is
      // `Unknown authentication strategy "<name>"`, which it emits by calling the
      // middleware's next() — that surfaces as a 500 on every request that does
      // not authenticate on the first strategy. It means a strategy named here was
      // never registered in a module's providers, i.e. a wiring bug, not a client
      // problem. Log it loudly, but still answer the client with the same 401 it
      // would have received anyway: an unauthenticated request must not be able to
      // provoke a 500 from the guard that fronts every route.
      this.logger.error(
        `Authentication could not be completed: ${
          error instanceof Error ? error.message : 'unknown error'
        }. Expected strategies: ${ACCEPTED_STRATEGIES.join(', ')}.`,
      );

      throw new UnauthorizedException('Authentication required');
    }
  }

  /**
   * Authentication first, unchanged, and it holds for an array of strategies too.
   *
   * With multiple strategies passport hands `info`/`status` over as ARRAYS (one
   * entry per failed strategy) rather than as single values — this method never
   * reads either, so that difference is invisible here and to callers.
   *
   * `err` is only ever populated when a strategy calls error() — which passport-jwt
   * does exclusively when the verify callback throws, i.e. when our validate()
   * threw an UnauthorizedException. That short-circuits the remaining strategies
   * and is rethrown verbatim, preserving today's specific messages ('User not
   * found', 'User is not active'). Every token-level failure (bad signature, wrong
   * algorithm, wrong issuer, expired, missing header) is a fail() instead, so it
   * falls through to the next strategy and, if none accepts, arrives here as
   * `user === false` and becomes the generic 401 below.
   *
   * Then the membership context (C6), for overlaid principals only; a legacy
   * principal (flag off, or anything without a contextKind) is returned as is:
   *
   *   route              context                                  answer
   *   -----------------  ---------------------------------------  ----------------------
   *   @ContextOptional   anything                                 the principal
   *   any other          problem MEMBERSHIP_INVALID               403 MEMBERSHIP_INVALID
   *   any other          problem MEMBERSHIP_REQUIRED, or 'none'   409 MEMBERSHIP_REQUIRED
   *   any other          'membership' without a tenantId          403 MEMBERSHIP_INVALID
   *   any other          'membership' / 'platform'                the principal
   *
   * A missing execution context (a direct call) is treated as a required route,
   * so the check fails closed.
   */
  handleRequest<TUser = unknown>(
    err: Error | null,
    user: TUser,
    _info?: unknown,
    context?: ExecutionContext,
  ): TUser {
    if (err || !user) {
      throw err || new UnauthorizedException('Authentication required');
    }

    if (!isActingUser(user)) {
      return user;
    }

    const kind = contextKindOf(user);
    if (kind === 'legacy' || this.isContextOptional(context)) {
      return user;
    }

    if (user.contextProblem === 'MEMBERSHIP_INVALID') {
      throw membershipInvalid();
    }
    if (user.contextProblem === 'MEMBERSHIP_REQUIRED' || kind === 'none') {
      throw membershipRequired(user.contextProblemReason ?? 'NO_MEMBERSHIPS');
    }
    if (kind === 'membership' && !user.tenantId) {
      // Only reachable through a resolver bug; never let it act unscoped.
      throw membershipInvalid();
    }

    return user;
  }

  private isContextOptional(context: ExecutionContext | undefined): boolean {
    if (!context) {
      return false;
    }

    return (
      this.reflector.getAllAndOverride<boolean>(CONTEXT_OPTIONAL_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    );
  }

  /** The HTTP request, or undefined for any other transport (never memoised). */
  private requestOf(context: ExecutionContext): AuthenticatedRequest | undefined {
    if (context.getType() !== 'http') {
      return undefined;
    }

    return context.switchToHttp().getRequest<AuthenticatedRequest>() ?? undefined;
  }
}
