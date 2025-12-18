import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ResidentsService } from './residents.service';
import { CreateResidentDto, UpdateResidentDto } from './dto/resident.dto';
import { JwtAuthGuard } from '@common/guards/jwt-auth.guard';
import { RolesGuard } from '@common/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { UserRole } from '@database/entities/user.entity';

@ApiTags('Residents')
@ApiBearerAuth()
@Controller('residents')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ResidentsController {
  constructor(private readonly residentsService: ResidentsService) {}

  @Get()
  @ApiOperation({ summary: 'Get all residents' })
  async findAll(@Query('tenantId') tenantId?: string) {
    return this.residentsService.findAll(tenantId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get resident by ID' })
  async findOne(@Param('id') id: string) {
    return this.residentsService.findOne(id);
  }

  @Post()
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  @ApiOperation({ summary: 'Create new resident' })
  async create(@Body() createDto: CreateResidentDto) {
    return this.residentsService.create(createDto);
  }

  @Patch(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  @ApiOperation({ summary: 'Update resident' })
  async update(@Param('id') id: string, @Body() updateDto: UpdateResidentDto) {
    return this.residentsService.update(id, updateDto);
  }

  @Delete(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  @ApiOperation({ summary: 'Delete resident' })
  async remove(@Param('id') id: string) {
    return this.residentsService.remove(id);
  }
}
