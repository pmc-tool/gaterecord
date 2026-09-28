/**
 * PPL-17 / PPL-18: idempotent paid-signup provisioning, and signing in after
 * payment only as the person that signup created.
 *
 * The REAL StripeService, MembershipsService and MembershipLifecycleService run
 * over the in-memory RollbackPeopleManager; the Stripe client is a double. The
 * verify-payment login runs the real AuthController and AuthService (F2's
 * harness) with the membership lookup answered from the same in-memory rows.
 * The advisory lock itself (two concurrent calls) needs Postgres; here its
 * query is recorded and the unique-violation fallback is simulated.
 */
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QueryFailedError, Repository } from 'typeorm';
import Stripe from 'stripe';
import { Membership } from '@database/entities/membership.entity';
import { SubscriptionPlan } from '@database/entities/subscription-plan.entity';
import { Tenant, TenantStatus } from '@database/entities/tenant.entity';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import { membershipErrorCodeOf } from '@common/context/membership-context.errors';
import { AuthController } from '../auth/auth.controller';
import { AuthHarness, buildAuthService } from '../auth/auth.service.spec-harness';
import { EmailService } from '../notification/email.service';
import { peopleFixtures } from '../people/people.spec-harness';
import { MembershipStack, buildMembershipStack } from '../tenants/tenant-lifecycle.spec-harness';
import { SIGNUP_SETTINGS, StripeService } from './stripe.service';

const SUBSCRIPTION = 'sub_signup_1';

function signupSession(overrides: Partial<Stripe.Checkout.Session['metadata']> = {}) {
  return {
    id: 'cs_signup_1',
    object: 'checkout.session',
    payment_status: 'paid',
    amount_total: 0,
    customer: 'cus_1',
    subscription: SUBSCRIPTION,
    metadata: {
      type: 'signup',
      firstName: 'Nia',
      lastName: 'Buyer',
      email: 'Nia.Buyer@Example.test',
      passwordHash: 'hash-from-checkout',
      phone: '555',
      buildingName: 'Paid Tower',
      buildingAddress: '9 Paid Street',
      planId: '',
      billingCycle: 'monthly',
      ...overrides,
    },
  } as unknown as Stripe.Checkout.Session;
}

/**
 * loginAfterPaidSignup's single-use claim (one UPDATE ... WHERE on the tenant
 * row), answered from the in-memory row: it succeeds once, for the person the
 * signup recorded. The time window is SQL on the database clock, so it is
 * covered with the real statement in test/db/paid-signup.db.spec.ts.
 */
function claimOver(stack: MembershipStack) {
  const params: Record<string, unknown> = {};
  const qb: Record<string, jest.Mock> = {};
  qb.update = jest.fn(() => qb);
  qb.set = jest.fn(() => qb);
  qb.where = jest.fn((_sql: string, p: Record<string, unknown> = {}) => {
    Object.assign(params, p);
    return qb;
  });
  qb.andWhere = qb.where;
  qb.execute = jest.fn(async () => {
    const row = stack.m.row(Tenant, String(params.tenantId));
    const settings = (row?.settings ?? {}) as Record<string, unknown>;
    if (
      !row ||
      settings[SIGNUP_SETTINGS.createdUserId] !== params.personId ||
      settings[SIGNUP_SETTINGS.loginConsumedAt] != null
    ) {
      return { affected: 0 };
    }
    row.settings = { ...settings, [SIGNUP_SETTINGS.loginConsumedAt]: new Date().toISOString() };
    return { affected: 1 };
  });
  return qb;
}

/**
 * findPaidSignupTenant's query (session id OR subscription id, deleted rows
 * included, oldest first), which the people fake does not build; answered from
 * the in-memory tenants. The real SQL runs in test/db/paid-signup.db.spec.ts.
 */
function paidSignupLookupOver(stack: MembershipStack) {
  const params: Record<string, unknown> = {};
  const qb: Record<string, jest.Mock> = {};
  for (const method of ['withDeleted', 'orderBy', 'addOrderBy']) {
    qb[method] = jest.fn(() => qb);
  }
  qb.where = jest.fn((_sql: string, p: Record<string, unknown> = {}) => {
    Object.assign(params, p);
    return qb;
  });
  qb.orWhere = qb.where;
  qb.getOne = jest.fn(async () => {
    const [row] = stack.m
      .rows(Tenant)
      .filter(
        (r) =>
          (r.settings as Record<string, unknown> | null)?.[SIGNUP_SETTINGS.sessionId] ===
            params.sessionId ||
          (params.subscriptionId !== undefined && r.stripeSubscriptionId === params.subscriptionId),
      )
      .sort((a, b) => (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime());
    return row ? Object.assign(new Tenant(), row) : null;
  });
  return qb;
}

function uniqueViolation() {
  return new QueryFailedError(
    'INSERT',
    [],
    Object.assign(new Error('duplicate'), { code: '23505' }),
  );
}

describe('paid signup provisioning (PPL-17) and login after payment (PPL-18)', () => {
  const originalFlag = process.env.GATE_MEMBERSHIP_CONTEXT;
  let stack: MembershipStack;
  let fx: ReturnType<typeof peopleFixtures>;
  let plan: SubscriptionPlan;
  let session: Stripe.Checkout.Session;
  let email: { sendWelcomeEmail: jest.Mock; sendAddedToBuildingEmail: jest.Mock };
  let audit: { create: jest.Mock; save: jest.Mock };
  let stripeClient: {
    subscriptions: { retrieve: jest.Mock };
    checkout: { sessions: { retrieve: jest.Mock; create: jest.Mock } };
  };
  let service: StripeService;

  beforeEach(() => {
    process.env.GATE_MEMBERSHIP_CONTEXT = 'off';
    stack = buildMembershipStack();
    const buildQuery = stack.m.createQueryBuilder.bind(stack.m);
    jest
      .spyOn(stack.m, 'createQueryBuilder')
      .mockImplementation(((target: new () => object, alias: string) =>
        target === Tenant ? paidSignupLookupOver(stack) : buildQuery(target, alias)) as never);
    fx = peopleFixtures(stack.m);
    plan = fx.plan({
      name: 'Pro',
      monthlyPrice: 49,
      yearlyPrice: 490,
    } as Partial<SubscriptionPlan>);
    session = signupSession({ planId: plan.id });

    email = {
      sendWelcomeEmail: jest.fn(async () => true),
      sendAddedToBuildingEmail: jest.fn(async () => true),
    };
    audit = { create: jest.fn((row: object) => row), save: jest.fn(async (row: object) => row) };

    const users = {
      createQueryBuilder: jest.fn(() => {
        const params: Record<string, unknown> = {};
        const qb: Record<string, jest.Mock> = {};
        qb.where = jest.fn((_sql: string, p: Record<string, unknown>) => {
          Object.assign(params, p);
          return qb;
        });
        qb.getOne = jest.fn(async () => {
          const row = stack.m
            .live(User)
            .find((r) => String(r.email).toLowerCase() === params.email);
          return row ? Object.assign(new User(), row) : null;
        });
        return qb;
      }),
    };

    service = new StripeService(
      { get: (_key: string, fallback?: unknown) => fallback } as unknown as ConfigService,
      { emit: jest.fn() } as never,
      email as unknown as EmailService,
      {
        findOne: (o: { where: object }) => stack.m.findOne(SubscriptionPlan, o),
      } as unknown as Repository<SubscriptionPlan>,
      {
        findOne: (o: { where: object }) => stack.m.findOne(Tenant, o),
        manager: stack.m,
      } as unknown as Repository<Tenant>,
      users as unknown as Repository<User>,
      audit as never,
      { findOne: jest.fn(async () => null), create: jest.fn(), save: jest.fn() } as never,
      stack.memberships,
      stack.service,
    );

    stripeClient = {
      subscriptions: {
        retrieve: jest.fn(async () => ({ current_period_end: 1_900_000_000 })),
      },
      checkout: {
        sessions: {
          retrieve: jest.fn(async () => session),
          create: jest.fn(async () => ({ id: 'cs_new', url: 'https://stripe.test/pay' })),
        },
      },
    };
    (service as unknown as { stripe: unknown }).stripe = stripeClient;
  });

  afterEach(() => {
    process.env.GATE_MEMBERSHIP_CONTEXT = originalFlag;
    jest.restoreAllMocks();
  });

  const paidTowers = () => stack.m.rows(Tenant).filter((row) => row.name === 'Paid Tower');

  describe('createSignupCheckoutSession', () => {
    it('refuses an email that already has an account with 409 EMAIL_HAS_ACCOUNT, before Stripe', async () => {
      fx.person({ email: 'nia.buyer@example.test' });

      const error = await service
        .createSignupCheckoutSession({
          firstName: 'Nia',
          lastName: 'Buyer',
          email: 'NIA.BUYER@example.test',
          password: 'Str0ng!pass',
          buildingName: 'Paid Tower',
          planId: plan.id,
          billingCycle: 'monthly',
        } as never)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect(membershipErrorCodeOf(error)).toBe('EMAIL_HAS_ACCOUNT');
      expect(stripeClient.checkout.sessions.create).not.toHaveBeenCalled();
    });
  });

  describe('provisionPaidSignup', () => {
    it('a new email: one tenant, one person with the checkout password, one admin membership', async () => {
      const result = await service.provisionPaidSignup(session);

      expect(result?.created).toBe(true);
      expect(paidTowers()).toHaveLength(1);

      const [person] = stack.m.live(User);
      expect(person).toMatchObject({
        email: 'nia.buyer@example.test',
        passwordHash: 'hash-from-checkout',
        status: UserStatus.ACTIVE,
        mustChangePassword: false,
        tenantId: result?.tenant.id,
        role: UserRole.BUILDING_ADMIN,
      });
      expect(String(person.qrCode)).toMatch(/^GR-/);
      expect(result?.signupCreatedUserId).toBe(person.id);
      expect(paidTowers()[0]).toMatchObject({
        status: TenantStatus.ACTIVE,
        stripeSubscriptionId: SUBSCRIPTION,
        settings: expect.objectContaining({
          [SIGNUP_SETTINGS.createdUserId]: person.id,
          [SIGNUP_SETTINGS.sessionId]: session.id,
        }),
      });
      expect(stack.m.live(Membership)).toEqual([
        expect.objectContaining({ userId: person.id, role: UserRole.BUILDING_ADMIN }),
      ]);
      expect(stack.m.queries).toEqual([
        expect.objectContaining({ params: [`paid-signup:${session.id}`] }),
      ]);
      expect(email.sendWelcomeEmail).toHaveBeenCalledTimes(1);
      expect(audit.save).toHaveBeenCalledTimes(1);
    });

    it('a replayed webhook followed by verify-payment gives exactly one tenant', async () => {
      await service.handleCheckoutCompleted(session);
      await service.handleCheckoutCompleted(session);
      const verified = await service.verifyCheckoutSession(session.id);

      expect(paidTowers()).toHaveLength(1);
      expect(stack.m.live(User)).toHaveLength(1);
      expect(stack.m.live(Membership)).toHaveLength(1);
      expect(verified).toEqual({
        success: true,
        tenantId: paidTowers()[0].id,
        loginAllowed: true,
        adminUserId: stack.m.live(User)[0].id,
      });
      expect(email.sendWelcomeEmail).toHaveBeenCalledTimes(1);
    });

    it('a replay after the subscription id changed still finds the building by its session id', async () => {
      const first = await service.provisionPaidSignup(session);
      const tower = stack.m.row(Tenant, first!.tenant.id)!;
      // Cancelled since (handleSubscriptionDeleted clears the id), and renamed,
      // so neither the subscription nor the unique name can catch the replay.
      tower.stripeSubscriptionId = null;
      tower.name = 'Renamed Tower';

      const replay = await service.provisionPaidSignup(session);

      expect(replay).toMatchObject({
        created: false,
        signupCreatedUserId: first!.signupCreatedUserId,
      });
      expect(replay?.tenant.id).toBe(first!.tenant.id);
      expect(stack.m.rows(Tenant)).toHaveLength(1);
      expect(stack.m.live(Membership)).toHaveLength(1);

      // Re-subscribed under another subscription id: the same building again.
      tower.stripeSubscriptionId = 'sub_resubscribed';
      await expect(service.provisionPaidSignup(session)).resolves.toMatchObject({
        created: false,
        tenant: expect.objectContaining({ id: first!.tenant.id }),
      });
      expect(stack.m.rows(Tenant)).toHaveLength(1);
      expect(email.sendWelcomeEmail).toHaveBeenCalledTimes(1);
      expect(audit.save).toHaveBeenCalledTimes(1);
    });

    it('verify-payment first, then the webhook: still one tenant', async () => {
      const verified = await service.verifyCheckoutSession(session.id);
      await service.handleCheckoutCompleted(session);

      expect(verified.success).toBe(true);
      expect(paidTowers()).toHaveLength(1);
    });

    it('an existing email gets a membership; its password is untouched and it is never signed in', async () => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
      const home = fx.tenant(plan, { name: 'Home Tower' });
      const existing = fx.person({
        email: 'nia.buyer@example.test',
        passwordHash: 'original-hash',
        tenantId: home.id,
        role: UserRole.RESIDENT,
      } as Partial<User>);
      fx.membership(existing, home, { role: UserRole.RESIDENT });

      await service.handleCheckoutCompleted(session);
      const verified = await service.verifyCheckoutSession(session.id);

      expect(paidTowers()).toHaveLength(1);
      expect(stack.m.rows(User)).toHaveLength(1);
      expect(stack.m.row(User, existing.id)?.passwordHash).toBe('original-hash');
      expect(
        stack.m.live(Membership).find((row) => row.tenantId === paidTowers()[0].id),
      ).toMatchObject({ userId: existing.id, role: UserRole.BUILDING_ADMIN });
      expect(paidTowers()[0].settings).not.toHaveProperty(SIGNUP_SETTINGS.createdUserId);
      expect(verified).toEqual({
        success: true,
        tenantId: paidTowers()[0].id,
        loginAllowed: false,
      });
      expect(email.sendAddedToBuildingEmail).toHaveBeenCalledWith(
        'nia.buyer@example.test',
        expect.any(String),
        UserRole.BUILDING_ADMIN,
        'Paid Tower',
        null,
        expect.any(String),
      );
      expect(email.sendWelcomeEmail).not.toHaveBeenCalled();
    });

    it('flag off, existing email in another building: the paid building is still created, without an admin', async () => {
      const home = fx.tenant(plan, { name: 'Home Tower' });
      const existing = fx.person({ email: 'nia.buyer@example.test', tenantId: home.id });
      fx.membership(existing, home, { role: UserRole.BUILDING_ADMIN });

      const result = await service.provisionPaidSignup(session);

      expect(result?.created).toBe(true);
      expect(result?.admin).toBeNull();
      expect(paidTowers()).toHaveLength(1);
      expect(paidTowers()[0].settings).toMatchObject({
        [SIGNUP_SETTINGS.adminPending]: {
          email: 'nia.buyer@example.test',
          reason: 'MULTI_MEMBERSHIP_DISABLED',
        },
      });
      expect(stack.m.live(Membership).filter((row) => row.tenantId === paidTowers()[0].id)).toEqual(
        [],
      );
    });

    it('answers with the winner when a concurrent call created the building first', async () => {
      const winner = Object.assign(new Tenant(), {
        id: '77777777-7777-4777-8777-777777777777',
        name: 'Paid Tower',
        settings: { [SIGNUP_SETTINGS.createdUserId]: '88888888-8888-4888-8888-888888888888' },
      });
      const lookups = jest
        .spyOn(
          service as unknown as { findPaidSignupTenant: () => Promise<Tenant | null> },
          'findPaidSignupTenant',
        )
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(winner);
      const save = stack.m.save.bind(stack.m);
      jest.spyOn(stack.m, 'save').mockImplementation(async (entity: { id?: string }) => {
        if (entity instanceof Tenant) throw uniqueViolation();
        return save(entity);
      });

      const result = await service.provisionPaidSignup(session);

      expect(lookups).toHaveBeenCalledTimes(3);
      expect(result).toMatchObject({
        tenant: winner,
        created: false,
        signupCreatedUserId: '88888888-8888-4888-8888-888888888888',
      });
      // The loser's person insert was rolled back.
      expect(stack.m.rows(User)).toHaveLength(0);
    });
  });

  describe('POST /auth/verify-payment signs in only the person the signup created', () => {
    let auth: AuthHarness;
    let controller: AuthController;
    const request = { headers: { 'user-agent': 'jest' }, ip: '127.0.0.1' } as never;

    beforeEach(() => {
      auth = buildAuthService();
      controller = new AuthController(auth.service, service);

      // Answer findAdminMembership / the person re-read from the in-memory rows.
      auth.memberships.findAdminMembership.mockImplementation(
        async (q: { tenantId: string; personId: string; status?: UserStatus }) => {
          const row = stack.m
            .live(Membership)
            .find(
              (m) =>
                m.tenantId === q.tenantId &&
                m.userId === q.personId &&
                m.role === UserRole.BUILDING_ADMIN &&
                (q.status === undefined || m.status === q.status),
            );
          if (!row) return null;
          return Object.assign(new Membership(), row, {
            user: Object.assign(new User(), stack.m.row(User, row.userId as string)),
            tenant: Object.assign(new Tenant(), stack.m.row(Tenant, row.tenantId as string)),
          });
        },
      );
      auth.users.findOne.mockImplementation(async (o: { where: { id: string } }) => {
        const row = stack.m.live(User).find((r) => r.id === o.where.id);
        return row ? Object.assign(new User(), row) : null;
      });
      Object.assign(auth.tenants, { createQueryBuilder: jest.fn(() => claimOver(stack)) });
    });

    it('the login is single-use: replaying the session id gets 401 Sign in to continue', async () => {
      await service.handleCheckoutCompleted(session);

      const first = await controller.verifyPayment({ sessionId: session.id }, request);
      expect(first.accessToken).toEqual(expect.any(String));
      expect(paidTowers()[0].settings).toHaveProperty(SIGNUP_SETTINGS.loginConsumedAt);

      // The session is still 'paid' at Stripe and the building still records
      // its creator; only the claim stops the second login.
      const replay = await controller
        .verifyPayment({ sessionId: session.id }, request)
        .catch((e: unknown) => e);
      expect(replay).toBeInstanceOf(UnauthorizedException);
      expect((replay as Error).message).toBe('Sign in to continue');
      expect(stack.m.live(User)).toHaveLength(1);
      expect(paidTowers()).toHaveLength(1);
    });

    it('a brand-new signup person gets tokens', async () => {
      await service.handleCheckoutCompleted(session);

      const response = await controller.verifyPayment({ sessionId: session.id }, request);

      const [person] = stack.m.live(User);
      expect(response.accessToken).toEqual(expect.any(String));
      expect(response.user).toMatchObject({ id: person.id, email: 'nia.buyer@example.test' });
      expect(auth.jwt.decode(response.accessToken)).toMatchObject({ sub: person.id });
    });

    it('a pre-existing person gets 401 Sign in to continue', async () => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
      fx.person({ email: 'nia.buyer@example.test' });
      await service.handleCheckoutCompleted(session);

      const error = await controller
        .verifyPayment({ sessionId: session.id }, request)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UnauthorizedException);
      expect((error as Error).message).toBe('Sign in to continue');
    });

    it('loginAfterPaidSignup refuses a person the tenant did not record as created by its signup', async () => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
      const other = fx.person({ email: 'other.admin@example.test' });
      await service.handleCheckoutCompleted(session);
      const tower = paidTowers()[0];
      fx.membership(other, { id: tower.id }, { role: UserRole.BUILDING_ADMIN });

      await expect(auth.service.loginAfterPaidSignup(tower.id, other.id)).rejects.toThrow(
        'Sign in to continue',
      );
      await expect(auth.service.loginAfterPaidSignup(tower.id, null)).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(auth.service.loginAfterPaidSignup('not-a-uuid', other.id)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('an inactive signup person is refused', async () => {
      await service.handleCheckoutCompleted(session);
      const [person] = stack.m.live(User);
      stack.m.row(User, person.id)!.status = UserStatus.INACTIVE;

      await expect(
        auth.service.loginAfterPaidSignup(paidTowers()[0].id, person.id),
      ).rejects.toThrow('Sign in to continue');
    });
  });
});
