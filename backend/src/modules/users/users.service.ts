import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import { Tenant } from '@database/entities/tenant.entity';
import { CreateUserDto, UpdateUserDto, UserQueryDto } from './dto/user.dto';
import { EmailService } from '../notification/email.service';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(Tenant)
    private tenantRepository: Repository<Tenant>,
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

    // Generate temporary password if not provided
    const plainPassword = createUserDto.password || this.generateTemporaryPassword();
    const passwordHash = await bcrypt.hash(plainPassword, 10);

    // Generate unique QR code
    const qrCode = `GR-${uuidv4()}`;

    const user = this.userRepository.create({
      ...createUserDto,
      tenantId, // Use the resolved tenantId
      email: createUserDto.email.toLowerCase(),
      passwordHash,
      qrCode,
      status: createUserDto.status || UserStatus.ACTIVE,
      mustChangePassword: true, // Force password change on first login
    });

    const savedUser = await this.userRepository.save(user);

    // Send welcome email with credentials
    this.sendWelcomeEmail(savedUser, plainPassword, currentUser).catch((err) => {
      this.logger.error(`Failed to send welcome email to ${savedUser.email}:`, err);
    });

    return savedUser;
  }

  private async sendWelcomeEmail(
    newUser: User,
    temporaryPassword: string,
    createdBy: User,
  ): Promise<void> {
    // Get building name
    let buildingName = 'GateRecord';
    if (newUser.tenantId) {
      const tenant = await this.tenantRepository.findOne({
        where: { id: newUser.tenantId },
      });
      if (tenant) {
        buildingName = tenant.name;
      }
    }

    const createdByName = `${createdBy.firstName} ${createdBy.lastName}`;
    const userName = `${newUser.firstName} ${newUser.lastName}`;
    const loginUrl = this.configService.get<string>('FRONTEND_URL', 'http://localhost:5173') + '/login';

    await this.emailService.sendNewUserCredentialsEmail(
      newUser.email,
      userName,
      newUser.role,
      temporaryPassword,
      buildingName,
      createdByName,
      loginUrl,
    );

    this.logger.log(`Welcome email sent to ${newUser.email}`);
  }

  /**
   * Generate a secure temporary password
   */
  private generateTemporaryPassword(): string {
    const length = 12;
    const uppercase = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const lowercase = 'abcdefghjkmnpqrstuvwxyz';
    const numbers = '23456789';
    const special = '!@#$%&*';
    const allChars = uppercase + lowercase + numbers + special;

    // Ensure at least one of each type
    let password = '';
    password += uppercase[Math.floor(Math.random() * uppercase.length)];
    password += lowercase[Math.floor(Math.random() * lowercase.length)];
    password += numbers[Math.floor(Math.random() * numbers.length)];
    password += special[Math.floor(Math.random() * special.length)];

    // Fill remaining characters
    for (let i = password.length; i < length; i++) {
      password += allChars[Math.floor(Math.random() * allChars.length)];
    }

    // Shuffle the password
    return password
      .split('')
      .sort(() => Math.random() - 0.5)
      .join('');
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
