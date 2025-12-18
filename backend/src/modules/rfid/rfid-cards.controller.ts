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
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RfidCard } from '@database/entities/rfid-card.entity';

@ApiTags('RFID Cards')
@ApiBearerAuth()
@Controller('rfid-cards')
export class RfidCardsController {
  private readonly logger = new Logger(RfidCardsController.name);

  constructor(
    @InjectRepository(RfidCard)
    private rfidCardRepository: Repository<RfidCard>,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get all RFID cards' })
  async findAll(@Query('userId') userId?: string, @Query('tenantId') tenantId?: string) {
    const where: Record<string, string> = {};
    if (userId) where.userId = userId;
    if (tenantId) where.tenantId = tenantId;

    return this.rfidCardRepository.find({
      where,
      relations: ['user'],
      order: { createdAt: 'DESC' },
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get RFID card by ID' })
  async findOne(@Param('id') id: string) {
    const card = await this.rfidCardRepository.findOne({
      where: { id },
      relations: ['user'],
    });

    if (!card) {
      throw new NotFoundException('RFID card not found');
    }

    return card;
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete RFID card' })
  async delete(@Param('id') id: string) {
    const card = await this.rfidCardRepository.findOne({ where: { id } });

    if (!card) {
      throw new NotFoundException('RFID card not found');
    }

    this.logger.log(`Deleting RFID card: ${card.uid} (ID: ${id})`);
    await this.rfidCardRepository.remove(card);
  }
}
