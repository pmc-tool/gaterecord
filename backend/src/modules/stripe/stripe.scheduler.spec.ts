/**
 * PPL-19: billing emails go to each building's ACTIVE building_admin
 * memberships, fetched once per cron run.
 *
 * Unit test with jest doubles (no database, no Stripe, no mail). Which
 * memberships count as an active admin (status, ban, deleted building) is
 * MembershipAccessService.findTenantAdminEmails' rule, covered by its own
 * database suite; the double below applies that rule to a small fixture so the
 * scheduler's use of it is visible end to end.
 */
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { Tenant, TenantStatus, SubscriptionStatus } from '@database/entities/tenant.entity';
import { UserRole, UserStatus } from '@database/entities/user.entity';
import { MembershipAccessService } from '../memberships/membership-access.service';
import { EmailService } from '../notification/email.service';
import { StripeScheduler } from './stripe.scheduler';

const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const D = 'dddddddd-0000-4000-8000-00000000000d';
const E = 'eeeeeeee-0000-4000-8000-00000000000e';

/** Everyone who holds a role somewhere, as findTenantAdminEmails would see them. */
const MEMBERS = [
  // Admin of A and of D (their gate_users row points at D).
  {
    tenantId: A,
    email: 'both@a-and-d.test',
    role: UserRole.BUILDING_ADMIN,
    status: UserStatus.ACTIVE,
  },
  {
    tenantId: D,
    email: 'both@a-and-d.test',
    role: UserRole.BUILDING_ADMIN,
    status: UserStatus.ACTIVE,
  },
  { tenantId: D, email: 'only-d@d.test', role: UserRole.BUILDING_ADMIN, status: UserStatus.ACTIVE },
  // Inactive admin of A: nothing.
  {
    tenantId: A,
    email: 'inactive@a.test',
    role: UserRole.BUILDING_ADMIN,
    status: UserStatus.INACTIVE,
  },
  // Resident of A: nothing.
  { tenantId: A, email: 'resident@a.test', role: UserRole.RESIDENT, status: UserStatus.ACTIVE },
];

function tenant(id: string, values: Partial<Tenant> = {}): Tenant {
  return Object.assign(new Tenant(), {
    id,
    name: `Tower ${id.slice(0, 1).toUpperCase()}`,
    contactEmail: `contact@${id.slice(0, 1)}.test`,
    status: TenantStatus.ACTIVE,
    subscriptionStatus: SubscriptionStatus.PAST_DUE,
    ...values,
  });
}

describe('StripeScheduler billing recipients (PPL-19)', () => {
  let scheduler: StripeScheduler;
  let tenants: { find: jest.Mock; save: jest.Mock };
  let access: { findTenantAdminEmails: jest.Mock };
  let sent: { kind: string; tenantId: string; to: string }[];

  beforeEach(() => {
    sent = [];
    tenants = { find: jest.fn(async () => []), save: jest.fn(async (t: Tenant) => t) };
    access = {
      findTenantAdminEmails: jest.fn(async (ids: string[]) => {
        const map = new Map<string, string[]>(ids.map((id) => [id, []]));
        for (const member of MEMBERS) {
          if (
            map.has(member.tenantId) &&
            member.role === UserRole.BUILDING_ADMIN &&
            member.status === UserStatus.ACTIVE
          ) {
            map.get(member.tenantId)?.push(member.email);
          }
        }
        return map;
      }),
    };

    scheduler = new StripeScheduler(
      { get: (_key: string, fallback?: unknown) => fallback } as unknown as ConfigService,
      { emit: jest.fn() } as never,
      {} as unknown as EmailService,
      tenants as unknown as Repository<Tenant>,
      {} as never,
      {
        create: jest.fn((row: object) => row),
        save: jest.fn(),
        findOne: jest.fn(async () => null),
      } as never,
      access as unknown as MembershipAccessService,
    );

    // Record instead of mailing.
    const record =
      (kind: string) =>
      async (t: Tenant, to: string): Promise<void> => {
        sent.push({ kind, tenantId: t.id, to });
      };
    const internals = scheduler as unknown as Record<string, unknown>;
    internals.sendDunningEmail = record('dunning');
    internals.sendTrialExpiryEmail = record('trial');
    internals.sendSuspensionEmail = record('suspension');
    internals.sendPauseResumeReminderEmail = record('pause');
    internals.sendRefundConfirmationEmail = record('refund');
    internals.sendRefundFailedEmail = record('refund-failed');
  });

  it("dunning: A's admins get A's email and not D's; one recipient query per run", async () => {
    tenants.find.mockResolvedValue([tenant(A), tenant(D)]);

    await scheduler.sendPaymentFailureReminders();

    expect(access.findTenantAdminEmails).toHaveBeenCalledTimes(1);
    expect(access.findTenantAdminEmails).toHaveBeenCalledWith([A, D]);
    expect(sent.filter((s) => s.tenantId === A).map((s) => s.to)).toEqual(['both@a-and-d.test']);
    expect(sent.filter((s) => s.tenantId === D).map((s) => s.to)).toEqual([
      'both@a-and-d.test',
      'only-d@d.test',
    ]);
    expect(sent.map((s) => s.to)).not.toContain('inactive@a.test');
    expect(sent.map((s) => s.to)).not.toContain('resident@a.test');
  });

  it('no longer loads tenant.users (super admins are not copied)', async () => {
    tenants.find.mockResolvedValue([tenant(A)]);

    await scheduler.sendPaymentFailureReminders();

    const [[options]] = tenants.find.mock.calls as unknown as [[{ relations?: string[] }]];
    expect(options.relations ?? []).not.toContain('users');
  });

  it('a building without an active admin falls back to its contact email', async () => {
    tenants.find.mockResolvedValue([tenant(E)]);

    await scheduler.suspendUnpaidAccounts();

    expect(sent).toEqual([{ kind: 'suspension', tenantId: E, to: 'contact@e.test' }]);
  });

  it('trial warnings fetch recipients once, only for the buildings actually due', async () => {
    const inDays = (days: number) => new Date(Date.now() + days * 24 * 60 * 60 * 1000 - 60_000);
    tenants.find.mockResolvedValue([
      tenant(A, { status: TenantStatus.TRIAL, subscriptionExpiresAt: inDays(3) }),
      tenant(D, { status: TenantStatus.TRIAL, subscriptionExpiresAt: inDays(5) }),
    ]);

    await scheduler.sendTrialExpiryWarnings();

    expect(access.findTenantAdminEmails).toHaveBeenCalledTimes(1);
    expect(access.findTenantAdminEmails).toHaveBeenCalledWith([A]);
    expect(sent).toEqual([{ kind: 'trial', tenantId: A, to: 'both@a-and-d.test' }]);
  });

  it('an empty run makes no recipient query', async () => {
    await scheduler.sendPauseResumeReminders();

    expect(access.findTenantAdminEmails).not.toHaveBeenCalled();
  });

  it('refund emails go to the refunded building admins only', async () => {
    await scheduler.handleRefundCreatedEvent({
      tenant: tenant(D),
      refund: {} as never,
      amount: 10,
      reason: 'requested_by_customer',
    });

    expect(access.findTenantAdminEmails).toHaveBeenCalledWith([D]);
    expect(sent.map((s) => s.to)).toEqual(['both@a-and-d.test', 'only-d@d.test']);
  });
});
