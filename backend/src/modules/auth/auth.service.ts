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
import { PasswordResetToken } from '@database/entities/password-reset-token.entity';
import { Tenant, TenantStatus, SubscriptionStatus } from '@database/entities/tenant.entity';
import { SubscriptionPlan } from '@database/entities/subscription-plan.entity';
import { LoginHistory, LoginStatus } from '@database/entities/login-history.entity';
import { LoginDto, LoginResponseDto, SignupDto } from './dto/login.dto';
import {
  ForgotPasswordDto,
  ForgotPasswordResponseDto,
  VerifyOtpDto,
  VerifyOtpResponseDto,
  ResetPasswordDto,
  ResetPasswordResponseDto,
} from './dto/password-reset.dto';
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
    @InjectRepository(LoginHistory)
    private loginHistoryRepository: Repository<LoginHistory>,
    @InjectRepository(PasswordResetToken)
    private passwordResetTokenRepository: Repository<PasswordResetToken>,
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
      throw new UnauthorizedException('No account found with this email address');
    }

    const isPasswordValid = await bcrypt.compare(loginDto.password, user.passwordHash);
    if (!isPasswordValid) {
      // Record failed login attempt
      await this.recordLoginActivity(user.id, LoginStatus.FAILED, ipAddress, userAgent, 'Invalid password');
      throw new UnauthorizedException('Incorrect password');
    }

    if (user.status !== UserStatus.ACTIVE) {
      // Record failed login attempt
      await this.recordLoginActivity(user.id, LoginStatus.FAILED, ipAddress, userAgent, 'Account not active');
      throw new UnauthorizedException('Account is not active');
    }

    // Update last login
    await this.userRepository.update(user.id, { lastLoginAt: new Date() });

    // Record successful login
    await this.recordLoginActivity(user.id, LoginStatus.SUCCESS, ipAddress, userAgent);

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
        profileImageUrl: user.profileImageUrl,
        qrCode: user.qrCode,
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
        profileImageUrl: tokenEntity.user.profileImageUrl,
        qrCode: tokenEntity.user.qrCode,
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
    const expiresIn = this.configService.get<string>('JWT_REFRESH_EXPIRATION', '30d');
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
      relations: ['tenant'],
    });

    if (existingUser) {
      // If user exists but tenant is PENDING_PAYMENT, allow re-signup (resume checkout)
      if (existingUser.tenant?.status === TenantStatus.PENDING_PAYMENT) {
        this.logger.log(`Resuming signup for pending account: ${signupDto.email}`);

        // Update password in case they changed it
        const passwordHash = await bcrypt.hash(signupDto.password, 10);
        await this.userRepository.update(existingUser.id, { passwordHash });

        // Generate tokens and return (they can proceed to Stripe Checkout)
        const tokens = await this.generateTokens(existingUser, userAgent, ipAddress);
        return {
          ...tokens,
          user: {
            id: existingUser.id,
            email: existingUser.email,
            firstName: existingUser.firstName,
            lastName: existingUser.lastName,
            role: existingUser.role,
            tenantId: existingUser.tenantId,
            profileImageUrl: existingUser.profileImageUrl,
            qrCode: existingUser.qrCode,
            tenant: existingUser.tenant
              ? {
                  id: existingUser.tenant.id,
                  name: existingUser.tenant.name,
                  slug: existingUser.tenant.slug,
                }
              : null,
          },
        };
      }

      throw new ConflictException('Email already registered');
    }

    // Check if building name already exists
    const existingTenant = await this.tenantRepository.findOne({
      where: { name: signupDto.buildingName },
    });

    if (existingTenant) {
      // Allow if the existing tenant is PENDING_PAYMENT (abandoned checkout)
      if (existingTenant.status !== TenantStatus.PENDING_PAYMENT) {
        throw new ConflictException('Building name already registered');
      }
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

    // Calculate trial expiration based on plan's trial days
    const trialDays = selectedPlan.trialDays || 14;
    const trialExpiresAt = new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000);

    // Determine initial tenant status:
    // - requiresPayment=true → PENDING_PAYMENT (waiting for Stripe checkout)
    // - startTrial=true → TRIAL (free trial, no payment yet)
    // - Free plan (monthlyPrice = 0) → TRIAL (no payment needed)
    let tenantStatus = TenantStatus.TRIAL;
    if (signupDto.requiresPayment) {
      tenantStatus = TenantStatus.PENDING_PAYMENT;
    }

    const now = new Date();

    // Create tenant (building)
    const tenant = this.tenantRepository.create({
      name: signupDto.buildingName,
      slug: slug + '-' + Date.now().toString(36),
      contactEmail: signupDto.email.toLowerCase(),
      contactPhone: signupDto.phone,
      address: signupDto.buildingAddress,
      status: tenantStatus,
      subscriptionPlanId: selectedPlan.id,
      subscriptionStartedAt: now,
      subscriptionExpiresAt: trialExpiresAt,
      currentPeriodEnd: trialExpiresAt,
      subscriptionStatus: SubscriptionStatus.TRIALING,
      settings: {
        paymentInfo: signupDto.paymentInfo,
        signupDate: now.toISOString(),
        startedAsTrial: signupDto.startTrial || false,
        trialDays: trialDays,
        requiresPayment: signupDto.requiresPayment || false,
      },
    });

    const savedTenant = await this.tenantRepository.save(tenant);

    // Create user as building admin
    const passwordHash = await bcrypt.hash(signupDto.password, 10);
    const qrCode = `GR-${uuidv4()}`;

    const user = this.userRepository.create({
      email: signupDto.email.toLowerCase(),
      passwordHash,
      firstName: signupDto.firstName,
      lastName: signupDto.lastName,
      phone: signupDto.phone,
      role: UserRole.BUILDING_ADMIN,
      status: UserStatus.ACTIVE,
      tenantId: savedTenant.id,
      qrCode,
    });

    const savedUser = await this.userRepository.save(user);

    // Load tenant relation for token generation
    savedUser.tenant = savedTenant;

    // Generate tokens and auto-login
    const tokens = await this.generateTokens(savedUser, userAgent, ipAddress);

    // Send welcome email with trial info (don't wait for it, don't fail signup if email fails)
    const frontendUrl = this.configService.get<string>('FRONTEND_URL', 'https://gaterecord.com');
    this.emailService
      .sendWelcomeEmail(
        savedUser.email,
        `${savedUser.firstName} ${savedUser.lastName}`,
        savedTenant.name,
        `${frontendUrl}/dashboard`,
        {
          type: 'trial',
          planName: selectedPlan.name,
          trialDays: trialDays,
        },
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
        profileImageUrl: savedUser.profileImageUrl,
        qrCode: savedUser.qrCode,
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
      order: { displayOrder: 'ASC' },
    });
  }

  /**
   * Login by tenant ID - used after payment verification
   * Finds the building admin and generates tokens for them
   */
  async loginByTenantId(
    tenantId: string,
    userAgent?: string,
    ipAddress?: string,
  ): Promise<LoginResponseDto> {
    const user = await this.userRepository.findOne({
      where: {
        tenantId,
        role: UserRole.BUILDING_ADMIN,
        status: UserStatus.ACTIVE,
      },
      relations: ['tenant'],
    });

    if (!user) {
      throw new UnauthorizedException('No active admin found for this building');
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
        profileImageUrl: user.profileImageUrl,
        qrCode: user.qrCode,
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

  // ==================== Login Activity Tracking ====================

  private async recordLoginActivity(
    userId: string,
    status: LoginStatus,
    ipAddress?: string,
    userAgent?: string,
    failureReason?: string,
  ): Promise<void> {
    try {
      const { browser, os, device } = this.parseUserAgent(userAgent || '');

      const loginHistory = this.loginHistoryRepository.create({
        userId,
        status,
        ipAddress,
        userAgent,
        browser,
        os,
        device,
        failureReason,
      });

      await this.loginHistoryRepository.save(loginHistory);
    } catch (error) {
      // Log but don't fail the login if activity tracking fails
      this.logger.error('Failed to record login activity', error);
    }
  }

  private parseUserAgent(userAgent: string): { browser: string; os: string; device: string } {
    let browser = 'Unknown';
    let os = 'Unknown';
    let device = 'Desktop';

    // Parse browser
    if (userAgent.includes('Chrome') && !userAgent.includes('Edg')) {
      browser = 'Chrome';
    } else if (userAgent.includes('Firefox')) {
      browser = 'Firefox';
    } else if (userAgent.includes('Safari') && !userAgent.includes('Chrome')) {
      browser = 'Safari';
    } else if (userAgent.includes('Edg')) {
      browser = 'Edge';
    } else if (userAgent.includes('Opera') || userAgent.includes('OPR')) {
      browser = 'Opera';
    }

    // Parse OS
    if (userAgent.includes('Windows')) {
      os = 'Windows';
    } else if (userAgent.includes('Mac OS')) {
      os = 'macOS';
    } else if (userAgent.includes('Linux')) {
      os = 'Linux';
    } else if (userAgent.includes('Android')) {
      os = 'Android';
    } else if (userAgent.includes('iOS') || userAgent.includes('iPhone') || userAgent.includes('iPad')) {
      os = 'iOS';
    }

    // Parse device
    if (userAgent.includes('Mobile') || userAgent.includes('Android') || userAgent.includes('iPhone')) {
      device = 'Mobile';
    } else if (userAgent.includes('Tablet') || userAgent.includes('iPad')) {
      device = 'Tablet';
    }

    return { browser, os, device };
  }

  // Password Reset Methods

  async forgotPassword(dto: ForgotPasswordDto): Promise<ForgotPasswordResponseDto> {
    const user = await this.userRepository.findOne({
      where: { email: dto.email.toLowerCase() },
    });

    const expiresInSeconds = 60; // OTP valid for 60 seconds

    if (!user) {
      this.logger.warn(`Password reset requested for non-existent email: ${dto.email}`);
      throw new BadRequestException('No account found with this email address');
    }

    if (user.status !== UserStatus.ACTIVE) {
      this.logger.warn(`Password reset requested for inactive user: ${dto.email}`);
      throw new BadRequestException('This account is not active');
    }

    // Invalidate any existing reset tokens for this user
    await this.passwordResetTokenRepository.update(
      { userId: user.id, isUsed: false },
      { isUsed: true },
    );

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const token = uuidv4();
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);

    // Save the reset token
    await this.passwordResetTokenRepository.save({
      email: user.email,
      userId: user.id,
      token,
      otp,
      expiresAt,
      isUsed: false,
      isVerified: false,
    });

    // Send OTP email
    const userName = user.firstName || user.email.split('@')[0];
    await this.emailService.sendPasswordResetOtp(user.email, userName, otp, expiresInSeconds);

    this.logger.log(`Password reset OTP sent to: ${user.email}`);

    return {
      message: 'Verification code has been sent to your email.',
      email: dto.email,
      expiresIn: expiresInSeconds,
    };
  }

  async verifyOtp(dto: VerifyOtpDto): Promise<VerifyOtpResponseDto> {
    const resetToken = await this.passwordResetTokenRepository.findOne({
      where: {
        email: dto.email.toLowerCase(),
        isUsed: false,
        isVerified: false,
      },
      order: { createdAt: 'DESC' },
    });

    if (!resetToken) {
      throw new BadRequestException('Invalid or expired verification code. Please request a new code.');
    }

    // Check expiration
    if (resetToken.expiresAt < new Date()) {
      await this.passwordResetTokenRepository.update(resetToken.id, { isUsed: true });
      throw new BadRequestException('Verification code has expired. Please request a new code.');
    }

    // Verify OTP
    if (resetToken.otp !== dto.otp) {
      throw new BadRequestException('Invalid verification code');
    }

    // Mark as verified
    await this.passwordResetTokenRepository.update(resetToken.id, { isVerified: true });

    this.logger.log(`OTP verified for: ${dto.email}`);

    return {
      message: 'Verification successful',
      token: resetToken.token,
      email: dto.email,
    };
  }

  async resetPassword(dto: ResetPasswordDto): Promise<ResetPasswordResponseDto> {
    const resetToken = await this.passwordResetTokenRepository.findOne({
      where: {
        email: dto.email.toLowerCase(),
        token: dto.token,
        isUsed: false,
        isVerified: true,
      },
    });

    if (!resetToken) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    // Check expiration (give extra 5 minutes after OTP verification)
    const extendedExpiry = new Date(resetToken.expiresAt.getTime() + 5 * 60 * 1000);
    if (extendedExpiry < new Date()) {
      await this.passwordResetTokenRepository.update(resetToken.id, { isUsed: true });
      throw new BadRequestException('Reset token has expired');
    }

    // Hash new password
    const passwordHash = await bcrypt.hash(dto.newPassword, 10);

    // Update user password
    await this.userRepository.update(resetToken.userId, { passwordHash });

    // Mark token as used
    await this.passwordResetTokenRepository.update(resetToken.id, { isUsed: true });

    // Invalidate all refresh tokens for security
    await this.refreshTokenRepository.update(
      { userId: resetToken.userId, isRevoked: false },
      { isRevoked: true },
    );

    this.logger.log(`Password reset successful for: ${dto.email}`);

    return {
      message: 'Password reset successful. Please login with your new password.',
      success: true,
    };
  }
}
