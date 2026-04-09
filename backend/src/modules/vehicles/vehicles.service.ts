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
import { CreateVehicleDto, UpdateVehicleDto } from './dto/vehicle.dto';

@Injectable()
export class VehiclesService {
  constructor(
    @InjectRepository(Vehicle)
    private readonly vehicleRepository: Repository<Vehicle>,
  ) {}

  async findAll(currentUser: User): Promise<Vehicle[]> {
    const query = this.vehicleRepository
      .createQueryBuilder('vehicle')
      .leftJoinAndSelect('vehicle.owner', 'owner')
      .leftJoinAndSelect('vehicle.tenant', 'tenant');

    // Tenant isolation - non-super-admins can only see their own tenant's vehicles
    if (currentUser.role !== UserRole.SUPER_ADMIN) {
      if (!currentUser.tenantId) {
        throw new ForbiddenException('User must belong to a tenant');
      }
      query.where('vehicle.tenantId = :tenantId', { tenantId: currentUser.tenantId });
    }

    return query.orderBy('vehicle.createdAt', 'DESC').getMany();
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
