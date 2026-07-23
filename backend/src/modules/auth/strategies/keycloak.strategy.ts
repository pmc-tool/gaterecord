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
import { ExtractJwt, Strategy, SecretOrKeyProvider } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import * as jwksRsa from 'jwks-rsa';
import { User } from '@database/entities/user.entity';
import { IdentityProvisioningService } from '../identity-provisioning.service';

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
  ) {
    const domain = configService.get<string>('KEYCLOAK_DOMAIN');
    const realm = configService.get<string>('KEYCLOAK_REALM');

    if (!domain || !realm) {
      throw new Error('KeycloakStrategy requires KEYCLOAK_DOMAIN and KEYCLOAK_REALM to be set');
    }

    const issuer = `${domain.replace(/\/+$/, '')}/realms/${realm}`;

    // jwks-rsa fetches and caches the realm's public signing keys, keyed by the
    // `kid` in the token header, so key rotation is picked up without a redeploy.
    const secretOrKeyProvider: SecretOrKeyProvider = jwksRsa.passportJwtSecret({
      jwksUri: `${issuer}/protocol/openid-connect/certs`,
      cache: true,
      cacheMaxAge: 600000, // 10 minutes, matching the account service
      rateLimit: true,
      jwksRequestsPerMinute: 10,
    });

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKeyProvider,
      algorithms: ['RS256'],
      issuer,
    });
  }

  /**
   * Signature, issuer, algorithm and expiry are already verified by passport-jwt
   * by the time this runs. Everything after that point is local bookkeeping, and
   * it all belongs to IdentityProvisioningService:
   *
   *   - the Keycloak `sub` lives in `gate_users.user_id`, NOT in `gate_users.id`
   *     (that column is gaterecord's own generated uuid), so there is no direct
   *     primary-key lookup to do here;
   *   - a user with no gate row must be PROVISIONED, not rejected — the account
   *     service owns signup, so a first request from a legitimate user is the
   *     normal case, not an error;
   *   - the global `users` mirror has to be kept in step at the same time.
   *
   * Returns the local User entity (never the token claims) so that everything
   * already consuming `req.user` — RolesGuard, TenantGuard, @CurrentUser — sees
   * the exact same shape it sees under the existing 'jwt' strategy, with the
   * `tenant` relation loaded and the ACTIVE-status check already applied.
   */
  async validate(payload: KeycloakJwtPayload): Promise<User> {
    return this.identityProvisioningService.provisionFromToken(payload);
  }
}
