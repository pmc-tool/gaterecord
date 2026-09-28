/**
 * SEC-7 — SocketAuthService verifies local HS256 and Keycloak RS256 handshake
 * tokens with the same rules as HTTP.
 *
 * Pure unit tests: the user repository and IdentityProvisioningService are jest
 * mocks, the JWKS fetch is stubbed with a locally generated RSA key pair, so no
 * database and no network are needed.
 */
import { generateKeyPairSync } from 'crypto';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import {
  SocketAuthError,
  SocketAuthService,
  SOCKET_AUTH_FAILED,
  extractSocketToken,
} from './socket-auth.service';

const JWT_SECRET = 'socket-auth-spec-secret';
const KEYCLOAK_DOMAIN = 'https://keycloak.example.test/';
const KEYCLOAK_REALM = 'yaad';
const ISSUER = 'https://keycloak.example.test/realms/yaad';
const PERSON_ID = '3f0c1d2e-4b5a-4c6d-8e7f-9a0b1c2d3e4f';
const KEYCLOAK_SUB = '7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d';

function rsaKeyPair() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

function makePerson(overrides: Partial<User> = {}): User {
  return {
    id: PERSON_ID,
    email: 'person@example.com',
    role: UserRole.BUILDING_ADMIN,
    status: UserStatus.ACTIVE,
    tenantId: '11111111-1111-4111-8111-111111111111',
    ...overrides,
  } as User;
}

async function refusal(promise: Promise<unknown>): Promise<SocketAuthError> {
  const error = await promise.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(SocketAuthError);
  expect((error as SocketAuthError).code).toBe(SOCKET_AUTH_FAILED);
  return error as SocketAuthError;
}

describe('SocketAuthService (SEC-7)', () => {
  const keycloakKeys = rsaKeyPair();
  const otherKeys = rsaKeyPair();

  let jwtService: JwtService;
  let userRepository: { findOne: jest.Mock };
  let identityProvisioningService: { provisionFromToken: jest.Mock };
  let config: Record<string, string | undefined>;
  let service: SocketAuthService;
  let signingKeyStub: jest.SpyInstance;

  function build() {
    service = new SocketAuthService(
      jwtService,
      { get: (key: string) => config[key] } as never,
      userRepository as never,
      identityProvisioningService as never,
    );
    // Stub the JWKS fetch: the realm "publishes" keycloakKeys.publicKey as kid-1.
    signingKeyStub = jest
      .spyOn(
        service as unknown as { getKeycloakSigningKey: (kid: string) => Promise<string> },
        'getKeycloakSigningKey',
      )
      .mockImplementation(async (kid: string) => {
        if (kid !== 'kid-1') {
          const err = new Error('Unable to find a signing key that matches');
          err.name = 'SigningKeyNotFoundError';
          throw err;
        }
        return keycloakKeys.publicKey;
      });
  }

  function localToken(payload: Record<string, unknown> = {}, secret = JWT_SECRET): string {
    return jwtService.sign(
      {
        sub: PERSON_ID,
        email: 'person@example.com',
        role: 'building_admin',
        tenantId: null,
        ...payload,
      },
      { secret, expiresIn: '1h' },
    );
  }

  function keycloakToken(
    options: {
      privateKey?: string;
      issuer?: string;
      expiresIn?: string | number;
      kid?: string;
    } = {},
  ): string {
    return jwtService.sign(
      { sub: KEYCLOAK_SUB, email: 'person@example.com', email_verified: true },
      {
        secret: options.privateKey ?? keycloakKeys.privateKey,
        algorithm: 'RS256',
        keyid: options.kid ?? 'kid-1',
        issuer: options.issuer ?? ISSUER,
        expiresIn: options.expiresIn ?? '1h',
      },
    );
  }

  beforeEach(() => {
    jwtService = new JwtService({ secret: JWT_SECRET });
    userRepository = { findOne: jest.fn().mockResolvedValue(makePerson()) };
    identityProvisioningService = {
      provisionFromToken: jest.fn().mockResolvedValue(makePerson()),
    };
    config = { KEYCLOAK_DOMAIN, KEYCLOAK_REALM };
    build();
  });

  describe('HS256 (locally issued)', () => {
    it('accepts a valid token from auth.token and loads the person with its tenant', async () => {
      const person = await service.authenticate({ auth: { token: localToken() } });

      expect(person.id).toBe(PERSON_ID);
      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { id: PERSON_ID },
        relations: ['tenant'],
      });
      expect(identityProvisioningService.provisionFromToken).not.toHaveBeenCalled();
    });

    it('accepts the token from an Authorization: Bearer header', async () => {
      await expect(
        service.authenticate({ headers: { authorization: `Bearer ${localToken()}` } }),
      ).resolves.toMatchObject({ id: PERSON_ID });
    });

    it('rejects an expired token', async () => {
      const expired = jwtService.sign(
        { sub: PERSON_ID, exp: Math.floor(Date.now() / 1000) - 60 },
        { secret: JWT_SECRET },
      );

      const error = await refusal(service.authenticate({ auth: { token: expired } }));
      expect(error.message).toBe('Token expired');
      expect(userRepository.findOne).not.toHaveBeenCalled();
    });

    it('rejects a token signed with another secret', async () => {
      const error = await refusal(
        service.authenticate({ auth: { token: localToken({}, 'not-the-secret') } }),
      );
      expect(error.message).toBe('Invalid token');
      expect(userRepository.findOne).not.toHaveBeenCalled();
    });

    it("rejects an unsigned ('none') token", async () => {
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const body = Buffer.from(JSON.stringify({ sub: PERSON_ID })).toString('base64url');

      await refusal(service.authenticate({ auth: { token: `${header}.${body}.` } }));
      expect(userRepository.findOne).not.toHaveBeenCalled();
    });

    it('rejects an inactive person', async () => {
      userRepository.findOne.mockResolvedValue(makePerson({ status: UserStatus.INACTIVE }));

      const error = await refusal(service.authenticate({ auth: { token: localToken() } }));
      expect(error.message).toBe('User is not active');
    });

    it('rejects a person that no longer exists', async () => {
      userRepository.findOne.mockResolvedValue(null);

      const error = await refusal(service.authenticate({ auth: { token: localToken() } }));
      expect(error.message).toBe('User not found');
    });
  });

  describe('RS256 (Keycloak)', () => {
    it('accepts a token verified against the (mocked) realm JWKS and provisions the person', async () => {
      const person = await service.authenticate({ auth: { token: keycloakToken() } });

      expect(person.id).toBe(PERSON_ID);
      expect(signingKeyStub).toHaveBeenCalledWith('kid-1');
      expect(identityProvisioningService.provisionFromToken).toHaveBeenCalledWith(
        expect.objectContaining({ sub: KEYCLOAK_SUB, email: 'person@example.com', iss: ISSUER }),
      );
      expect(userRepository.findOne).not.toHaveBeenCalled();
    });

    it('rejects a token signed by a key the realm did not publish', async () => {
      const error = await refusal(
        service.authenticate({
          auth: { token: keycloakToken({ privateKey: otherKeys.privateKey }) },
        }),
      );
      expect(error.message).toBe('Invalid token');
      expect(identityProvisioningService.provisionFromToken).not.toHaveBeenCalled();
    });

    it('rejects an unknown kid', async () => {
      await refusal(service.authenticate({ auth: { token: keycloakToken({ kid: 'kid-2' }) } }));
      expect(identityProvisioningService.provisionFromToken).not.toHaveBeenCalled();
    });

    it('rejects a token from another issuer', async () => {
      const error = await refusal(
        service.authenticate({
          auth: { token: keycloakToken({ issuer: 'https://evil.example.test/realms/yaad' }) },
        }),
      );
      expect(error.message).toBe('Invalid token');
      expect(identityProvisioningService.provisionFromToken).not.toHaveBeenCalled();
    });

    it('rejects an expired token', async () => {
      const expired = jwtService.sign(
        {
          sub: KEYCLOAK_SUB,
          email: 'person@example.com',
          exp: Math.floor(Date.now() / 1000) - 60,
        },
        { secret: keycloakKeys.privateKey, algorithm: 'RS256', keyid: 'kid-1', issuer: ISSUER },
      );

      const error = await refusal(service.authenticate({ auth: { token: expired } }));
      expect(error.message).toBe('Token expired');
      expect(identityProvisioningService.provisionFromToken).not.toHaveBeenCalled();
    });

    it('rejects an inactive person (provisioning refuses it)', async () => {
      identityProvisioningService.provisionFromToken.mockRejectedValue(
        new UnauthorizedException('User is not active'),
      );

      const error = await refusal(service.authenticate({ auth: { token: keycloakToken() } }));
      expect(error.message).toBe('User is not active');
    });

    it('refuses RS256 tokens when Keycloak is not configured', async () => {
      config = {};
      build();

      await refusal(service.authenticate({ auth: { token: keycloakToken() } }));
      expect(identityProvisioningService.provisionFromToken).not.toHaveBeenCalled();
    });

    it('does not accept an RS256 token as a local token', async () => {
      // Pinning HS256 on the local path means a Keycloak token can never reach
      // loadActiveLocalUser, even if the JWKS path is unavailable.
      config = {};
      build();

      await refusal(service.authenticate({ auth: { token: keycloakToken() } }));
      expect(userRepository.findOne).not.toHaveBeenCalled();
    });
  });

  describe('handshake without a usable token', () => {
    it.each([
      ['no handshake', undefined],
      ['empty auth', { auth: {} }],
      ['non-string token', { auth: { token: 42 } }],
      ['array header', { headers: { authorization: ['Bearer a', 'Bearer b'] } }],
      ['non-bearer header', { headers: { authorization: 'Basic abc' } }],
      ['garbage token', { auth: { token: 'not-a-jwt' } }],
    ])('%s is refused', async (_label, handshake) => {
      await refusal(service.authenticate(handshake as never));
      expect(userRepository.findOne).not.toHaveBeenCalled();
      expect(identityProvisioningService.provisionFromToken).not.toHaveBeenCalled();
    });
  });

  describe('extractSocketToken', () => {
    it('prefers auth.token over the header', () => {
      expect(
        extractSocketToken({ auth: { token: 'a' }, headers: { authorization: 'Bearer b' } }),
      ).toBe('a');
    });

    it('tolerates a Bearer prefix on auth.token', () => {
      expect(extractSocketToken({ auth: { token: 'Bearer abc' } })).toBe('abc');
    });
  });
});
