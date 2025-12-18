import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
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

  async findAll(tenantId?: string): Promise<User[]> {
    const query = this.userRepository
      .createQueryBuilder('user')
      .leftJoinAndSelect('user.tenant', 'tenant')
      .leftJoinAndSelect('user.vehicles', 'vehicles')
      .leftJoinAndSelect('user.rfidCards', 'rfidCards')
      .where('user.role = :role', { role: UserRole.RESIDENT });

    if (tenantId) {
      query.andWhere('user.tenantId = :tenantId', { tenantId });
    }

    return query.orderBy('user.createdAt', 'DESC').getMany();
  }

  async findOne(id: string): Promise<User> {
    const resident = await this.userRepository.findOne({
      where: { id, role: UserRole.RESIDENT },
      relations: ['tenant', 'vehicles', 'rfidCards'],
    });

    if (!resident) {
      throw new NotFoundException(`Resident with ID ${id} not found`);
    }

    return resident;
  }

  async create(createDto: CreateResidentDto): Promise<User> {
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

  async update(id: string, updateDto: UpdateResidentDto): Promise<User> {
    const resident = await this.findOne(id);

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
      tenantId: updateDto.tenantId ?? resident.tenantId,
    });

    return this.userRepository.save(resident);
  }

  async remove(id: string): Promise<void> {
    const resident = await this.findOne(id);
    await this.userRepository.remove(resident);
  }
}
