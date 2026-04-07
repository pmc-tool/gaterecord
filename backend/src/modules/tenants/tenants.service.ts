import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan, Between, LessThan } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { Tenant, TenantStatus, BillingCycle } from '@database/entities/tenant.entity';
import { SubscriptionPlan } from '@database/entities/subscription-plan.entity';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import { Gate } from '@database/entities/gate.entity';
import { AccessEvent } from '@database/entities/access-event.entity';
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
  ) {}

  async createPlan(dto: CreateSubscriptionPlanDto): Promise<SubscriptionPlan> {
    const existing = await this.planRepository.findOne({ where: { name: dto.name } });
    if (existing) {
      throw new ConflictException('Plan with this name already exists');
    }

    const plan = this.planRepository.create(dto);
    return this.planRepository.save(plan);
  }

  async findAllPlans(includeInactive = false): Promise<SubscriptionPlan[]> {
    const query = includeInactive ? {} : { where: { isActive: true } };
    return this.planRepository.find({
      ...query,
      order: { displayOrder: 'ASC', createdAt: 'ASC' },
      relations: ['tenants'],
    });
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

    // Create tenant
    const tenant = this.tenantRepository.create({
      name: dto.name,
      slug: dto.slug,
      contactEmail: dto.contactEmail,
      contactPhone: dto.contactPhone,
      address: dto.address,
      subscriptionPlanId: dto.subscriptionPlanId,
      status: TenantStatus.TRIAL,
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

    return { tenant: savedTenant, adminPassword };
  }

  async findAll(): Promise<Tenant[]> {
    return this.tenantRepository.find({
      relations: ['subscriptionPlan'],
      order: { createdAt: 'DESC' },
    });
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

      return {
        planId: plan.id,
        planName: plan.name,
        monthlyPrice: Number(plan.monthlyPrice),
        yearlyPrice: Number(plan.yearlyPrice),
        subscriberCount: subscribers.length,
        monthlySubscribers: monthlySubscribers.length,
        yearlySubscribers: yearlySubscribers.length,
        revenue: monthlyRev + yearlyRev / 12, // Normalize to monthly for comparison
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
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
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

    const planDistribution: { planName: string; count: number; revenue: number }[] = [];

    for (const plan of plans) {
      const planTenants = tenants.filter((t) => t.subscriptionPlanId === plan.id);
      const activePlanTenants = planTenants.filter((t) => t.status === TenantStatus.ACTIVE);

      let planRevenue = 0;
      activePlanTenants.forEach((t) => {
        if (t.billingCycle === BillingCycle.YEARLY) {
          planRevenue += Number(plan.yearlyPrice) / 12; // Convert to monthly
        } else {
          planRevenue += Number(plan.monthlyPrice);
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
      totalRevenue: Math.round(mrr * 100) / 100, // Current month
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
}
