import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import { CreateResidentDto, UpdateResidentDto } from './dto/resident.dto';
import * as bcrypt from 'bcrypt';

@Injectable()
export class ResidentsService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async findAll(currentUser: User, tenantId?: string): Promise<User[]> {
    const query = this.userRepository
      .createQueryBuilder('user')
      .leftJoinAndSelect('user.tenant', 'tenant')
      .leftJoinAndSelect('user.vehicles', 'vehicles')
      .leftJoinAndSelect('user.rfidCards', 'rfidCards')
      .where('user.role = :role', { role: UserRole.RESIDENT });

    // Tenant isolation
    if (currentUser.role === UserRole.SUPER_ADMIN) {
      // Super admin can filter by specific tenant if provided
      if (tenantId) {
        query.andWhere('user.tenantId = :tenantId', { tenantId });
      }
    } else {
      // Non-super-admins can only see their own tenant's residents
      if (!currentUser.tenantId) {
        throw new ForbiddenException('User must belong to a tenant');
      }
      query.andWhere('user.tenantId = :tenantId', { tenantId: currentUser.tenantId });
    }

    return query.orderBy('user.createdAt', 'DESC').getMany();
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

    const existingUser = await this.userRepository.findOne({
      where: { email: createDto.email },
    });

    if (existingUser) {
      throw new ConflictException('Email already in use');
    }

    const passwordHash = await bcrypt.hash(createDto.password || 'Resident123!', 10);

    const resident = this.userRepository.create({
      ...createDto,
      passwordHash,
      role: UserRole.RESIDENT,
      status: createDto.isActive === false ? UserStatus.INACTIVE : UserStatus.ACTIVE,
    });

    return this.userRepository.save(resident);
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
