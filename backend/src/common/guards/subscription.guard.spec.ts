import { ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { User, UserRole } from '@database/entities/user.entity';
import { Tenant, TenantStatus } from '@database/entities/tenant.entity';
import { ActingUser, ContextKind } from '../context/acting-user';
import { buildActingUser } from '../../modules/memberships/membership-context.service';
import { ContextOptional } from '../decorators/context-optional.decorator';
import { Public } from '../decorators/public.decorator';
import { SubscriptionExempt } from '../decorators/subscription-exempt.decorator';
import { NotificationController } from '../../modules/notification/notification.controller';
import { UsersController } from '../../modules/users/users.controller';
import { SUBSCRIPTION_INACTIVE_CODE, SubscriptionGuard } from './subscription.guard';

/**
 * AUTH-8: tenant status x method x principal x route marks.
 *
 * The oracle below is the rule in words; every combination is checked against
 * it, so a change to the guard that is not also a change to the rule fails.
 */
type Mark = 'none' | 'public' | 'exempt' | 'optional';
type TenantState = 'active' | 'trial' | 'suspended' | 'pending_payment' | 'paused' | 'absent';
type Principal =
  | 'legacy-admin'
  | 'legacy-super-admin'
  | 'legacy-tenantless'
  | 'plain-row'
  | 'membership'
  | 'platform'
  | 'none-required'
  | 'none-invalid';

class Routes {
  @Public() publicRoute() {}
  @SubscriptionExempt() exemptRoute() {}
  @ContextOptional() optionalRoute() {}
  plainRoute() {}
}

const HANDLERS: Record<Mark, string> = {
  none: 'plainRoute',
  public: 'publicRoute',
  exempt: 'exemptRoute',
  optional: 'optionalRoute',
};

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

function tenantFor(state: TenantState): Tenant | null {
  if (state === 'absent') return null;
  return Object.assign(new Tenant(), {
    id: TENANT_ID,
    status: state === 'paused' ? TenantStatus.ACTIVE : (state as TenantStatus),
    isPaused: state === 'paused',
  });
}

function overlay(kind: ContextKind, tenant: Tenant | null, extra: Partial<ActingUser> = {}) {
  return buildActingUser(Object.assign(new User(), { id: 'p', role: UserRole.RESIDENT }), {
    contextKind: kind,
    role: kind === 'none' ? null : kind === 'platform' ? UserRole.SUPER_ADMIN : UserRole.RESIDENT,
    tenantId: tenant?.id ?? null,
    tenant,
    unit: null,
    isSuperAdmin: kind === 'platform',
    contextProblem: extra.contextProblem ?? null,
    contextProblemReason: extra.contextProblemReason ?? null,
  });
}

function principal(kind: Principal, tenant: Tenant | null): unknown {
  switch (kind) {
    case 'legacy-admin':
      return overlay('legacy', tenant);
    case 'legacy-super-admin':
      return Object.assign(overlay('legacy', tenant), { role: UserRole.SUPER_ADMIN });
    case 'legacy-tenantless':
      return overlay('legacy', null);
    case 'plain-row':
      return Object.assign(new User(), {
        role: UserRole.BUILDING_ADMIN,
        tenantId: tenant?.id ?? null,
        tenant,
      });
    case 'membership':
      return overlay('membership', tenant);
    case 'platform':
      return overlay('platform', null);
    case 'none-required':
      return overlay('none', null, {
        contextProblem: 'MEMBERSHIP_REQUIRED',
        contextProblemReason: 'AMBIGUOUS',
      });
    case 'none-invalid':
      return overlay('none', null, { contextProblem: 'MEMBERSHIP_INVALID' });
  }
}

/** The principals of legacy mode (GATE_MEMBERSHIP_CONTEXT off). */
const LEGACY_PRINCIPALS: readonly Principal[] = [
  'legacy-admin',
  'legacy-super-admin',
  'legacy-tenantless',
  'plain-row',
];

/** The rule, in words. Returns 'allow' or the expected HTTP status. */
function expected(
  mark: Mark,
  who: Principal,
  state: TenantState,
  method: string,
): 'allow' | number {
  if (mark === 'public' || mark === 'exempt') return 'allow';
  // @ContextOptional exempts only a membership-context principal; legacy mode
  // gates those routes exactly as before (flag off is unchanged, L6).
  if (mark === 'optional' && !LEGACY_PRINCIPALS.includes(who)) return 'allow';
  const inactive = state === 'suspended' || state === 'pending_payment' || state === 'paused';
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(method);

  switch (who) {
    case 'platform':
      return 'allow';
    case 'none-required':
      return 409;
    case 'none-invalid':
      return 403;
    case 'membership':
      if (state === 'absent') return 403; // fail closed
      return inactive && write ? 402 : 'allow';
    case 'legacy-super-admin':
    case 'legacy-tenantless':
      return 'allow';
    default:
      // legacy / plain row: fail open without a tenant
      if (state === 'absent') return 'allow';
      return inactive && write ? 402 : 'allow';
  }
}

function contextFor(mark: Mark, request: unknown): ExecutionContext {
  return {
    getHandler: () => (Routes.prototype as unknown as Record<string, () => void>)[HANDLERS[mark]],
    getClass: () => Routes,
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function outcome(guard: SubscriptionGuard, context: ExecutionContext): 'allow' | number {
  try {
    return guard.canActivate(context) ? 'allow' : 0;
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    return (error as HttpException).getStatus();
  }
}

describe('SubscriptionGuard (AUTH-8)', () => {
  const guard = new SubscriptionGuard(new Reflector());
  const marks: Mark[] = ['none', 'public', 'exempt', 'optional'];
  const principals: Principal[] = [
    'legacy-admin',
    'legacy-super-admin',
    'legacy-tenantless',
    'plain-row',
    'membership',
    'platform',
    'none-required',
    'none-invalid',
  ];
  const states: TenantState[] = [
    'active',
    'trial',
    'suspended',
    'pending_payment',
    'paused',
    'absent',
  ];
  const methods = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'];

  const matrix: Array<[Mark, Principal, TenantState, string]> = [];
  for (const mark of marks)
    for (const who of principals)
      for (const state of states)
        for (const method of methods) matrix.push([mark, who, state, method]);

  it.each(matrix)('%s route, %s, tenant %s, %s', (mark, who, state, method) => {
    const request = { method, user: principal(who, tenantFor(state)) };
    expect(outcome(guard, contextFor(mark, request))).toBe(expected(mark, who, state, method));
  });

  it('allows a request without a user (JwtAuthGuard already decided)', () => {
    expect(outcome(guard, contextFor('none', { method: 'POST' }))).toBe('allow');
    expect(outcome(guard, contextFor('none', undefined))).toBe('allow');
  });

  it('keeps the 402 body stable', () => {
    const request = { method: 'POST', user: principal('membership', tenantFor('suspended')) };
    try {
      guard.canActivate(contextFor('none', request));
      throw new Error('expected 402');
    } catch (error) {
      expect((error as HttpException).getResponse()).toMatchObject({
        code: SUBSCRIPTION_INACTIVE_CODE,
        status: TenantStatus.SUSPENDED,
      });
    }
  });

  describe('@ContextOptional person-level writes (AUTHCTX-2)', () => {
    // The five writes that were @ContextOptional but not @SubscriptionExempt
    // before this change, on their real controllers.
    const routes: Array<[string, object, string, string]> = [
      ['PATCH /users/profile', UsersController, 'updateProfile', 'PATCH'],
      ['POST /users/profile/upload-image', UsersController, 'uploadProfileImage', 'POST'],
      ['POST /notifications/mark-read', NotificationController, 'markAsRead', 'POST'],
      ['POST /notifications/mark-all-read', NotificationController, 'markAllAsRead', 'POST'],
      ['DELETE /notifications/:id', NotificationController, 'delete', 'DELETE'],
    ];

    const routeContext = (controller: object, handler: string, request: unknown) =>
      ({
        getHandler: () =>
          (controller as { prototype: Record<string, () => void> }).prototype[handler],
        getClass: () => controller,
        getType: () => 'http',
        switchToHttp: () => ({ getRequest: () => request }),
      }) as unknown as ExecutionContext;

    it.each(routes)(
      'flag off, suspended building: %s still gets 402, as before',
      (_label, controller, handler, method) => {
        const request = { method, user: principal('legacy-admin', tenantFor('suspended')) };
        expect(outcome(guard, routeContext(controller, handler, request))).toBe(402);
      },
    );

    it.each(routes)(
      'flag on, acting in a suspended building: %s is person-level and passes',
      (_label, controller, handler, method) => {
        const request = { method, user: principal('membership', tenantFor('suspended')) };
        expect(outcome(guard, routeContext(controller, handler, request))).toBe('allow');
      },
    );
  });

  describe('membership context examples (flag on)', () => {
    it('an admin of suspended A acting as security of active C can POST in C', () => {
      const towerC = tenantFor('active') as Tenant;
      const securityOfC = buildActingUser(
        // The person row still mirrors their suspended building A.
        Object.assign(new User(), {
          id: 'x',
          role: UserRole.BUILDING_ADMIN,
          tenantId: 'aaaaaaaa-0000-4000-8000-00000000000a',
          tenant: tenantFor('suspended'),
        }),
        {
          contextKind: 'membership',
          role: UserRole.SECURITY,
          tenantId: towerC.id,
          tenant: towerC,
          unit: null,
          isSuperAdmin: false,
        },
      );
      expect(outcome(guard, contextFor('none', { method: 'POST', user: securityOfC }))).toBe(
        'allow',
      );
    });

    it('a resident POST in suspended B gets 402', () => {
      const towerB = tenantFor('suspended') as Tenant;
      const residentOfB = buildActingUser(
        Object.assign(new User(), {
          id: 'x',
          role: UserRole.BUILDING_ADMIN,
          tenantId: 'aaaaaaaa-0000-4000-8000-00000000000a',
          tenant: tenantFor('active'),
        }),
        {
          contextKind: 'membership',
          role: UserRole.RESIDENT,
          tenantId: towerB.id,
          tenant: towerB,
          unit: '4C',
          isSuperAdmin: false,
        },
      );
      expect(outcome(guard, contextFor('none', { method: 'POST', user: residentOfB }))).toBe(402);
    });

    it('a super admin acting in a suspended building of their own is gated like anyone', () => {
      const suspended = tenantFor('suspended') as Tenant;
      const superAdminAsResident = buildActingUser(
        Object.assign(new User(), { id: 'x', role: UserRole.SUPER_ADMIN }),
        {
          contextKind: 'membership',
          role: UserRole.RESIDENT,
          tenantId: suspended.id,
          tenant: suspended,
          unit: null,
          isSuperAdmin: true,
        },
      );
      expect(
        outcome(guard, contextFor('none', { method: 'DELETE', user: superAdminAsResident })),
      ).toBe(402);
    });
  });
});
