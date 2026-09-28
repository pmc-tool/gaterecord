import * as fs from 'fs';
import * as path from 'path';
import {
  Controller,
  Get,
  INestApplication,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as request from 'supertest';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import { Tenant, TenantStatus } from '@database/entities/tenant.entity';
import { Membership, MembershipRole } from '@database/entities/membership.entity';
import { GATE_AUTHENTICATED } from '../context/acting-user';
import { ContextOptional } from '../decorators/context-optional.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';
import { SubscriptionGuard } from './subscription.guard';
import { JwtStrategy } from '../../modules/auth/strategies/jwt.strategy';
import { KeycloakStrategy } from '../../modules/auth/strategies/keycloak.strategy';
import { IdentityProvisioningService } from '../../modules/auth/identity-provisioning.service';
import { MembershipContextService } from '../../modules/memberships/membership-context.service';
import { MembershipsService } from '../../modules/memberships/memberships.service';
import { MembershipsController } from '../../modules/memberships/memberships.controller';

// jwks-rsa pulls in 'jose', which is ESM-only and cannot load under jest. The
// Keycloak strategy must still be REGISTERED (the guard names it), but no test
// here sends an RS256 token, so a key source that never finds a key is enough.
jest.mock('jwks-rsa', () => ({
  passportJwtSecret:
    () => (_req: unknown, _raw: unknown, done: (err: Error | null, key?: string) => void) =>
      done(new Error('no signing keys in tests')),
}));

/**
 * AUTH-7: both strategies wired to MembershipContextService behind the real
 * JwtAuthGuard + SubscriptionGuard, over HTTP (supertest), with every database
 * read stubbed. Covers C6 end to end, the controller-level re-run memo, and
 * that a validate() 401 short-circuits the second strategy.
 */
const JWT_SECRET = 'integration-spec-secret';
const PERSON_ID = '0b6f6a3c-8a53-4d8e-9d1f-2c5a7b1e0a01';
const TOWER_A = Object.assign(new Tenant(), {
  id: 'aaaaaaaa-0000-4000-8000-00000000000a',
  name: 'Tower A',
  slug: 'tower-a',
  status: TenantStatus.ACTIVE,
  isPaused: false,
});
const TOWER_B = Object.assign(new Tenant(), {
  id: 'bbbbbbbb-0000-4000-8000-00000000000b',
  name: 'Tower B',
  slug: 'tower-b',
  status: TenantStatus.SUSPENDED,
  isPaused: false,
});
const MEMBERSHIP_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const MEMBERSHIP_B = 'bbbbbbbb-1111-4111-8111-111111111111';
const FOREIGN_MEMBERSHIP = 'ffffffff-1111-4111-8111-111111111111';

function membership(id: string, tenant: Tenant, role: MembershipRole): Membership {
  return Object.assign(new Membership(), {
    id,
    userId: PERSON_ID,
    tenantId: tenant.id,
    tenant,
    role,
    status: UserStatus.ACTIVE,
    unit: null,
  });
}

interface ProbeRequest {
  user: {
    contextKind: string;
    role: string | null;
    tenantId: string | null;
  };
  [GATE_AUTHENTICATED]?: unknown;
}

function describePrincipal(req: ProbeRequest) {
  return { kind: req.user.contextKind, role: req.user.role, tenantId: req.user.tenantId };
}

@Controller('probe')
class ProbeController {
  @Get('required')
  required(@Req() req: ProbeRequest) {
    return describePrincipal(req);
  }

  @Get('optional')
  @ContextOptional()
  optional(@Req() req: ProbeRequest) {
    return describePrincipal(req);
  }

  @Post('write')
  write(@Req() req: ProbeRequest) {
    return describePrincipal(req);
  }
}

/** One of the 34 controllers that re-apply the guard. */
@Controller('rerun')
@UseGuards(JwtAuthGuard)
class RerunController {
  @Get()
  rerun(@Req() req: ProbeRequest) {
    return { sameAsMemo: req[GATE_AUTHENTICATED] === req.user, ...describePrincipal(req) };
  }
}

describe('JwtAuthGuard + strategies + membership context (AUTH-7, integration)', () => {
  const originalFlag = process.env.GATE_MEMBERSHIP_CONTEXT;
  let app: INestApplication;
  let token: string;
  let person: User;
  let userRepository: { findOne: jest.Mock };
  let tenantRepository: { findOne: jest.Mock };
  let identityProvisioning: { provisionFromToken: jest.Mock };
  let membershipsService: MembershipsService;
  let resolveSpy: jest.SpyInstance;

  beforeAll(async () => {
    userRepository = { findOne: jest.fn() };
    tenantRepository = { findOne: jest.fn() };
    identityProvisioning = { provisionFromToken: jest.fn() };
    membershipsService = new MembershipsService({} as never);

    const config: Record<string, string> = {
      JWT_SECRET,
      KEYCLOAK_DOMAIN: 'https://keycloak.example.test',
      KEYCLOAK_REALM: 'yaad',
    };

    const moduleRef = await Test.createTestingModule({
      imports: [PassportModule, JwtModule.register({ secret: JWT_SECRET })],
      controllers: [ProbeController, RerunController, MembershipsController],
      providers: [
        JwtStrategy,
        KeycloakStrategy,
        MembershipContextService,
        { provide: MembershipsService, useValue: membershipsService },
        { provide: IdentityProvisioningService, useValue: identityProvisioning },
        { provide: getRepositoryToken(User), useValue: userRepository },
        { provide: getRepositoryToken(Tenant), useValue: tenantRepository },
        { provide: ConfigService, useValue: { get: (key: string) => config[key] } },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: SubscriptionGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    await app.init();

    token = moduleRef.get(JwtService).sign({
      sub: PERSON_ID,
      email: 'x@example.test',
      role: 'building_admin',
      tenantId: TOWER_A.id,
    });
    resolveSpy = jest.spyOn(moduleRef.get(MembershipContextService), 'resolve');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
    person = Object.assign(new User(), {
      id: PERSON_ID,
      email: 'x@example.test',
      firstName: 'X',
      lastName: 'Person',
      role: UserRole.BUILDING_ADMIN,
      status: UserStatus.ACTIVE,
      tenantId: TOWER_A.id,
      unit: null,
    });
    userRepository.findOne.mockReset().mockImplementation(async () => person);
    tenantRepository.findOne.mockReset().mockResolvedValue(TOWER_A);
    identityProvisioning.provisionFromToken.mockReset();
    resolveSpy.mockClear();

    const a = membership(MEMBERSHIP_A, TOWER_A, UserRole.BUILDING_ADMIN);
    const b = membership(MEMBERSHIP_B, TOWER_B, UserRole.RESIDENT);
    jest
      .spyOn(membershipsService, 'findOwnedWithTenant')
      .mockImplementation(async (id: string) => [a, b].find((m) => m.id === id) ?? null);
    jest.spyOn(membershipsService, 'listActiveForPerson').mockResolvedValue([a, b]);
    jest.spyOn(membershipsService, 'listForPerson').mockResolvedValue([a, b]);
    jest.spyOn(membershipsService, 'listPendingJoinRequests').mockResolvedValue([]);
  });

  afterAll(async () => {
    process.env.GATE_MEMBERSHIP_CONTEXT = originalFlag;
    await app?.close();
  });

  const get = (url: string, header?: string) => {
    const req = request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${token}`);
    return header === undefined ? req : req.set('X-Gate-Membership', header);
  };

  describe('flag on', () => {
    it('required route, several buildings, no header: 409 MEMBERSHIP_REQUIRED AMBIGUOUS', async () => {
      const res = await get('/probe/required');
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'MEMBERSHIP_REQUIRED', reason: 'AMBIGUOUS' });
    });

    it('required route, no memberships: 409 NO_MEMBERSHIPS', async () => {
      jest.spyOn(membershipsService, 'listActiveForPerson').mockResolvedValue([]);
      const res = await get('/probe/required');
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'MEMBERSHIP_REQUIRED', reason: 'NO_MEMBERSHIPS' });
    });

    it('required route, foreign membership id: 403 MEMBERSHIP_INVALID', async () => {
      const res = await get('/probe/required', FOREIGN_MEMBERSHIP);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'MEMBERSHIP_INVALID' });
      expect(res.body).not.toHaveProperty('reason');
    });

    it('required route, malformed header: 403 without reaching the database', async () => {
      const res = await get('/probe/required', "1' OR 1=1 --");
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'MEMBERSHIP_INVALID' });
      expect(membershipsService.findOwnedWithTenant).not.toHaveBeenCalled();
    });

    it('required route, own membership: acts in that building with that role', async () => {
      const res = await get('/probe/required', MEMBERSHIP_A);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        kind: 'membership',
        role: 'building_admin',
        tenantId: TOWER_A.id,
      });
    });

    it('optional route with a bad header: 200 in the none context', async () => {
      const res = await get('/probe/optional', FOREIGN_MEMBERSHIP);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ kind: 'none', role: null, tenantId: null });
    });

    it('a controller-level re-run keeps the same req.user and resolves once', async () => {
      const res = await get('/rerun', MEMBERSHIP_A);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        sameAsMemo: true,
        kind: 'membership',
        tenantId: TOWER_A.id,
      });
      expect(resolveSpy).toHaveBeenCalledTimes(1);
      expect(userRepository.findOne).toHaveBeenCalledTimes(1);
    });

    it('a controller-level re-run still enforces the context (the global run already did)', async () => {
      const res = await get('/rerun');
      expect(res.status).toBe(409);
      expect(resolveSpy).toHaveBeenCalledTimes(1);
    });

    it('a write acting in suspended Tower B gets 402; the same person writes in Tower A', async () => {
      const inB = await request(app.getHttpServer())
        .post('/probe/write')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Gate-Membership', MEMBERSHIP_B);
      expect(inB.status).toBe(402);
      expect(inB.body).toMatchObject({ code: 'SUBSCRIPTION_INACTIVE' });

      const inA = await request(app.getHttpServer())
        .post('/probe/write')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Gate-Membership', MEMBERSHIP_A);
      expect(inA.status).toBe(201);
    });

    it('GET /memberships/me with a stale header: 200 and activeMembershipId null', async () => {
      const res = await get('/memberships/me', FOREIGN_MEMBERSHIP);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ activeMembershipId: null, isSuperAdmin: false });
      expect(res.body.memberships).toHaveLength(2);
    });

    it('GET /memberships/me with a malformed header never 500s', async () => {
      const res = await get('/memberships/me', 'garbage');
      expect(res.status).toBe(200);
    });
  });

  describe('flag off (legacy)', () => {
    beforeEach(() => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'off';
    });

    it('req.user is the gate_users row as before, whatever the header', async () => {
      for (const header of [undefined, FOREIGN_MEMBERSHIP, 'garbage', MEMBERSHIP_B]) {
        const res = await get('/probe/required', header);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ kind: 'legacy', role: 'building_admin', tenantId: TOWER_A.id });
      }
      expect(membershipsService.findOwnedWithTenant).not.toHaveBeenCalled();
      expect(membershipsService.listActiveForPerson).not.toHaveBeenCalled();
    });

    it('a tenantless row still authenticates (legacy never throws for context)', async () => {
      person.tenantId = null;
      const res = await get('/probe/required');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ kind: 'legacy', role: 'building_admin', tenantId: null });
    });

    it('GET /memberships/me answers 404', async () => {
      const res = await get('/memberships/me');
      expect(res.status).toBe(404);
    });
  });

  describe('authentication', () => {
    it("a validate() 401 short-circuits: 'keycloak' is never tried", async () => {
      person.status = UserStatus.INACTIVE;
      const res = await get('/probe/required');
      expect(res.status).toBe(401);
      expect(res.body.message).toBe('User is not active');
      expect(identityProvisioning.provisionFromToken).not.toHaveBeenCalled();
      expect(resolveSpy).not.toHaveBeenCalled();
    });

    it('an unknown person is 401 User not found', async () => {
      userRepository.findOne.mockResolvedValue(null);
      const res = await get('/probe/required');
      expect(res.status).toBe(401);
      expect(res.body.message).toBe('User not found');
    });

    it('no token is the generic 401', async () => {
      const res = await request(app.getHttpServer()).get('/probe/required');
      expect(res.status).toBe(401);
      expect(res.body.message).toBe('Authentication required');
    });

    it('a token no strategy accepts is the generic 401', async () => {
      const res = await request(app.getHttpServer())
        .get('/probe/required')
        .set('Authorization', 'Bearer not.a.token');
      expect(res.status).toBe(401);
      expect(identityProvisioning.provisionFromToken).not.toHaveBeenCalled();
    });

    it('loads the person without the tenant relation (the resolver loads the building)', async () => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'off';
      await get('/probe/required');
      expect(userRepository.findOne).toHaveBeenCalledWith({ where: { id: PERSON_ID } });
      expect(tenantRepository.findOne).toHaveBeenCalledWith({ where: { id: TOWER_A.id } });
    });

    it('never returns 401 for a 409 / 403 context answer (they are distinct)', async () => {
      const res = await get('/probe/required', FOREIGN_MEMBERSHIP);
      expect(res.status).not.toBe(401);
      expect(new UnauthorizedException().getStatus()).toBe(401);
    });
  });

  describe('CORS (AUTH-2)', () => {
    it('main.ts allows the X-Gate-Membership request header in the preflight', async () => {
      const source = fs.readFileSync(path.resolve(__dirname, '../../main.ts'), 'utf8');
      const match = source.match(/allowedHeaders:\s*\[([\s\S]*?)\]/);
      expect(match).not.toBeNull();
      const allowedHeaders = (match as RegExpMatchArray)[1]
        .split(',')
        .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
      expect(allowedHeaders).toContain('X-Gate-Membership');

      // The same list on a bare app answers the browser's preflight.
      const corsModule = await Test.createTestingModule({}).compile();
      const corsApp = corsModule.createNestApplication({ logger: false });
      corsApp.enableCors({
        origin: ['http://localhost:3000'],
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders,
        optionsSuccessStatus: 204,
      });
      await corsApp.init();
      const res = await request(corsApp.getHttpServer())
        .options('/anything')
        .set('Origin', 'http://localhost:3000')
        .set('Access-Control-Request-Method', 'GET')
        .set('Access-Control-Request-Headers', 'authorization,x-gate-membership');
      await corsApp.close();

      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-headers'].toLowerCase()).toContain(
        'x-gate-membership',
      );
    });
  });
});
