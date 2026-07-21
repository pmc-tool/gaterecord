import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import * as QRCode from 'qrcode';
import { v4 as uuidv4 } from 'uuid';
import { ConfigService } from '@nestjs/config';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import { Tenant } from '@database/entities/tenant.entity';
import { CreateUserDto, UpdateUserDto, UserQueryDto } from './dto/user.dto';
import { AccountIdentityClient } from '../account-identity/account-identity.client';
import { EmailService } from '../notification/email.service';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(Tenant)
    private tenantRepository: Repository<Tenant>,
    private accountIdentityClient: AccountIdentityClient,
    private emailService: EmailService,
    private configService: ConfigService,
  ) {}

  async create(createUserDto: CreateUserDto, currentUser: User): Promise<User> {
    // Check if email exists
    const existing = await this.userRepository.findOne({
      where: { email: createUserDto.email.toLowerCase() },
    });
    if (existing) {
      throw new ConflictException('Email already exists');
    }

    // Determine tenantId
    let tenantId: string | undefined = createUserDto.tenantId;

    // Validate tenant permissions
    if (currentUser.role !== UserRole.SUPER_ADMIN) {
      // For non-super-admins, default to their own tenant if not specified
      if (!tenantId && currentUser.tenantId) {
        tenantId = currentUser.tenantId;
      }
      // Cannot create users for other tenants
      if (tenantId !== currentUser.tenantId) {
        throw new ForbiddenException('Cannot create user for another tenant');
      }
      // Building admin can only create certain roles
      if (
        createUserDto.role === UserRole.SUPER_ADMIN ||
        createUserDto.role === UserRole.BUILDING_ADMIN
      ) {
        throw new ForbiddenException('Cannot create users with this role');
      }
    }

    // Check user limit based on subscription plan
    if (tenantId) {
      const tenant = await this.tenantRepository.findOne({
        where: { id: tenantId },
        relations: ['subscriptionPlan', 'users'],
      });

      if (tenant?.subscriptionPlan?.maxUsers) {
        const userCount = tenant.users?.length || 0;
        if (userCount >= tenant.subscriptionPlan.maxUsers) {
          throw new ForbiddenException(
            `User limit reached. Your plan allows ${tenant.subscriptionPlan.maxUsers} users. Please upgrade your plan to add more users.`,
          );
        }
      }
    }

    const email = createUserDto.email.toLowerCase();

    // ORDER MATTERS. The platform identity is created FIRST, before the local row.
    //
    // If this call fails, nothing local is written and the admin sees a clear
    // error. If it succeeds but the local insert then fails, the identity still
    // exists and is reconciled by email on the next attempt (the account endpoint
    // is idempotent by email and returns the same id).
    //
    // The reverse order would leave a gate_users row whose person has no platform
    // credential at all - invisible until they try to log in and cannot.
    //
    // The password is passed THROUGH when the admin supplied one. gaterecord no
    // longer decides, generates, stores or emails passwords: the account service
    // owns the credential and its delivery.
    const identity = await this.accountIdentityClient.provisionUser({
      email,
      first_name: createUserDto.firstName,
      last_name: createUserDto.lastName,
      phone: createUserDto.phone,
      password: createUserDto.password,
      // gaterecord sends its own branded credentials email below - it knows the
      // building, the role and who created the user, which the account service
      // does not. Account just returns the password for us to deliver.
      sendEmail: false,
    });

    if (!identity.created) {
      this.logger.log(
        `Platform identity already existed for this email; linking the new gate user to it.`,
      );
    }

    // gate_users.password_hash is NOT NULL and the legacy HS256 login path still
    // reads it. Authentication for this person happens at the account service, so
    // we store a bcrypt hash of a random value that nobody holds or is ever shown:
    // bcrypt.compare against it can only ever return false. The column and the
    // local login path are deliberately left intact - this phase is additive.
    const passwordHash = await bcrypt.hash(uuidv4(), 10);

    // Generate unique QR code
    const qrCode = `GR-${uuidv4()}`;

    const user = this.userRepository.create({
      ...createUserDto,
      tenantId, // Use the resolved tenantId
      email,
      userId: identity.id, // Keycloak sub - the platform identity link
      passwordHash,
      qrCode,
      status: createUserDto.status || UserStatus.ACTIVE,
      mustChangePassword: true, // Force password change on first login
    });

    const savedUser = await this.userRepository.save(user);

    // Branded gaterecord credentials email - building, role and creating admin
    // included. Only on a genuine create (a replay returns no password), and
    // never fatal: the identity and gate user already exist, so a mail failure
    // must not fail the request. The person can always use "forgot password".
    if (identity.created && identity.password) {
      const buildingName = tenantId
        ? (await this.tenantRepository.findOne({ where: { id: tenantId } }))?.name ??
          'your building'
        : 'your building';
      const loginUrl = this.configService.get<string>(
        'GATE_LOGIN_URL',
        'https://yaad.global/login',
      );

      this.emailService
        .sendNewUserCredentialsEmail(
          savedUser.email,
          `${savedUser.firstName} ${savedUser.lastName}`.trim(),
          savedUser.role,
          identity.password,
          buildingName,
          `${currentUser.firstName} ${currentUser.lastName}`.trim(),
          loginUrl,
        )
        .catch((err) =>
          this.logger.warn(
            `Platform identity created for ${savedUser.email} but the credentials email failed to send. The user can use "forgot password". ${err?.message ?? ''}`,
          ),
        );
    }

    return savedUser;
  }

  async findAll(query: UserQueryDto, currentUser: User): Promise<User[]> {
    const qb = this.userRepository
      .createQueryBuilder('user')
      .leftJoinAndSelect('user.tenant', 'tenant');

    // Tenant isolation
    if (currentUser.role === UserRole.SUPER_ADMIN) {
      if (query.tenantId) {
        qb.where('user.tenant_id = :tenantId', { tenantId: query.tenantId });
      }
    } else {
      qb.where('user.tenant_id = :tenantId', { tenantId: currentUser.tenantId });
    }

    // Search by name or email
    if (query.search) {
      qb.andWhere(
        '(LOWER(user.firstName) LIKE :search OR LOWER(user.lastName) LIKE :search OR LOWER(user.email) LIKE :search)',
        { search: `%${query.search.toLowerCase()}%` },
      );
    }

    // Filter by role
    if (query.role) {
      qb.andWhere('user.role = :role', { role: query.role });
    }

    // Filter by status
    if (query.status) {
      qb.andWhere('user.status = :status', { status: query.status });
    }

    return qb.orderBy('user.createdAt', 'DESC').getMany();
  }

  async findOne(id: string, currentUser: User): Promise<User> {
    const user = await this.userRepository.findOne({
      where: { id },
      relations: ['tenant', 'vehicles', 'rfidCards'],
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Check access
    if (currentUser.role !== UserRole.SUPER_ADMIN && user.tenantId !== currentUser.tenantId) {
      throw new ForbiddenException('Access denied');
    }

    return user;
  }

  async update(id: string, updateUserDto: UpdateUserDto, currentUser: User): Promise<User> {
    const user = await this.findOne(id, currentUser);

    // Prevent role escalation
    if (updateUserDto.role && currentUser.role !== UserRole.SUPER_ADMIN) {
      if (
        updateUserDto.role === UserRole.SUPER_ADMIN ||
        updateUserDto.role === UserRole.BUILDING_ADMIN
      ) {
        throw new ForbiddenException('Cannot assign this role');
      }
    }

    if (updateUserDto.password) {
      const passwordHash = await bcrypt.hash(updateUserDto.password, 10);
      Object.assign(user, { ...updateUserDto, passwordHash });
      delete (user as Partial<User> & { password?: string }).password;
    } else {
      Object.assign(user, updateUserDto);
    }

    return this.userRepository.save(user);
  }

  async remove(id: string, currentUser: User): Promise<void> {
    const user = await this.findOne(id, currentUser);

    // Prevent self-deletion
    if (user.id === currentUser.id) {
      throw new ForbiddenException('Cannot delete yourself');
    }

    await this.userRepository.softDelete(id);
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.userRepository.findOne({
      where: { email: email.toLowerCase() },
      relations: ['tenant'],
    });
  }

  /**
   * Update user's profile image URL
   */
  async updateProfileImage(userId: string, profileImageUrl: string): Promise<User> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    user.profileImageUrl = profileImageUrl;
    return this.userRepository.save(user);
  }

  /**
   * Get current user's profile with full details
   */
  async getProfile(userId: string): Promise<User> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
      relations: ['tenant'],
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  /**
   * Render the user's personal access QR code as a PNG data URL.
   *
   * Mirrors VisitorPassService.getQrCode: only the token itself is encoded, not
   * a URL, because gate scanners read the raw token. Users provisioned before
   * qr_code existed, or via a path that skipped it, are backfilled on demand so
   * this never returns an unusable empty code.
   */
  async getProfileQrCode(userId: string): Promise<{ qrCode: string; value: string }> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (!user.qrCode) {
      user.qrCode = `GR-${uuidv4()}`;
      await this.userRepository.update(user.id, { qrCode: user.qrCode });
    }

    return {
      qrCode: await QRCode.toDataURL(user.qrCode),
      value: user.qrCode,
    };
  }

  /**
   * Update current user's profile (self-service)
   */
  async updateProfile(
    userId: string,
    updateData: { firstName?: string; lastName?: string; phone?: string },
  ): Promise<User> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
      relations: ['tenant'],
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (updateData.firstName) user.firstName = updateData.firstName;
    if (updateData.lastName) user.lastName = updateData.lastName;
    if (updateData.phone !== undefined) user.phone = updateData.phone;

    return this.userRepository.save(user);
  }
}
