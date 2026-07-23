import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User, UserRole } from '@database/entities/user.entity';
import {
  Tenant,
  TenantStatus,
  SubscriptionStatus,
} from '@database/entities/tenant.entity';
import { SubscriptionPlan } from '@database/entities/subscription-plan.entity';
import { CreateBuildingDto } from './dto/create-building.dto';
import { UpdateBuildingDto } from './dto/update-building.dto';

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
  /**
   * Rename / re-address the caller's OWN building.
   *
   * Exists because PATCH /admin/tenants/:id is super-admin only, so a building
   * admin had no way to correct their own building's details. Scoped strictly to
   * the caller's tenantId — the id is never taken from the request, so this
   * cannot be used to edit someone else's building.
   *
   * The slug is intentionally NOT regenerated: it is a stable public identifier
   * and rewriting it on every rename would break anything already referencing it.
   */
  async updateBuilding(userId: string, dto: UpdateBuildingDto) {
    const user = await this.userRepository.findOne({ where: { id: userId } });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.role !== UserRole.BUILDING_ADMIN && user.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('Only a building admin can edit building details');
    }

    if (!user.tenantId) {
      throw new ConflictException(
        'This account is not linked to a building yet. Complete onboarding first.',
      );
    }

    const tenant = await this.tenantRepository.findOne({
      where: { id: user.tenantId },
    });

    if (!tenant) {
      throw new NotFoundException('Building not found');
    }

    const name = dto.buildingName.trim();

    // Building names are unique platform-wide (createBuilding enforces the same
    // rule). Exclude the caller's own tenant so re-saving an unchanged name works.
    const clash = await this.tenantRepository.findOne({ where: { name } });
    if (clash && clash.id !== tenant.id) {
      throw new ConflictException('Building name already registered');
    }

    tenant.name = name;
    if (dto.buildingAddress !== undefined) {
      tenant.address = dto.buildingAddress.trim();
    }

    const saved = await this.tenantRepository.save(tenant);

    return {
      id: saved.id,
      name: saved.name,
      slug: saved.slug,
      address: saved.address,
      status: saved.status,
    };
  }

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

    // A paid plan is NEVER granted at onboarding — a building cannot sit on a plan
    // it has not paid for, and there are no free trials. EVERY new building is
    // created on the system DEFAULT (Free) plan, ACTIVE, with a 60-day window.
    // If the user picked a paid plan, the client redirects them to Stripe checkout
    // afterwards to pay for and activate it. `dto.planName` is therefore only a
    // client-side hint for that redirect; it never selects the plan here.
    const plans = await this.subscriptionPlanRepository.find({
      where: { isActive: true },
    });
    const defaultPlan = plans.find((p) => p.isDefault) ?? plans[0];
    if (!defaultPlan) {
      throw new BadRequestException('No subscription plans available');
    }
    const selectedPlan: SubscriptionPlan = defaultPlan;

    // Generate slug from building name
    const slug = dto.buildingName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');

    // The Free (default) plan grants default_validity_days (the 60-day free ride);
    // after that the expiry cron suspends the tenant and the SubscriptionGuard
    // makes it read-only until they subscribe.
    const validityDays = selectedPlan.defaultValidityDays || 60;
    const trialExpiresAt = new Date(
      Date.now() + validityDays * 24 * 60 * 60 * 1000,
    );

    // Free plan → ACTIVE immediately. No PENDING_PAYMENT / TRIALING here: payment
    // for a paid plan happens later, through checkout.
    const tenantStatus = TenantStatus.ACTIVE;
    const subscriptionStatus = SubscriptionStatus.ACTIVE;

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
      subscriptionStatus,
      settings: {
        paymentInfo: dto.paymentInfo,
        signupDate: now.toISOString(),
        startedAsTrial: dto.startTrial || false,
        trialDays: validityDays,
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
