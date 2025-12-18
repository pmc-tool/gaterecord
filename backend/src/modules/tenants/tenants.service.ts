import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { Tenant, TenantStatus } from '@database/entities/tenant.entity';
import { SubscriptionPlan } from '@database/entities/subscription-plan.entity';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import { CreateTenantDto, UpdateTenantDto, CreateSubscriptionPlanDto } from './dto/tenant.dto';

@Injectable()
export class TenantsService {
  constructor(
    @InjectRepository(Tenant)
    private tenantRepository: Repository<Tenant>,
    @InjectRepository(SubscriptionPlan)
    private planRepository: Repository<SubscriptionPlan>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
  ) {}

  async createPlan(dto: CreateSubscriptionPlanDto): Promise<SubscriptionPlan> {
    const existing = await this.planRepository.findOne({ where: { name: dto.name } });
    if (existing) {
      throw new ConflictException('Plan with this name already exists');
    }

    const plan = this.planRepository.create(dto);
    return this.planRepository.save(plan);
  }

  async findAllPlans(): Promise<SubscriptionPlan[]> {
    return this.planRepository.find({ where: { isActive: true } });
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
}
