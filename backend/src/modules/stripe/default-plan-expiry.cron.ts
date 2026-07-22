import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Not, Repository } from 'typeorm';
import { Tenant, TenantStatus } from '@database/entities/tenant.entity';
import { SubscriptionPlan } from '@database/entities/subscription-plan.entity';

/**
 * Enforces the default-plan free ride. A tenant auto-subscribed to the system
 * default plan gets `default_validity_days` (60) of use; after that, if they
 * have NOT taken a paid Stripe subscription, they are suspended and the
 * SubscriptionGuard makes them read-only (they can still log in, see data, and
 * pay to reactivate).
 *
 * Kept in its own file (not stripe.scheduler.ts) so this feature is isolated and
 * two independent cron jobs never collide on one file.
 */
@Injectable()
export class DefaultPlanExpiryCron {
  private readonly logger = new Logger(DefaultPlanExpiryCron.name);

  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    @InjectRepository(SubscriptionPlan)
    private readonly planRepository: Repository<SubscriptionPlan>,
  ) {}

  // Daily. Complements suspendUnpaidAccounts (which handles lapsed PAID plans);
  // this one handles the never-paid default-plan tenants whose window ran out.
  @Cron(CronExpression.EVERY_DAY_AT_5AM)
  async suspendExpiredDefaultPlanTenants(): Promise<void> {
    const defaultPlan = await this.planRepository.findOne({
      where: { isDefault: true },
    });
    if (!defaultPlan) {
      // No default plan configured — nothing to enforce.
      return;
    }

    // Tenants still on the default plan, past their window, and NOT already
    // suspended. A tenant who took a paid plan has a different
    // subscriptionPlanId and stripeSubscriptionId, so they are excluded here.
    const now = new Date();
    const expired = await this.tenantRepository.find({
      where: {
        subscriptionPlanId: defaultPlan.id,
        subscriptionExpiresAt: LessThan(now),
        status: Not(TenantStatus.SUSPENDED),
        stripeSubscriptionId: IsNull(),
      },
    });

    if (expired.length === 0) {
      return;
    }

    for (const tenant of expired) {
      tenant.status = TenantStatus.SUSPENDED;
      await this.tenantRepository.save(tenant);
    }

    // Count only — never tenant identifiers or PII.
    this.logger.log(
      `Suspended ${expired.length} default-plan tenant(s) past their ${defaultPlan.defaultValidityDays ?? 60}-day window.`,
    );
  }
}
