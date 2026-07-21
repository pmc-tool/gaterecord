import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import { Tenant } from '@database/entities/tenant.entity';
import { CreateResidentDto, UpdateResidentDto } from './dto/resident.dto';
import { AccountIdentityClient } from '../account-identity/account-identity.client';
import { EmailService } from '../notification/email.service';
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class ResidentsService {
  private readonly logger = new Logger(ResidentsService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    private readonly accountIdentityClient: AccountIdentityClient,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
  ) {}

  async findAll(currentUser: User, query: { search?: string; tenantId?: string; status?: string; page?: number; limit?: number } = {}): Promise<{ data: User[]; total: number; page: number; limit: number }> {
    const page = query.page || 1;
    const limit = query.limit || 10;
    const skip = (page - 1) * limit;

    const qb = this.userRepository
      .createQueryBuilder('user')
      .leftJoinAndSelect('user.tenant', 'tenant')
      .leftJoinAndSelect('user.vehicles', 'vehicles')
      .leftJoinAndSelect('user.rfidCards', 'rfidCards')
      .where('user.role = :role', { role: UserRole.RESIDENT });

    // Tenant isolation
    if (currentUser.role === UserRole.SUPER_ADMIN) {
      // Super admin can filter by specific tenant if provided
      if (query.tenantId) {
        qb.andWhere('user.tenantId = :tenantId', { tenantId: query.tenantId });
      }
    } else {
      // Non-super-admins can only see their own tenant's residents
      if (!currentUser.tenantId) {
        throw new ForbiddenException('User must belong to a tenant');
      }
      qb.andWhere('user.tenantId = :tenantId', { tenantId: currentUser.tenantId });
    }

    // Search by name or email
    if (query.search) {
      qb.andWhere(
        '(LOWER(user.firstName) LIKE LOWER(:search) OR LOWER(user.lastName) LIKE LOWER(:search) OR LOWER(user.email) LIKE LOWER(:search))',
        { search: `%${query.search}%` }
      );
    }

    // Filter by status
    if (query.status) {
      qb.andWhere('user.status = :status', { status: query.status });
    }

    const [data, total] = await qb
      .orderBy('user.createdAt', 'DESC')
      .skip(skip)
      .take(limit)
      .getManyAndCount();

    return { data, total, page, limit };
  }

  async findOne(id: string, currentUser: User): Promise<User> {
    const resident = await this.userRepository.findOne({
      where: { id, role: UserRole.RESIDENT },
      relations: ['tenant', 'vehicles', 'rfidCards'],
    });

    if (!resident) {
      throw new NotFoundException(`Resident with ID ${id} not found`);
    }

    // Tenant isolation check
    if (currentUser.role !== UserRole.SUPER_ADMIN) {
      if (resident.tenantId !== currentUser.tenantId) {
        throw new ForbiddenException('Access denied - resident belongs to different tenant');
      }
    }

    return resident;
  }

  async create(createDto: CreateResidentDto, currentUser: User): Promise<User> {
    // Ensure tenant is set for non-super-admins
    if (currentUser.role !== UserRole.SUPER_ADMIN) {
      if (!currentUser.tenantId) {
        throw new ForbiddenException('User must belong to a tenant');
      }
      createDto.tenantId = currentUser.tenantId;
    }

    // Validate tenantId is provided
    if (!createDto.tenantId) {
      throw new ForbiddenException('Tenant ID is required');
    }

    // Check user limit based on subscription plan
    const tenant = await this.tenantRepository.findOne({
      where: { id: createDto.tenantId },
      relations: ['subscriptionPlan'],
    });

    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    if (!tenant.subscriptionPlan) {
      throw new ForbiddenException('No subscription plan found. Please subscribe to a plan first.');
    }

    const residentCount = await this.userRepository.count({
      where: { tenantId: createDto.tenantId, role: UserRole.RESIDENT },
    });

    if (residentCount >= tenant.subscriptionPlan.maxUsers) {
      throw new ForbiddenException(
        `User limit reached. Your plan allows ${tenant.subscriptionPlan.maxUsers} users. Please upgrade your plan to add more users.`,
      );
    }

    const existingUser = await this.userRepository.findOne({
      where: { email: createDto.email.toLowerCase() },
    });

    if (existingUser) {
      throw new ConflictException('Email already in use');
    }

    // Platform identity FIRST, local row second - same ordering and reasoning as
    // UsersService.create. A resident added here must be able to sign in across
    // the platform, so the account service owns the credential and emails it.
    // createDto.password is passed through when supplied; when it is not, the
    // account service generates a strong one. The previous shared literal default
    // gave every resident the same guessable password.
    const identity = await this.accountIdentityClient.provisionUser({
      email: createDto.email.toLowerCase(),
      first_name: createDto.firstName,
      last_name: createDto.lastName,
      phone: createDto.phone,
      password: createDto.password,
      // gaterecord sends its own branded credentials email below.
      sendEmail: false,
    });

    if (!identity.created) {
      this.logger.log(
        'Platform identity already existed for this email; linking the new resident to it.',
      );
    }

    // NOT NULL column kept satisfied with an unguessable value nobody holds - see
    // UsersService.create. Authentication happens at the account service.
    const passwordHash = await bcrypt.hash(uuidv4(), 10);

    const resident = this.userRepository.create({
      ...createDto,
      email: createDto.email.toLowerCase(),
      userId: identity.id, // Keycloak sub - the platform identity link
      passwordHash,
      role: UserRole.RESIDENT,
      status: createDto.isActive === false ? UserStatus.INACTIVE : UserStatus.ACTIVE,
    });

    const savedResident = await this.userRepository.save(resident);

    // Branded gaterecord credentials email - never fatal (see UsersService.create).
    if (identity.created && identity.password) {
      const loginUrl = this.configService.get<string>(
        'GATE_LOGIN_URL',
        'https://yaad.global/login',
      );
      this.emailService
        .sendNewUserCredentialsEmail(
          savedResident.email,
          `${savedResident.firstName} ${savedResident.lastName}`.trim(),
          savedResident.role,
          identity.password,
          tenant.name,
          `${currentUser.firstName} ${currentUser.lastName}`.trim(),
          loginUrl,
        )
        .catch((err: any) =>
          this.logger.warn(
            `Resident identity created for ${savedResident.email} but the credentials email failed to send. ${err?.message ?? ''}`,
          ),
        );
    }

    return savedResident;
  }

  async update(id: string, updateDto: UpdateResidentDto, currentUser: User): Promise<User> {
    const resident = await this.findOne(id, currentUser);

    // Prevent changing tenant for non-super-admins
    if (currentUser.role !== UserRole.SUPER_ADMIN && updateDto.tenantId) {
      if (updateDto.tenantId !== currentUser.tenantId) {
        throw new ForbiddenException('Cannot move resident to different tenant');
      }
    }

    if (updateDto.email && updateDto.email !== resident.email) {
      const existingUser = await this.userRepository.findOne({
        where: { email: updateDto.email },
      });
      if (existingUser) {
        throw new ConflictException('Email already in use');
      }
    }

    if (updateDto.isActive !== undefined) {
      resident.status = updateDto.isActive ? UserStatus.ACTIVE : UserStatus.INACTIVE;
    }

    Object.assign(resident, {
      firstName: updateDto.firstName ?? resident.firstName,
      lastName: updateDto.lastName ?? resident.lastName,
      email: updateDto.email ?? resident.email,
      phone: updateDto.phone ?? resident.phone,
      unit: updateDto.unit ?? resident.unit,
      // Only super admin can change tenant
      ...(currentUser.role === UserRole.SUPER_ADMIN && updateDto.tenantId
        ? { tenantId: updateDto.tenantId }
        : {}),
    });

    return this.userRepository.save(resident);
  }

  async remove(id: string, currentUser: User): Promise<void> {
    const resident = await this.findOne(id, currentUser);
    await this.userRepository.remove(resident);
  }
}
