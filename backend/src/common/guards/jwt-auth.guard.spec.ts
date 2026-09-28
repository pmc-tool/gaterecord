import { ExecutionContext, HttpException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { User, UserRole } from '@database/entities/user.entity';
import { Tenant } from '@database/entities/tenant.entity';
import {
  ActingUser,
  ContextKind,
  ContextProblem,
  GATE_AUTHENTICATED,
  MembershipRequiredReason,
} from '../context/acting-user';
import { buildActingUser } from '../../modules/memberships/membership-context.service';
import { ContextOptional, ContextRequired } from '../decorators/context-optional.decorator';
import { Public } from '../decorators/public.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';

/**
 * AUTH-6: the C6 matrix in handleRequest, legacy passthrough, and the per-request
 * memo that neutralises controller-level @UseGuards(JwtAuthGuard) re-runs.
 * Passport itself is stubbed; the wired-up path is covered by
 * jwt-auth.guard.integration.spec.ts.
 */
const TENANT = '11111111-1111-4111-8111-111111111111';

class RequiredController {
  handler() {}
}

@ContextOptional()
class OptionalController {
  handler() {}

  @ContextRequired()
  requiredHandler() {}
}

class MixedController {
  @ContextOptional()
  optionalHandler() {}

  @Public()
  publicHandler() {}
}

function contextFor(
  cls: new () => object,
  method: string,
  request: Record<string | symbol, unknown> = {},
): ExecutionContext {
  const handler = (cls.prototype as Record<string, unknown>)[method] as () => void;
  return {
    getHandler: () => handler,
    getClass: () => cls,
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function acting(
  contextKind: ContextKind,
  options: {
    problem?: ContextProblem | null;
    reason?: MembershipRequiredReason | null;
    tenantId?: string | null;
  } = {},
): ActingUser {
  const tenantId =
    options.tenantId === undefined
      ? contextKind === 'membership'
        ? TENANT
        : null
      : options.tenantId;
  return buildActingUser(Object.assign(new User(), { id: 'p', role: UserRole.RESIDENT }), {
    contextKind,
    role: contextKind === 'none' ? null : UserRole.RESIDENT,
    tenantId,
    tenant: tenantId ? Object.assign(new Tenant(), { id: tenantId }) : null,
    unit: null,
    isSuperAdmin: false,
    contextProblem: options.problem ?? null,
    contextProblemReason: options.reason ?? null,
  });
}

function bodyOf(fn: () => unknown): { status: number; body: Record<string, unknown> } {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    const http = error as HttpException;
    return { status: http.getStatus(), body: http.getResponse() as Record<string, unknown> };
  }
  throw new Error('expected a throw');
}

describe('JwtAuthGuard (AUTH-6)', () => {
  let guard: JwtAuthGuard;

  beforeEach(() => {
    guard = new JwtAuthGuard(new Reflector());
  });

  afterEach(() => jest.restoreAllMocks());

  describe('handleRequest: authentication', () => {
    it('rethrows a strategy error verbatim', () => {
      const error = new UnauthorizedException('User is not active');
      expect(() =>
        guard.handleRequest(error, false, undefined, contextFor(RequiredController, 'handler')),
      ).toThrow(error);
    });

    it('gives the generic 401 without a user', () => {
      expect(() =>
        guard.handleRequest(null, false, undefined, contextFor(RequiredController, 'handler')),
      ).toThrow('Authentication required');
    });
  });

  describe('handleRequest: the C6 matrix on a required route', () => {
    const required = () => contextFor(RequiredController, 'handler');

    it('returns a membership context', () => {
      const user = acting('membership');
      expect(guard.handleRequest(null, user, undefined, required())).toBe(user);
    });

    it('returns the platform context', () => {
      const user = acting('platform');
      expect(guard.handleRequest(null, user, undefined, required())).toBe(user);
    });

    it('answers 403 MEMBERSHIP_INVALID (no reason) for an invalid header', () => {
      const { status, body } = bodyOf(() =>
        guard.handleRequest(
          null,
          acting('none', { problem: 'MEMBERSHIP_INVALID' }),
          undefined,
          required(),
        ),
      );
      expect(status).toBe(403);
      expect(body).toMatchObject({ code: 'MEMBERSHIP_INVALID' });
      expect(body).not.toHaveProperty('reason');
    });

    it.each<MembershipRequiredReason>(['NO_MEMBERSHIPS', 'AMBIGUOUS'])(
      'answers 409 MEMBERSHIP_REQUIRED %s',
      (reason) => {
        const { status, body } = bodyOf(() =>
          guard.handleRequest(
            null,
            acting('none', { problem: 'MEMBERSHIP_REQUIRED', reason }),
            undefined,
            required(),
          ),
        );
        expect(status).toBe(409);
        expect(body).toMatchObject({ code: 'MEMBERSHIP_REQUIRED', reason });
      },
    );

    it("answers 409 for a bare 'none' context", () => {
      const { status, body } = bodyOf(() =>
        guard.handleRequest(null, acting('none'), undefined, required()),
      );
      expect(status).toBe(409);
      expect(body).toMatchObject({ code: 'MEMBERSHIP_REQUIRED', reason: 'NO_MEMBERSHIPS' });
    });

    it("fails closed on a 'membership' context without a tenant (403)", () => {
      const { status, body } = bodyOf(() =>
        guard.handleRequest(null, acting('membership', { tenantId: null }), undefined, required()),
      );
      expect(status).toBe(403);
      expect(body).toMatchObject({ code: 'MEMBERSHIP_INVALID' });
    });

    it('treats a missing execution context as a required route', () => {
      expect(() =>
        guard.handleRequest(null, acting('none', { problem: 'MEMBERSHIP_REQUIRED' })),
      ).toThrow(HttpException);
    });

    it('honours @ContextRequired on a handler of an optional controller', () => {
      const { status } = bodyOf(() =>
        guard.handleRequest(
          null,
          acting('none', { problem: 'MEMBERSHIP_REQUIRED', reason: 'AMBIGUOUS' }),
          undefined,
          contextFor(OptionalController, 'requiredHandler'),
        ),
      );
      expect(status).toBe(409);
    });
  });

  describe('handleRequest: @ContextOptional routes accept any context', () => {
    const cases: Array<[string, ActingUser]> = [
      ['invalid', acting('none', { problem: 'MEMBERSHIP_INVALID' })],
      ['required', acting('none', { problem: 'MEMBERSHIP_REQUIRED', reason: 'AMBIGUOUS' })],
      ['none', acting('none')],
      ['membership', acting('membership')],
      ['platform', acting('platform')],
    ];

    it.each(cases)('class-level: %s', (_label, user) => {
      expect(
        guard.handleRequest(null, user, undefined, contextFor(OptionalController, 'handler')),
      ).toBe(user);
    });

    it.each(cases)('handler-level: %s', (_label, user) => {
      expect(
        guard.handleRequest(null, user, undefined, contextFor(MixedController, 'optionalHandler')),
      ).toBe(user);
    });
  });

  describe('handleRequest: legacy never throws for the context', () => {
    it('returns a legacy overlay even without a tenant', () => {
      const user = acting('legacy', { tenantId: null });
      expect(
        guard.handleRequest(null, user, undefined, contextFor(RequiredController, 'handler')),
      ).toBe(user);
    });

    it('returns a plain gate_users row (no overlay) untouched', () => {
      const row = Object.assign(new User(), { id: 'p', tenantId: null });
      expect(
        guard.handleRequest(null, row, undefined, contextFor(RequiredController, 'handler')),
      ).toBe(row);
    });
  });

  describe('canActivate: per-request memo', () => {
    function stubPassport(user: unknown) {
      const parent = Object.getPrototypeOf(JwtAuthGuard.prototype) as {
        canActivate: (context: ExecutionContext) => Promise<boolean>;
      };
      return jest.spyOn(parent, 'canActivate').mockImplementation(async (context) => {
        const req = context.switchToHttp().getRequest<Record<string, unknown>>();
        // What @nestjs/passport does: a NEW principal object on every run.
        req.user = typeof user === 'function' ? (user as () => unknown)() : user;
        return true;
      });
    }

    it('runs passport once per request; the re-run keeps the same req.user', async () => {
      const passport = stubPassport(() => acting('membership'));
      const request: Record<string | symbol, unknown> = {};
      const context = contextFor(RequiredController, 'handler', request);

      await expect(guard.canActivate(context)).resolves.toBe(true);
      const first = request.user;
      expect(request[GATE_AUTHENTICATED]).toBe(first);

      // The controller-level @UseGuards(JwtAuthGuard) re-run.
      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(passport).toHaveBeenCalledTimes(1);
      expect(request.user).toBe(first);
    });

    it('does not memoise a failed authentication', async () => {
      const parent = Object.getPrototypeOf(JwtAuthGuard.prototype) as {
        canActivate: (context: ExecutionContext) => Promise<boolean>;
      };
      const passport = jest
        .spyOn(parent, 'canActivate')
        .mockRejectedValue(new UnauthorizedException('Authentication required'));
      const request: Record<string | symbol, unknown> = {};
      const context = contextFor(RequiredController, 'handler', request);

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(passport).toHaveBeenCalledTimes(2);
      expect(request[GATE_AUTHENTICATED]).toBeUndefined();
    });

    it('re-authenticates when req.user was replaced after the memo', async () => {
      const passport = stubPassport(() => acting('membership'));
      const request: Record<string | symbol, unknown> = {};
      const context = contextFor(RequiredController, 'handler', request);

      await guard.canActivate(context);
      request.user = acting('membership');
      await guard.canActivate(context);
      expect(passport).toHaveBeenCalledTimes(2);
    });

    it('never authenticates a @Public route', async () => {
      const passport = stubPassport(() => acting('membership'));
      await expect(guard.canActivate(contextFor(MixedController, 'publicHandler'))).resolves.toBe(
        true,
      );
      expect(passport).not.toHaveBeenCalled();
    });

    it('turns a non-HTTP passport error into the generic 401', async () => {
      const parent = Object.getPrototypeOf(JwtAuthGuard.prototype) as {
        canActivate: (context: ExecutionContext) => Promise<boolean>;
      };
      jest
        .spyOn(parent, 'canActivate')
        .mockRejectedValue(new Error('Unknown authentication strategy "x"'));
      jest
        .spyOn((guard as unknown as { logger: { error: () => void } }).logger, 'error')
        .mockImplementation(() => undefined);

      await expect(guard.canActivate(contextFor(RequiredController, 'handler'))).rejects.toThrow(
        'Authentication required',
      );
    });
  });
});
