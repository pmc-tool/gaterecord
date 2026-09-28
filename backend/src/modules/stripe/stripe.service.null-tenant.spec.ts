/**
 * SEC-4 — StripeService null-tenant guards.
 *
 * Pure unit tests (every dependency is a jest mock, no database, no Stripe
 * network). Each tenant-scoped method must refuse a null or empty tenantId with
 * 400 TENANT_REQUIRED before touching a repository or the Stripe client, because
 * TypeORM drops a null where-value instead of matching nothing.
 */
import { BadRequestException } from '@nestjs/common';
import { StripeService } from './stripe.service';
import { BillingCycle } from '@database/entities/tenant.entity';

type RepoMock = Record<string, jest.Mock> & { manager?: Record<string, jest.Mock> };

function makeRepo(): RepoMock {
  const repo: RepoMock = {
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
    findAndCount: jest.fn().mockResolvedValue([[], 0]),
    count: jest.fn().mockResolvedValue(0),
    save: jest.fn(),
    update: jest.fn(),
    create: jest.fn(),
  };
  repo.manager = { count: jest.fn().mockResolvedValue(0) };
  return repo;
}

describe('StripeService — null-tenant guards (SEC-4)', () => {
  let service: StripeService;
  let repos: Record<'plan' | 'tenant' | 'user' | 'audit' | 'payment', RepoMock>;
  let stripeTouched: string[];

  beforeEach(() => {
    repos = {
      plan: makeRepo(),
      tenant: makeRepo(),
      user: makeRepo(),
      audit: makeRepo(),
      payment: makeRepo(),
    };

    service = new StripeService(
      { get: jest.fn() } as never,
      { emit: jest.fn() } as never,
      {} as never,
      repos.plan as never,
      repos.tenant as never,
      repos.user as never,
      repos.audit as never,
      repos.payment as never,
      // MembershipsService and MembershipLifecycleService: not reached by any
      // tenant-scoped billing method.
      {} as never,
      {} as never,
    );

    // A configured Stripe client that records any access, so a guard that ran
    // too late (after a Stripe call) is caught as well as one after a query.
    stripeTouched = [];
    (service as unknown as { stripe: unknown }).stripe = new Proxy(
      {},
      {
        get: (_target, prop) => {
          stripeTouched.push(String(prop));
          throw new Error(`Stripe client touched: ${String(prop)}`);
        },
      },
    );
  });

  const plan = { id: 'plan-1' };

  // [method name, (tenantId) => call]
  const cases: Array<[string, (tenantId: string) => Promise<unknown>]> = [
    ['createCheckoutSession', (t) => service.createCheckoutSession(t, {} as never)],
    ['createSubscriptionIntent', (t) => service.createSubscriptionIntent(t, {} as never)],
    ['createPortalSession', (t) => service.createPortalSession(t)],
    ['getSubscriptionDetails', (t) => service.getSubscriptionDetails(t)],
    ['cancelSubscription', (t) => service.cancelSubscription(t)],
    ['resumeSubscription', (t) => service.resumeSubscription(t)],
    ['pauseSubscription', (t) => service.pauseSubscription(t)],
    ['unpauseSubscription', (t) => service.unpauseSubscription(t)],
    ['getPauseStatus', (t) => service.getPauseStatus(t)],
    ['getAvailablePlans', (t) => service.getAvailablePlans(t)],
    ['previewPlanChange', (t) => service.previewPlanChange(t, 'plan-1', BillingCycle.MONTHLY)],
    ['changePlan', (t) => service.changePlan(t, 'plan-1', BillingCycle.MONTHLY)],
    [
      'activateSubscriptionFromSetupIntent',
      (t) => service.activateSubscriptionFromSetupIntent(t, 'seti_123'),
    ],
    ['createRefund', (t) => service.createRefund(t, {} as never)],
    ['calculateProratedRefund', (t) => service.calculateProratedRefund(t)],
    ['getRefundHistory', (t) => service.getRefundHistory(t)],
    ['getTenantPaymentHistory', (t) => service.getTenantPaymentHistory(t)],
    ['getTenantInvoices', (t) => service.getTenantInvoices(t)],
    [
      'assertUsageFitsPlan',
      (t) =>
        (
          service as unknown as {
            assertUsageFitsPlan: (tenantId: string, p: unknown) => Promise<void>;
          }
        ).assertUsageFitsPlan(t, plan),
    ],
  ];

  it('covers all 19 tenant-scoped methods', () => {
    expect(cases).toHaveLength(19);
  });

  describe.each([
    ['null', null],
    ['empty string', ''],
  ])('with a %s tenantId', (_label, tenantId) => {
    it.each(cases)(
      '%s throws 400 TENANT_REQUIRED before any repository call',
      async (_name, call) => {
        const error = await call(tenantId as unknown as string).then(
          () => undefined,
          (err: unknown) => err,
        );

        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).getResponse()).toEqual(
          expect.objectContaining({ code: 'TENANT_REQUIRED' }),
        );

        for (const repo of Object.values(repos)) {
          for (const [key, fn] of Object.entries(repo)) {
            if (key === 'manager') continue;
            expect(fn).not.toHaveBeenCalled();
          }
          for (const fn of Object.values(repo.manager ?? {})) {
            expect(fn).not.toHaveBeenCalled();
          }
        }
        expect(stripeTouched).toEqual([]);
      },
    );
  });

  describe('tenant-scoped behaviour is unchanged', () => {
    const TENANT = '11111111-1111-4111-8111-111111111111';

    it('getTenantPaymentHistory still filters by the given tenant', async () => {
      await service.getTenantPaymentHistory(TENANT);

      expect(repos.payment.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenantId: TENANT } }),
      );
    });

    it('getPauseStatus still looks the tenant up by id', async () => {
      await expect(service.getPauseStatus(TENANT)).rejects.toThrow('Tenant not found');

      expect(repos.tenant.findOne).toHaveBeenCalledWith({ where: { id: TENANT } });
    });
  });
});
