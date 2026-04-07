import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, LessThanOrEqual, MoreThanOrEqual } from 'typeorm';
import {
  VisitorPass,
  VisitorPassStatus,
  RegistrationType,
} from '@database/entities/visitor-pass.entity';
import { User, UserRole } from '@database/entities/user.entity';
import {
  CreateVisitorPassDto,
  UpdateVisitorPassDto,
  VisitorPassQueryDto,
  ValidityType,
} from './dto/visitor-pass.dto';
import { v4 as uuidv4 } from 'uuid';
import * as QRCode from 'qrcode';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class VisitorPassService {
  constructor(
    @InjectRepository(VisitorPass)
    private readonly visitorPassRepository: Repository<VisitorPass>,
    private readonly configService: ConfigService,
  ) {}

  async create(createDto: CreateVisitorPassDto, currentUser: User): Promise<VisitorPass> {
    // Validate custom dates if custom type
    if (createDto.validityType === ValidityType.CUSTOM) {
      if (!createDto.customValidFrom || !createDto.customValidUntil) {
        throw new BadRequestException('Custom validity requires both start and end dates');
      }
      if (new Date(createDto.customValidFrom) >= new Date(createDto.customValidUntil)) {
        throw new BadRequestException('Start date must be before end date');
      }
    }

    // Generate unique QR token
    const qrToken = uuidv4();

    // Calculate validity dates based on validity type
    const { validFrom, validUntil, maxUses } = this.calculateValidity(createDto);

    // Determine registration type based on user role
    const isStaffRegistration = [
      UserRole.SUPER_ADMIN,
      UserRole.BUILDING_ADMIN,
      UserRole.SECURITY,
    ].includes(currentUser.role);
    const registrationType = isStaffRegistration
      ? createDto.registrationType || RegistrationType.ON_PREMISE
      : RegistrationType.SELF_SERVICE;

    // Determine tenant ID
    let tenantId: string;
    if (currentUser.role === UserRole.SUPER_ADMIN) {
      // Super admin must specify tenant ID
      if (!createDto.tenantId) {
        throw new BadRequestException(
          'Super admin must specify a tenant ID when creating visitor passes',
        );
      }
      tenantId = createDto.tenantId;
    } else if (currentUser.tenantId) {
      // Other users use their own tenant
      tenantId = currentUser.tenantId;
    } else {
      throw new BadRequestException('You must belong to a tenant to create visitor passes');
    }

    // Create visitor pass with ACTIVE status (no approval needed)
    const pass = this.visitorPassRepository.create({
      qrToken,
      visitorName: createDto.visitorName,
      visitorPhone: createDto.visitorPhone,
      visitorEmail: createDto.visitorEmail,
      purpose: createDto.purpose,
      hostUnit: createDto.hostUnit || currentUser.unit,
      status: VisitorPassStatus.ACTIVE,
      validFrom,
      validUntil,
      maxUses,
      useCount: 0,
      createdById: currentUser.id,
      tenantId,
      // On-premise registration fields
      registrationType,
      residentConfirmed:
        registrationType === RegistrationType.ON_PREMISE ? createDto.residentConfirmed : undefined,
      confirmationNotes:
        registrationType === RegistrationType.ON_PREMISE ? createDto.confirmationNotes : undefined,
      residentId:
        registrationType === RegistrationType.ON_PREMISE ? createDto.residentId : undefined,
    });

    const savedPass = await this.visitorPassRepository.save(pass);

    // Return the saved pass (notifications will be handled by controller)
    return savedPass;
  }

  private calculateValidity(dto: CreateVisitorPassDto): {
    validFrom: Date;
    validUntil: Date;
    maxUses: number;
  } {
    const now = new Date();
    let validFrom = now;
    let validUntil: Date;
    let maxUses: number;

    switch (dto.validityType) {
      case ValidityType.SINGLE_USE:
        validUntil = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24 hours
        maxUses = 1;
        break;
      case ValidityType.TWENTY_FOUR_HOURS:
        validUntil = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24 hours
        maxUses = 100; // Unlimited for practical purposes
        break;
      case ValidityType.ONE_WEEK:
        validUntil = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days
        maxUses = 100;
        break;
      case ValidityType.CUSTOM:
        validFrom = new Date(dto.customValidFrom!);
        validUntil = new Date(dto.customValidUntil!);
        maxUses = dto.customMaxUses || 100;
        break;
      default:
        validUntil = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        maxUses = 1;
    }

    return { validFrom, validUntil, maxUses };
  }

  async findAll(currentUser: User, query: VisitorPassQueryDto): Promise<VisitorPass[]> {
    const queryBuilder = this.visitorPassRepository
      .createQueryBuilder('pass')
      .leftJoinAndSelect('pass.createdBy', 'createdBy')
      .leftJoinAndSelect('pass.tenant', 'tenant')
      .leftJoinAndSelect('pass.resident', 'resident');

    // Filter by tenant for non-super-admin users
    if (currentUser.tenantId) {
      queryBuilder.andWhere('pass.tenantId = :tenantId', { tenantId: currentUser.tenantId });
    }

    // Residents only see their own passes
    if (currentUser.role === 'resident') {
      queryBuilder.andWhere('pass.createdById = :userId', { userId: currentUser.id });
    }

    // Apply filters
    if (query.status) {
      queryBuilder.andWhere('pass.status = :status', { status: query.status });
    }

    if (query.startDate && query.endDate) {
      queryBuilder.andWhere('pass.validFrom BETWEEN :startDate AND :endDate', {
        startDate: new Date(query.startDate),
        endDate: new Date(query.endDate),
      });
    } else if (query.startDate) {
      queryBuilder.andWhere('pass.validFrom >= :startDate', {
        startDate: new Date(query.startDate),
      });
    } else if (query.endDate) {
      queryBuilder.andWhere('pass.validFrom <= :endDate', { endDate: new Date(query.endDate) });
    }

    return queryBuilder.orderBy('pass.createdAt', 'DESC').getMany();
  }

  async findOne(id: string, currentUser: User): Promise<VisitorPass> {
    const pass = await this.visitorPassRepository.findOne({
      where: { id },
      relations: ['createdBy', 'tenant', 'resident'],
    });

    if (!pass) {
      throw new NotFoundException(`Visitor pass with ID ${id} not found`);
    }

    // Check access: user must be creator, or admin of same tenant
    if (pass.createdById !== currentUser.id && currentUser.role === 'resident') {
      throw new ForbiddenException('You do not have access to this visitor pass');
    }

    if (currentUser.tenantId && pass.tenantId !== currentUser.tenantId) {
      throw new ForbiddenException('You do not have access to this visitor pass');
    }

    return pass;
  }

  async findByToken(qrToken: string): Promise<VisitorPass> {
    const pass = await this.visitorPassRepository.findOne({
      where: { qrToken },
      relations: ['createdBy', 'tenant', 'resident'],
    });

    if (!pass) {
      throw new NotFoundException('Visitor pass not found');
    }

    return pass;
  }

  async update(
    id: string,
    updateDto: UpdateVisitorPassDto,
    currentUser: User,
  ): Promise<VisitorPass> {
    const pass = await this.findOne(id, currentUser);

    // Only creator can update (or admin)
    if (pass.createdById !== currentUser.id && currentUser.role === 'resident') {
      throw new ForbiddenException('You can only update your own visitor passes');
    }

    Object.assign(pass, {
      visitorName: updateDto.visitorName ?? pass.visitorName,
      visitorPhone: updateDto.visitorPhone ?? pass.visitorPhone,
      visitorEmail: updateDto.visitorEmail ?? pass.visitorEmail,
      purpose: updateDto.purpose ?? pass.purpose,
      status: updateDto.status ?? pass.status,
    });

    return this.visitorPassRepository.save(pass);
  }

  async cancel(id: string, currentUser: User): Promise<VisitorPass> {
    const pass = await this.findOne(id, currentUser);

    if (pass.status === VisitorPassStatus.CANCELLED) {
      throw new BadRequestException('Pass is already cancelled');
    }

    if (pass.status === VisitorPassStatus.USED) {
      throw new BadRequestException('Cannot cancel a used pass');
    }

    pass.status = VisitorPassStatus.CANCELLED;
    return this.visitorPassRepository.save(pass);
  }

  async remove(id: string, currentUser: User): Promise<void> {
    const pass = await this.findOne(id, currentUser);

    // Only creator can delete (or admin)
    if (pass.createdById !== currentUser.id && currentUser.role === 'resident') {
      throw new ForbiddenException('You can only delete your own visitor passes');
    }

    await this.visitorPassRepository.remove(pass);
  }

  async getQrCode(id: string, currentUser: User): Promise<string> {
    const pass = await this.findOne(id, currentUser);
    const frontendUrl = this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000';
    const publicUrl = `${frontendUrl}/visitor-pass/${pass.qrToken}`;
    return QRCode.toDataURL(publicUrl);
  }

  async getQrCodeByToken(qrToken: string): Promise<string> {
    const pass = await this.findByToken(qrToken);
    const frontendUrl = this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000';
    const publicUrl = `${frontendUrl}/visitor-pass/${pass.qrToken}`;
    return QRCode.toDataURL(publicUrl);
  }

  // Get statistics for current user's visitor passes
  async getStats(currentUser: User): Promise<{
    total: number;
    active: number;
    expired: number;
    cancelled: number;
    used: number;
  }> {
    const queryBuilder = this.visitorPassRepository.createQueryBuilder('pass');

    if (currentUser.tenantId) {
      queryBuilder.andWhere('pass.tenantId = :tenantId', { tenantId: currentUser.tenantId });
    }

    if (currentUser.role === 'resident') {
      queryBuilder.andWhere('pass.createdById = :userId', { userId: currentUser.id });
    }

    const passes = await queryBuilder.getMany();

    return {
      total: passes.length,
      active: passes.filter((p) => p.status === VisitorPassStatus.ACTIVE).length,
      expired: passes.filter((p) => p.status === VisitorPassStatus.EXPIRED).length,
      cancelled: passes.filter((p) => p.status === VisitorPassStatus.CANCELLED).length,
      used: passes.filter((p) => p.status === VisitorPassStatus.USED).length,
    };
  }
}
