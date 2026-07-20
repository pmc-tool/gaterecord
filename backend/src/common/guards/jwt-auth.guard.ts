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

    try {
      return (await super.canActivate(context)) as boolean;
    } catch (error) {
      // Anything already shaped as an HTTP response — including the 401s thrown
      // by handleRequest below and by the strategies' validate() — passes through
      // untouched.
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
   * Unchanged contract, and it holds for an array of strategies too.
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
   */
  handleRequest<TUser = unknown>(err: Error | null, user: TUser, _info: Error | null): TUser {
    if (err || !user) {
      throw err || new UnauthorizedException('Authentication required');
    }
    return user;
  }
}
