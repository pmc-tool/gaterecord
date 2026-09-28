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
import { DataSource, Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { User, UserStatus, UserRole } from '@database/entities/user.entity';
import { RefreshToken } from '@database/entities/refresh-token.entity';
import { PasswordResetToken } from '@database/entities/password-reset-token.entity';
import { Tenant, TenantStatus, SubscriptionStatus } from '@database/entities/tenant.entity';
import { SubscriptionPlan } from '@database/entities/subscription-plan.entity';
import { LoginHistory, LoginStatus } from '@database/entities/login-history.entity';
import { ActingUser, PLATFORM_CONTEXT_ID, isUuid } from '@common/context/acting-user';
import { isMembershipContextEnabled } from '@common/context/membership-flags';
import { emailHasAccount } from '@common/context/membership-context.errors';
import {
  LEGACY_SENTINEL,
  MembershipsService,
  activeMembershipIdOf,
  isSelectableMembership,
  legacyColumnsFor,
  toMembershipView,
} from '../memberships/memberships.service';
import { MembershipContextService } from '../memberships/membership-context.service';
import { LoginDto, LoginResponseDto, SessionUser, SignupDto } from './dto/login.dto';
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
import { PAID_SIGNUP_LOGIN_WINDOW_MINUTES, SIGNUP_SETTINGS } from '../stripe/stripe.service';

/**
 * bcrypt (cost 10) of a random value nobody holds. The signup resume compares
 * against it when the account row has no usable hash, so every resume attempt
 * costs exactly one bcrypt compare and its timing says nothing about the row.
 */
const DUMMY_PASSWORD_HASH = '$2b$10$Zqw2najQN1WExrj9ojJxfOQdgbtU4TDCgq3eN2bXkUGNa98ZBXlt2';

/** The tenant summary login / refresh / me have always returned. */
function tenantSummary(tenant: Pick<Tenant, 'id' | 'name' | 'slug'> | null | undefined) {
  return tenant ? { id: tenant.id, name: tenant.name, slug: tenant.slug } : null;
}

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
    private dataSource: DataSource,
    private membershipsService: MembershipsService,
    private membershipContextService: MembershipContextService,
  ) {}

  async login(
    loginDto: LoginDto,
    userAgent?: string,
    ipAddress?: string,
  ): Promise<LoginResponseDto> {
    const user = await this.findByEmailWithPassword(loginDto.email);

    if (!user) {
      throw new UnauthorizedException('No account found with this email address');
    }

    const isPasswordValid = await bcrypt.compare(loginDto.password, user.passwordHash);
    if (!isPasswordValid) {
      // Record failed login attempt
      await this.recordLoginActivity(
        user.id,
        LoginStatus.FAILED,
        ipAddress,
        userAgent,
        'Invalid password',
      );
      throw new UnauthorizedException('Incorrect password');
    }

    if (user.status !== UserStatus.ACTIVE) {
      // Record failed login attempt
      await this.recordLoginActivity(
        user.id,
        LoginStatus.FAILED,
        ipAddress,
        userAgent,
        'Account not active',
      );
      throw new UnauthorizedException('Account is not active');
    }

    // Update last login
    await this.userRepository.update(user.id, { lastLoginAt: new Date() });

    // Record successful login
    await this.recordLoginActivity(user.id, LoginStatus.SUCCESS, ipAddress, userAgent);

    const sessionUser = await this.buildSessionUser(user);
    const tokens = await this.generateTokens(user, userAgent, ipAddress, sessionUser);

    return { ...tokens, user: sessionUser };
  }

  /**
   * The person with this email, WITH passwordHash (select: false on the entity,
   * so it must be asked for) and the legacy tenant relation. Only for code that
   * verifies a password; never return the result as is.
   */
  private findByEmailWithPassword(email: string): Promise<User | null> {
    return this.userRepository
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .leftJoinAndSelect('user.tenant', 'tenant')
      .where('user.email = :email', { email: email.toLowerCase() })
      .getOne();
  }

  /**
   * The user block of login / refresh / signup responses, and the source of the
   * informational role / tenantId token claims.
   *
   *   GATE_MEMBERSHIP_CONTEXT off  the gate_users row (role, tenantId, tenant), as
   *                                before; `person.tenant` must be loaded.
   *   on                           a platform admin: super_admin, no building;
   *                                exactly one usable membership: its role and
   *                                building; otherwise (several, or none): nulls.
   *                                Plus every membership (the C4 list) and
   *                                activeMembershipId ('platform', the single
   *                                membership's id, or null).
   *
   * Key order matches the legacy body so flag-off responses are unchanged.
   */
  async buildSessionUser(person: User): Promise<SessionUser> {
    const base = {
      id: person.id,
      email: person.email,
      firstName: person.firstName,
      lastName: person.lastName,
    };
    const personal = { profileImageUrl: person.profileImageUrl, qrCode: person.qrCode };

    if (!isMembershipContextEnabled()) {
      return {
        ...base,
        role: person.role,
        tenantId: person.tenantId,
        ...personal,
        tenant: tenantSummary(person.tenant),
      };
    }

    const [usable, memberships] = await Promise.all([
      this.membershipsService.listActiveForPerson(person.id),
      this.membershipsService.listForPerson(person.id),
    ]);
    const selectable = usable.filter(isSelectableMembership);

    let context: Pick<SessionUser, 'role' | 'tenantId' | 'tenant' | 'activeMembershipId'> = {
      role: null,
      tenantId: null,
      tenant: null,
      activeMembershipId: null,
    };
    if (this.membershipContextService.isPlatformAdmin(person)) {
      context = {
        role: UserRole.SUPER_ADMIN,
        tenantId: null,
        tenant: null,
        activeMembershipId: PLATFORM_CONTEXT_ID,
      };
    } else if (selectable.length === 1) {
      const [only] = selectable;
      context = {
        role: only.role,
        tenantId: only.tenantId,
        tenant: tenantSummary(only.tenant),
        activeMembershipId: only.id,
      };
    }

    return {
      ...base,
      role: context.role,
      tenantId: context.tenantId,
      ...personal,
      tenant: context.tenant,
      memberships: memberships.map(toMembershipView),
      activeMembershipId: context.activeMembershipId,
    };
  }

  /**
   * POST /auth/me: the acting principal as the request resolved it (the
   * overlay, so it follows X-Gate-Membership), in the shape the endpoint has
   * always returned. While GATE_MEMBERSHIP_CONTEXT is on it also lists the
   * person's memberships and names the one this request acts as.
   */
  async describeActingUser(user: ActingUser | User) {
    const body = {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      role: user.role,
      tenantId: user.tenantId,
      profileImageUrl: user.profileImageUrl,
      qrCode: user.qrCode,
      unit: user.unit,
      tenant: tenantSummary(user.tenant),
    };

    if (!isMembershipContextEnabled()) {
      return body;
    }

    const memberships = await this.membershipsService.listForPerson(user.id);
    return {
      ...body,
      memberships: memberships.map(toMembershipView),
      activeMembershipId: activeMembershipIdOf(user),
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

    // A token whose person was soft-deleted loads with user = null; refuse it
    // instead of failing on the property reads below.
    if (!tokenEntity || !tokenEntity.user) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (tokenEntity.expiresAt < new Date()) {
      await this.refreshTokenRepository.update(tokenEntity.id, { isRevoked: true });
      throw new UnauthorizedException('Refresh token expired');
    }

    // Revoke old token
    await this.refreshTokenRepository.update(tokenEntity.id, { isRevoked: true });

    const sessionUser = await this.buildSessionUser(tokenEntity.user);
    const tokens = await this.generateTokens(tokenEntity.user, userAgent, ipAddress, sessionUser);

    return { ...tokens, user: sessionUser };
  }

  async logout(refreshToken: string): Promise<void> {
    await this.refreshTokenRepository.update({ token: refreshToken }, { isRevoked: true });
  }

  async logoutAll(userId: string): Promise<void> {
    await this.refreshTokenRepository.update({ userId, isRevoked: false }, { isRevoked: true });
  }

  /**
   * Signs the HS256 access token and stores a refresh token.
   *
   * The claims keep the shape the legacy SPA reads, {sub, email, role, tenantId},
   * but only `sub` authenticates; role and tenantId are informational and come
   * from the session user (null when the person has several buildings or none).
   * Without a session user they are the gate_users row's.
   */
  private async generateTokens(
    user: User,
    userAgent?: string,
    ipAddress?: string,
    session?: Pick<SessionUser, 'role' | 'tenantId'>,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: session ? session.role : user.role,
      tenantId: session ? session.tenantId : user.tenantId,
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
    const existingUser = await this.findByEmailWithPassword(signupDto.email);

    if (existingUser) {
      return this.resumeSignup(existingUser, signupDto, userAgent, ipAddress);
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

    // Default to the first available plan if not found
    const selectedPlan = plan ?? plans[0];
    if (!selectedPlan) {
      throw new BadRequestException('No subscription plans available');
    }
    if (!plan) {
      console.log(`Plan "${signupDto.planName}" not found, using default: ${selectedPlan.name}`);
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

    // Hashed before the transaction so the row locks are not held across bcrypt.
    const passwordHash = await bcrypt.hash(signupDto.password, 10);
    const qrCode = `GR-${uuidv4()}`;

    // The building, the person and the person's building-admin membership are
    // written in ONE transaction: a failure anywhere (a building-name race, a
    // membership conflict) leaves no tenant without an admin and no person
    // without a building.
    const { savedTenant, savedUser, membership } = await this.dataSource.transaction(
      async (manager) => {
        // Create tenant (building)
        const createdTenant = await manager.save(
          manager.create(Tenant, {
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
          }),
        );

        // Create the person with the no-building sentinel on the legacy columns;
        // MembershipsService is their only writer and mirrors the new building
        // onto them when it adds the membership below.
        const createdUser = await manager.save(
          manager.create(User, {
            email: signupDto.email.toLowerCase(),
            passwordHash,
            firstName: signupDto.firstName,
            lastName: signupDto.lastName,
            phone: signupDto.phone,
            role: LEGACY_SENTINEL.role,
            tenantId: LEGACY_SENTINEL.tenantId,
            status: UserStatus.ACTIVE,
            qrCode,
          }),
        );

        const adminMembership = await this.membershipsService.add(
          {
            userId: createdUser.id,
            tenantId: createdTenant.id,
            role: UserRole.BUILDING_ADMIN,
            status: UserStatus.ACTIVE,
          },
          manager,
        );

        return { savedTenant: createdTenant, savedUser: createdUser, membership: adminMembership };
      },
    );

    // Bring the in-memory person in line with the committed row: the legacy
    // columns add() mirrored, the tenant relation, and no hash.
    Reflect.deleteProperty(savedUser, 'passwordHash');
    Object.assign(savedUser, legacyColumnsFor(membership));
    savedUser.tenant = savedTenant;

    // Generate tokens and auto-login
    const sessionUser = await this.buildSessionUser(savedUser);
    const tokens = await this.generateTokens(savedUser, userAgent, ipAddress, sessionUser);

    // Send welcome email with trial info (don't wait for it, don't fail signup if email fails)
    const frontendUrl = this.configService.get<string>('FRONTEND_URL', 'https://yaad.global');
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

    return { ...tokens, user: sessionUser };
  }

  /**
   * POST /auth/signup with an email that already has an account (SEC-1).
   *
   * The only thing this may do is let the SAME person resume a signup whose
   * building is still waiting for payment, so they can get back to Stripe
   * Checkout. It never writes the password (a signup form must not be a way to
   * reset someone's password), and it issues tokens only when the caller proves
   * they hold the account: it is ACTIVE and the password matches.
   *
   *   wrong password, or account not active   409 'Email already registered'
   *                                            (identical whatever the account's
   *                                            state), recorded as a FAILED login
   *   right password, no pending building      409 EMAIL_HAS_ACCOUNT: sign in and
   *                                            add a building from Get Started
   *   right password, pending building         tokens, nothing written
   *
   * The pending building is found through the person's building_admin
   * membership in a PENDING_PAYMENT building (AUTH-11), not through the legacy
   * gate_users.tenant_id. Exactly one bcrypt compare runs on every path.
   */
  private async resumeSignup(
    existing: User,
    signupDto: SignupDto,
    userAgent?: string,
    ipAddress?: string,
  ): Promise<LoginResponseDto> {
    const passwordMatches = await bcrypt.compare(
      signupDto.password,
      existing.passwordHash || DUMMY_PASSWORD_HASH,
    );

    if (!passwordMatches || existing.status !== UserStatus.ACTIVE) {
      await this.recordLoginActivity(
        existing.id,
        LoginStatus.FAILED,
        ipAddress,
        userAgent,
        passwordMatches
          ? 'Signup resume refused: account not active'
          : 'Signup resume refused: invalid password',
      );
      throw new ConflictException('Email already registered');
    }

    const pending = await this.membershipsService.findAdminMembership({
      personId: existing.id,
      status: UserStatus.ACTIVE,
      tenantStatus: TenantStatus.PENDING_PAYMENT,
    });
    if (!pending) {
      throw emailHasAccount();
    }

    this.logger.log(`Resuming signup for pending account: ${existing.email}`);

    const sessionUser = await this.buildSessionUser(existing);
    const tokens = await this.generateTokens(existing, userAgent, ipAddress, sessionUser);

    // Tokens for the Stripe Checkout step; nothing about the account changed.
    return { ...tokens, user: sessionUser };
  }

  async getSubscriptionPlans(): Promise<SubscriptionPlan[]> {
    return this.subscriptionPlanRepository.find({
      where: { isActive: true },
      order: { displayOrder: 'ASC' },
    });
  }

  /**
   * Signs in the person a paid signup just created - used after payment
   * verification (POST /auth/verify-payment), and ONLY for that person (L9).
   *
   * It replaces loginByTenantId, which handed tokens for "the first active
   * building_admin row of this tenant" to anyone holding a Stripe session id:
   * with memberships that could be a pre-existing person who admins other
   * buildings too. Now every condition must hold, or it answers 401 'Sign in
   * to continue' (the person then signs in normally):
   *   - adminUserId names a live, ACTIVE person;
   *   - that person holds an ACTIVE building_admin membership in the tenant
   *     (live membership in a live building, MembershipsService.findAdminMembership);
   *   - the tenant records that its signup created exactly this person
   *     (tenants.settings.signupCreatedUserId, written by
   *     StripeService.provisionPaidSignup). An email that already had an
   *     account never gets tokens from a Stripe session id;
   *   - it is the first such login, within PAID_SIGNUP_LOGIN_WINDOW_MINUTES of
   *     the building's creation: claimed once on the tenant row
   *     (settings.signupLoginConsumedAt), so the session id is not a lasting
   *     credential.
   * Tokens and the response user come from generateTokens + buildSessionUser,
   * like every other login.
   */
  async loginAfterPaidSignup(
    tenantId: string,
    adminUserId: string | null | undefined,
    userAgent?: string,
    ipAddress?: string,
  ): Promise<LoginResponseDto> {
    const refuse = () => new UnauthorizedException('Sign in to continue');

    if (!isUuid(tenantId) || !isUuid(adminUserId)) {
      throw refuse();
    }

    const membership = await this.membershipsService.findAdminMembership({
      tenantId,
      personId: adminUserId,
      status: UserStatus.ACTIVE,
    });
    if (
      !membership ||
      membership.user?.status !== UserStatus.ACTIVE ||
      membership.tenant?.settings?.signupCreatedUserId !== membership.userId
    ) {
      throw refuse();
    }

    // Re-read with the legacy tenant relation, which buildSessionUser reads
    // while GATE_MEMBERSHIP_CONTEXT is off.
    const person = await this.userRepository.findOne({
      where: { id: membership.userId },
      relations: ['tenant'],
    });
    if (!person || person.status !== UserStatus.ACTIVE) {
      throw refuse();
    }

    // Single use, and only right after the signup: claim this login on the
    // tenant row in ONE statement, so of two concurrent calls with the same
    // session id only one gets tokens, and a session id replayed later (it sits
    // in the success URL, so in browser history and logs) gets 401 however
    // valid the checkout still is. The window counts from the building's
    // creation, on the database clock.
    const claimed = await this.tenantRepository
      .createQueryBuilder()
      .update(Tenant)
      .set({
        settings: () =>
          `COALESCE("settings", '{}'::jsonb) || ` +
          `jsonb_build_object('${SIGNUP_SETTINGS.loginConsumedAt}', now())`,
      })
      .where('"id" = :tenantId', { tenantId })
      .andWhere(`"settings" ->> '${SIGNUP_SETTINGS.createdUserId}' = :personId`, {
        personId: person.id,
      })
      .andWhere(`"settings" ->> '${SIGNUP_SETTINGS.loginConsumedAt}' IS NULL`)
      .andWhere(`"created_at" > now() - interval '${PAID_SIGNUP_LOGIN_WINDOW_MINUTES} minutes'`)
      .execute();
    if (!claimed.affected) {
      throw refuse();
    }

    // Update last login
    await this.userRepository.update(person.id, { lastLoginAt: new Date() });

    const sessionUser = await this.buildSessionUser(person);
    const tokens = await this.generateTokens(person, userAgent, ipAddress, sessionUser);

    return { ...tokens, user: sessionUser };
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
    } else if (
      userAgent.includes('iOS') ||
      userAgent.includes('iPhone') ||
      userAgent.includes('iPad')
    ) {
      os = 'iOS';
    }

    // Parse device
    if (
      userAgent.includes('Mobile') ||
      userAgent.includes('Android') ||
      userAgent.includes('iPhone')
    ) {
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
      throw new BadRequestException(
        'Invalid or expired verification code. Please request a new code.',
      );
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
