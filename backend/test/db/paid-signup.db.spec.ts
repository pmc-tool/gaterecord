import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import Stripe from 'stripe';
import { AuthController } from '../../src/modules/auth/auth.controller';
import { AuthService } from '../../src/modules/auth/auth.service';
import { MembershipsService } from '../../src/modules/memberships/memberships.service';
import { MembershipContextService } from '../../src/modules/memberships/membership-context.service';
import { MembershipLifecycleService } from '../../src/modules/people/membership-lifecycle.service';
import { AccountIdentityClient } from '../../src/modules/account-identity/account-identity.client';
import { EmailService } from '../../src/modules/notification/email.service';
import {
  PAID_SIGNUP_LOGIN_WINDOW_MINUTES,
  SIGNUP_SETTINGS,
  StripeService,
} from '../../src/modules/stripe/stripe.service';
import { Membership } from '../../src/database/entities/membership.entity';
import { Payment } from '../../src/database/entities/payment.entity';
import { SubscriptionAuditLog } from '../../src/database/entities/subscription-audit-log.entity';
import { SubscriptionPlan } from '../../src/database/entities/subscription-plan.entity';
import { Tenant } from '../../src/database/entities/tenant.entity';
import { User } from '../../src/database/entities/user.entity';
import { RefreshToken } from '../../src/database/entities/refresh-token.entity';
import { LoginHistory } from '../../src/database/entities/login-history.entity';
import { PasswordResetToken } from '../../src/database/entities/password-reset-token.entity';
import { createTestDataSource, describeDb, rebuildSchema } from './test-data-source';
import { makePlan } from './fixtures';

/**
 * Paid signup against Postgres (AUTHCTX-1, DATA-4): the SQL the unit spec
 * (src/modules/stripe/stripe-signup.spec.ts) answers from memory.
 *   - POST /auth/verify-payment signs the created person in ONCE, through one
 *     UPDATE ... WHERE claim on the tenant row, and only within
 *     PAID_SIGNUP_LOGIN_WINDOW_MINUTES of the building's creation (now() on
 *     the database);
 *   - a replayed checkout session finds its building by the session id even
 *     after the tenant's subscription id changed, so it never creates another.
 * Skipped without TEST_DATABASE_URL.
 */
describeDb('paid signup: single-use login and replay lookup (database)', () => {
  const originalFlag = process.env.GATE_MEMBERSHIP_CONTEXT;
  const request = { headers: { 'user-agent': 'jest' }, ip: '127.0.0.1' } as never;
  let dataSource: DataSource;
  let plan: SubscriptionPlan;
  let stripe: StripeService;
  let controller: AuthController;
  let sessions: Map<string, Stripe.Checkout.Session>;

  beforeAll(async () => {
    dataSource = await createTestDataSource();
    await rebuildSchema(dataSource);
    plan = await makePlan(dataSource, { name: `Pro-${randomUUID().slice(0, 6)}` });

    const config = {
      get: (_key: string, fallback?: unknown) => fallback,
    } as unknown as ConfigService;
    const email = {
      sendWelcomeEmail: jest.fn(async () => true),
      sendAddedToBuildingEmail: jest.fn(async () => true),
    } as unknown as EmailService;
    const memberships = new MembershipsService(dataSource);
    const lifecycle = new MembershipLifecycleService(
      dataSource,
      memberships,
      {} as AccountIdentityClient,
      email,
      config,
    );

    stripe = new StripeService(
      config,
      { emit: () => true } as never,
      email,
      dataSource.getRepository(SubscriptionPlan),
      dataSource.getRepository(Tenant),
      dataSource.getRepository(User),
      dataSource.getRepository(SubscriptionAuditLog),
      dataSource.getRepository(Payment),
      memberships,
      lifecycle,
    );
    // The Stripe API double: completed sessions stay retrievable, as at Stripe.
    sessions = new Map();
    (stripe as unknown as { stripe: unknown }).stripe = {
      subscriptions: { retrieve: async () => ({ current_period_end: 1_900_000_000 }) },
      checkout: {
        sessions: {
          retrieve: async (id: string) => {
            const session = sessions.get(id);
            if (!session) throw new Error(`No such checkout session: ${id}`);
            return session;
          },
        },
      },
    };

    const auth = new AuthService(
      dataSource.getRepository(User),
      dataSource.getRepository(RefreshToken),
      dataSource.getRepository(Tenant),
      dataSource.getRepository(SubscriptionPlan),
      dataSource.getRepository(LoginHistory),
      dataSource.getRepository(PasswordResetToken),
      new JwtService({ secret: 'db-spec-secret', signOptions: { expiresIn: '1h' } }),
      config,
      email,
      dataSource,
      memberships,
      new MembershipContextService(memberships, dataSource.getRepository(Tenant)),
    );
    controller = new AuthController(auth, stripe);
  });

  beforeEach(() => {
    process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
  });

  afterAll(async () => {
    process.env.GATE_MEMBERSHIP_CONTEXT = originalFlag;
    await dataSource?.destroy();
  });

  /** A paid signup Checkout Session for a brand-new email and building. */
  function paidSignupSession(): Stripe.Checkout.Session {
    const handle = randomUUID().slice(0, 8);
    const session = {
      id: `cs_test_${randomUUID()}`,
      object: 'checkout.session',
      payment_status: 'paid',
      customer: `cus_${handle}`,
      subscription: `sub_${handle}`,
      metadata: {
        type: 'signup',
        firstName: 'Nia',
        lastName: 'Buyer',
        email: `buyer-${handle}@example.test`,
        passwordHash: 'hash-from-checkout',
        buildingName: `Paid Tower ${handle}`,
        planId: plan.id,
        billingCycle: 'monthly',
      },
    } as unknown as Stripe.Checkout.Session;
    sessions.set(session.id, session);
    return session;
  }

  const verify = (session: Stripe.Checkout.Session) =>
    controller.verifyPayment({ sessionId: session.id }, request);

  const refusal = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(UnauthorizedException);
    expect((error as Error).message).toBe('Sign in to continue');
  };

  const buildingOf = (session: Stripe.Checkout.Session) =>
    dataSource
      .getRepository(Tenant)
      .createQueryBuilder('tenant')
      .withDeleted()
      .where(`tenant.settings ->> '${SIGNUP_SETTINGS.sessionId}' = :id`, { id: session.id })
      .getMany();

  const ageBuilding = (tenantId: string, minutes: number) =>
    dataSource.query(
      `UPDATE tenants SET created_at = now() - make_interval(mins => $2) WHERE id = $1`,
      [tenantId, minutes],
    );

  describe('POST /auth/verify-payment (AUTHCTX-1)', () => {
    it('signs the created person in once; replaying the session id is 401', async () => {
      const session = paidSignupSession();

      const first = await verify(session);
      expect(first.accessToken).toEqual(expect.any(String));

      const [tower] = await buildingOf(session);
      expect(first.user).toMatchObject({ email: session.metadata?.email });
      expect(tower.settings).toMatchObject({
        [SIGNUP_SETTINGS.createdUserId]: first.user.id,
        [SIGNUP_SETTINGS.loginConsumedAt]: expect.any(String),
      });

      // The session is still paid at Stripe and the building still records its
      // creator: only the claim refuses the replay.
      await refusal(verify(session));
      expect(await buildingOf(session)).toHaveLength(1);
    });

    it('two concurrent calls with the same session id: exactly one gets tokens', async () => {
      const session = paidSignupSession();

      const outcomes = await Promise.allSettled([verify(session), verify(session)]);

      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      const [rejected] = outcomes.filter(
        (o): o is PromiseRejectedResult => o.status === 'rejected',
      );
      expect(rejected.reason).toBeInstanceOf(UnauthorizedException);
      expect(await buildingOf(session)).toHaveLength(1);
    });

    it(`a building older than ${PAID_SIGNUP_LOGIN_WINDOW_MINUTES} minutes gets 401 even for its first login`, async () => {
      const session = paidSignupSession();
      const provisioned = await stripe.provisionPaidSignup(session);
      const tenantId = provisioned!.tenant.id;

      await ageBuilding(tenantId, PAID_SIGNUP_LOGIN_WINDOW_MINUTES + 1);
      await refusal(verify(session));
      const [stale] = await buildingOf(session);
      expect(stale.settings).not.toHaveProperty(SIGNUP_SETTINGS.loginConsumedAt);

      // Inside the window the same first login still works.
      await ageBuilding(tenantId, PAID_SIGNUP_LOGIN_WINDOW_MINUTES - 1);
      await expect(verify(session)).resolves.toMatchObject({ accessToken: expect.any(String) });
    });
  });

  describe('replaying a paid signup after its subscription id changed (DATA-4)', () => {
    it('finds the building by the session id: no second building, no second membership', async () => {
      const session = paidSignupSession();
      const first = await stripe.provisionPaidSignup(session);
      const tenantId = first!.tenant.id;

      // Cancelled since (handleSubscriptionDeleted clears the id) and renamed,
      // so neither the subscription nor the unique name catches the replay.
      await dataSource
        .getRepository(Tenant)
        .update(tenantId, { stripeSubscriptionId: null as never, name: `Renamed ${tenantId}` });

      const replay = await stripe.provisionPaidSignup(session);
      expect(replay).toMatchObject({ created: false, tenant: { id: tenantId } });
      expect(replay?.signupCreatedUserId).toBe(first!.signupCreatedUserId);

      // Re-subscribed under another subscription id: the same building again.
      await dataSource
        .getRepository(Tenant)
        .update(tenantId, { stripeSubscriptionId: `sub_other_${randomUUID().slice(0, 8)}` });
      await expect(stripe.provisionPaidSignup(session)).resolves.toMatchObject({
        created: false,
        tenant: { id: tenantId },
      });

      expect(await buildingOf(session)).toHaveLength(1);
      const buyer = await dataSource
        .getRepository(User)
        .findOneOrFail({ where: { email: String(session.metadata?.email) } });
      const held = await dataSource.getRepository(Membership).find({ where: { userId: buyer.id } });
      expect(held.map((m) => m.tenantId)).toEqual([tenantId]);
    });

    it('still finds the building by its subscription id', async () => {
      const session = paidSignupSession();
      const first = await stripe.provisionPaidSignup(session);

      // Another session for the same subscription (Stripe never does this for a
      // signup, but the subscription id alone must still match).
      const sameSubscription = {
        ...session,
        id: `cs_test_${randomUUID()}`,
      } as Stripe.Checkout.Session;
      await expect(stripe.provisionPaidSignup(sameSubscription)).resolves.toMatchObject({
        created: false,
        tenant: { id: first!.tenant.id },
      });
    });
  });
});
