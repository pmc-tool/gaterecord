import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { User, UserStatus, UserRole } from '@database/entities/user.entity';
import { RefreshToken } from '@database/entities/refresh-token.entity';
import { Tenant, TenantStatus } from '@database/entities/tenant.entity';
import { SubscriptionPlan } from '@database/entities/subscription-plan.entity';
import { LoginDto, LoginResponseDto, SignupDto } from './dto/login.dto';
import { JwtPayload } from './strategies/jwt.strategy';
import { EmailService } from '../notification/email.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(RefreshToken)
    private refreshTokenRepository: Repository<RefreshToken>,
    @InjectRepository(Tenant)
    private tenantRepository: Repository<Tenant>,
    @InjectRepository(SubscriptionPlan)
    private subscriptionPlanRepository: Repository<SubscriptionPlan>,
    private jwtService: JwtService,
    private configService: ConfigService,
    private emailService: EmailService,
  ) {}

  async login(
    loginDto: LoginDto,
    userAgent?: string,
    ipAddress?: string,
  ): Promise<LoginResponseDto> {
    const user = await this.userRepository.findOne({
      where: { email: loginDto.email.toLowerCase() },
      relations: ['tenant'],
    });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isPasswordValid = await bcrypt.compare(loginDto.password, user.passwordHash);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('Account is not active');
    }

    // Update last login
    await this.userRepository.update(user.id, { lastLoginAt: new Date() });

    const tokens = await this.generateTokens(user, userAgent, ipAddress);

    return {
      ...tokens,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        tenantId: user.tenantId,
        tenant: user.tenant
          ? {
              id: user.tenant.id,
              name: user.tenant.name,
              slug: user.tenant.slug,
            }
          : null,
      },
    };
  }

  async refreshTokens(
    refreshToken: string,
    userAgent?: string,
    ipAddress?: string,
  ): Promise<LoginResponseDto> {
    const tokenEntity = await this.refreshTokenRepository.findOne({
      where: { token: refreshToken, isRevoked: false },
      relations: ['user', 'user.tenant'],
    });

    if (!tokenEntity) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (tokenEntity.expiresAt < new Date()) {
      await this.refreshTokenRepository.update(tokenEntity.id, { isRevoked: true });
      throw new UnauthorizedException('Refresh token expired');
    }

    // Revoke old token
    await this.refreshTokenRepository.update(tokenEntity.id, { isRevoked: true });

    const tokens = await this.generateTokens(tokenEntity.user, userAgent, ipAddress);

    return {
      ...tokens,
      user: {
        id: tokenEntity.user.id,
        email: tokenEntity.user.email,
        firstName: tokenEntity.user.firstName,
        lastName: tokenEntity.user.lastName,
        role: tokenEntity.user.role,
        tenantId: tokenEntity.user.tenantId,
        tenant: tokenEntity.user.tenant
          ? {
              id: tokenEntity.user.tenant.id,
              name: tokenEntity.user.tenant.name,
              slug: tokenEntity.user.tenant.slug,
            }
          : null,
      },
    };
  }

  async logout(refreshToken: string): Promise<void> {
    await this.refreshTokenRepository.update({ token: refreshToken }, { isRevoked: true });
  }

  async logoutAll(userId: string): Promise<void> {
    await this.refreshTokenRepository.update({ userId, isRevoked: false }, { isRevoked: true });
  }

  private async generateTokens(
    user: User,
    userAgent?: string,
    ipAddress?: string,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
    };

    const accessToken = this.jwtService.sign(payload);

    const refreshToken = uuidv4();
    const expiresIn = this.configService.get<string>('JWT_REFRESH_EXPIRATION', '7d');
    const expiresAt = this.calculateExpiration(expiresIn);

    await this.refreshTokenRepository.save({
      token: refreshToken,
      userId: user.id,
      expiresAt,
      userAgent,
      ipAddress,
    });

    return { accessToken, refreshToken };
  }

  private calculateExpiration(duration: string): Date {
    const match = duration.match(/^(\d+)([smhd])$/);
    if (!match) {
      return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // Default 7 days
    }

    const value = parseInt(match[1], 10);
    const unit = match[2];
    let ms: number;

    switch (unit) {
      case 's':
        ms = value * 1000;
        break;
      case 'm':
        ms = value * 60 * 1000;
        break;
      case 'h':
        ms = value * 60 * 60 * 1000;
        break;
      case 'd':
        ms = value * 24 * 60 * 60 * 1000;
        break;
      default:
        ms = 7 * 24 * 60 * 60 * 1000;
    }

    return new Date(Date.now() + ms);
  }

  async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, 10);
  }

  async validatePassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }

  async signup(
    signupDto: SignupDto,
    userAgent?: string,
    ipAddress?: string,
  ): Promise<LoginResponseDto> {
    // Check if email already exists
    const existingUser = await this.userRepository.findOne({
      where: { email: signupDto.email.toLowerCase() },
    });

    if (existingUser) {
      throw new ConflictException('Email already registered');
    }

    // Check if building name already exists
    const existingTenant = await this.tenantRepository.findOne({
      where: { name: signupDto.buildingName },
    });

    if (existingTenant) {
      throw new ConflictException('Building name already registered');
    }

    // Find subscription plan (case-insensitive)
    const plans = await this.subscriptionPlanRepository.find({ where: { isActive: true } });
    const plan = plans.find((p) => p.name.toLowerCase() === signupDto.planName.toLowerCase());

    if (!plan) {
      // Default to the first available plan if not found
      const defaultPlan = plans[0];
      if (!defaultPlan) {
        throw new BadRequestException('No subscription plans available');
      }
      // Use the default plan
      console.log(`Plan "${signupDto.planName}" not found, using default: ${defaultPlan.name}`);
      var selectedPlan = defaultPlan;
    } else {
      var selectedPlan = plan;
    }

    // Generate slug from building name
    const slug = signupDto.buildingName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');

    // Create tenant (building)
    const tenant = this.tenantRepository.create({
      name: signupDto.buildingName,
      slug: slug + '-' + Date.now().toString(36),
      contactEmail: signupDto.email.toLowerCase(),
      contactPhone: signupDto.phone,
      address: signupDto.buildingAddress,
      status: TenantStatus.TRIAL, // Start with trial, payment would make it ACTIVE
      subscriptionPlanId: selectedPlan.id,
      subscriptionExpiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000), // 14-day trial
      settings: {
        paymentInfo: signupDto.paymentInfo,
        signupDate: new Date().toISOString(),
      },
    });

    const savedTenant = await this.tenantRepository.save(tenant);

    // Create user as building admin
    const passwordHash = await bcrypt.hash(signupDto.password, 10);

    const user = this.userRepository.create({
      email: signupDto.email.toLowerCase(),
      passwordHash,
      firstName: signupDto.firstName,
      lastName: signupDto.lastName,
      phone: signupDto.phone,
      role: UserRole.BUILDING_ADMIN,
      status: UserStatus.ACTIVE,
      tenantId: savedTenant.id,
    });

    const savedUser = await this.userRepository.save(user);

    // Load tenant relation for token generation
    savedUser.tenant = savedTenant;

    // Generate tokens and auto-login
    const tokens = await this.generateTokens(savedUser, userAgent, ipAddress);

    // Send welcome email (don't wait for it, don't fail signup if email fails)
    const frontendUrl = this.configService.get<string>('FRONTEND_URL', 'https://gaterecord.com');
    this.emailService
      .sendWelcomeEmail(
        savedUser.email,
        `${savedUser.firstName} ${savedUser.lastName}`,
        savedTenant.name,
        `${frontendUrl}/dashboard`,
      )
      .catch((error) => {
        this.logger.error(`Failed to send welcome email to ${savedUser.email}:`, error);
      });

    return {
      ...tokens,
      user: {
        id: savedUser.id,
        email: savedUser.email,
        firstName: savedUser.firstName,
        lastName: savedUser.lastName,
        role: savedUser.role,
        tenantId: savedUser.tenantId,
        tenant: {
          id: savedTenant.id,
          name: savedTenant.name,
          slug: savedTenant.slug,
        },
      },
    };
  }

  async getSubscriptionPlans(): Promise<SubscriptionPlan[]> {
    return this.subscriptionPlanRepository.find({
      where: { isActive: true },
      order: { maxGates: 'ASC' },
    });
  }
}
