import {
  Controller,
  Get,
  Delete,
  Param,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Query,
  Logger,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RfidCard } from '@database/entities/rfid-card.entity';
import { JwtAuthGuard } from '@common/guards/jwt-auth.guard';
import { RolesGuard } from '@common/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { User, UserRole } from '@database/entities/user.entity';

/**
 * RFID cards control physical gate access, so every route is tenant-scoped and
 * admin-only. Previously the controller had NO role guard and NO tenant
 * scoping: any authenticated user of any building could list, read or DELETE
 * cards platform-wide — a cross-tenant hole on physical access control.
 *
 * Now: super admin may act across tenants (optionally filtered); everyone else
 * is confined to their own tenant, and a card outside it is treated as
 * not-found rather than acknowledged.
 */
@ApiTags('RFID Cards')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
@Controller('rfid-cards')
export class RfidCardsController {
  private readonly logger = new Logger(RfidCardsController.name);

  constructor(
    @InjectRepository(RfidCard)
    private rfidCardRepository: Repository<RfidCard>,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get RFID cards for the current tenant' })
  async findAll(
    @CurrentUser() user: User,
    @Query('userId') userId?: string,
    @Query('vehicleId') vehicleId?: string,
    @Query('tenantId') tenantId?: string,
  ) {
    const where: Record<string, string> = {};
    if (userId) where.userId = userId;
    if (vehicleId) where.vehicleId = vehicleId;

    if (user.role === UserRole.SUPER_ADMIN) {
      // Super admin may scope to a tenant, or see all when none is given.
      if (tenantId) where.tenantId = tenantId;
    } else {
      // Everyone else is confined to their own tenant; a supplied tenantId
      // cannot widen that.
      where.tenantId = user.tenantId as string;
    }

    return this.rfidCardRepository.find({
      where,
      relations: ['user', 'vehicle'],
      order: { createdAt: 'DESC' },
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get RFID card by ID' })
  async findOne(@Param('id') id: string, @CurrentUser() user: User) {
    const card = await this.rfidCardRepository.findOne({
      where: { id },
      relations: ['user'],
    });

    // Not-found rather than forbidden: never confirm a card exists in another
    // tenant.
    if (!card || !this.sameTenant(user, card)) {
      throw new NotFoundException('RFID card not found');
    }

    return card;
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete RFID card' })
  async delete(@Param('id') id: string, @CurrentUser() user: User) {
    const card = await this.rfidCardRepository.findOne({ where: { id } });

    if (!card || !this.sameTenant(user, card)) {
      throw new NotFoundException('RFID card not found');
    }

    this.logger.log(`Deleting RFID card: ${card.uid} (ID: ${id})`);
    await this.rfidCardRepository.remove(card);
  }

  private sameTenant(user: User, card: RfidCard): boolean {
    return user.role === UserRole.SUPER_ADMIN || card.tenantId === user.tenantId;
  }
}
