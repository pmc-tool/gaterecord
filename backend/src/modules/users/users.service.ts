import { Injectable, NotFoundException, ConflictException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import { CreateUserDto, UpdateUserDto } from './dto/user.dto';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
  ) {}

  async create(createUserDto: CreateUserDto, currentUser: User): Promise<User> {
    // Check if email exists
    const existing = await this.userRepository.findOne({
      where: { email: createUserDto.email.toLowerCase() },
    });
    if (existing) {
      throw new ConflictException('Email already exists');
    }

    // Validate tenant permissions
    if (currentUser.role !== UserRole.SUPER_ADMIN) {
      if (createUserDto.tenantId !== currentUser.tenantId) {
        throw new ForbiddenException('Cannot create user for another tenant');
      }
      // Building admin can only create certain roles
      if (createUserDto.role === UserRole.SUPER_ADMIN || createUserDto.role === UserRole.BUILDING_ADMIN) {
        throw new ForbiddenException('Cannot create users with this role');
      }
    }

    const passwordHash = await bcrypt.hash(createUserDto.password, 10);

    const user = this.userRepository.create({
      ...createUserDto,
      email: createUserDto.email.toLowerCase(),
      passwordHash,
      status: UserStatus.ACTIVE,
    });

    return this.userRepository.save(user);
  }

  async findAll(tenantId: string | null, currentUser: User): Promise<User[]> {
    const query = this.userRepository.createQueryBuilder('user');

    if (currentUser.role === UserRole.SUPER_ADMIN) {
      if (tenantId) {
        query.where('user.tenant_id = :tenantId', { tenantId });
      }
    } else {
      query.where('user.tenant_id = :tenantId', { tenantId: currentUser.tenantId });
    }

    return query.getMany();
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
      if (updateUserDto.role === UserRole.SUPER_ADMIN || updateUserDto.role === UserRole.BUILDING_ADMIN) {
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
}
