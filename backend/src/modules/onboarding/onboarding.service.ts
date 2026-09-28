import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import { Tenant, TenantStatus, SubscriptionStatus } from '@database/entities/tenant.entity';
import { SubscriptionPlan } from '@database/entities/subscription-plan.entity';
import { Membership } from '@database/entities/membership.entity';
import {
  BuildingJoinRequest,
  JoinRequestStatus,
} from '@database/entities/building-join-request.entity';
import { isUniqueViolation } from '@database/pg-errors';
import { ActingUser, isActingUser, isUuid } from '@common/context/acting-user';
import { assertBuildingContext } from '@common/context/assert-building-context';
import { multiMembershipDisabled } from '@common/context/membership-context.errors';
import { isMembershipContextEnabled } from '@common/context/membership-flags';
import { MembershipsService, toMembershipTenantView } from '../memberships/memberships.service';
import { CreateBuildingDto } from './dto/create-building.dto';
import { UpdateBuildingDto } from './dto/update-building.dto';
import {
  BuildingCreationPolicy,
  MAX_BUILDINGS_CREATED_PER_PERSON_ENV,
  ONBOARDING_MULTI_BUILDING_POLICY_ENV,
  buildingCreationRefused,
  decideBuildingCreation,
  parseBuildingCreationPolicy,
  parseMaxBuildingsCreated,
} from './building-creation-policy';

/** Who may rename the building the request acts in. */
const BUILDING_EDIT_ROLES: readonly UserRole[] = [UserRole.BUILDING_ADMIN];

/**
 * The "Get Started" flow for users provisioned from the account/Keycloak service.
 *
 * A lazily-provisioned person lands here with no membership at all. Until they
 * create a building (POST /onboarding/building) or are approved into one, every
 * building-scoped endpoint is closed to them. This service is the one thing
 * they can do.
 *
 * With memberships it is also how someone who already belongs somewhere adds a
 * building of their own: the admin of Tower A, or a resident of Tower B, can
 * create Tower E and becomes its building admin through a new membership. The
 * person row itself is never written here (MembershipsService keeps its legacy
 * mirror), and ONBOARDING_MULTI_BUILDING_POLICY / MAX_BUILDINGS_CREATED_PER_PERSON
 * bound how many buildings one person can create (building-creation-policy.ts).
 *
 * Explicitly NOT in scope: creating users, hashing passwords, issuing tokens,
 * emailing credentials. Authentication belongs to the upstream account service.
 */
@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    @InjectRepository(Tenant)
    private tenantRepository: Repository<Tenant>,
    @InjectRepository(SubscriptionPlan)
    private subscriptionPlanRepository: Repository<SubscriptionPlan>,
    @InjectRepository(BuildingJoinRequest)
    private joinRequestRepository: Repository<BuildingJoinRequest>,
    @InjectRepository(Membership)
    private membershipRepository: Repository<Membership>,
    private dataSource: DataSource,
    private membershipsService: MembershipsService,
    private configService: ConfigService,
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
   *   - needsOnboarding: the person holds NO membership in a live building, of
   *     any status, and is not a super admin (L8). Someone whose only
   *     memberships are inactive or pending is not sent back to Get Started:
   *     the picker shows those rows disabled instead. A super admin with no
   *     building goes to the Platform dashboard, not to Get Started. Counted
   *     fresh on every call: the membership is exactly the thing a concurrent
   *     request (a create, an approval) may have just changed.
   *     While GATE_MEMBERSHIP_CONTEXT is off a gate_users row that still names
   *     a building also counts as onboarded, as it always did.
   *   - isSuperAdmin: from the person's own role, before any context.
   *   - tenantId, role, tenant: the building and role this request ACTS in
   *     (the overlay), all null when none is chosen. The list of every
   *     membership is GET /memberships/me; it is deliberately not repeated here.
   *   - joinRequestStatus: the latest join request's status, reported only while
   *     the person has no building (then an approved request belongs to a
   *     building they have since left, so it reads as null).
   */
  async getStatus(user: User | ActingUser) {
    const [memberships, plans] = await Promise.all([
      this.countMemberships(user.id),
      this.getSubscriptionPlans(),
    ]);

    const isSuperAdmin = isActingUser(user)
      ? user.isSuperAdmin
      : user.role === UserRole.SUPER_ADMIN;
    const hasBuilding = memberships > 0 || (!isMembershipContextEnabled() && !!user.tenantId);

    const latestRequest = hasBuilding
      ? null
      : await this.joinRequestRepository.findOne({
          where: { userId: user.id },
          order: { createdAt: 'DESC' },
        });
    const joinRequestStatus =
      latestRequest && latestRequest.status !== JoinRequestStatus.APPROVED
        ? latestRequest.status
        : null;

    return {
      needsOnboarding: !isSuperAdmin && !hasBuilding,
      isSuperAdmin,
      tenantId: user.tenantId ?? null,
      role: user.role ?? null,
      joinRequestStatus,
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
   * Rename / re-address the building the request acts in, as its building admin.
   *
   * Exists because PATCH /admin/tenants/:id is super-admin only, so a building
   * admin had no way to correct their own building's details. The building comes
   * from the acting context (assertBuildingContext), never from the request, so
   * this cannot be used to edit someone else's building: an admin of Tower A
   * acting as a resident of Tower B gets 403, and without a chosen building 409.
   *
   * The slug is intentionally NOT regenerated: it is a stable public identifier
   * and rewriting it on every rename would break anything already referencing it.
   */
  async updateBuilding(user: User | ActingUser, dto: UpdateBuildingDto) {
    const tenantId = assertBuildingContext(user, BUILDING_EDIT_ROLES);

    const tenant = await this.tenantRepository.findOne({
      where: { id: tenantId },
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

  /**
   * Create a building and make the caller its building admin.
   *
   * TENANT-CREATION LOGIC IS INTENTIONALLY MIRRORED FROM AuthService.signup()
   * (src/modules/auth/auth.service.ts). The two must be kept in step: plan
   * resolution, slug construction, trial expiry, status and subscription fields
   * are all deliberately identical, so that a tenant behaves the same for
   * trial/billing purposes regardless of which path created it. If you change the
   * semantics in one place, change the other. The only intentional divergence is
   * that this path does NOT create a user — it gives the one that already exists
   * a BUILDING_ADMIN membership in the new building.
   *
   * One transaction: the person row is locked first (so one person's concurrent
   * creates are counted against the policy one at a time), then the tenant and
   * the membership are written together, so a refusal from
   * MembershipsService.add() leaves no building behind. gate_users is never
   * written here; the membership write re-mirrors its legacy columns.
   *
   * Refusals, before anything is written:
   *   - 409 MULTI_MEMBERSHIP_DISABLED while GATE_MEMBERSHIP_CONTEXT is off and the
   *     person already has a building (today's once-only rule);
   *   - 403 BUILDING_LIMIT_REACHED / BUILDING_CREATION_NOT_ALLOWED from the
   *     policy (building-creation-policy.ts);
   *   - 409 'Building name already registered'.
   *
   * The response adds membershipId and membership {id, role, tenant} so the web
   * can switch straight into the new building.
   */
  async createBuilding(user: User | ActingUser, dto: CreateBuildingDto) {
    const personId = user.id;

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
    const trialExpiresAt = new Date(Date.now() + validityDays * 24 * 60 * 60 * 1000);

    // Free plan → ACTIVE immediately. No PENDING_PAYMENT / TRIALING here: payment
    // for a paid plan happens later, through checkout.
    const tenantStatus = TenantStatus.ACTIVE;
    const subscriptionStatus = SubscriptionStatus.ACTIVE;

    const policy = this.creationPolicy();
    const maxCreated = parseMaxBuildingsCreated(
      this.configService.get<string>(MAX_BUILDINGS_CREATED_PER_PERSON_ENV),
    );
    const multiMembership = isMembershipContextEnabled();

    let created: { tenant: Tenant; membership: Membership; person: User };
    try {
      created = await this.dataSource.transaction(async (m) => {
        const person = await m.findOne(User, {
          where: { id: personId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!person) {
          throw new NotFoundException('User not found');
        }

        const live = await this.membershipsService.listLiveForUser(person.id, m);

        // Flag off: one building per person, as before. The legacy tenant_id
        // also counts, so a row that names a building without a membership
        // (written by an older backend) is never silently re-homed.
        if (!multiMembership && (live.length > 0 || person.tenantId)) {
          throw multiMembershipDisabled();
        }

        const refusal = decideBuildingCreation({
          policy,
          maxCreated,
          liveMemberships: live.length,
          createdSoFar: maxCreated === null ? 0 : await this.countBuildingsCreatedBy(m, person.id),
          adminOfMultiBuildingPlan:
            policy === 'plan' && live.length > 0
              ? await this.isAdminOnMultiBuildingPlan(m, person.id)
              : false,
        });
        if (refusal) {
          throw buildingCreationRefused(refusal, maxCreated);
        }

        const now = new Date();

        // Create tenant (building)
        const tenant = await m.save(
          m.create(Tenant, {
            name: dto.buildingName,
            slug: slug + '-' + Date.now().toString(36),
            // Contact details come from the authenticated user rather than the
            // request body — the account service owns them and the client must
            // not be able to set a contact address it does not control.
            contactEmail: person.email.toLowerCase(),
            contactPhone: person.phone,
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
              // Who created it here: counted by MAX_BUILDINGS_CREATED_PER_PERSON.
              createdByUserId: person.id,
            },
          }),
        );

        // The creator becomes its building admin. No user row is written.
        const membership = await this.membershipsService.add(
          { userId: person.id, tenantId: tenant.id, role: UserRole.BUILDING_ADMIN },
          m,
        );

        return { tenant, membership, person };
      });
    } catch (error) {
      // Two concurrent creates of the same name: the loser's insert hits the
      // unique index after the pre-check passed.
      if (isUniqueViolation(error)) {
        throw new ConflictException('Building name already registered');
      }
      throw error;
    }

    const { tenant: savedTenant, membership, person } = created;

    this.logger.log(
      `User ${person.id} created tenant ${savedTenant.id} (${savedTenant.slug}) on plan ` +
        `${selectedPlan.name} as building admin (membership ${membership.id})`,
    );

    return {
      membershipId: membership.id,
      membership: {
        id: membership.id,
        role: membership.role,
        tenant: toMembershipTenantView(savedTenant),
      },
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
      // The person as they are in the NEW building (what they act as once they
      // switch to membershipId), in the shape this response always had.
      user: {
        id: person.id,
        email: person.email,
        firstName: person.firstName,
        lastName: person.lastName,
        role: membership.role,
        tenantId: savedTenant.id,
        profileImageUrl: person.profileImageUrl,
        qrCode: person.qrCode,
      },
    };
  }

  // ============ Internals ============

  /** The policy, read per call (like the rollout flag) so a change needs no code. */
  private creationPolicy(): BuildingCreationPolicy {
    const raw = this.configService.get<string>(ONBOARDING_MULTI_BUILDING_POLICY_ENV);
    const { policy, unrecognised } = parseBuildingCreationPolicy(raw);
    if (unrecognised !== null) {
      this.logger.warn(
        `${ONBOARDING_MULTI_BUILDING_POLICY_ENV}='${unrecognised}' is not one of open, plan, ` +
          `off; treating it as 'off'.`,
      );
    }
    return policy;
  }

  /**
   * The person's memberships in live buildings, any role and status. Soft-deleted
   * memberships drop out as the main alias and deleted buildings through the
   * join (TypeORM adds "deleted_at IS NULL" to both), the same set the picker
   * lists (GET /memberships/me).
   */
  protected async countMemberships(personId: string): Promise<number> {
    if (!isUuid(personId)) {
      return 0;
    }
    return this.membershipRepository
      .createQueryBuilder('membership')
      .innerJoin('membership.tenant', 'tenant')
      .where('membership.userId = :personId', { personId })
      .getCount();
  }

  /** Live buildings this person created through onboarding. */
  protected async countBuildingsCreatedBy(m: EntityManager, personId: string): Promise<number> {
    return m
      .createQueryBuilder(Tenant, 'tenant')
      .where(`tenant.settings ->> 'createdByUserId' = :personId`, { personId })
      .getCount();
  }

  /** An ACTIVE building_admin membership in a live building whose plan has multi_building. */
  protected async isAdminOnMultiBuildingPlan(m: EntityManager, personId: string): Promise<boolean> {
    const count = await m
      .createQueryBuilder(Membership, 'membership')
      .innerJoin('membership.tenant', 'tenant')
      .innerJoin('tenant.subscriptionPlan', 'plan')
      .where('membership.userId = :personId', { personId })
      .andWhere('membership.role = :role', { role: UserRole.BUILDING_ADMIN })
      .andWhere('membership.status = :status', { status: UserStatus.ACTIVE })
      .andWhere(`plan.features ->> 'multi_building' = 'true'`)
      .getCount();
    return count > 0;
  }
}
