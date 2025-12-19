import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { VehiclesService } from './vehicles.service';
import { CreateVehicleDto, UpdateVehicleDto } from './dto/vehicle.dto';
import { JwtAuthGuard } from '@common/guards/jwt-auth.guard';
import { RolesGuard } from '@common/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { User, UserRole } from '@database/entities/user.entity';

@ApiTags('Vehicles')
@ApiBearerAuth()
@Controller('vehicles')
@UseGuards(JwtAuthGuard, RolesGuard)
export class VehiclesController {
  constructor(private readonly vehiclesService: VehiclesService) {}

  @Get()
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  @ApiOperation({ summary: 'Get all vehicles for current tenant' })
  async findAll(@CurrentUser() user: User) {
    return this.vehiclesService.findAll(user);
  }

  @Get(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  @ApiOperation({ summary: 'Get vehicle by ID' })
  async findOne(@Param('id') id: string, @CurrentUser() user: User) {
    return this.vehiclesService.findOne(id, user);
  }

  @Post()
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  @ApiOperation({ summary: 'Create new vehicle' })
  async create(@Body() createDto: CreateVehicleDto, @CurrentUser() user: User) {
    // Building admin can only create vehicles for their own tenant
    if (user.role !== UserRole.SUPER_ADMIN) {
      if (!user.tenantId) {
        throw new ForbiddenException('User must belong to a tenant');
      }
      createDto.tenantId = user.tenantId;
    }
    return this.vehiclesService.create(createDto, user);
  }

  @Patch(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  @ApiOperation({ summary: 'Update vehicle' })
  async update(
    @Param('id') id: string,
    @Body() updateDto: UpdateVehicleDto,
    @CurrentUser() user: User,
  ) {
    return this.vehiclesService.update(id, updateDto, user);
  }

  @Delete(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  @ApiOperation({ summary: 'Delete vehicle' })
  async remove(@Param('id') id: string, @CurrentUser() user: User) {
    return this.vehiclesService.remove(id, user);
  }
}
