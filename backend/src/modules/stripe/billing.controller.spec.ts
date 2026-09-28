/**
 * PPL-16: every /billing/* handler bills the building the request ACTS IN, as
 * its building admin, and refuses before the service is called otherwise.
 *
 * Parametrised over all 18 BillingController handlers, with a jest double for
 * StripeService (no database, no Stripe). The principals are overlaid users as
 * the passport strategies build them.
 */
import 'reflect-metadata';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { User, UserRole } from '@database/entities/user.entity';
import {
  ACTING_USER_MARK,
  ContextKind,
  MembershipRequiredReason,
} from '@common/context/acting-user';
import { membershipErrorCodeOf } from '@common/context/membership-context.errors';
import { ROLES_KEY } from '@common/decorators/roles.decorator';
import { SUBSCRIPTION_EXEMPT_KEY } from '@common/decorators/subscription-exempt.decorator';
import { BillingCycle } from '@database/entities/tenant.entity';
import { BillingController, billingTenantId } from './stripe.controller';
import { StripeService } from './stripe.service';

const TENANT_A = '0a0a0a0a-0000-4000-8000-00000000000a';
const TENANT_D = '0d0d0d0d-0000-4000-8000-00000000000d';

function principal(overlay: {
  contextKind?: ContextKind;
  role: UserRole | null;
  tenantId: string | null;
  contextProblemReason?: MembershipRequiredReason | null;
}) {
  const user = Object.assign(new User(), {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'pat@example.test',
    role: overlay.role,
    tenantId: overlay.tenantId,
  });
  if (overlay.contextKind) {
    Object.assign(user, {
      contextKind: overlay.contextKind,
      contextProblem: overlay.contextProblemReason ? 'MEMBERSHIP_REQUIRED' : null,
      contextProblemReason: overlay.contextProblemReason ?? null,
      isSuperAdmin: overlay.role === UserRole.SUPER_ADMIN,
      [ACTING_USER_MARK]: true,
    });
  }
  return { user, query: {} as Record<string, string> };
}

function stripeServiceDouble() {
  return {
    createCheckoutSession: jest.fn(async () => ({ sessionId: 'cs', url: 'u' })),
    createSubscriptionIntent: jest.fn(async () => ({ clientSecret: 's' })),
    activateSubscriptionFromSetupIntent: jest.fn(async () => ({})),
    createPortalSession: jest.fn(async () => ({ url: 'u' })),
    getSubscriptionDetails: jest.fn(async () => null),
    cancelSubscription: jest.fn(async () => undefined),
    resumeSubscription: jest.fn(async () => undefined),
    pauseSubscription: jest.fn(async () => ({ pausedUntil: null })),
    unpauseSubscription: jest.fn(async () => ({ nextBillingDate: null })),
    getPauseStatus: jest.fn(async () => ({})),
    calculateProratedRefund: jest.fn(async () => ({})),
    getRefundHistory: jest.fn(async () => ({})),
    createRefund: jest.fn(async () => ({ amountFormatted: '$1.00' })),
    getTenantPaymentHistory: jest.fn(async () => ({})),
    getTenantInvoices: jest.fn(async () => ({})),
    getAvailablePlans: jest.fn(async () => ({})),
    previewPlanChange: jest.fn(async () => ({})),
    changePlan: jest.fn(async () => ({})),
  };
}

type Double = ReturnType<typeof stripeServiceDouble>;
type Req = ReturnType<typeof principal>;

const planChange = { newPlanId: 'plan-2', billingCycle: BillingCycle.MONTHLY };

// [handler, call, the StripeService method it must reach]
const handlers: Array<
  [keyof BillingController, (c: BillingController, r: Req) => Promise<unknown>, keyof Double]
> = [
  [
    'createCheckoutSession',
    (c, r) => c.createCheckoutSession(r, { planId: 'p' } as never),
    'createCheckoutSession',
  ],
  [
    'createSubscriptionIntent',
    (c, r) => c.createSubscriptionIntent(r, { planId: 'p' } as never),
    'createSubscriptionIntent',
  ],
  [
    'activateSubscription',
    (c, r) => c.activateSubscription(r, { setupIntentId: 'seti' }),
    'activateSubscriptionFromSetupIntent',
  ],
  ['createPortalSession', (c, r) => c.createPortalSession(r, {} as never), 'createPortalSession'],
  ['getSubscription', (c, r) => c.getSubscription(r), 'getSubscriptionDetails'],
  ['cancelSubscription', (c, r) => c.cancelSubscription(r, {} as never), 'cancelSubscription'],
  ['resumeSubscription', (c, r) => c.resumeSubscription(r), 'resumeSubscription'],
  ['pauseSubscription', (c, r) => c.pauseSubscription(r, {} as never), 'pauseSubscription'],
  ['unpauseSubscription', (c, r) => c.unpauseSubscription(r, {} as never), 'unpauseSubscription'],
  ['getPauseStatus', (c, r) => c.getPauseStatus(r), 'getPauseStatus'],
  ['calculateRefund', (c, r) => c.calculateRefund(r), 'calculateProratedRefund'],
  ['getRefundHistory', (c, r) => c.getRefundHistory(r), 'getRefundHistory'],
  ['requestRefund', (c, r) => c.requestRefund(r, {}), 'createRefund'],
  ['getPaymentHistory', (c, r) => c.getPaymentHistory(r), 'getTenantPaymentHistory'],
  ['getInvoices', (c, r) => c.getInvoices(r), 'getTenantInvoices'],
  ['getAvailablePlans', (c, r) => c.getAvailablePlans(r), 'getAvailablePlans'],
  ['previewPlanChange', (c, r) => c.previewPlanChange(r, planChange as never), 'previewPlanChange'],
  ['changePlan', (c, r) => c.changePlan(r, planChange as never), 'changePlan'],
];

describe('BillingController acts on the active building_admin context (PPL-16)', () => {
  let stripe: Double;
  let controller: BillingController;

  beforeEach(() => {
    stripe = stripeServiceDouble();
    controller = new BillingController(stripe as unknown as StripeService);
  });

  it('covers all 18 handlers', () => {
    expect(handlers).toHaveLength(18);
  });

  it('the controller stays subscription-exempt (D6: a suspended admin can still pay)', () => {
    expect(Reflect.getMetadata(SUBSCRIPTION_EXEMPT_KEY, BillingController)).toBe(true);
  });

  describe.each(handlers)('%s', (name, call, serviceMethod) => {
    it('is @Roles(BUILDING_ADMIN) only (super admins bill through /admin/stripe)', () => {
      const handler = BillingController.prototype[name] as unknown as object;
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([UserRole.BUILDING_ADMIN]);
    });

    it('409 MEMBERSHIP_REQUIRED without a chosen building; the service is not called', async () => {
      const req = principal({
        contextKind: 'none',
        role: null,
        tenantId: null,
        contextProblemReason: 'AMBIGUOUS',
      });

      const error = await call(controller, req).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect(membershipErrorCodeOf(error)).toBe('MEMBERSHIP_REQUIRED');
      expect(stripe[serviceMethod]).not.toHaveBeenCalled();
    });

    it('409 for a tenantless legacy row (null never reaches billing)', async () => {
      const error = await call(
        controller,
        principal({ role: UserRole.BUILDING_ADMIN, tenantId: null }),
      ).catch((e: unknown) => e);

      expect(membershipErrorCodeOf(error)).toBe('MEMBERSHIP_REQUIRED');
      expect(stripe[serviceMethod]).not.toHaveBeenCalled();
    });

    it('403 ROLE_NOT_ALLOWED_IN_BUILDING for a resident context', async () => {
      const req = principal({
        contextKind: 'membership',
        role: UserRole.RESIDENT,
        tenantId: TENANT_D,
      });

      const error = await call(controller, req).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ForbiddenException);
      expect(membershipErrorCodeOf(error)).toBe('ROLE_NOT_ALLOWED_IN_BUILDING');
      expect(stripe[serviceMethod]).not.toHaveBeenCalled();
    });

    it('the admin of A and D acting in D bills D', async () => {
      const req = principal({
        contextKind: 'membership',
        role: UserRole.BUILDING_ADMIN,
        tenantId: TENANT_D,
      });

      await call(controller, req);

      expect(stripe[serviceMethod]).toHaveBeenCalledTimes(1);
      expect((stripe[serviceMethod] as jest.Mock).mock.calls[0][0]).toBe(TENANT_D);
      expect((stripe[serviceMethod] as jest.Mock).mock.calls[0][0]).not.toBe(TENANT_A);
    });
  });

  it('billingTenantId: a platform super admin gets 409, never a building', () => {
    const { user } = principal({
      contextKind: 'platform',
      role: UserRole.SUPER_ADMIN,
      tenantId: null,
    });

    expect(() => billingTenantId({ user })).toThrow(ConflictException);
  });

  it('billingTenantId: the legacy single-building admin keeps working (flag off)', () => {
    const { user } = principal({ role: UserRole.BUILDING_ADMIN, tenantId: TENANT_A });

    expect(billingTenantId({ user })).toBe(TENANT_A);
  });
});
