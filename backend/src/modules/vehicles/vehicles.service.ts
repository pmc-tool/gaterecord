import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Vehicle, VehicleStatus } from '@database/entities/vehicle.entity';
import { User, UserRole } from '@database/entities/user.entity';
import { Tenant } from '@database/entities/tenant.entity';
import { CreateVehicleDto, UpdateVehicleDto, VehicleQueryDto } from './dto/vehicle.dto';

@Injectable()
export class VehiclesService {
  constructor(
    @InjectRepository(Vehicle)
    private readonly vehicleRepository: Repository<Vehicle>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) {}

  async findAll(currentUser: User, queryDto: VehicleQueryDto = {}): Promise<{ data: Vehicle[]; total: number; page: number; limit: number }> {
    const page = queryDto.page || 1;
    const limit = queryDto.limit || 10;
    const skip = (page - 1) * limit;

    const qb = this.vehicleRepository
      .createQueryBuilder('vehicle')
      .leftJoinAndSelect('vehicle.owner', 'owner')
      .leftJoinAndSelect('vehicle.tenant', 'tenant');

    // Tenant isolation - non-super-admins can only see their own tenant's vehicles
    if (currentUser.role === UserRole.SUPER_ADMIN) {
      // Super admin can filter by specific tenant if provided
      if (queryDto.tenantId) {
        qb.where('vehicle.tenantId = :tenantId', { tenantId: queryDto.tenantId });
      }
    } else {
      if (!currentUser.tenantId) {
        throw new ForbiddenException('User must belong to a tenant');
      }
      qb.where('vehicle.tenantId = :tenantId', { tenantId: currentUser.tenantId });
    }

    // Search by plate number or owner name
    if (queryDto.search) {
      qb.andWhere(
        '(LOWER(vehicle.licensePlate) LIKE LOWER(:search) OR LOWER(owner.firstName) LIKE LOWER(:search) OR LOWER(owner.lastName) LIKE LOWER(:search))',
        { search: `%${queryDto.search}%` }
      );
    }

    // Filter by status
    if (queryDto.status) {
      qb.andWhere('vehicle.status = :status', { status: queryDto.status });
    }

    const [data, total] = await qb
      .orderBy('vehicle.createdAt', 'DESC')
      .skip(skip)
      .take(limit)
      .getManyAndCount();

    return { data, total, page, limit };
  }

  async findOne(id: string, currentUser: User): Promise<Vehicle> {
    const vehicle = await this.vehicleRepository.findOne({
      where: { id },
      relations: ['owner', 'tenant'],
    });

    if (!vehicle) {
      throw new NotFoundException(`Vehicle with ID ${id} not found`);
    }

    // Tenant isolation check
    if (currentUser.role !== UserRole.SUPER_ADMIN) {
      if (vehicle.tenantId !== currentUser.tenantId) {
        throw new ForbiddenException('Access denied - vehicle belongs to different tenant');
      }
    }

    return vehicle;
  }

  async findByRfidUid(rfidUid: string, tenantId: string): Promise<Vehicle | null> {
    return this.vehicleRepository.findOne({
      where: { rfidUid, tenantId },
      relations: ['owner', 'tenant'],
    });
  }

  async create(createDto: CreateVehicleDto, currentUser: User): Promise<Vehicle> {
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

    // Check vehicle limit based on subscription plan
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

    const vehicleCount = await this.vehicleRepository.count({
      where: { tenantId: createDto.tenantId },
    });

    if (vehicleCount >= tenant.subscriptionPlan.maxVehicles) {
      throw new ForbiddenException(
        `Vehicle limit reached. Your plan allows ${tenant.subscriptionPlan.maxVehicles} vehicles. Please upgrade your plan to add more vehicles.`,
      );
    }

    const existingRfid = await this.vehicleRepository.findOne({
      where: { rfidUid: createDto.rfidUid, tenantId: createDto.tenantId },
    });
    if (existingRfid) {
      throw new ConflictException('RFID UID already in use for this building');
    }

    const existingPlate = await this.vehicleRepository.findOne({
      where: { licensePlate: createDto.licensePlate, tenantId: createDto.tenantId },
    });
    if (existingPlate) {
      throw new ConflictException('License plate already registered for this building');
    }

    const vehicle = this.vehicleRepository.create({
      ...createDto,
      status: createDto.isActive === false ? VehicleStatus.INACTIVE : VehicleStatus.ACTIVE,
    });
    return this.vehicleRepository.save(vehicle);
  }

  async update(id: string, updateDto: UpdateVehicleDto, currentUser: User): Promise<Vehicle> {
    const vehicle = await this.findOne(id, currentUser);

    if (updateDto.rfidUid && updateDto.rfidUid !== vehicle.rfidUid) {
      const existingRfid = await this.vehicleRepository.findOne({
        where: { rfidUid: updateDto.rfidUid, tenantId: vehicle.tenantId },
      });
      if (existingRfid) {
        throw new ConflictException('RFID UID already in use for this building');
      }
    }

    if (updateDto.licensePlate && updateDto.licensePlate !== vehicle.licensePlate) {
      const existingPlate = await this.vehicleRepository.findOne({
        where: { licensePlate: updateDto.licensePlate, tenantId: vehicle.tenantId },
      });
      if (existingPlate) {
        throw new ConflictException('License plate already registered for this building');
      }
    }

    if (updateDto.isActive !== undefined) {
      vehicle.status = updateDto.isActive ? VehicleStatus.ACTIVE : VehicleStatus.INACTIVE;
    }

    Object.assign(vehicle, {
      licensePlate: updateDto.licensePlate ?? vehicle.licensePlate,
      brand: updateDto.brand ?? vehicle.brand,
      model: updateDto.model ?? vehicle.model,
      color: updateDto.color ?? vehicle.color,
      rfidUid: updateDto.rfidUid ?? vehicle.rfidUid,
      ownerId: updateDto.ownerId ?? vehicle.ownerId,
    });

    return this.vehicleRepository.save(vehicle);
  }

  async remove(id: string, currentUser: User): Promise<void> {
    const vehicle = await this.findOne(id, currentUser);
    await this.vehicleRepository.remove(vehicle);
  }
}
