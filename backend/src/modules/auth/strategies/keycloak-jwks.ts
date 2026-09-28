/**
 * Keycloak realm coordinates and signing-key lookup, in one place.
 *
 * Two code paths verify Keycloak-issued RS256 tokens and they must agree on
 * EXACTLY the same issuer and key source, or a token accepted over HTTP could be
 * refused on a socket (or, worse, the other way round):
 *
 *   - HTTP:    KeycloakStrategy (./keycloak.strategy.ts), through passport-jwt;
 *   - sockets: SocketAuthService (../socket-auth.service.ts), which has no
 *              passport pipeline and verifies the handshake token itself.
 *
 * Both derive the issuer from KEYCLOAK_DOMAIN + KEYCLOAK_REALM and fetch the
 * realm's public keys from its JWKS endpoint with the same cache and rate-limit
 * settings (ported from the account service). Pure helpers, no Nest providers,
 * so either side can use them without a module dependency.
 *
 * jwks-rsa is loaded LAZILY, on the first client creation. It depends on `jose`,
 * which is ESM-only: Node loads it fine, but jest's CommonJS runtime cannot. This
 * file is imported (through SocketAuthService → EventsGateway → GatewayService)
 * by most services, so an eager import would make every one of their unit specs
 * unloadable.
 *
 * Security note: never log token contents or key material from this file.
 */
import { ConfigService } from '@nestjs/config';
import { SecretOrKeyProvider } from 'passport-jwt';
import type * as JwksRsa from 'jwks-rsa';

function loadJwksRsa(): typeof JwksRsa {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('jwks-rsa');
}

/**
 * jwks-rsa caches keys by the `kid` in the token header, so a realm key rotation
 * is picked up without a redeploy, and rate-limits refetches so a flood of tokens
 * with unknown kids cannot hammer Keycloak.
 */
export const KEYCLOAK_JWKS_CACHE_OPTIONS = {
  cache: true,
  cacheMaxAge: 600000, // 10 minutes, matching the account service
  rateLimit: true,
  jwksRequestsPerMinute: 10,
} as const;

/** The only algorithm a Keycloak access token is accepted with. */
export const KEYCLOAK_ALGORITHMS: ['RS256'] = ['RS256'];

/**
 * `${KEYCLOAK_DOMAIN}/realms/${KEYCLOAK_REALM}` (trailing slashes on the domain
 * trimmed), or null when either variable is unset. Callers decide whether a
 * missing realm is fatal (the HTTP strategy refuses to boot) or just disables the
 * RS256 path.
 */
export function resolveKeycloakIssuer(configService: ConfigService): string | null {
  const domain = configService.get<string>('KEYCLOAK_DOMAIN');
  const realm = configService.get<string>('KEYCLOAK_REALM');

  if (!domain || !realm) {
    return null;
  }

  return `${domain.replace(/\/+$/, '')}/realms/${realm}`;
}

/** The realm's JWKS (public signing keys) endpoint. */
export function keycloakJwksUri(issuer: string): string {
  return `${issuer}/protocol/openid-connect/certs`;
}

/** A jwks-rsa client for direct `getSigningKey(kid)` lookups (sockets). */
export function createKeycloakJwksClient(issuer: string): JwksRsa.JwksClient {
  const { JwksClient } = loadJwksRsa();
  return new JwksClient({
    jwksUri: keycloakJwksUri(issuer),
    ...KEYCLOAK_JWKS_CACHE_OPTIONS,
  });
}

/** The same key source shaped as a passport-jwt secretOrKeyProvider (HTTP). */
export function createKeycloakSecretProvider(issuer: string): SecretOrKeyProvider {
  return loadJwksRsa().passportJwtSecret({
    jwksUri: keycloakJwksUri(issuer),
    ...KEYCLOAK_JWKS_CACHE_OPTIONS,
  });
}
