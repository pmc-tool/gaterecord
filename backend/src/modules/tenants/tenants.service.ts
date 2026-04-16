import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository, MoreThan } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { Tenant, TenantStatus, BillingCycle, SubscriptionStatus } from '@database/entities/tenant.entity';
import { SubscriptionPlan } from '@database/entities/subscription-plan.entity';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import { Gate } from '@database/entities/gate.entity';
import { AccessEvent } from '@database/entities/access-event.entity';
import { Payment, PaymentStatus, TransactionType } from '@database/entities/payment.entity';
import { EmailService } from '../notification/email.service';
import {
  CreateTenantDto,
  UpdateTenantDto,
  CreateSubscriptionPlanDto,
  UpdateSubscriptionPlanDto,
} from './dto/tenant.dto';

@Injectable()
export class TenantsService {
  constructor(
    @InjectRepository(Tenant)
    private tenantRepository: Repository<Tenant>,
    @InjectRepository(SubscriptionPlan)
    private planRepository: Repository<SubscriptionPlan>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(Gate)
    private gateRepository: Repository<Gate>,
    @InjectRepository(AccessEvent)
    private accessEventRepository: Repository<AccessEvent>,
    @InjectRepository(Payment)
    private paymentRepository: Repository<Payment>,
    private emailService: EmailService,
    private configService: ConfigService,
  ) {}

  async createPlan(dto: CreateSubscriptionPlanDto): Promise<SubscriptionPlan> {
    const existing = await this.planRepository.findOne({ where: { name: dto.name } });
    if (existing) {
      throw new ConflictException('Plan with this name already exists');
    }

    const plan = this.planRepository.create(dto);
    return this.planRepository.save(plan);
  }

  async findAllPlans(query: { search?: string; status?: string; page?: number; limit?: number } = {}): Promise<{ data: SubscriptionPlan[]; total: number; page: number; limit: number }> {
    const page = query.page || 1;
    const limit = query.limit || 10;
    const skip = (page - 1) * limit;

    const qb = this.planRepository.createQueryBuilder('plan')
      .leftJoinAndSelect('plan.tenants', 'tenants')
      .orderBy('plan.displayOrder', 'ASC')
      .addOrderBy('plan.createdAt', 'ASC');

    // Search by name
    if (query.search) {
      qb.andWhere('LOWER(plan.name) LIKE LOWER(:search)', { search: `%${query.search}%` });
    }

    // Filter by status
    if (query.status === 'active') {
      qb.andWhere('plan.isActive = :isActive', { isActive: true });
    } else if (query.status === 'inactive') {
      qb.andWhere('plan.isActive = :isActive', { isActive: false });
    }
    // If no status filter, return all plans (for admin)

    const [data, total] = await qb
      .skip(skip)
      .take(limit)
      .getManyAndCount();

    return { data, total, page, limit };
  }

  async findOnePlan(id: string): Promise<SubscriptionPlan> {
    const plan = await this.planRepository.findOne({
      where: { id },
      relations: ['tenants'],
    });

    if (!plan) {
      throw new NotFoundException('Subscription plan not found');
    }

    return plan;
  }

  async updatePlan(id: string, dto: UpdateSubscriptionPlanDto): Promise<SubscriptionPlan> {
    const plan = await this.findOnePlan(id);

    if (dto.name && dto.name !== plan.name) {
      const existing = await this.planRepository.findOne({ where: { name: dto.name } });
      if (existing) {
        throw new ConflictException('Plan with this name already exists');
      }
    }

    Object.assign(plan, dto);
    return this.planRepository.save(plan);
  }

  async removePlan(id: string): Promise<void> {
    const plan = await this.findOnePlan(id);

    // Check if any tenants are using this plan
    if (plan.tenants && plan.tenants.length > 0) {
      throw new ConflictException(
        `Cannot delete plan. ${plan.tenants.length} tenant(s) are currently using this plan.`,
      );
    }

    await this.planRepository.remove(plan);
  }

  async getPublicPlans(): Promise<SubscriptionPlan[]> {
    return this.planRepository.find({
      where: { isActive: true, isPublic: true },
      order: { displayOrder: 'ASC' },
    });
  }

  async createTenant(dto: CreateTenantDto): Promise<{ tenant: Tenant; adminPassword: string }> {
    // Check uniqueness
    const existingName = await this.tenantRepository.findOne({ where: { name: dto.name } });
    if (existingName) {
      throw new ConflictException('Tenant name already exists');
    }

    const existingSlug = await this.tenantRepository.findOne({ where: { slug: dto.slug } });
    if (existingSlug) {
      throw new ConflictException('Tenant slug already exists');
    }

    const existingEmail = await this.userRepository.findOne({
      where: { email: dto.adminEmail.toLowerCase() },
    });
    if (existingEmail) {
      throw new ConflictException('Admin email already exists');
    }

    // Verify plan exists
    const plan = await this.planRepository.findOne({ where: { id: dto.subscriptionPlanId } });
    if (!plan) {
      throw new NotFoundException('Subscription plan not found');
    }

    const now = new Date();
    // Use same trial logic as user self-signup
    const trialDays = plan.trialDays || 14;
    const trialExpiresAt = new Date();
    trialExpiresAt.setDate(trialExpiresAt.getDate() + trialDays);

    // Create tenant with trial status (same as user self-signup)
    const tenant = this.tenantRepository.create({
      name: dto.name,
      slug: dto.slug,
      contactEmail: dto.contactEmail,
      contactPhone: dto.contactPhone,
      address: dto.address,
      subscriptionPlanId: dto.subscriptionPlanId,
      status: TenantStatus.TRIAL,
      subscriptionStatus: SubscriptionStatus.TRIALING,
      subscriptionStartedAt: now,
      subscriptionExpiresAt: trialExpiresAt,
      currentPeriodEnd: trialExpiresAt,
      settings: {
        signupDate: now.toISOString(),
        startedAsTrial: true,
        trialDays: trialDays,
        createdBySuperAdmin: true,
      },
    });

    const savedTenant = await this.tenantRepository.save(tenant);

    // Generate random password for admin
    const adminPassword = this.generatePassword();
    const passwordHash = await bcrypt.hash(adminPassword, 10);

    // Create building admin user
    const adminUser = this.userRepository.create({
      email: dto.adminEmail.toLowerCase(),
      passwordHash,
      firstName: dto.adminFirstName,
      lastName: dto.adminLastName,
      role: UserRole.BUILDING_ADMIN,
      status: UserStatus.ACTIVE,
      tenantId: savedTenant.id,
      mustChangePassword: true,
    });

    await this.userRepository.save(adminUser);

    // Send credentials email to building admin
    const frontendUrl = this.configService.get<string>('FRONTEND_URL', 'http://localhost:3000');
    const loginUrl = `${frontendUrl}/login`;

    this.emailService.sendNewUserCredentialsEmail(
      dto.adminEmail.toLowerCase(),
      `${dto.adminFirstName} ${dto.adminLastName}`,
      UserRole.BUILDING_ADMIN,
      adminPassword,
      dto.name,
      'GateRecord Admin',
      loginUrl,
    ).catch((error) => {
      console.error('Failed to send credentials email:', error);
    });

    return { tenant: savedTenant, adminPassword };
  }

  async findAll(query: { search?: string; status?: string; startDate?: string; endDate?: string; page?: number; limit?: number } = {}): Promise<{ data: Tenant[]; total: number; page: number; limit: number }> {
    const page = query.page || 1;
    const limit = query.limit || 10;
    const skip = (page - 1) * limit;

    const qb = this.tenantRepository.createQueryBuilder('tenant')
      .leftJoinAndSelect('tenant.subscriptionPlan', 'subscriptionPlan')
      .orderBy('tenant.createdAt', 'DESC');

    // Search by name, slug, or contact email
    if (query.search) {
      qb.andWhere(
        '(LOWER(tenant.name) LIKE LOWER(:search) OR LOWER(tenant.slug) LIKE LOWER(:search) OR LOWER(tenant.contactEmail) LIKE LOWER(:search))',
        { search: `%${query.search}%` }
      );
    }

    // Filter by status
    if (query.status) {
      qb.andWhere('tenant.status = :status', { status: query.status });
    }

    // Filter by date range
    if (query.startDate) {
      qb.andWhere('tenant.createdAt >= :startDate', { startDate: query.startDate });
    }
    if (query.endDate) {
      qb.andWhere('tenant.createdAt <= :endDate', { endDate: `${query.endDate} 23:59:59` });
    }

    const [data, total] = await qb
      .skip(skip)
      .take(limit)
      .getManyAndCount();

    return { data, total, page, limit };
  }

  async findOne(id: string): Promise<Tenant> {
    const tenant = await this.tenantRepository.findOne({
      where: { id },
      relations: ['subscriptionPlan', 'users', 'gates'],
    });

    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    return tenant;
  }

  async findBySlug(slug: string): Promise<Tenant> {
    const tenant = await this.tenantRepository.findOne({
      where: { slug },
      relations: ['subscriptionPlan'],
    });

    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    return tenant;
  }

  async update(id: string, dto: UpdateTenantDto): Promise<Tenant> {
    const tenant = await this.findOne(id);

    if (dto.slug && dto.slug !== tenant.slug) {
      const existing = await this.tenantRepository.findOne({ where: { slug: dto.slug } });
      if (existing) {
        throw new ConflictException('Slug already exists');
      }
    }

    Object.assign(tenant, dto);
    return this.tenantRepository.save(tenant);
  }

  async remove(id: string): Promise<void> {
    const tenant = await this.findOne(id);
    await this.tenantRepository.softDelete(tenant.id);
  }

  async getTenantStats(id: string): Promise<{
    userCount: number;
    gateCount: number;
    eventCount: number;
  }> {
    const tenant = await this.tenantRepository.findOne({
      where: { id },
      relations: ['users', 'gates', 'accessEvents'],
    });

    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    return {
      userCount: tenant.users?.length || 0,
      gateCount: tenant.gates?.length || 0,
      eventCount: tenant.accessEvents?.length || 0,
    };
  }

  private generatePassword(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    let password = '';
    for (let i = 0; i < 12; i++) {
      password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password + '!';
  }

  async getSubscriptionStats(): Promise<{
    totalSubscriptions: number;
    activeSubscriptions: number;
    trialSubscriptions: number;
    monthlyRevenue: number;
    yearlyRevenue: number;
    totalRevenue: number;
    planBreakdown: {
      planId: string;
      planName: string;
      monthlyPrice: number;
      yearlyPrice: number;
      subscriberCount: number;
      monthlySubscribers: number;
      yearlySubscribers: number;
      revenue: number;
      // Lifetime revenue from payments
      lifetimeMonthlyRevenue: number;
      lifetimeYearlyRevenue: number;
      lifetimeTotalRevenue: number;
      monthlyPaymentCount: number;
      yearlyPaymentCount: number;
    }[];
    recentSubscriptions: {
      id: string;
      tenantName: string;
      planName: string;
      billingCycle: string;
      amount: number;
      subscribedAt: Date;
      status: string;
    }[];
  }> {
    const tenants = await this.tenantRepository.find({
      relations: ['subscriptionPlan'],
    });

    const plans = await this.planRepository.find({
      where: { isActive: true },
    });

    // Get lifetime payment stats per plan and billing cycle
    const lifetimeRevenueQuery = await this.paymentRepository
      .createQueryBuilder('payment')
      .select('payment.subscription_plan_id', 'planId')
      .addSelect('payment.billing_cycle', 'billingCycle')
      .addSelect('COALESCE(SUM(payment.amount), 0)', 'totalAmount')
      .addSelect('COUNT(*)', 'paymentCount')
      .where('payment.transaction_type = :type', { type: TransactionType.CHARGE })
      .andWhere('payment.status = :status', { status: PaymentStatus.SUCCEEDED })
      .andWhere('payment.subscription_plan_id IS NOT NULL')
      .groupBy('payment.subscription_plan_id')
      .addGroupBy('payment.billing_cycle')
      .getRawMany();

    // Create a map for quick lookup
    const lifetimeRevenueMap = new Map<string, { monthly: { amount: number; count: number }; yearly: { amount: number; count: number } }>();
    lifetimeRevenueQuery.forEach((row) => {
      const planId = row.planId;
      if (!lifetimeRevenueMap.has(planId)) {
        lifetimeRevenueMap.set(planId, {
          monthly: { amount: 0, count: 0 },
          yearly: { amount: 0, count: 0 },
        });
      }
      const planData = lifetimeRevenueMap.get(planId)!;
      if (row.billingCycle === 'monthly') {
        planData.monthly.amount = parseFloat(row.totalAmount) || 0;
        planData.monthly.count = parseInt(row.paymentCount) || 0;
      } else if (row.billingCycle === 'yearly') {
        planData.yearly.amount = parseFloat(row.totalAmount) || 0;
        planData.yearly.count = parseInt(row.paymentCount) || 0;
      }
    });

    let monthlyRevenue = 0;
    let yearlyRevenue = 0;
    let activeCount = 0;
    let trialCount = 0;

    const planBreakdown = plans.map((plan) => {
      const subscribers = tenants.filter((t) => t.subscriptionPlanId === plan.id);
      const monthlySubscribers = subscribers.filter(
        (t) => t.billingCycle === BillingCycle.MONTHLY && t.status === TenantStatus.ACTIVE,
      );
      const yearlySubscribers = subscribers.filter(
        (t) => t.billingCycle === BillingCycle.YEARLY && t.status === TenantStatus.ACTIVE,
      );

      const monthlyRev = monthlySubscribers.length * Number(plan.monthlyPrice);
      const yearlyRev = yearlySubscribers.length * Number(plan.yearlyPrice);

      monthlyRevenue += monthlyRev;
      yearlyRevenue += yearlyRev;

      // Get lifetime payment stats for this plan
      const lifetimeData = lifetimeRevenueMap.get(plan.id) || {
        monthly: { amount: 0, count: 0 },
        yearly: { amount: 0, count: 0 },
      };

      return {
        planId: plan.id,
        planName: plan.name,
        monthlyPrice: Number(plan.monthlyPrice),
        yearlyPrice: Number(plan.yearlyPrice),
        subscriberCount: subscribers.length,
        monthlySubscribers: monthlySubscribers.length,
        yearlySubscribers: yearlySubscribers.length,
        revenue: monthlyRev + yearlyRev / 12, // Normalize to monthly for comparison
        // Lifetime revenue from actual payments
        lifetimeMonthlyRevenue: lifetimeData.monthly.amount,
        lifetimeYearlyRevenue: lifetimeData.yearly.amount,
        lifetimeTotalRevenue: lifetimeData.monthly.amount + lifetimeData.yearly.amount,
        monthlyPaymentCount: lifetimeData.monthly.count,
        yearlyPaymentCount: lifetimeData.yearly.count,
      };
    });

    tenants.forEach((t) => {
      if (t.status === TenantStatus.ACTIVE) activeCount++;
      if (t.status === TenantStatus.TRIAL) trialCount++;
    });

    // Get recent subscriptions (last 10)
    const recentTenants = await this.tenantRepository.find({
      relations: ['subscriptionPlan'],
      order: { createdAt: 'DESC' },
      take: 10,
    });

    const recentSubscriptions = recentTenants.map((t) => ({
      id: t.id,
      tenantName: t.name,
      planName: t.subscriptionPlan?.name || 'Unknown',
      billingCycle: t.billingCycle,
      amount:
        t.billingCycle === BillingCycle.YEARLY
          ? Number(t.subscriptionPlan?.yearlyPrice || 0)
          : Number(t.subscriptionPlan?.monthlyPrice || 0),
      subscribedAt: t.createdAt,
      status: t.status,
    }));

    return {
      totalSubscriptions: tenants.length,
      activeSubscriptions: activeCount,
      trialSubscriptions: trialCount,
      monthlyRevenue,
      yearlyRevenue,
      totalRevenue: monthlyRevenue + yearlyRevenue,
      planBreakdown,
      recentSubscriptions,
    };
  }

  async getSuperAdminDashboard(): Promise<{
    // Financial metrics
    mrr: number;
    arr: number;
    totalRevenue: number;
    monthlySubscriptionsRevenue: number;
    yearlySubscriptionsRevenue: number;
    revenueGrowth: number;
    // Platform overview
    totalTenants: number;
    activeTenants: number;
    trialTenants: number;
    suspendedTenants: number;
    newTenantsThisMonth: number;
    // Usage metrics
    totalUsers: number;
    totalResidents: number;
    totalGates: number;
    onlineGates: number;
    totalEventsToday: number;
    totalEventsThisMonth: number;
    // Plan distribution
    planDistribution: {
      planName: string;
      count: number;
      revenue: number;
    }[];
    // Recent activity
    recentTenants: {
      id: string;
      name: string;
      planName: string;
      status: string;
      createdAt: Date;
    }[];
    // Alerts
    expiringTrials: {
      id: string;
      name: string;
      expiresAt: Date;
      daysLeft: number;
    }[];
    tenantsAtLimit: {
      id: string;
      name: string;
      limitType: string;
      current: number;
      max: number;
    }[];
  }> {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    // Get all tenants with their plans
    const tenants = await this.tenantRepository.find({
      relations: ['subscriptionPlan', 'users', 'gates'],
    });

    // Get all plans
    const plans = await this.planRepository.find({ where: { isActive: true } });

    // Calculate financial metrics
    let mrr = 0;
    let lastMonthMrr = 0;
    let activeTenants = 0;
    let trialTenants = 0;
    let suspendedTenants = 0;
    let monthlySubscriptionsRevenue = 0;
    let yearlySubscriptionsRevenue = 0;

    const planDistribution: { planName: string; count: number; revenue: number }[] = [];

    for (const plan of plans) {
      const planTenants = tenants.filter((t) => t.subscriptionPlanId === plan.id);
      const activePlanTenants = planTenants.filter((t) => t.status === TenantStatus.ACTIVE);

      let planRevenue = 0;
      activePlanTenants.forEach((t) => {
        if (t.billingCycle === BillingCycle.YEARLY) {
          const yearlyPrice = Number(plan.yearlyPrice);
          planRevenue += yearlyPrice / 12; // Convert to monthly for MRR
          yearlySubscriptionsRevenue += yearlyPrice;
        } else {
          const monthlyPrice = Number(plan.monthlyPrice);
          planRevenue += monthlyPrice;
          monthlySubscriptionsRevenue += monthlyPrice;
        }
      });

      mrr += planRevenue;
      planDistribution.push({
        planName: plan.name,
        count: planTenants.length,
        revenue: planRevenue,
      });
    }

    // Calculate tenant status counts
    tenants.forEach((t) => {
      if (t.status === TenantStatus.ACTIVE) activeTenants++;
      if (t.status === TenantStatus.TRIAL) trialTenants++;
      if (t.status === TenantStatus.SUSPENDED) suspendedTenants++;
    });

    // New tenants this month
    const newTenantsThisMonth = tenants.filter((t) => new Date(t.createdAt) >= startOfMonth).length;

    // User and gate counts
    const totalUsers = await this.userRepository.count();
    const totalResidents = await this.userRepository.count({
      where: { role: UserRole.RESIDENT },
    });
    const totalGates = await this.gateRepository.count();
    const onlineGates = await this.gateRepository.count({
      where: { isOnline: true },
    });

    // Event counts
    const totalEventsToday = await this.accessEventRepository.count({
      where: { timestamp: MoreThan(startOfDay) },
    });
    const totalEventsThisMonth = await this.accessEventRepository.count({
      where: { timestamp: MoreThan(startOfMonth) },
    });

    // Recent tenants (last 5)
    const recentTenants = tenants
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 5)
      .map((t) => ({
        id: t.id,
        name: t.name,
        planName: t.subscriptionPlan?.name || 'Unknown',
        status: t.status,
        createdAt: t.createdAt,
      }));

    // Expiring trials (next 7 days)
    const expiringTrials = tenants
      .filter((t) => {
        if (t.status !== TenantStatus.TRIAL) return false;
        if (!t.subscriptionExpiresAt) return false;
        const expiresAt = new Date(t.subscriptionExpiresAt);
        return expiresAt <= sevenDaysFromNow && expiresAt > now;
      })
      .map((t) => {
        const expiresAt = new Date(t.subscriptionExpiresAt!);
        const daysLeft = Math.ceil((expiresAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
        return {
          id: t.id,
          name: t.name,
          expiresAt,
          daysLeft,
        };
      })
      .sort((a, b) => a.daysLeft - b.daysLeft);

    // Tenants at limits (>80% usage)
    const tenantsAtLimit: {
      id: string;
      name: string;
      limitType: string;
      current: number;
      max: number;
    }[] = [];

    for (const tenant of tenants) {
      if (!tenant.subscriptionPlan) continue;

      const userCount = tenant.users?.length || 0;
      const gateCount = tenant.gates?.length || 0;
      const maxUsers = tenant.subscriptionPlan.maxUsers;
      const maxGates = tenant.subscriptionPlan.maxGates;

      if (userCount >= maxUsers * 0.8) {
        tenantsAtLimit.push({
          id: tenant.id,
          name: tenant.name,
          limitType: 'Users',
          current: userCount,
          max: maxUsers,
        });
      }
      if (gateCount >= maxGates * 0.8) {
        tenantsAtLimit.push({
          id: tenant.id,
          name: tenant.name,
          limitType: 'Gates',
          current: gateCount,
          max: maxGates,
        });
      }
    }

    // Estimate last month MRR for growth calculation (simplified)
    const lastMonthTenants = tenants.filter(
      (t) => new Date(t.createdAt) < startOfMonth && t.status === TenantStatus.ACTIVE,
    );
    for (const t of lastMonthTenants) {
      if (!t.subscriptionPlan) continue;
      if (t.billingCycle === BillingCycle.YEARLY) {
        lastMonthMrr += Number(t.subscriptionPlan.yearlyPrice) / 12;
      } else {
        lastMonthMrr += Number(t.subscriptionPlan.monthlyPrice);
      }
    }

    const revenueGrowth = lastMonthMrr > 0 ? ((mrr - lastMonthMrr) / lastMonthMrr) * 100 : 0;

    return {
      // Financial metrics
      mrr: Math.round(mrr * 100) / 100,
      arr: Math.round(mrr * 12 * 100) / 100,
      totalRevenue: Math.round((monthlySubscriptionsRevenue + yearlySubscriptionsRevenue) * 100) / 100,
      monthlySubscriptionsRevenue: Math.round(monthlySubscriptionsRevenue * 100) / 100,
      yearlySubscriptionsRevenue: Math.round(yearlySubscriptionsRevenue * 100) / 100,
      revenueGrowth: Math.round(revenueGrowth * 10) / 10,
      // Platform overview
      totalTenants: tenants.length,
      activeTenants,
      trialTenants,
      suspendedTenants,
      newTenantsThisMonth,
      // Usage metrics
      totalUsers,
      totalResidents,
      totalGates,
      onlineGates,
      totalEventsToday,
      totalEventsThisMonth,
      // Plan distribution
      planDistribution,
      // Recent activity
      recentTenants,
      // Alerts
      expiringTrials,
      tenantsAtLimit,
    };
  }

  /**
   * Get professional SaaS metrics for the Subscription & Earnings Dashboard
   * Includes Netflix/Stripe-level business intelligence metrics
   */
  async getProfessionalMetrics(): Promise<{
    // Revenue Metrics
    mrr: number;
    arr: number;
    netRevenue: number;
    revenueGrowth: number;
    // Subscription Metrics
    activeSubscriptions: number;
    newThisMonth: number;
    churnedThisMonth: number;
    churnRate: number;
    // Customer Value Metrics
    arpu: number;
    ltv: number;
    trialConversionRate: number;
    // Billing Split
    monthlySubscribers: number;
    yearlySubscribers: number;
    // Health Indicators
    paymentSuccessRate: number;
    failedPayments: number;
    pastDueCount: number;
    expiringTrials: number;
    // Revenue Trend (last 12 months)
    revenueTrend: { month: string; revenue: number; subscriptions: number }[];
    // Plan Performance
    planPerformance: {
      planName: string;
      subscribers: number;
      mrr: number;
      churnRate: number;
      growth: number;
    }[];
  }> {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);
    const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    // Get all tenants with plans
    const tenants = await this.tenantRepository.find({
      relations: ['subscriptionPlan'],
    });

    const plans = await this.planRepository.find({ where: { isActive: true } });

    // Calculate MRR
    let mrr = 0;
    let lastMonthMrr = 0;
    let activeSubscriptions = 0;
    let monthlySubscribers = 0;
    let yearlySubscribers = 0;
    let trialCount = 0;

    // Current active tenants
    const activeTenants = tenants.filter((t) => t.status === TenantStatus.ACTIVE);
    const trialTenants = tenants.filter((t) => t.status === TenantStatus.TRIAL);
    
    activeTenants.forEach((t) => {
      activeSubscriptions++;
      if (t.billingCycle === BillingCycle.MONTHLY) {
        monthlySubscribers++;
        mrr += Number(t.subscriptionPlan?.monthlyPrice || 0);
      } else if (t.billingCycle === BillingCycle.YEARLY) {
        yearlySubscribers++;
        mrr += Number(t.subscriptionPlan?.yearlyPrice || 0) / 12;
      }
    });

    trialCount = trialTenants.length;

    // New subscriptions this month
    const newThisMonth = tenants.filter(
      (t) => new Date(t.createdAt) >= startOfMonth && t.status === TenantStatus.ACTIVE,
    ).length;

    // Estimate churned this month (tenants that became suspended this month)
    const churnedThisMonth = tenants.filter(
      (t) =>
        t.status === TenantStatus.SUSPENDED &&
        t.updatedAt &&
        new Date(t.updatedAt) >= startOfMonth,
    ).length;

    // Calculate last month MRR for comparison (tenants that existed before this month)
    const lastMonthActiveTenants = tenants.filter(
      (t) =>
        new Date(t.createdAt) < startOfMonth &&
        (t.status === TenantStatus.ACTIVE ||
          (t.status === TenantStatus.SUSPENDED && t.updatedAt && new Date(t.updatedAt) >= startOfMonth)),
    );

    lastMonthActiveTenants.forEach((t) => {
      if (!t.subscriptionPlan) return;
      if (t.billingCycle === BillingCycle.YEARLY) {
        lastMonthMrr += Number(t.subscriptionPlan.yearlyPrice) / 12;
      } else {
        lastMonthMrr += Number(t.subscriptionPlan.monthlyPrice);
      }
    });

    // Revenue growth
    const revenueGrowth = lastMonthMrr > 0 ? ((mrr - lastMonthMrr) / lastMonthMrr) * 100 : 0;

    // Churn rate = churned this month / total active at start of month
    const totalAtStartOfMonth = lastMonthActiveTenants.length;
    const churnRate = totalAtStartOfMonth > 0 ? (churnedThisMonth / totalAtStartOfMonth) * 100 : 0;

    // ARPU (Average Revenue Per User) = MRR / Active Subscribers
    const arpu = activeSubscriptions > 0 ? mrr / activeSubscriptions : 0;

    // LTV (Lifetime Value) = ARPU / Monthly Churn Rate (as decimal)
    const monthlyChurnRateDecimal = churnRate / 100;
    const ltv = monthlyChurnRateDecimal > 0 ? arpu / monthlyChurnRateDecimal : arpu * 24; // Default to 24 months if no churn

    // Trial conversion - tenants that were trial and became active
    const convertedTrials = tenants.filter(
      (t) =>
        t.status === TenantStatus.ACTIVE &&
        t.createdAt &&
        t.updatedAt &&
        new Date(t.updatedAt) >= startOfMonth,
    ).length;
    const totalTrialsLastMonth = tenants.filter(
      (t) =>
        (t.status === TenantStatus.TRIAL || t.status === TenantStatus.ACTIVE) &&
        new Date(t.createdAt) >= startOfLastMonth &&
        new Date(t.createdAt) < startOfMonth,
    ).length;
    const trialConversionRate = totalTrialsLastMonth > 0 ? (convertedTrials / totalTrialsLastMonth) * 100 : 0;

    // Expiring trials in next 7 days
    const expiringTrials = trialTenants.filter((t) => {
      if (!t.subscriptionExpiresAt) return false;
      const expiresAt = new Date(t.subscriptionExpiresAt);
      return expiresAt <= sevenDaysFromNow && expiresAt > now;
    }).length;

    // Payment metrics
    const monthlyPayments = await this.paymentRepository.count({
      where: {
        createdAt: MoreThan(startOfMonth),
        transactionType: TransactionType.CHARGE,
      },
    });

    const successfulPayments = await this.paymentRepository.count({
      where: {
        createdAt: MoreThan(startOfMonth),
        transactionType: TransactionType.CHARGE,
        status: PaymentStatus.SUCCEEDED,
      },
    });

    const failedPayments = await this.paymentRepository.count({
      where: {
        createdAt: MoreThan(startOfMonth),
        transactionType: TransactionType.CHARGE,
        status: PaymentStatus.FAILED,
      },
    });

    const paymentSuccessRate = monthlyPayments > 0 ? (successfulPayments / monthlyPayments) * 100 : 100;

    // Past due subscriptions
    const pastDueCount = tenants.filter(
      (t) =>
        t.subscriptionExpiresAt &&
        new Date(t.subscriptionExpiresAt) < now &&
        t.status === TenantStatus.ACTIVE,
    ).length;

    // Net revenue (total successful payments this month)
    const netRevenueResult = await this.paymentRepository
      .createQueryBuilder('payment')
      .select('COALESCE(SUM(payment.net_amount), 0)', 'total')
      .where('payment.created_at >= :startOfMonth', { startOfMonth })
      .andWhere('payment.status = :status', { status: PaymentStatus.SUCCEEDED })
      .andWhere('payment.transaction_type = :type', { type: TransactionType.CHARGE })
      .getRawOne();
    const netRevenue = parseFloat(netRevenueResult?.total) || 0;

    // Revenue trend (last 12 months)
    const revenueTrend: { month: string; revenue: number; subscriptions: number }[] = [];
    for (let i = 11; i >= 0; i--) {
      const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
      const monthName = monthStart.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });

      const monthRevenueResult = await this.paymentRepository
        .createQueryBuilder('payment')
        .select('COALESCE(SUM(payment.amount), 0)', 'total')
        .addSelect('COUNT(DISTINCT payment.tenant_id)', 'subscriptions')
        .where('payment.created_at >= :monthStart', { monthStart })
        .andWhere('payment.created_at <= :monthEnd', { monthEnd })
        .andWhere('payment.status = :status', { status: PaymentStatus.SUCCEEDED })
        .andWhere('payment.transaction_type = :type', { type: TransactionType.CHARGE })
        .getRawOne();

      revenueTrend.push({
        month: monthName,
        revenue: parseFloat(monthRevenueResult?.total) || 0,
        subscriptions: parseInt(monthRevenueResult?.subscriptions) || 0,
      });
    }

    // Plan performance
    const planPerformance = plans.map((plan) => {
      const planSubscribers = activeTenants.filter((t) => t.subscriptionPlanId === plan.id);
      let planMrr = 0;
      planSubscribers.forEach((t) => {
        if (t.billingCycle === BillingCycle.YEARLY) {
          planMrr += Number(plan.yearlyPrice) / 12;
        } else {
          planMrr += Number(plan.monthlyPrice);
        }
      });

      const planChurned = tenants.filter(
        (t) =>
          t.subscriptionPlanId === plan.id &&
          t.status === TenantStatus.SUSPENDED &&
          t.updatedAt &&
          new Date(t.updatedAt) >= startOfMonth,
      ).length;

      const planLastMonth = tenants.filter(
        (t) =>
          t.subscriptionPlanId === plan.id &&
          new Date(t.createdAt) < startOfMonth &&
          (t.status === TenantStatus.ACTIVE ||
            (t.status === TenantStatus.SUSPENDED && t.updatedAt && new Date(t.updatedAt) >= startOfMonth)),
      ).length;

      const planChurnRate = planLastMonth > 0 ? (planChurned / planLastMonth) * 100 : 0;

      const planNewThisMonth = tenants.filter(
        (t) =>
          t.subscriptionPlanId === plan.id &&
          new Date(t.createdAt) >= startOfMonth &&
          t.status === TenantStatus.ACTIVE,
      ).length;

      const planGrowth = planLastMonth > 0 ? ((planSubscribers.length - planLastMonth) / planLastMonth) * 100 : 0;

      return {
        planName: plan.name,
        subscribers: planSubscribers.length,
        mrr: Math.round(planMrr * 100) / 100,
        churnRate: Math.round(planChurnRate * 10) / 10,
        growth: Math.round(planGrowth * 10) / 10,
      };
    });

    return {
      // Revenue Metrics
      mrr: Math.round(mrr * 100) / 100,
      arr: Math.round(mrr * 12 * 100) / 100,
      netRevenue: Math.round(netRevenue * 100) / 100,
      revenueGrowth: Math.round(revenueGrowth * 10) / 10,
      // Subscription Metrics
      activeSubscriptions,
      newThisMonth,
      churnedThisMonth,
      churnRate: Math.round(churnRate * 10) / 10,
      // Customer Value Metrics
      arpu: Math.round(arpu * 100) / 100,
      ltv: Math.round(ltv * 100) / 100,
      trialConversionRate: Math.round(trialConversionRate * 10) / 10,
      // Billing Split
      monthlySubscribers,
      yearlySubscribers,
      // Health Indicators
      paymentSuccessRate: Math.round(paymentSuccessRate * 10) / 10,
      failedPayments,
      pastDueCount,
      expiringTrials,
      // Revenue Trend
      revenueTrend,
      // Plan Performance
      planPerformance,
    };
  }

  /**
   * Get subscriptions with pagination and date range filter
   */
  async getSubscriptionsList(params: {
    page?: number;
    limit?: number;
    startDate?: string;
    endDate?: string;
    status?: string;
    planId?: string;
  }): Promise<{
    data: {
      id: string;
      tenantName: string;
      planName: string;
      billingCycle: string;
      amount: number;
      subscribedAt: Date;
      status: string;
    }[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = params.page || 1;
    const limit = params.limit || 10;
    const skip = (page - 1) * limit;

    const queryBuilder = this.tenantRepository
      .createQueryBuilder('tenant')
      .leftJoinAndSelect('tenant.subscriptionPlan', 'plan')
      .orderBy('tenant.createdAt', 'DESC');

    // Apply date range filter
    if (params.startDate) {
      queryBuilder.andWhere('tenant.createdAt >= :startDate', {
        startDate: new Date(params.startDate),
      });
    }
    if (params.endDate) {
      const endDate = new Date(params.endDate);
      endDate.setHours(23, 59, 59, 999);
      queryBuilder.andWhere('tenant.createdAt <= :endDate', { endDate });
    }

    // Apply status filter
    if (params.status) {
      queryBuilder.andWhere('tenant.status = :status', { status: params.status });
    }

    // Apply plan filter
    if (params.planId) {
      queryBuilder.andWhere('tenant.subscriptionPlanId = :planId', { planId: params.planId });
    }

    const [tenants, total] = await queryBuilder
      .skip(skip)
      .take(limit)
      .getManyAndCount();

    const data = tenants.map((t) => ({
      id: t.id,
      tenantName: t.name,
      planName: t.subscriptionPlan?.name || 'Unknown',
      billingCycle: t.billingCycle,
      amount:
        t.billingCycle === BillingCycle.YEARLY
          ? Number(t.subscriptionPlan?.yearlyPrice || 0)
          : Number(t.subscriptionPlan?.monthlyPrice || 0),
      subscribedAt: t.createdAt,
      status: t.status,
    }));

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }
}
