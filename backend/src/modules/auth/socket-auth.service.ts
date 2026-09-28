/**
 * Socket handshake authentication (SEC-7).
 *
 * HTTP requests are authenticated by passport (JwtAuthGuard accepts both the
 * local 'jwt' strategy and the 'keycloak' one). Socket.IO connections never pass
 * through that pipeline, so before this service the /events namespace accepted
 * anyone and the default namespace verified HS256 only — every Keycloak-signed-in
 * web user was refused there, and the user's status was never checked.
 *
 * authenticate() applies the SAME two rules as HTTP to the handshake token:
 *
 *   - HS256 (locally issued, JWT_SECRET): verified with JwtService, pinned to
 *     HS256, then the person is loaded with loadActiveLocalUser — the lookup and
 *     ACTIVE check JwtStrategy.validate performs.
 *   - RS256 (Keycloak): verified against the realm JWKS with the realm issuer
 *     (the coordinates KeycloakStrategy uses, from ./strategies/keycloak-jwks.ts),
 *     then handed to IdentityProvisioningService.provisionFromToken, exactly as
 *     KeycloakStrategy.validate does.
 *
 * The token's header picks the path; each verification pins its own algorithm,
 * so an HS256 token can never be checked against a JWKS key or the other way
 * round. It returns the PERSON (the gate_users row; the HS256 path also loads
 * its legacy tenant relation, the RS256 path returns the provisioned row without
 * relations). Nothing on the socket side reads `tenant`; the membership context
 * is resolved on top of the person later (GATE-11, MembershipContextService).
 *
 * Registration: provided by GatewayModule for now (it is the only consumer and
 * imports AuthModule for JwtService and IdentityProvisioningService). Moving it
 * into AuthModule's providers/exports needs no change here.
 *
 * Security note: never log the token, its claims or key material. Failures are
 * reported with a short fixed reason only.
 */
import { HttpException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { JwksClient } from 'jwks-rsa';
import { User } from '@database/entities/user.entity';
import { IdentityProvisioningService, IdentityTokenPayload } from './identity-provisioning.service';
import type { JwtPayload } from './strategies/jwt.strategy';
import { loadActiveLocalUser } from './strategies/load-active-local-user';
import {
  KEYCLOAK_ALGORITHMS,
  createKeycloakJwksClient,
  resolveKeycloakIssuer,
} from './strategies/keycloak-jwks';

/** The code a refused handshake carries (connect_error data / 'error' payload). */
export const SOCKET_AUTH_FAILED = 'AUTH_FAILED';

/**
 * The part of a Socket.IO handshake this service reads. socket.handshake
 * satisfies it; tests can pass a plain object.
 */
export interface SocketHandshakeLike {
  auth?: Record<string, unknown> | null;
  headers?: Record<string, string | string[] | undefined> | null;
}

/**
 * Thrown for every refused handshake. `message` is a short fixed reason that is
 * safe to send to the client; `code` is always AUTH_FAILED.
 */
export class SocketAuthError extends Error {
  readonly code = SOCKET_AUTH_FAILED;

  constructor(message: string) {
    super(message);
    this.name = 'SocketAuthError';
  }
}

/**
 * The bearer token of a handshake: `auth.token` (what the web sends through
 * io(url, { auth: { token } })) first, then an `Authorization: Bearer` header
 * (non-browser clients). A leading "Bearer " on auth.token is tolerated. Array
 * or non-string values are ignored, never coerced.
 */
export function extractSocketToken(
  handshake: SocketHandshakeLike | null | undefined,
): string | null {
  const fromAuth = handshake?.auth?.token;
  if (typeof fromAuth === 'string' && fromAuth.trim()) {
    return fromAuth.trim().replace(/^Bearer\s+/i, '') || null;
  }

  const header = handshake?.headers?.authorization;
  if (typeof header === 'string') {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
    if (match) {
      return match[1];
    }
  }

  return null;
}

interface DecodedTokenHeader {
  alg?: unknown;
  kid?: unknown;
}

@Injectable()
export class SocketAuthService {
  private readonly logger = new Logger(SocketAuthService.name);

  /** Realm issuer, or null when Keycloak is not configured (RS256 then refused). */
  private readonly keycloakIssuer: string | null;

  /** Created on first RS256 handshake so HS256-only setups never build it. */
  private jwksClient: JwksClient | null = null;

  constructor(
    private readonly jwtService: JwtService,
    configService: ConfigService,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly identityProvisioningService: IdentityProvisioningService,
  ) {
    this.keycloakIssuer = resolveKeycloakIssuer(configService);
  }

  /**
   * Verifies the handshake token and returns the ACTIVE person it names.
   * Throws SocketAuthError (code AUTH_FAILED) on any failure.
   */
  async authenticate(handshake: SocketHandshakeLike | null | undefined): Promise<User> {
    const token = extractSocketToken(handshake);
    if (!token) {
      throw new SocketAuthError('No token provided');
    }

    // decode() only reads the header to pick the path; nothing in it is trusted.
    let header: DecodedTokenHeader | undefined;
    try {
      const decoded = this.jwtService.decode(token, { complete: true }) as {
        header?: DecodedTokenHeader;
      } | null;
      header = decoded?.header;
    } catch {
      header = undefined;
    }
    if (!header) {
      throw new SocketAuthError('Invalid token');
    }

    try {
      if (header.alg === 'RS256') {
        return await this.authenticateKeycloak(token, header.kid);
      }
      // Everything else is tried as a local token; verification is pinned to
      // HS256, so any other algorithm (including 'none') fails there.
      return await this.authenticateLocal(token);
    } catch (error) {
      throw this.toSocketAuthError(error);
    }
  }

  // ---------------------------------------------------------------------------
  // HS256 — locally issued tokens
  // ---------------------------------------------------------------------------

  private async authenticateLocal(token: string): Promise<User> {
    const payload = await this.jwtService.verifyAsync<JwtPayload>(token, {
      algorithms: ['HS256'],
    });
    return loadActiveLocalUser(this.userRepository, payload?.sub);
  }

  // ---------------------------------------------------------------------------
  // RS256 — Keycloak tokens
  // ---------------------------------------------------------------------------

  private async authenticateKeycloak(token: string, kid: unknown): Promise<User> {
    if (!this.keycloakIssuer) {
      throw new SocketAuthError('Invalid token');
    }
    if (typeof kid !== 'string' || !kid) {
      throw new SocketAuthError('Invalid token');
    }

    const publicKey = await this.getKeycloakSigningKey(kid);

    // `secret` is how JwtService takes a per-call verification key; it overrides
    // the module's JWT_SECRET. Issuer, algorithm and expiry are all enforced here,
    // matching the passport options in KeycloakStrategy.
    const payload = await this.jwtService.verifyAsync<IdentityTokenPayload>(token, {
      secret: publicKey,
      algorithms: KEYCLOAK_ALGORITHMS,
      issuer: this.keycloakIssuer,
    });

    return this.identityProvisioningService.provisionFromToken(payload);
  }

  /** The realm's PEM public key for `kid`. Separate so tests can stub the JWKS fetch. */
  protected async getKeycloakSigningKey(kid: string): Promise<string> {
    if (!this.jwksClient) {
      this.jwksClient = createKeycloakJwksClient(this.keycloakIssuer as string);
    }
    const key = await this.jwksClient.getSigningKey(kid);
    return key.getPublicKey();
  }

  // ---------------------------------------------------------------------------
  // Error mapping
  // ---------------------------------------------------------------------------

  /**
   * Collapses every failure into a SocketAuthError with a fixed, client-safe
   * reason. jsonwebtoken / jwks errors are never passed through (their messages
   * can describe the key or the token); the 401 messages the identity services
   * throw ('User not found', 'User is not active', ...) are already safe.
   */
  private toSocketAuthError(error: unknown): SocketAuthError {
    if (error instanceof SocketAuthError) {
      return error;
    }

    if (error instanceof HttpException && error.getStatus() === 401) {
      return new SocketAuthError(error.message);
    }

    const name = error instanceof Error ? error.name : '';
    if (name === 'TokenExpiredError') {
      return new SocketAuthError('Token expired');
    }
    if (
      name === 'JsonWebTokenError' ||
      name === 'NotBeforeError' ||
      name === 'SigningKeyNotFoundError'
    ) {
      return new SocketAuthError('Invalid token');
    }

    // Anything else is ours (database, JWKS endpoint unreachable, ...). Log the
    // error type only and refuse the connection.
    this.logger.warn(`Socket authentication could not be completed (${name || 'unknown error'})`);
    return new SocketAuthError('Authentication failed');
  }
}
