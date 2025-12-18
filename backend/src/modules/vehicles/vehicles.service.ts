import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Vehicle, VehicleStatus } from '@database/entities/vehicle.entity';
import { CreateVehicleDto, UpdateVehicleDto } from './dto/vehicle.dto';

@Injectable()
export class VehiclesService {
  constructor(
    @InjectRepository(Vehicle)
    private readonly vehicleRepository: Repository<Vehicle>,
  ) {}

  async findAll(tenantId?: string): Promise<Vehicle[]> {
    const query = this.vehicleRepository
      .createQueryBuilder('vehicle')
      .leftJoinAndSelect('vehicle.owner', 'owner')
      .leftJoinAndSelect('vehicle.tenant', 'tenant');

    if (tenantId) {
      query.where('vehicle.tenantId = :tenantId', { tenantId });
    }

    return query.orderBy('vehicle.createdAt', 'DESC').getMany();
  }

  async findOne(id: string): Promise<Vehicle> {
    const vehicle = await this.vehicleRepository.findOne({
      where: { id },
      relations: ['owner', 'tenant'],
    });

    if (!vehicle) {
      throw new NotFoundException(`Vehicle with ID ${id} not found`);
    }

    return vehicle;
  }

  async findByRfidUid(rfidUid: string, tenantId: string): Promise<Vehicle | null> {
    return this.vehicleRepository.findOne({
      where: { rfidUid, tenantId },
      relations: ['owner', 'tenant'],
    });
  }

  async create(createDto: CreateVehicleDto): Promise<Vehicle> {
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

  async update(id: string, updateDto: UpdateVehicleDto): Promise<Vehicle> {
    const vehicle = await this.findOne(id);

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
      make: updateDto.make ?? vehicle.make,
      model: updateDto.model ?? vehicle.model,
      color: updateDto.color ?? vehicle.color,
      rfidUid: updateDto.rfidUid ?? vehicle.rfidUid,
      ownerId: updateDto.ownerId ?? vehicle.ownerId,
    });

    return this.vehicleRepository.save(vehicle);
  }

  async remove(id: string): Promise<void> {
    const vehicle = await this.findOne(id);
    await this.vehicleRepository.remove(vehicle);
  }
}
