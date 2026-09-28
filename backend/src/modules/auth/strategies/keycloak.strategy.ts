/**
 * Keycloak JWT validation strategy (passport strategy name: 'keycloak').
 *
 * It deliberately uses the strategy name 'keycloak' so it can coexist with the
 * existing default 'jwt' strategy (see ./jwt.strategy.ts). The two share nothing:
 * JwtStrategy keeps verifying locally-issued HS256 tokens with JWT_SECRET, this
 * one verifies Keycloak-issued RS256 tokens against the realm JWKS endpoint.
 * JwtAuthGuard accepts both at once (see src/common/guards/jwt-auth.guard.ts).
 *
 * Ported from account service: src/core/guards/jwt-keycloak.guard.ts.
 *
 * Security note: signature verification alone is NOT sufficient to authenticate.
 * A structurally valid Keycloak token only proves the realm minted it; it says
 * nothing about whether this gate deployment still wants that user. The local
 * half of that decision — resolving/creating the `gate_users` row, mirroring
 * `users`, and rejecting anyone who is not ACTIVE — lives in
 * IdentityProvisioningService, which validate() below delegates to wholesale.
 * Never log token contents or key material from this file.
 */
import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { ActingUser, readMembershipHeader } from '@common/context/acting-user';
import { IdentityProvisioningService } from '../identity-provisioning.service';
import { MembershipContextService } from '../../memberships/membership-context.service';
import {
  KEYCLOAK_ALGORITHMS,
  createKeycloakSecretProvider,
  resolveKeycloakIssuer,
} from './keycloak-jwks';

export const KEYCLOAK_STRATEGY_NAME = 'keycloak';

/** Subset of the Keycloak access token claims this strategy relies on. */
export interface KeycloakJwtPayload {
  /** Keycloak user id. Becomes `users.id` and `gate_users.user_id`. */
  sub: string;
  iss?: string;
  email?: string;
  email_verified?: boolean;
  preferred_username?: string;
  given_name?: string;
  family_name?: string;
  name?: string;
  realm_access?: { roles?: string[] };
  resource_access?: Record<string, { roles?: string[] }>;
}

@Injectable()
export class KeycloakStrategy extends PassportStrategy(Strategy, KEYCLOAK_STRATEGY_NAME) {
  constructor(
    configService: ConfigService,
    private readonly identityProvisioningService: IdentityProvisioningService,
    private readonly membershipContextService: MembershipContextService,
  ) {
    // The realm coordinates and key source are shared with the socket handshake
    // (SocketAuthService) through ./keycloak-jwks.ts, so HTTP and sockets can
    // never disagree on which tokens are valid.
    const issuer = resolveKeycloakIssuer(configService);

    if (!issuer) {
      throw new Error('KeycloakStrategy requires KEYCLOAK_DOMAIN and KEYCLOAK_REALM to be set');
    }

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      // jwks-rsa fetches and caches the realm's public signing keys, keyed by
      // the `kid` in the token header, so key rotation is picked up without a
      // redeploy.
      secretOrKeyProvider: createKeycloakSecretProvider(issuer),
      algorithms: KEYCLOAK_ALGORITHMS,
      issuer,
      passReqToCallback: true,
    });
  }

  /**
   * Signature, issuer, algorithm and expiry are already verified by passport-jwt
   * by the time this runs. Everything after that point is local bookkeeping:
   *
   *   - the PERSON, which belongs to IdentityProvisioningService: the Keycloak
   *     `sub` lives in `gate_users.user_id`, NOT in `gate_users.id` (that column
   *     is gaterecord's own generated uuid), a user with no gate row must be
   *     PROVISIONED rather than rejected (the account service owns signup), the
   *     global `users` mirror is kept in step, and anyone not ACTIVE gets a 401;
   *   - the ACTING CONTEXT, which belongs to MembershipContextService: which of
   *     the person's memberships this request acts as, from X-Gate-Membership.
   *
   * Returns the overlaid principal (never the token claims), the same shape the
   * 'jwt' strategy returns, so RolesGuard, SubscriptionGuard and @CurrentUser
   * see one thing whichever strategy accepted the token.
   */
  async validate(req: Request, payload: KeycloakJwtPayload): Promise<ActingUser> {
    const person = await this.identityProvisioningService.provisionFromToken(payload);

    return this.membershipContextService.resolve(person, readMembershipHeader(req));
  }
}
