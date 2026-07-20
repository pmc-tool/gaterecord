import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '@database/entities/user.entity';
import {
  Tenant,
  TenantStatus,
  SubscriptionStatus,
} from '@database/entities/tenant.entity';
import { SubscriptionPlan } from '@database/entities/subscription-plan.entity';
import { CreateBuildingDto } from './dto/create-building.dto';

/**
 * The "Get Started" flow for users provisioned from the account/Keycloak service.
 *
 * A lazily-provisioned user lands here with role=building_admin and tenantId=null.
 * Until they call POST /onboarding/building they have no tenant, so every
 * tenant-scoped endpoint in the app is closed to them. This service is the one
 * thing they can do.
 *
 * Explicitly NOT in scope: creating users, hashing passwords, issuing tokens,
 * emailing credentials. Authentication belongs to the upstream account service.
 */
@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(Tenant)
    private tenantRepository: Repository<Tenant>,
    @InjectRepository(SubscriptionPlan)
    private subscriptionPlanRepository: Repository<SubscriptionPlan>,
  ) {}

  /**
   * Same query as AuthService.getSubscriptionPlans() — active plans in display order.
   */
  async getSubscriptionPlans(): Promise<SubscriptionPlan[]> {
    return this.subscriptionPlanRepository.find({
      where: { isActive: true },
      order: { displayOrder: 'ASC' },
    });
  }

  /**
   * Whether the caller still has to onboard, plus the plan list so the client can
   * render the picker in one round trip.
   *
   * Re-reads the user from the database rather than trusting the request-scoped
   * copy: the strategy loaded that row when the request arrived, and onboarding
   * state is exactly the thing a concurrent request may have just changed.
   */
  async getStatus(userId: string) {
    const user = await this.userRepository.findOne({
      where: { id: userId },
      relations: ['tenant'],
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const plans = await this.getSubscriptionPlans();

    return {
      needsOnboarding: user.tenantId === null || user.tenantId === undefined,
      tenantId: user.tenantId ?? null,
      role: user.role,
      tenant: user.tenant
        ? {
            id: user.tenant.id,
            name: user.tenant.name,
            slug: user.tenant.slug,
            status: user.tenant.status,
          }
        : null,
      plans,
    };
  }

  /**
   * Create the caller's building and attach it to their existing gate_users row.
   *
   * TENANT-CREATION LOGIC IS INTENTIONALLY MIRRORED FROM AuthService.signup()
   * (src/modules/auth/auth.service.ts). The two must be kept in step: plan
   * resolution, slug construction, trial expiry, status and subscription fields
   * are all deliberately identical, so that a tenant behaves the same for
   * trial/billing purposes regardless of which path created it. If you change the
   * semantics in one place, change the other. The only intentional divergence is
   * that this path does NOT create a user — it updates the one that already exists.
   */
  async createBuilding(userId: string, dto: CreateBuildingDto) {
    const user = await this.userRepository.findOne({ where: { id: userId } });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Onboarding is once-only. Re-running it would create a second tenant and
    // silently orphan the first one (along with its gates, residents and events),
    // so refuse rather than repair.
    if (user.tenantId) {
      throw new ConflictException(
        'This account has already completed onboarding and belongs to a building',
      );
    }

    // Check if building name already exists
    const existingTenant = await this.tenantRepository.findOne({
      where: { name: dto.buildingName },
    });

    if (existingTenant) {
      // Allow if the existing tenant is PENDING_PAYMENT (abandoned checkout)
      if (existingTenant.status !== TenantStatus.PENDING_PAYMENT) {
        throw new ConflictException('Building name already registered');
      }
    }

    // Find subscription plan (case-insensitive)
    const plans = await this.subscriptionPlanRepository.find({
      where: { isActive: true },
    });
    const plan = plans.find(
      (p) => p.name.toLowerCase() === dto.planName.toLowerCase(),
    );

    let selectedPlan: SubscriptionPlan;
    if (!plan) {
      // Default to the first available plan if not found
      const defaultPlan = plans[0];
      if (!defaultPlan) {
        throw new BadRequestException('No subscription plans available');
      }
      this.logger.warn(
        `Plan "${dto.planName}" not found, using default: ${defaultPlan.name}`,
      );
      selectedPlan = defaultPlan;
    } else {
      selectedPlan = plan;
    }

    // Generate slug from building name
    const slug = dto.buildingName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');

    // Calculate trial expiration based on plan's trial days
    const trialDays = selectedPlan.trialDays || 14;
    const trialExpiresAt = new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000);

    // Determine initial tenant status:
    // - requiresPayment=true → PENDING_PAYMENT (waiting for Stripe checkout)
    // - startTrial=true → TRIAL (free trial, no payment yet)
    // - Free plan (monthlyPrice = 0) → TRIAL (no payment needed)
    let tenantStatus = TenantStatus.TRIAL;
    if (dto.requiresPayment) {
      tenantStatus = TenantStatus.PENDING_PAYMENT;
    }

    const now = new Date();

    // Create tenant (building)
    const tenant = this.tenantRepository.create({
      name: dto.buildingName,
      slug: slug + '-' + Date.now().toString(36),
      // Contact details come from the authenticated user rather than the request
      // body — the account service owns them and the client must not be able to
      // set a contact address it does not control.
      contactEmail: user.email.toLowerCase(),
      contactPhone: user.phone,
      address: dto.buildingAddress,
      status: tenantStatus,
      subscriptionPlanId: selectedPlan.id,
      subscriptionStartedAt: now,
      subscriptionExpiresAt: trialExpiresAt,
      currentPeriodEnd: trialExpiresAt,
      subscriptionStatus: SubscriptionStatus.TRIALING,
      settings: {
        paymentInfo: dto.paymentInfo,
        signupDate: now.toISOString(),
        startedAsTrial: dto.startTrial || false,
        trialDays: trialDays,
        requiresPayment: dto.requiresPayment || false,
      },
    });

    const savedTenant = await this.tenantRepository.save(tenant);

    // Attach the EXISTING user to the new tenant. No user row is created here and
    // the stored role is left untouched.
    user.tenantId = savedTenant.id;
    const savedUser = await this.userRepository.save(user);

    this.logger.log(
      `User ${savedUser.id} onboarded tenant ${savedTenant.id} (${savedTenant.slug}) on plan ${selectedPlan.name}`,
    );

    return {
      tenant: {
        id: savedTenant.id,
        name: savedTenant.name,
        slug: savedTenant.slug,
        address: savedTenant.address,
        status: savedTenant.status,
        subscriptionPlanId: savedTenant.subscriptionPlanId,
        subscriptionStatus: savedTenant.subscriptionStatus,
        subscriptionExpiresAt: savedTenant.subscriptionExpiresAt,
        currentPeriodEnd: savedTenant.currentPeriodEnd,
      },
      user: {
        id: savedUser.id,
        email: savedUser.email,
        firstName: savedUser.firstName,
        lastName: savedUser.lastName,
        role: savedUser.role,
        tenantId: savedUser.tenantId,
        profileImageUrl: savedUser.profileImageUrl,
        qrCode: savedUser.qrCode,
      },
    };
  }
}
